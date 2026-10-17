/**
 * The keeper: the chores that keep the exchange honest between trades.
 *
 *   - busts positions the moment a print crosses their trigger
 *   - executes direct close requests at their pinned price
 *   - pays the queue when the house has cash
 *   - sends stakers their share of the fees, and the house's cash above its cap
 *   - keeps the oracle's Pyth-fee float from running dry
 *
 * Busts, direct closes, harvests and the fee push are permissionless on-chain; running them here
 * just means nobody has to wait. Sweeping the house's spare cash to stakers is the operator's own
 * job. The caps on open interest are not the keeper's to touch: they are what bounds a trader who
 * moves the market the oracle reads, and only the owner sets them.
 */
import { parseEther, formatEther, parseAbi } from "viem";
import { crossed } from "../../shared/math.mjs";
import { DIRECT_DELAY, PIN_WINDOW, REQUEST_EXPIRY } from "../../shared/eip712.mjs";
import { nowSeconds } from "./util.mjs";

const HARVEST_ENTRIES = 32n;
const LOW_FLOAT = parseEther("0.004");

const WAD = 10n ** 18n;
/** Sweeper.MARGIN_BPS: held back from a sweep on top of open profit, in bps of everything open. */
const SWEEP_MARGIN_BPS = 20n;
/** The Sweeper refuses a price older than 30 s when the transaction lands. Leave it room to land. */
const SWEEP_MAX_PRINT_AGE = 8;
const PYTH_FEE_ABI = parseAbi(["function getUpdateFee(bytes[] updateData) view returns (uint256)"]);

/**
 * What a sweep would send to stakers right now: the house's cash above its cap, less what the open
 * positions are up at `priceOf(market)`, less a margin on everything open. Mirrors Sweeper._owed.
 * Returns null when a market with open positions has no price to mark it with.
 */
export function sweepable(house, markets, priceOf) {
  if (!house) return 0n;
  let owed = 0n;
  for (const m of markets) {
    if (!m.sizeLong && !m.sizeShort) continue;
    const price = m.retired ? m.frozenPrice : priceOf(m);
    if (!price) return null;
    const longsWorth = (m.sizeLong * price + WAD - 1n) / WAD;
    const shortsWorth = (m.sizeShort * price) / WAD;
    if (longsWorth > m.oiLong) owed += longsWorth - m.oiLong;
    if (m.oiShort > shortsWorth) owed += m.oiShort - shortsWorth;
    owed += ((m.oiLong + m.oiShort) * SWEEP_MARGIN_BPS + 9_999n) / 10_000n;
  }
  return house.excess > owed ? house.excess - owed : 0n;
}

export function createKeeper({ config, chain, book, source, store, queue, engine, indexer, log }) {
  const { publicClient, walletClient, addresses, read } = chain;
  const orderBound = config.executionMode === "order-bound";
  const executing = new Set();
  const minPush = BigInt(Math.round(config.stakerPushMinUsd * 1e6));
  let harvesting = false;
  let paying = false;
  let timers = [];

  // ---------------------------------------------------------------------------------------
  // Liquidations
  // ---------------------------------------------------------------------------------------

  const requestLive = (position) => position.closeRequestedAt !== 0 && nowSeconds() < position.closeRequestedAt + REQUEST_EXPIRY;

  function shouldBust(position, print) {
    const printAt = orderBound ? print.observedAt : print.time;
    const entryAt = orderBound ? (position.entryAtMs ?? position.entryTime * 1000 + 999) : position.entryTime;
    if (position.liquidating || !Number.isFinite(printAt) || printAt <= entryAt) return false;
    if (!crossed(print.price, position.bust, position.isLong)) return false;
    // A close that was priced at or before this print comes first. If its own price is past the
    // trigger the contract busts it anyway.
    const closingAt = engine.closingAt(position.id);
    if (closingAt !== null && closingAt <= printAt) return false;
    // Same for a binding direct close, for as long as it is live.
    if (requestLive(position) && print.time >= position.closeRequestedAt + DIRECT_DELAY) return false;
    return true;
  }

  function bust(position, print) {
    position.liquidating = true;
    queue
      .push({ label: `bust ${position.id.slice(0, 10)}`, functionName: "liquidate", args: [position.id, [print.blob]] })
      .then((result) => {
        if (result.ok) return;
        // Already gone is fine. Anything else: let a later print try again.
        if (result.reason !== "NoPosition") position.liquidating = false;
      });
  }

  function onTick(marketId, print) {
    // A take-profit or stop-loss touched by this print is a close priced before any bust it makes.
    engine.watchTriggers(marketId, print);
    for (const position of store.positions.values()) {
      if (position.market === marketId && shouldBust(position, print)) bust(position, print);
    }
  }

  /** After a close fell through, look back for a touch that was skipped on its account. */
  function rescan(positionId) {
    const position = store.positions.get(positionId);
    if (!position || position.liquidating) return;
    const history = orderBound ? book.betweenMs(position.market, position.entryAtMs ?? position.entryTime * 1000 + 999, book.latest(position.market)?.observedAt ?? Date.now()) : book.between(position.market, position.entryTime, nowSeconds());
    for (const print of history) {
      if (shouldBust(position, print)) return bust(position, print);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Direct closes
  // ---------------------------------------------------------------------------------------

  async function executeDirectClose(position) {
    if (executing.has(position.id)) return;
    executing.add(position.id);
    try {
      const market = store.markets[position.market];
      let blob = [];
      if (!market.retired) {
        const print = await book.pinned(market.id, position.closeRequestedAt + DIRECT_DELAY, PIN_WINDOW, source.at);
        blob = [print.blob];
      }
      const result = await queue.push({ label: `direct close ${position.id.slice(0, 10)}`, functionName: "executeClose", args: [position.id, blob] });
      if (!result.ok) log.warn(`direct close ${position.id.slice(0, 10)}: ${result.reason}`);
    } catch (error) {
      log.warn(`direct close ${position.id.slice(0, 10)}: ${error.message}`);
    } finally {
      executing.delete(position.id);
    }
  }

  function sweepDirectCloses() {
    const now = nowSeconds();
    for (const position of store.positions.values()) {
      if (!position.closeRequestedAt) continue;
      if (requestLive(position)) {
        // Operators may execute a direct close the moment its price exists.
        if (now >= position.closeRequestedAt + DIRECT_DELAY) executeDirectClose(position);
      } else {
        // It lapsed unexecuted (no price in its window). It shields the position from nothing any
        // more, so look back for a bust touch that was skipped on its account.
        position.closeRequestedAt = 0;
        rescan(position.id);
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // The queue, fees and the oracle float
  // ---------------------------------------------------------------------------------------

  async function harvest() {
    const house = store.house;
    if (harvesting || !house || house.queueLength === 0n) return;
    // Worth a transaction only if there is cash to pay with, or spent claims to clear.
    if (house.lpCash === 0n && house.totalQueued !== 0n) return;
    harvesting = true;
    try {
      const result = await queue.push({ label: "harvest", functionName: "harvest", args: [HARVEST_ENTRIES] });
      if (result.ok) await indexer.refreshHouse();
    } catch (error) {
      // This runs from a timer with nothing awaiting it. Uncaught, one failed read of the house
      // after a harvest (an RPC hiccup) would be an unhandled rejection, which ends the process.
      log.warn(`harvest: ${error.shortMessage ?? error.message}`);
    } finally {
      harvesting = false;
    }
  }

  /**
   * Sends stakers what the exchange has for them: the fees it has accrued, and the house's cash
   * above its cap. The staking contract streams whatever arrives over the following day.
   */
  async function payStakers() {
    if (!addresses.staking || !store.house || paying) return;
    paying = true;
    try {
      if (store.house.stakerFees >= minPush) {
        const pushed = await queue.push({ label: "push staker fees", functionName: "pushStakerFees", args: [] });
        if (pushed.ok) await indexer.refreshHouse();
      }
      await sweep();
    } catch (error) {
      log.warn(`pay stakers: ${error.shortMessage ?? error.message}`);
    } finally {
      paying = false;
    }
  }

  let pythAddress = null;
  /** Signed prices cost nothing to read: no Pyth fee to pay, no float to keep. */
  const signedPrices = config.oracleKind === "signed";

  /**
   * What the house can truly spare at these prices: its cash above the cap, less every winning
   * position's gain before any haircut, less the margin on everything open. No loser's paper loss
   * is counted: it is not cash until that position settles. Null if a price is missing.
   */
  function spare(priceOf) {
    let owed = 0n;
    for (const position of store.positions.values()) {
      const market = store.markets[position.market];
      const price = market.retired ? market.frozenPrice : priceOf(market);
      if (!price) return null;
      const wins = position.isLong ? price > position.entryPrice : price < position.entryPrice;
      if (!wins) continue;
      const delta = price > position.entryPrice ? price - position.entryPrice : position.entryPrice - price;
      const notional = position.margin * BigInt(position.leverage);
      owed += (notional * delta + position.entryPrice - 1n) / position.entryPrice;
    }
    for (const m of store.markets) owed += ((m.oiLong + m.oiShort) * SWEEP_MARGIN_BPS + 9_999n) / 10_000n;
    return store.house.excess > owed ? store.house.excess - owed : 0n;
  }

  /**
   * Has the Sweeper send the house's spare cash above the cap to stakers. The Sweeper's own check
   * marks each side of a market as a whole and so can let through more than the house can spare;
   * the figure passed to it is worked out here, position by position, and is the one that counts.
   */
  async function sweep() {
    if (!addresses.sweeper || store.house.excess < minPush) return;
    const now = nowSeconds();
    // Only with the book at rest: nothing waiting to be busted, no close priced and not yet landed.
    for (const position of store.positions.values()) {
      const print = book.latest(position.market);
      if (position.status !== "open" || position.liquidating) return;
      if (print && crossed(print.price, position.bust, position.isLong)) return;
      if (engine.closingAt(position.id) !== null || requestLive(position)) return;
    }
    const fresh = (m) => {
      const print = book.latest(m.id);
      return print && now - print.time <= SWEEP_MAX_PRINT_AGE ? print : null;
    };
    const amount = spare((m) => fresh(m)?.price ?? null);
    if (amount === null || amount < minPush) return;

    const blobs = store.markets.filter((m) => !m.retired && (m.sizeLong || m.sizeShort)).map((m) => fresh(m).blob);
    let value = 0n;
    if (blobs.length && !signedPrices) {
      pythAddress ??= await read("sweeper", "pyth");
      value = await publicClient.readContract({ address: pythAddress, abi: PYTH_FEE_ABI, functionName: "getUpdateFee", args: [blobs] });
    }
    const swept = await queue.push({ contract: "sweeper", label: "sweep to stakers", functionName: "sweep", args: [blobs, amount], value });
    if (swept.ok) await indexer.refreshHouse();
    // Prices move between the check and the block: nothing to spare after all is not a fault.
    else if (swept.reason !== "NothingToSweep") log.warn(`sweep: ${swept.reason}`);
  }

  async function checkFloat() {
    if (signedPrices) return;
    try {
      const balance = await publicClient.getBalance({ address: addresses.oracle });
      if (balance >= LOW_FLOAT) return;
      const topUp = parseEther(config.oracleTopUpEth || "0");
      if (topUp === 0n) {
        log.warn(`oracle float is low: ${formatEther(balance)} ETH at ${addresses.oracle}. Trading stops when it cannot pay Pyth's fee.`);
        return;
      }
      const hash = await walletClient.sendTransaction({ to: addresses.oracle, value: topUp });
      log.info(`oracle float topped up by ${formatEther(topUp)} ETH (${hash})`);
    } catch (error) {
      log.warn(`oracle float check: ${error.shortMessage ?? error.message}`);
    }
  }

  return {
    start() {
      book.onTick(onTick);
      timers = [
        setInterval(sweepDirectCloses, 1_000),
        setInterval(harvest, 3_000),
        setInterval(payStakers, config.stakerPushSeconds * 1_000),
        setInterval(checkFloat, 5 * 60_000),
      ];
      checkFloat();
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
    },
    rescan,
    harvest,
    payStakers,
  };
}
