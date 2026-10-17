import test from "node:test";
import assert from "node:assert/strict";
import { createOracleReference } from "../src/prices/hyperliquid.mjs";
import { createBook } from "../src/prices/book.mjs";

test("the oracle reference accepts a base URL or an info URL and fetches each dex", async () => {
  for (const apiUrl of ["https://venue.test", "https://venue.test/", "https://venue.test/info", "https://venue.test/info/"]) {
    const calls = [];
    const reference = createOracleReference({
      coins: ["BTC", "xyz:TSLA"], apiUrl, log: { warn() {} },
      fetchImpl: async (url, init) => {
        const { dex } = JSON.parse(init.body);
        calls.push(url);
        return { ok: true, json: async () => [{ universe: [{ name: dex ? "xyz:TSLA" : "BTC" }] }, [{ oraclePx: dex ? "250" : "80000" }]] };
      },
    });
    try {
      reference.start();
      await new Promise(setImmediate);
      assert.deepEqual(calls, ["https://venue.test/info", "https://venue.test/info"]);
      assert.equal(reference.get("BTC").price, 80000);
      assert.equal(reference.get("xyz:TSLA").price, 250);
    } finally { reference.stop(); }
  }
});

test("a fallback cannot fill an order with a print outside its pin window", async () => {
  const book = createBook([0]);
  const pin = Math.floor(Date.now() / 1000) - 30;
  book.add(0, { time: pin, prev: pin, price: 1n, conf: 0n, blob: "0x" });
  await assert.rejects(book.pinned(0, pin, 10, async () => ({ time: pin + 11, prev: pin - 1, price: 1n, conf: 0n, blob: "0x" })), /no usable price/);
});
