/**
 * Turns a dump of real settlements from the reference exchange (public on-chain data, collected read-only from
 * their public API) into the fixture the parity tests read: test/fixtures/reference-settlements.csv.
 *
 *   node tools/build-reference-fixture.mjs <dataset.json>
 *
 * Amounts are converted to this project's units: prices 8 decimals, USD 6 decimals. Rows whose
 * margin cannot be written in 6 decimals without loss are left out (USDC cannot hold them), as
 * are wallets, hashes and anything else that is not needed to check the arithmetic.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , source] = process.argv;
if (!source) throw new Error("usage: node tools/build-reference-fixture.mjs <dataset.json>");
const rows = JSON.parse(readFileSync(source, "utf8"));

const DUST = 10n ** 12n;
const towardZero = (v) => (v >= 0n ? v / DUST : -(-v / DUST));
const out = ["market,isLong,leverage,margin,entry,exit,kind,pnl,fee"];
let skipped = 0;
for (const t of rows) {
  const margin18 = BigInt(t.marginRaw);
  if (margin18 % DUST !== 0n) {
    skipped += 1;
    continue;
  }
  const tick = 100_000_000n / BigInt(t.priceScaleRaw);
  const kind = t.kind === "Liquidated" ? "bust" : "close";
  out.push(
    [
      t.symbol,
      t.isLong ? 1 : 0,
      t.leverage,
      margin18 / DUST,
      BigInt(t.entryPriceRaw) * tick,
      BigInt(t.exitPriceRaw) * tick,
      kind,
      towardZero(BigInt(t.adjustedPnlRaw)),
      BigInt(t.userPaidFeeRaw) / DUST,
    ].join(","),
  );
}
writeFileSync(new URL("../test/fixtures/reference-settlements.csv", import.meta.url), out.join("\n") + "\n");
console.log(`${out.length - 1} settlements written, ${skipped} left out for sub-micro margins`);
