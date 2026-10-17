import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/lib/preview/feed.ts", import.meta.url))], bundle: true, format: "cjs", platform: "node", write: false, logLevel: "silent" });
function fixture(t) {
  const original = { fetch: globalThis.fetch, now: Date.now }, calls = [];
  let now = 100_000, fail = false, value = "100";
  Date.now = () => now;
  globalThis.fetch = async (_, options) => {
    calls.push(JSON.parse(options.body)); if (fail) throw Error("Offline");
    return { ok: true, json: async () => [{ universe: [{ name: "BTC" }, { name: "ETH" }] }, [{ prevDayPx: value }, { prevDayPx: "200" }]] };
  };
  t.after(() => { globalThis.fetch = original.fetch; Date.now = original.now; });
  const module = { exports: {} }; new Function("module", "exports", bundled.outputFiles[0].text)(module, module.exports);
  return { load: module.exports.loadDayOpen, calls, time: (v) => { now = v; }, fail: (v) => { fail = v; }, value: (v) => { value = v; } };
}
test("one daily-context request per dex is shared by its markets", async (t) => {
  const f = fixture(t); assert.deepEqual(await Promise.all([f.load("BTC"), f.load("ETH")]), [100, 200]); assert.equal(f.calls.length, 1);
});
test("daily references refresh after a minute rather than remaining fixed for the tab's lifetime", async (t) => {
  const f = fixture(t); assert.equal(await f.load("BTC"), 100); f.value("105"); f.time(159_999); assert.equal(await f.load("BTC"), 100);
  f.time(160_000); assert.equal(await f.load("BTC"), 105); assert.equal(f.calls.length, 2);
});
test("a failed initial or refresh request does not cache a permanent failure", async (t) => {
  const f = fixture(t); f.fail(true); await assert.rejects(f.load("BTC")); f.fail(false); assert.equal(await f.load("BTC"), 100);
  f.time(160_000); f.fail(true); await assert.rejects(f.load("BTC")); f.fail(false); f.value("110"); assert.equal(await f.load("BTC"), 110);
});
test("invalid daily reference values are never presented as a valid percentage baseline", async (t) => {
  const f = fixture(t);
  for (const [i, value] of ["Infinity", "NaN", "0", "-1"].entries()) { f.time(100_000 + i * 60_000); f.value(value); assert.equal(await f.load("BTC"), null); }
});
