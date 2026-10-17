// Read-only network benchmark. Public fixture signing key, nonexistent oracle, no chain writes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createBook } from "../src/prices/book.mjs";
import { createHyperliquidSource, createOracleReference, coinOfFeed } from "../src/prices/hyperliquid.mjs";
import { createPrintLog } from "../src/prices/printlog.mjs";
import { createExecutionSigner, createExecutions } from "../src/prices/execution.mjs";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const config = await (await fetch("https://api.tapemarket.io/config")).json();
const markets = config.markets.filter(market => !market.retired);
const book = createBook(markets.map(market => market.id));
const dir = await mkdtemp(join(tmpdir(), "tape-fast-feed-"));
const oracle = `0x${"22".repeat(20)}`;
const signer = createExecutionSigner({ privateKey: `0x${"11".repeat(32)}`, chainId: 1, oracle });
const log = { info() {}, warn: value => console.log(value), error: (...args) => console.error(...args) };
const reference = createOracleReference({ coins: markets.map(market => coinOfFeed(market.feedId)), log });
const source = createHyperliquidSource({ markets, book, signer, orderBound: true, reference, sanityBps: 150, log,
  printLog: createPrintLog({ dir, chainId: 1, oracle, signer: signer.address }) });
try {
  source.start();
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && markets.some(market => !book.latest(market.id))) await sleep(100);
  const executions = await createExecutions({ dir, chainId: 1, oracle, signer, source });
  const results = await Promise.allSettled(markets.map(async market => {
    if (!book.latest(market.id)) throw Error(`No eligible ${market.symbol} price: ${source.health().find(value => value.markets.includes(market.id))?.stopped}`);
    const receivedAt = Date.now();
    const price = await executions.price({ id: `0x${randomBytes(32).toString("hex")}`, market, timestamp: Math.floor(receivedAt / 1000), receivedAt });
    return { market: market.symbol, pricingMs: Date.now() - receivedAt, observationAfterIntakeMs: price.observedAt - receivedAt };
  }));
  for (const result of results) console.log(JSON.stringify(result.status === "fulfilled" ? result.value : { failed: result.reason.message }));
  console.log(JSON.stringify({ clock: source.health().map(value => ({ coin: value.coin, offset: value.clockOffsetMs, stopped: value.stopped })), readOnly: true }));
  if (results.some(result => result.status === "rejected")) process.exitCode = 1;
} finally { source.stop(); await source.settled(); await rm(dir, { recursive: true, force: true }); }
