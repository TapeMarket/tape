/**
 * Development price source. NOT a market's price: it is made up here.
 *
 * It anchors to a public exchange ticker every few seconds, adds a little second-to-second noise so
 * the chart always moves, and encodes each print the way the deployment's oracle takes it: signed
 * by the price signer for a SignedOracle (script/DevDeploy.s.sol, with one of anvil's own keys), or
 * unsigned the way the MockPyth test contract expects. That lets the whole stack be run and clicked
 * through on a local chain with live-looking prices, and lets tests move the price at will. If the
 * ticker is unreachable it carries on from the last value.
 *
 * Only ever used on a local chain (31337). On a real chain the source is Hyperliquid or Hermes.
 */
import { encodeAbiParameters } from "viem";

const TICKERS = { BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD" };
const START = { BTC: 80_000, ETH: 2_500, SOL: 150 };

const UPDATE_PARAMS = [
  { type: "bytes32" },
  { type: "int64" },
  { type: "uint64" },
  { type: "int32" },
  { type: "uint64" },
  { type: "uint64" },
];

const ANCHOR_EVERY_MS = 3_000;
// Per-second noise, as a fraction of price. About a basis point: enough to bust a 1000x position
// within a minute or so, which is what makes local testing of liquidations practical.
const NOISE = 0.00012;
const PULL = 0.25;

/**
 * @param {{ sign(feedId: string, print: object): Promise<string> } | null} [options.signer] the
 *        price signer of a SignedOracle deployment; without one, prints are encoded for MockPyth
 */
export function createDevSource({ markets, book, log, signer = null, fetchImpl = fetch }) {
  const state = new Map(
    markets.map((m) => [m.id, { lastTime: 0, value: START[m.symbol] ?? 100, anchor: null, anchoredAt: 0, shift: 1, chain: Promise.resolve() }]),
  );
  let timer = null;
  let warned = false;

  async function refreshAnchor(market) {
    const s = state.get(market.id);
    const product = TICKERS[market.symbol];
    if (!product || Date.now() - s.anchoredAt < ANCHOR_EVERY_MS) return;
    s.anchoredAt = Date.now();
    try {
      const res = await fetchImpl(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
        headers: { accept: "application/json", "user-agent": "bust-dev" },
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw new Error(`ticker ${res.status}`);
      const json = await res.json();
      const mid = (Number(json.bid) + Number(json.ask)) / 2;
      if (!Number.isFinite(mid) || mid <= 0) throw new Error("ticker returned no price");
      if (s.anchor === null) s.value = mid;
      s.anchor = mid;
    } catch (error) {
      if (!warned) {
        warned = true;
        log.warn(`dev prices: ticker unreachable (${error.message}); carrying on without it`);
      }
    }
  }

  function print(market) {
    const s = state.get(market.id);
    const time = Math.floor(Date.now() / 1000);
    if (time <= s.lastTime) return; // one print per second
    const target = s.anchor === null ? s.value : s.anchor * s.shift;
    s.value = s.value + (target - s.value) * PULL + s.value * (Math.random() - 0.5) * 2 * NOISE;

    const price = BigInt(Math.round(s.value * 1e8));
    const conf = price / 20_000n; // half a basis point
    const prev = s.lastTime || time - 1;
    s.lastTime = time;
    if (!signer) {
      const blob = encodeAbiParameters(UPDATE_PARAMS, [market.feedId, price, conf, -8, BigInt(time), BigInt(prev)]);
      book.add(market.id, { time, prev, price, conf, blob, at: Date.now() });
      return;
    }
    // Signing takes a moment. One print at a time, so they reach the book in the order they were made.
    s.chain = s.chain
      .then(async () => {
        const blob = await signer.sign(market.feedId, { price, conf, time, prev });
        book.add(market.id, { time, prev, price, conf, blob, at: Date.now() });
      })
      .catch((error) => log.error("dev prices: signing a print failed", error));
  }

  return {
    name: "dev",
    start() {
      const tick = () => {
        for (const market of markets) {
          refreshAnchor(market);
          print(market);
        }
      };
      Promise.all(markets.map(refreshAnchor)).finally(tick);
      timer = setInterval(tick, 250);
    },
    stop() {
      clearInterval(timer);
    },
    /** Nothing to fall back to: every print this source makes is the first of its second. */
    at: async () => null,
    /**
     * Moves a market by `bps` basis points and holds it there, so tests can make a position bust or
     * win on demand instead of waiting for the market. `bps` of 0 returns to the real ticker.
     */
    nudge(marketId, bps) {
      const s = state.get(marketId);
      if (!s) return false;
      if (bps === 0) {
        s.value /= s.shift;
        s.shift = 1;
      } else {
        const factor = 1 + bps / 10_000;
        s.shift *= factor;
        s.value *= factor;
      }
      return true;
    },
  };
}
