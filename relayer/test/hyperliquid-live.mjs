/**
 * The Hyperliquid price source against the real API, for half a minute.
 *
 * Proves, from this machine and this network: that Hyperliquid's public API answers without a key,
 * that the source turns it into one first print a second for BTC and ETH, each signed and chained
 * as the contract requires, that the prices are the market's (within a fraction of a percent of
 * Coinbase), that a dropped stream does not stop the prints, and what this machine's clock is
 * against Hyperliquid's.
 *
 * If a local chain with a signed deployment is running (anvil + script/DevDeploy.s.sol), every
 * print is also handed to the real SignedOracle contract, which has to read it back.
 *
 *   node relayer/test/hyperliquid-live.mjs [seconds]        (Node 22 or newer)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { createBook } from "../src/prices/book.mjs";
import { createPrintSigner, SIGNED_ORACLE_ABI } from "../src/prices/signer.mjs";
import { createHyperliquidSource, createCoinbaseReference } from "../src/prices/hyperliquid.mjs";

const SECONDS = Number(process.argv[2] ?? 30);
const BTC = "0x68797065726c69717569643a4254430000000000000000000000000000000000";
const ETH = "0x68797065726c69717569643a4554480000000000000000000000000000000000";
const MARKETS = [
  { id: 0, symbol: "BTC", feedId: BTC },
  { id: 1, symbol: "ETH", feedId: ETH },
];
// anvil's account 9, the price signer of a local deployment. Worthless anywhere else.
const KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const said = [];
const log = {
  info: (m) => console.log(`  ${m}`),
  warn: (m) => (said.push(m), console.log(`  WARN ${m}`)),
  error: (m, e) => (said.push(m), console.log(`  ERROR ${m}${e ? `: ${e.message}` : ""}`)),
};

// A local signed deployment, if there is one, to check the prints against the contract itself.
let chain = null;
const file = new URL("../../deployments/31337.json", import.meta.url);
if (existsSync(file)) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  if (d.oracleKind === "signed") {
    const client = createPublicClient({ transport: http("http://127.0.0.1:8545") });
    try {
      if ((await client.getChainId()) === 31337 && (await client.getCode({ address: d.oracle }))) chain = { client, oracle: d.oracle };
    } catch {
      // No local chain running: signatures are checked off-chain only.
    }
  }
}
const signer = createPrintSigner({ privateKey: KEY, chainId: 31337, oracle: chain?.oracle ?? "0x00000000000000000000000000000000000051c4" });
console.log(chain ? `prints will be read back by the SignedOracle at ${chain.oracle} on the local chain` : "no local signed deployment: prints are not shown to a contract");

const book = createBook(MARKETS.map((m) => m.id));
const prints = new Map(MARKETS.map((m) => [m.id, []]));
book.onTick((market, print) => prints.get(market).push(print));
const reference = createCoinbaseReference({ symbols: ["BTC", "ETH"], log });
const sockets = [];
// The real WebSocket, kept track of so the test can cut the stream.
class Tracked extends WebSocket {
  constructor(url) {
    super(url);
    sockets.push(this);
  }
}
const source = createHyperliquidSource({ markets: MARKETS, book, signer, log, reference, WebSocketImpl: Tracked });

console.log(`streaming for ${SECONDS}s`);
const started = Math.floor(Date.now() / 1000);
source.start();
await sleep((SECONDS * 1000) / 2);
console.log("cutting the stream");
sockets.at(-1)?.close();
await sleep((SECONDS * 1000) / 2);
const health = source.health();
source.stop();
await source.settled();
const ended = Math.floor(Date.now() / 1000);

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "[ OK ]" : "[FAIL]"} ${what}`);
  if (!ok) failed = true;
};

for (const market of MARKETS) {
  const list = prints.get(market.id);
  const firsts = list.filter((p) => p.prev < p.time);
  const seconds = ended - started - 1;
  check(firsts.length >= seconds * 0.9, `${market.symbol}: ${firsts.length} first prints in ${seconds} seconds, ${list.length} prints in all`);

  let chained = true;
  let lastFirst = null;
  let lastTime = 0;
  for (const p of list) {
    if (p.time < lastTime || p.prev > p.time) chained = false;
    if (p.prev < p.time) {
      // A first print names the second of the print before it.
      if (lastTime && p.prev !== lastTime) chained = false;
      lastFirst = p;
    } else if (!lastFirst || lastFirst.time !== p.time) chained = false;
    lastTime = p.time;
  }
  check(chained, `${market.symbol}: every print follows the one before it, and only one print a second is a first`);

  const gaps = firsts.slice(1).map((p, i) => p.time - firsts[i].time);
  const worst = Math.max(0, ...gaps);
  check(worst <= 3, `${market.symbol}: no gap longer than 3 seconds, the stream cut included (longest ${worst}s)`);

  const ref = reference.get(market.symbol);
  const last = list.at(-1);
  if (ref && last) {
    const price = Number(last.price) / 1e8;
    const apart = (Math.abs(price - ref.price) / ref.price) * 10_000;
    check(apart < 50, `${market.symbol}: Hyperliquid ${price.toFixed(2)} vs Coinbase ${ref.price.toFixed(2)}, ${apart.toFixed(1)} bps apart`);
    check(last.conf * 10_000n < last.price * 20n, `${market.symbol}: the book is ${(Number(last.conf * 2n) / Number(last.price) * 10_000).toFixed(2)} bps wide, far inside the 20 bps a market refuses to open past`);
  } else check(false, `${market.symbol}: no Coinbase price to compare with`);

  if (chain) {
    let read = 0;
    for (const p of list) {
      const [price, conf, time, prev] = await chain.client.readContract({ address: chain.oracle, abi: SIGNED_ORACLE_ABI, functionName: "read", args: [market.feedId, [p.blob]] });
      assert.deepEqual([price, conf, Number(time), Number(prev)], [p.price, p.conf, p.time, p.prev]);
      read++;
    }
    check(read === list.length, `${market.symbol}: the SignedOracle contract read back all ${read} prints`);
  }
}
for (const h of health) {
  check(Math.abs(h.clockOffsetMs) < 2000, `${h.coin}: this machine's clock is ${h.clockOffsetMs}ms from Hyperliquid's stamp (network delay included); the source stops signing past 2000ms`);
}
check(sockets.length >= 2, `the stream was reopened after the cut (${sockets.length} connections)`);
check(!said.some((m) => /REFUSES|bps apart|clock/.test(m)), "nothing was refused for being wrong");

console.log(failed ? "\nFAILED" : "\nALL GOOD");
process.exit(failed ? 1 : 0);
