/**
 * Runs the production price source against the real Pyth Hermes for a few seconds and says what
 * came back. It needs PYTH_API_KEY (from the environment or the repo's .env) to be a key entitled
 * to the feeds; it never prints the key.
 *
 *   node relayer/test/hermes-live.mjs [seconds]
 *
 * Exit code 0: every feed streamed and a historical lookup worked. 2: Hermes refused the key.
 * 1: anything else.
 */
import { readFileSync, existsSync } from "node:fs";
import { createBook } from "../src/prices/book.mjs";
import { createHermesSource } from "../src/prices/hermes.mjs";

const SECONDS = Number(process.argv[2] ?? 8);
const FEEDS = [
  { id: 0, symbol: "BTC", feedId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  { id: 1, symbol: "ETH", feedId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
];

function keyFromDotEnv() {
  const file = new URL("../../.env", import.meta.url);
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("PYTH_API_KEY="));
  return line?.slice("PYTH_API_KEY=".length).trim() || undefined;
}

const apiKey = process.env.PYTH_API_KEY || keyFromDotEnv();
const baseUrl = process.env.HERMES_URL || "https://hermes.pyth.network";
console.log(`Hermes at ${baseUrl}, ${apiKey ? "with a key" : "WITHOUT a key"}, for ${SECONDS}s`);

const refusals = [];
const log = {
  info: (m) => console.log(`  ${m}`),
  warn: (m) => console.log(`  warn: ${m}`),
  error: (m) => {
    refusals.push(String(m));
    console.log(`  error: ${m}`);
  },
};
const book = createBook(FEEDS.map((f) => f.id));
const counts = new Map(FEEDS.map((f) => [f.id, 0]));
const firstOfSecond = new Map(FEEDS.map((f) => [f.id, 0]));
book.onTick((marketId, print) => {
  counts.set(marketId, counts.get(marketId) + 1);
  if (print.prev < print.time) firstOfSecond.set(marketId, firstOfSecond.get(marketId) + 1);
});
const source = createHermesSource({ markets: FEEDS, book, log, baseUrl, apiKey });
source.start();
await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));

let ok = true;
for (const feed of FEEDS) {
  const n = counts.get(feed.id);
  const last = book.latest(feed.id);
  console.log(
    `${feed.symbol}: ${n} prints (${(n / SECONDS).toFixed(1)}/s), ${firstOfSecond.get(feed.id)} of them the first of their second` +
      (last ? `, last $${(Number(last.price) / 1e8).toFixed(2)} ± $${(Number(last.conf) / 1e8).toFixed(2)}, ${Date.now() / 1000 - last.time < 5 ? "fresh" : "STALE"}, blob ${last.blob.length / 2 - 1} bytes` : ""),
  );
  if (n === 0) ok = false;
}

// The lookup the relayer falls back on when it missed a print: the first price at or after a second.
if (ok) {
  const when = Math.floor(Date.now() / 1000) - 20;
  for (const feed of FEEDS) {
    try {
      const print = await source.at(feed.id, when);
      console.log(`${feed.symbol}: lookup at ${when} -> ${print ? `print of second ${print.time} (previous ${print.prev})` : "nothing"}`);
      if (!print || print.time < when) ok = false;
    } catch (error) {
      console.log(`${feed.symbol}: lookup failed: ${error.message}`);
      ok = false;
    }
  }
}
source.stop();
console.log(ok ? "\nALL GOOD: the real stream works with this key" : refusals.length ? "\nREFUSED: Hermes did not accept this key for these feeds" : "\nFAILED");
process.exit(ok ? 0 : refusals.length ? 2 : 1);
