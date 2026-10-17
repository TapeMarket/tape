/**
 * The sampler: once a minute it writes down where the house, the queue and the coin stand, so the
 * site can draw a day of history. Samples are plain dollars and coins (floats), for charts only.
 *
 * The last day is kept in memory and saved to disk every few minutes, so a restart does not blank
 * the charts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowSeconds } from "./util.mjs";

const EVERY_MS = 60_000;
const KEEP = 1_440; // one day of minutes
const SAVE_EVERY = 5; // samples

const usd = (value) => Number(value ?? 0n) / 1e6;
const coins = (value) => Number((value ?? 0n) / 10n ** 12n) / 1e6;

export function createSampler({ config, chain, store, book, log }) {
  const { publicClient, addresses, abis } = chain;
  const dir = config.dataDir ?? join(config.root, "relayer", "data");
  const file = join(dir, `series-${config.chainId}-${addresses.exchange.toLowerCase()}.json`);
  let points = [];
  let timer = null;
  let unsaved = 0;

  function load() {
    try {
      if (existsSync(file)) points = JSON.parse(readFileSync(file, "utf8")).filter((p) => p.t > nowSeconds() - KEEP * 60);
    } catch (error) {
      log.warn(`series: could not read ${file}: ${error.message}`);
    }
  }

  function save() {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(points));
      unsaved = 0;
    } catch (error) {
      log.warn(`series: could not save: ${error.message}`);
    }
  }

  async function sample() {
    const house = store.house;
    if (!house) return;
    let staked = 0n;
    if (addresses.staking) {
      try {
        staked = await publicClient.readContract({ address: addresses.staking, abi: abis.staking, functionName: "totalStaked" });
      } catch {
        // Keep the sample; the staked line just holds its last value on the chart.
        staked = null;
      }
    }
    const previous = points[points.length - 1];
    points.push({
      t: nowSeconds(),
      lp: usd(house.lpCash),
      eq: Number(house.equity) / 1e6,
      q: usd(house.totalQueued),
      tvl: usd(house.treasury),
      oi: store.markets.map((m) => [usd(m.oiLong), usd(m.oiShort)]),
      px: store.markets.map((m) => Number(book.latest(m.id)?.price ?? 0n) / 1e8),
      mined: coins(store.coin.mined),
      staked: staked === null ? (previous?.staked ?? 0) : coins(staked),
      paid: usd(store.coin.received),
      vol: usd(store.totals.volume),
      volm: store.markets.map((m) => usd(store.totals.volumeByMarket[m.id])),
      pnl: Number(store.totals.pnl) / 1e6,
      n: store.totals.trades,
      users: store.users.size,
    });
    if (points.length > KEEP) points.splice(0, points.length - KEEP);
    if (++unsaved >= SAVE_EVERY) save();
  }

  return {
    start() {
      load();
      sample().catch(() => {});
      timer = setInterval(() => sample().catch((error) => log.warn(`series: ${error.message}`)), EVERY_MS);
    },
    stop() {
      clearInterval(timer);
      if (unsaved > 0) save();
    },
    /** The oldest price on record for `marketId` within the last day, to measure the change from. */
    reference(marketId) {
      for (const point of points) {
        const price = point.px?.[marketId];
        if (price > 0) return price;
      }
      return null;
    },
    /** Samples from the last `seconds`, thinned to at most `max` points. */
    recent(seconds = 86_400, max = 360) {
      const since = nowSeconds() - seconds;
      const window = points.filter((p) => p.t >= since);
      if (window.length <= max) return window;
      const step = Math.ceil(window.length / max);
      const thinned = window.filter((_, i) => i % step === 0);
      // Always end on the newest sample.
      if (thinned[thinned.length - 1] !== window[window.length - 1]) thinned.push(window[window.length - 1]);
      return thinned;
    },
  };
}
