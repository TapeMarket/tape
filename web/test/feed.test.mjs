import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/lib/preview/feed.ts", import.meta.url))], bundle: true, format: "cjs", platform: "node", write: false, logLevel: "silent" });
const module = { exports: {} };
new Function("module", "exports", bundled.outputFiles[0].text)(module, module.exports);
const { createFeed } = module.exports;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(t, coins = ["BTC", "ETH"]) {
  const original = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, now: Date.now, setInterval, clearInterval };
  let now = 100_000, respond = async () => { throw Error("Offline"); };
  const sockets = [], timers = new Set(), quotes = [], requests = [];
  globalThis.WebSocket = class {
    constructor() { sockets.push(this); }
    send() {}
    close() { this.onclose?.(); }
  };
  Date.now = () => now;
  globalThis.setInterval = (callback) => { timers.add(callback); return callback; };
  globalThis.clearInterval = (callback) => timers.delete(callback);
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const data = await respond(body);
    return { ok: true, json: async () => data };
  };
  const feed = createFeed(coins, (index, price) => quotes.push({ index, price }));
  t.after(() => { feed.stop(); globalThis.WebSocket = original.WebSocket; globalThis.fetch = original.fetch; Date.now = original.now; globalThis.setInterval = original.setInterval; globalThis.clearInterval = original.clearInterval; });
  const emit = (coin, price, time = now) => sockets.at(-1).onmessage({ data: JSON.stringify({ channel: "bbo", data: { coin, time, bbo: [{ px: String(price - 1) }, { px: String(price + 1) }] } }) });
  return { feed, quotes, requests, emit, setTime: (value) => { now = value; }, poll: () => timers.forEach((callback) => callback()), respond: (fn) => { respond = fn; } };
}

test("an active BTC stream cannot keep a silent ETH quote fresh or suppress its fallback", async (t) => {
  const f = fixture(t); f.feed.start(); await flush(); f.emit("BTC", 100); f.emit("ETH", 200);
  assert.equal(f.feed.healthy(), true);
  f.setTime(107_000); f.emit("BTC", 110); f.poll(); await flush();
  assert.equal(f.feed.healthy(0), true); assert.equal(f.feed.healthy(1), false); assert.equal(f.feed.healthy(), false);
  assert.equal(f.requests.length, 2, "fallback must run even though BTC is active");
});

test("fallback recovers only the quiet dex and leaves its live neighbours unchanged", async (t) => {
  const f = fixture(t, ["BTC", "xyz:TSLA"]); f.feed.start(); await flush(); f.requests.length = 0;
  f.emit("BTC", 100); f.emit("xyz:TSLA", 200); f.setTime(107_000); f.emit("BTC", 110);
  f.respond(async () => ({ "xyz:TSLA": "250" })); f.poll(); await flush();
  assert.deepEqual(f.requests, [{ type: "allMids", dex: "xyz" }]);
  assert.deepEqual(f.quotes.at(-1), { index: 1, price: 250 }); assert.equal(f.feed.healthy(), true);
});

test("a slow HTTP fallback cannot overwrite a resumed WebSocket quote", async (t) => {
  const f = fixture(t, ["BTC"]); let resolve;
  f.respond(() => new Promise((done) => { resolve = done; })); f.feed.start(); f.emit("BTC", 120);
  resolve({ BTC: "100" }); await flush();
  assert.deepEqual(f.quotes, [{ index: 0, price: 120 }]);
});

test("fallback requests do not overlap and replies from a stopped generation are discarded", async (t) => {
  const f = fixture(t, ["BTC"]); const resolves = [];
  f.respond(() => new Promise((done) => resolves.push(done))); f.feed.start(); f.poll(); f.poll();
  assert.equal(f.requests.length, 1);
  f.feed.stop(); f.feed.start(); assert.equal(f.requests.length, 2);
  resolves[0]({ BTC: "100" }); await flush(); assert.equal(f.quotes.length, 0);
  resolves[1]({ BTC: "200" }); await flush(); assert.deepEqual(f.quotes, [{ index: 0, price: 200 }]);
  f.feed.stop(); assert.equal(f.feed.healthy(0), false);
});

test("stale, future and older WebSocket messages cannot refresh or replace a market", async (t) => {
  const f = fixture(t, ["BTC"]); f.feed.start(); await flush();
  f.emit("BTC", 50, 94_000); f.emit("BTC", 60, 103_000); f.emit("BTC", 70, 0);
  assert.equal(f.feed.healthy(0), false); assert.equal(f.quotes.length, 0);
  f.emit("BTC", 100); f.setTime(100_500); f.emit("BTC", 90, 99_999);
  assert.deepEqual(f.quotes, [{ index: 0, price: 100 }]);
});
