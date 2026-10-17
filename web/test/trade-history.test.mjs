import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const built = await build({ entryPoints: [fileURLToPath(new URL("../src/lib/trade-history.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
const { filterTrades, tradesCsv } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const base = { id: "0x01", owner: "0x02", market: 0, isLong: true, leverage: 100, margin: "10000000", entryPrice: "8000000000000", entryTime: 1000, exitPrice: "8000012345678", pnl: "1", credited: "10000001", queued: "0", fee: "0", busted: false, time: 1002, tx: "0x03" };
const trades = [base, { ...base, id: "0x04", market: 1, pnl: "-1", busted: true }, { ...base, id: "0x05", pnl: "0" }];
test("market and outcome filters intersect, including zero and one-micro-USDC outcomes", () => {
  for (const [market, result, ids] of [["all", "all", ["0x01", "0x04", "0x05"]], ["0", "wins", ["0x01"]], ["0", "losses", []], ["all", "losses", ["0x04"]], ["all", "flat", ["0x05"]], ["1", "liquidated", ["0x04"]]]) {
    assert.deepEqual(filterTrades(trades, market, result).map((t) => t.id), ids);
  }
  assert.equal(trades.length, 3);
});
test("CSV preserves integer precision, negative fractions, null fields and UTC times", () => {
  const csv = tradesCsv([{ ...base, margin: "9007199254740993123456", pnl: "-1", entryPrice: null, entryTime: null, leverage: null, isLong: null }], [{ symbol: "BTC" }], true);
  assert.ok(csv.includes('"9007199254740993.123456","","80000.12345678","-0.000001"'));
  assert.ok(csv.includes('"1970-01-01T00:16:42.000Z"'));
  assert.ok(csv.includes('"Practice"')); assert.equal(csv.split("\r\n").length, 3);
});
test("CSV quotes punctuation and guards formula-like text without changing signed amounts", () => {
  const csv = tradesCsv([{ ...base, pnl: "-1000000" }], [{ symbol: '=HYPERLINK("x"),danger' }], false);
  assert.ok(csv.includes('"\'=HYPERLINK(""x""),danger"'));
  assert.ok(csv.includes('"-1.000000"')); assert.ok(csv.includes('"Live"'));
});
test("export covers every filtered loaded row, beyond a 25-row table page", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ ...base, id: `0x${i}` }));
  assert.equal(tradesCsv(filterTrades(rows, "0", "all"), [{ symbol: "BTC" }], true).split("\r\n").length, 42);
});
