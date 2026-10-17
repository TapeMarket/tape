import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundled = await build({
  stdin: { resolveDir: fileURLToPath(new URL("../src/lib/", import.meta.url)), contents: 'export * from "./api"; export * from "./candles"; export * from "./store";', loader: "ts" },
  bundle: true, format: "cjs", platform: "node", write: false, external: ["react"], logLevel: "silent",
  plugins: [{ name: "live-backend", setup(builder) {
    builder.onLoad({ filter: /[\\/]lib[\\/]mode\.ts$/ }, () => ({ contents: 'export const PREVIEW=false; export const API_URL="https://test.invalid";', loader: "ts" }));
    builder.onResolve({ filter: /^\.\/preview\/tabs$/ }, () => ({ path: "unused-preview", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export function createPreview(){throw Error("Unexpected preview backend");}' }));
  } }],
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(t) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => requests.push({
    url: new URL(url), init, reject,
    reply: (json, status = 200) => resolve({ ok: status < 400, status, json: async () => json }),
  }));
  t.after(() => { globalThis.fetch = originalFetch; });
  const module = { exports: {} };
  new Function("module", "exports", "require", bundled.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
  return { ...module.exports, requests };
}

test("simultaneous public reads share a request; subsequent refreshes and different queries stay fresh", async (t) => {
  const f = fixture(t);
  const a = f.loadPrices(0, 3600), b = f.loadPrices(0, 3600), c = f.loadPrices(1, 3600);
  await flush(); assert.equal(f.requests.length, 2);
  f.requests[0].reply({ market: 0, points: [{ t: 1, p: "900719925474099312" }] });
  f.requests[1].reply({ market: 1, points: [] });
  assert.deepEqual(await a, await b); await c;
  assert.equal((await a).points[0].p, "900719925474099312", "price precision survives sharing");
  const fresh = f.loadPrices(0, 3600); await flush(); assert.equal(f.requests.length, 3);
  f.requests[2].reply({ market: 0, points: [{ t: 2, p: "1" }] });
  assert.equal((await fresh).points[0].t, 2);
});

test("a failed shared public request is discarded so recovery can retry", async (t) => {
  const f = fixture(t), pending = Promise.allSettled([f.get("/status"), f.get("/status")]);
  await flush(); assert.equal(f.requests.length, 1);
  f.requests[0].reply({ error: "Offline" }, 503);
  assert.ok((await pending).every(result => result.status === "rejected" && result.reason.status === 503));
  const retry = f.get("/status"); await flush(); assert.equal(f.requests.length, 2);
  f.requests[1].reply({ online: true }); assert.deepEqual(await retry, { online: true });
});

test("account reads, history and writes are never coalesced or cached", async (t) => {
  const f = fixture(t);
  const operations = [f.get("/account/0x01"), f.get("/account/0x01"), f.get("/history/0x01"), f.get("/history/0x01"), f.post("/open", { amount: 1n }), f.post("/open", { amount: 1n })];
  await flush(); assert.equal(f.requests.length, 6);
  f.requests.forEach((request, i) => request.reply({ sequence: i }));
  assert.deepEqual((await Promise.all(operations)).map(r => r.sequence), [0, 1, 2, 3, 4, 5]);
  assert.equal(f.requests[4].init.body, '{"amount":"1"}');
});

test("configuration consumers do not mutate the shared server response", async (t) => {
  const f = fixture(t), snapshot = { time: Date.now(), markets: [{ id: 0, price: "100", ref24h: 12 }], tape: [] };
  const raw = f.get("/config"), loaded = f.loadConfig(); await flush();
  assert.equal(f.requests.length, 1); f.requests[0].reply(snapshot); await loaded;
  assert.equal((await raw).markets[0].ref24h, 12);
  assert.equal(f.getState().config.markets[0].ref24h, null);
});

const candles = [{ t: 60_000, o: "10", h: "12", l: "9", c: "11" }];
test("chart prefetch and mount share candles without sharing mutable chart bars", async (t) => {
  const f = fixture(t), a = f.loadCandles("BTC", 60), b = f.loadCandles("BTC", 60);
  await flush(); assert.equal(f.requests.length, 1); f.requests[0].reply(candles);
  const [first, second] = await Promise.all([a, b]); first[0].close = 999;
  assert.equal(second[0].close, 11); assert.equal(f.heldCandles("BTC", 60)[0].close, 11);
  const cached = await f.loadCandles("BTC", 60); cached[0].close = 888;
  assert.equal(f.requests.length, 1); assert.equal(f.heldCandles("BTC", 60)[0].close, 11);
});

test("different coins, intervals and older candle pages cannot share the wrong data", async (t) => {
  const f = fixture(t), all = [f.loadCandles("BTC", 60), f.loadCandles("ETH", 60), f.loadCandles("BTC", 300), f.loadCandles("BTC", 60, 60)];
  await flush(); assert.equal(f.requests.length, 4);
  f.requests.forEach(request => request.reply(candles));
  const results = await Promise.all(all); assert.equal(results[3].length, 0, "older pages exclude the boundary candle");
  assert.equal(f.heldCandles("BTC", 60).length, 1, "older pages do not replace the latest page");
});

test("failed candle prefetches retry, and cached candles expire", async (t) => {
  const f = fixture(t), failed = Promise.allSettled([f.loadCandles("BTC", 60), f.loadCandles("BTC", 60)]);
  await flush(); f.requests[0].reply({}, 503); assert.ok((await failed).every(r => r.status === "rejected"));
  const retry = f.loadCandles("BTC", 60); await flush(); assert.equal(f.requests.length, 2); f.requests[1].reply(candles); await retry;
  const now = Date.now; t.after(() => { Date.now = now; }); Date.now = () => now() + 21_000;
  const expired = f.loadCandles("BTC", 60); await flush(); assert.equal(f.requests.length, 3); f.requests[2].reply(candles); await expired;
});

test("no-op state patches are quiet while meaningful updates notify immediately", (t) => {
  const f = fixture(t); let count = 0;
  const off = f.subscribe(() => { count++; });
  f.setState({}); f.setState(s => ({ owner: s.owner })); f.setState({ marketId: 0 }); assert.equal(count, 0);
  f.setState({ marketId: 1 }); assert.equal(count, 1); assert.equal(f.getState().marketId, 1);
  f.setState({ owner: "0x01" }); assert.equal(count, 2); off(); f.setState({ marketId: 2 }); assert.equal(count, 2);
});
