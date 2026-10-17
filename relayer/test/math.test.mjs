/**
 * The site previews with shared/math.mjs and the keeper decides liquidations with it, so it has to
 * agree with src/libraries/PerpMath.sol to the last unit. test/Parity.t.sol writes a table of
 * inputs and the contract's own answers; this checks the JavaScript against every row.
 *
 *   forge test --match-contract ParityTest     (regenerates test/fixtures/math-vectors.csv)
 *   node --test relayer/test/math.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bustPrice, hasRoom, crossed, settle, quoteClose, impactNotionalFor, keepShare, sizeLevel, FEE_BPS, BPS, REFERENCE_NOTIONAL, MAX_IMPACT_NOTIONAL } from "../../shared/math.mjs";

const rows = readFileSync(new URL("../../test/fixtures/math-vectors.csv", import.meta.url), "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [entry, exit, margin, leverage, isLong, rateMultiplier, positionMultiplier, tick, bustBuffer, maxKeepBps, ahead, depth, bust, room, isCrossed, impactNotional, win, amount] =
      line.split(",");
    return {
      entry: BigInt(entry),
      exit: BigInt(exit),
      margin: BigInt(margin),
      leverage: Number(leverage),
      isLong: isLong === "1",
      // The market, as the relayer and the site hand it around.
      rateMultiplier: Number(rateMultiplier),
      positionMultiplier: Number(positionMultiplier),
      tick: Number(tick),
      bustBuffer,
      maxKeepBps: Number(maxKeepBps),
      // What was open on the side before the position, and the market's depth in dollars.
      ahead: BigInt(ahead),
      depth: Number(depth),
      impactNotional: BigInt(impactNotional),
      bust: BigInt(bust),
      room: room === "1",
      crossed: isCrossed === "1",
      win: win === "1",
      amount: BigInt(amount),
    };
  });
const show = (r) => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? `${v}` : v));

test("the fixture is not empty", () => {
  assert.ok(rows.length >= 300, `only ${rows.length} vectors`);
  assert.ok(rows.some((r) => r.win && r.amount > 0n), "no winning vector");
  assert.ok(rows.some((r) => !r.win && r.amount > 0n), "no losing vector");
  assert.ok(rows.some((r) => r.crossed), "no busted vector");
  assert.ok(rows.some((r) => !r.room), "no vector without room for a trigger");
  assert.ok(rows.some((r) => r.impactNotional === REFERENCE_NOTIONAL), "no vector at the reference price");
  assert.ok(rows.some((r) => r.impactNotional > REFERENCE_NOTIONAL && r.win && r.amount > 0n), "no winning vector charged for size");
  assert.ok(rows.some((r) => r.impactNotional === MAX_IMPACT_NOTIONAL), "no vector at the ceiling of the charge");
});

test("bustPrice matches the contract", () => {
  for (const r of rows) assert.equal(bustPrice(r.entry, r.leverage, r.isLong, r), r.bust, show(r));
});

test("hasRoom matches the contract", () => {
  for (const r of rows) assert.equal(hasRoom(r.entry, r.leverage, r), r.room, show(r));
});

test("crossed matches the contract", () => {
  for (const r of rows) assert.equal(crossed(r.exit, r.bust, r.isLong), r.crossed);
});

test("impactNotionalFor matches the contract", () => {
  for (const r of rows) assert.equal(impactNotionalFor(r.ahead, r.margin * BigInt(r.leverage), r.depth), r.impactNotional, show(r));
});

test("settle matches the contract", () => {
  for (const r of rows) {
    const got = settle(r.entry, r.exit, r.margin * BigInt(r.leverage), r.isLong, r, r.impactNotional);
    assert.equal(got.win, r.win, `win flag: ${show(r)}`);
    assert.equal(got.amount, r.amount, `amount: ${show(r)}`);
  }
});

test("quoteClose composes them the way the Exchange does", () => {
  for (const r of rows) {
    const { busted, pnl } = quoteClose({ entryPrice: r.entry, margin: r.margin, leverage: r.leverage, isLong: r.isLong, impactNotional: r.impactNotional }, r, r.exit);
    assert.equal(busted, r.crossed);
    if (r.crossed) assert.equal(pnl, -r.margin);
    else if (r.win) assert.equal(pnl, r.amount - (r.amount * FEE_BPS) / BPS);
    else assert.equal(pnl, -(r.amount < r.margin ? r.amount : r.margin));
  }
});

test("size costs nothing up to the depth, and more the fuller the side", () => {
  const depth = 500_000;
  const usd = (n) => BigInt(n) * 1_000_000n;
  // Anything whose middle sits inside the depth is charged on the reference.
  assert.equal(impactNotionalFor(0n, usd(10_000), depth), REFERENCE_NOTIONAL);
  assert.equal(impactNotionalFor(0n, usd(1_000_000), depth), REFERENCE_NOTIONAL);
  assert.equal(impactNotionalFor(usd(400_000), usd(200_000), depth), REFERENCE_NOTIONAL);
  // One dollar past it is not.
  assert.equal(impactNotionalFor(usd(400_000), usd(200_010), depth), REFERENCE_NOTIONAL + 1n);
  // The middle of the stretch decides: $5M on an empty side stands at $2.5M, five depths.
  assert.equal(impactNotionalFor(0n, usd(5_000_000), depth), 500_000n);
  assert.equal(sizeLevel(impactNotionalFor(0n, usd(5_000_000), depth)), 5);
  // The same $5M in ten pieces climbs the same stack: its pieces stand at 0.5, 1.5, ... 9.5 depths.
  let ahead = 0n;
  const levels = [];
  for (let i = 0; i < 10; i++) {
    levels.push(sizeLevel(impactNotionalFor(ahead, usd(500_000), depth)));
    ahead += usd(500_000);
  }
  assert.deepEqual(levels, [1, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5]);
  // A crowded side keeps less of a small move, and nearly as much of a large one.
  const btc = { rateMultiplier: 15000, positionMultiplier: 814598, maxKeepBps: 9000, tick: 10000000, bustBuffer: "476041580087574" };
  assert.ok(keepShare(10, btc, 1_000_000n) < keepShare(10, btc) * 0.6);
  assert.ok(keepShare(1_000, btc, 1_000_000n) > keepShare(1_000, btc) * 0.9);
  // A depth of one dollar runs into the ceiling instead of overflowing what the contract stores.
  assert.equal(impactNotionalFor(usd(60_000_000), usd(10_000_000), 1), MAX_IMPACT_NOTIONAL);
});

// Real settlements from the reference exchange (see test/ReferenceParity.t.sol, which holds the contract to
// the same file). The JavaScript has to reproduce them too, since the site previews with it.
const MARKETS = {
  BTC: { rateMultiplier: 15000, positionMultiplier: 814598, maxKeepBps: 9000, tick: 10000000, bustBuffer: "476041580087574" },
  ETH: { rateMultiplier: 15000, positionMultiplier: 483979, maxKeepBps: 9000, tick: 1000000, bustBuffer: "481304050180130" },
};

test("every real reference settlement comes out the same", () => {
  const lines = readFileSync(new URL("../../test/fixtures/reference-settlements.csv", import.meta.url), "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1);
  assert.ok(lines.length > 2000, `only ${lines.length} settlements`);
  for (const line of lines) {
    const [symbol, isLong, leverage, margin, entry, exit, kind, pnl, fee] = line.split(",");
    const market = MARKETS[symbol];
    const position = { entryPrice: BigInt(entry), margin: BigInt(margin), leverage: Number(leverage), isLong: isLong === "1" };
    if (kind === "bust") {
      const bust = bustPrice(position.entryPrice, position.leverage, position.isLong, market);
      assert.ok(crossed(BigInt(exit), bust, position.isLong), `their bust is not one here: ${line}`);
      assert.equal(BigInt(pnl), -position.margin, line);
      continue;
    }
    const r = settle(position.entryPrice, BigInt(exit), position.margin * BigInt(position.leverage), position.isLong, market);
    const ours = r.win ? r.amount : -(r.amount < position.margin ? r.amount : position.margin);
    assert.equal(ours, BigInt(pnl), line);
    // Their fee is cut from an 18-decimal figure, ours from the 6-decimal one.
    const ourFee = r.win ? (r.amount * FEE_BPS) / BPS : 0n;
    const gap = ourFee > BigInt(fee) ? ourFee - BigInt(fee) : BigInt(fee) - ourFee;
    assert.ok(gap <= 1n, `fee: ${line}`);
  }
});
