import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const result = await build({ entryPoints: [fileURLToPath(new URL("../src/lib/store.ts", import.meta.url))], bundle: true, format: "cjs", platform: "node", write: false, external: ["react"], logLevel: "silent" });
function fixture(search = "") {
  const module = { exports: {} }, location = { pathname: "/docs", search }, scrolls = [];
  const history = { pushState(_, __, to) { const url = new URL(to, "https://tapemarket.io"); location.pathname = url.pathname; location.search = url.search; } };
  const document = { querySelector: () => ({ scrollTo: (...args) => scrolls.push(args) }) };
  new Function("module", "exports", "require", "location", "history", "document", result.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url), location, history, document);
  return { store: module.exports, location, scrolls };
}
test("moving to another page resets the scrolling container before the previous path is lost", () => {
  const f = fixture(); f.store.navigate("/trade");
  assert.deepEqual(f.scrolls, [[0, 0]]); assert.equal(f.store.getState().path, "/trade");
});
test("same-page query changes preserve scroll and update search; identical links do nothing", () => {
  const f = fixture(); f.store.navigate("/docs?section=fees"); f.store.navigate("/docs?section=fees");
  assert.deepEqual(f.scrolls, []); assert.equal(f.store.getState().search, "?section=fees");
});

test("legacy market shortcuts and portfolio tabs retain the original exchange across reloads", () => {
  const f = fixture("?legacy=1");
  f.store.navigate("/portfolio?tab=history");
  assert.equal(f.location.search, "?tab=history&legacy=1");
  f.store.navigate("/trade");
  assert.equal(f.location.search, "?legacy=1");
});

test("forced practice mode does not retain a legacy exchange flag through navigation", () => {
  const f = fixture("?preview=1&legacy=1");
  f.store.navigate("/trade?preview=1");
  assert.equal(f.location.search, "?preview=1");
});

test("second previous exchange remains selected across portfolio and market navigation", () => {
  const f = fixture("?legacy=2");
  f.store.navigate("/portfolio?tab=history");
  assert.equal(f.location.search, "?tab=history&legacy=2");
  f.store.navigate("/trade");
  assert.equal(f.location.search, "?legacy=2");
});
