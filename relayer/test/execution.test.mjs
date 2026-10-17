import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAbiParameters, recoverTypedDataAddress, serializeSignature } from "viem";
import { createExecutionSigner, createExecutions, FILL_TYPES, TICK_TYPES } from "../src/prices/execution.mjs";
import { printDomain } from "../src/prices/signer.mjs";
import { createHyperliquidSource } from "../src/prices/hyperliquid.mjs";
import { createBook } from "../src/prices/book.mjs";

const KEY = `0x${"11".repeat(32)}`, ORACLE = `0x${"22".repeat(20)}`;
const FEED = `0x${Buffer.from("hyperliquid:BTC").toString("hex").padEnd(64, "0")}`;
const MARKET = { id: 0, feedId: FEED };
const ID = `0x${"33".repeat(32)}`;
const T = 1_800_000_000_000;
const signer = createExecutionSigner({ privateKey: KEY, chainId: 1, oracle: ORACLE });
const print = { price: 80_00000000000n, conf: 10000n, time: T / 1000, observedAt: T + 200 };

test("JavaScript execution and high-resolution tick signatures use the Solidity layouts and domains", async () => {
  const blob = await signer.fill(FEED, ID, print);
  const [feedId, orderId, price, conf, publishTime, observedAt, v, r, s] = decodeAbiParameters([
    ...["bytes32", "bytes32", "uint64", "uint64", "uint64", "uint64", "uint8", "bytes32", "bytes32"].map(type => ({ type })),
  ], blob);
  assert.equal(blob.length, 2 + 288 * 2);
  assert.equal(await recoverTypedDataAddress({ domain: printDomain(1, ORACLE), types: FILL_TYPES, primaryType: "Fill", message: { feedId, orderId, price, conf, publishTime, observedAt }, signature: serializeSignature({ r, s, yParity: v - 27 }) }), signer.address);
  const tick = { ...print, prev: T / 1000, prevObservedAt: T + 100 };
  const tickBlob = await signer.sign(FEED, tick);
  const [f, p, c, t, prev, ms, prevMs, tv, tr, ts] = decodeAbiParameters(["bytes32", "uint64", "uint64", "uint64", "uint64", "uint64", "uint64", "uint8", "bytes32", "bytes32"].map(type => ({ type })), tickBlob);
  assert.equal(await recoverTypedDataAddress({ domain: printDomain(1, ORACLE), types: TICK_TYPES, primaryType: "Tick", message: { feedId: f, price: p, conf: c, publishTime: t, prevPublishTime: prev, observedAt: ms, prevObservedAt: prevMs }, signature: serializeSignature({ r: tr, s: ts, yParity: tv - 27 }) }), signer.address);
  await assert.rejects(signer.fill(FEED, ID, { ...print, price: 0n }), /Invalid/);
});

async function journalFixture(t, source = { execution: async () => print }) {
  const dir = await mkdtemp(join(tmpdir(), "tape-execution-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { dir, chainId: 1, oracle: ORACLE, signer, source, now: () => T + 300 };
  const executions = await createExecutions(options);
  const request = { id: ID, market: MARKET, timestamp: T / 1000, receivedAt: T + 100 };
  return { dir, options, executions, request };
}
test("concurrent requests and restarts reuse exactly the first persisted order quote", async t => {
  let calls = 0;
  const f = await journalFixture(t, { execution: async () => { calls++; return { ...print, price: print.price + BigInt(calls) }; } });
  const [first, second] = await Promise.all([f.executions.price(f.request), f.executions.price(f.request)]);
  assert.equal(first.blob, second.blob); assert.equal(calls, 1);
  const file = (await readdir(f.dir))[0];
  assert.equal((await readFile(join(f.dir, file), "utf8")).trim().split("\n").length, 1);
  const restarted = await createExecutions(f.options);
  assert.equal((await restarted.price({ ...f.request, receivedAt: T + 300 })).blob, first.blob);
  assert.equal(calls, 1);
  await assert.rejects(restarted.price({ ...f.request, market: { ...MARKET, id: 1 } }), /does not match/);
});
test("a pre-intake source observation cannot be signed or journaled", async t => {
  const f = await journalFixture(t, { execution: async () => ({ ...print, observedAt: T + 50 }) });
  await assert.rejects(f.executions.price(f.request), /stale/);
  assert.deepEqual(await readdir(f.dir), []);
});
test("a corrupted execution journal stops startup rather than allowing a second price", async t => {
  const f = await journalFixture(t);
  await f.executions.price(f.request);
  await writeFile(join(f.dir, (await readdir(f.dir))[0]), '{"id":');
  await assert.rejects(createExecutions(f.options));
});

function rig(t, extra = {}) {
  let now = T;
  const book = createBook([0]);
  const signed = [], persisted = [];
  const source = createHyperliquidSource({ markets: [MARKET], book, orderBound: true,
    signer: { sign: async (feed, value) => { signed.push(value); return `0x${"44".repeat(320)}`; } },
    printLog: { appendDurable: async (feed, value) => { persisted.push(value); }, release() {}, acquire() {}, load: () => [] },
    now: () => now, sanityBps: 0, fetchImpl: () => new Promise(() => {}), log: { info() {}, warn() {}, error() {} }, ...extra,
  });
  const ingest = (at, sourceAt = at, bid = "80000", ask = "80001") => { now = at; source.ingest("BTC", bid, ask, sourceAt); };
  t.after(() => source.stop());
  return { source, book, signed, persisted, ingest };
}
test("first fresh source observation after intake fills without the two-second scheduler", async t => {
  const r = rig(t);
  r.ingest(T + 1100);
  let resolved = false;
  const promise = r.source.execution(0, T + 1150, T / 1000 + 1).then(value => { resolved = true; return value; });
  r.ingest(T + 1160, T + 1140); // Received after intake, but the exchange observation was before it.
  await Promise.resolve(); assert.equal(resolved, false);
  r.ingest(T + 1200, T + 1180);
  const fill = await promise;
  assert.equal(fill.observedAt, T + 1180);
  assert.ok(fill.observedAt - (T + 1150) < 100);
});
test("a previously received observation cannot be reused even when the feed clock is ahead", async t => {
  const r = rig(t);
  r.ingest(T + 1100, T + 1300);
  let done = false;
  const promise = r.source.execution(0, T + 1150, T / 1000 + 1).then(value => { done = true; return value; });
  await Promise.resolve(); assert.equal(done, false);
  r.ingest(T + 1200, T + 1400);
  assert.equal((await promise).observedAt, T + 1400);
});
test("every eligible intrasecond price move is persisted before becoming a liquidation tick", async t => {
  const r = rig(t);
  r.ingest(T + 1100);
  r.ingest(T + 1120, T + 1120, "78000", "78001");
  r.ingest(T + 1140, T + 1140, "80000", "80001");
  await r.source.settled();
  assert.deepEqual(r.signed.map(value => value.observedAt), [T + 1100, T + 1120, T + 1140]);
  assert.deepEqual(r.signed.map(value => value.prevObservedAt), [0, T + 1100, T + 1120]);
  assert.equal(r.persisted.length, 3);
  assert.equal(r.book.betweenMs(0, T + 1110, T + 1140).length, 2);
});
test("quiet markets receive fresh unchanged-price snapshots without waiting for the next BBO change", async t => {
  const r = rig(t);
  r.ingest(T + 1100);
  const promise = r.source.execution(0, T + 1150, T / 1000 + 1);
  r.ingest(T + 1200, T + 1100); // Move only the fixture clock; duplicate source observation is ignored.
  r.source.onMessage({ data: JSON.stringify({ channel: "l2Book", data: { coin: "BTC", time: T + 1180, levels: [[{ px: "80000" }], [{ px: "80001" }]] } }) });
  assert.equal((await promise).observedAt, T + 1180);
});
test("concurrent orders share one informational request on the already-open socket", async t => {
  class Socket {
    static current;
    readyState = 1;
    events = new Map(); sent = [];
    constructor() { Socket.current = this; }
    addEventListener(type, fn) { this.events.set(type, fn); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() {}
  }
  const r = rig(t, { WebSocketImpl: Socket });
  r.source.start(); Socket.current.events.get("open")();
  assert.deepEqual(Socket.current.sent.map(value => value.subscription.type), ["bbo", "l2Book"]);
  r.ingest(T + 1100);
  const first = r.source.execution(0, T + 1150, T / 1000 + 1);
  const second = r.source.execution(0, T + 1150, T / 1000 + 1);
  const requests = Socket.current.sent.filter(value => value.method === "post");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.type, "info");
  r.ingest(T + 1300, T + 1100);
  r.source.onMessage({ data: JSON.stringify({ channel: "post", data: { id: requests[0].id, response: { type: "info", payload: { type: "l2Book", data: { coin: "BTC", time: T + 1250, levels: [[{ px: "80000" }], [{ px: "80001" }]] } } } } }) });
  assert.equal((await first).observedAt, T + 1250);
  assert.equal((await second).observedAt, T + 1250);
});
