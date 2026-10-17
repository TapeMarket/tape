/**
 * The preview's books against the real contracts.
 *
 * `forge test --match-contract PreviewParity` plays a long random trading session through the
 * Exchange, Staking, LossMining and Sweeper contracts and writes every balance after every step to
 * test/fixtures/preview-scenario.jsonl. This replays the same session through the JavaScript books
 * the preview site runs on (web/src/lib/preview/books.ts) and requires every figure to be
 * identical after every step: balances, queued winnings, house cash, fees, margin, the coin in
 * each wallet, each stake, each claimable reward, and where the staking stream stands.
 *
 *   node web/test/books.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "books-"));
const bundle = join(scratch, "books.mjs");
await build({
  entryPoints: [join(root, "web/src/lib/preview/books.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
  alias: { "@shared": join(root, "shared") },
  logLevel: "silent",
});
const { createBooks, emptyBooks } = await import(pathToFileURL(bundle).href);
rmSync(scratch, { recursive: true, force: true });

const steps = readFileSync(join(root, "test/fixtures/preview-scenario.jsonl"), "utf8")
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));
const params = steps.shift();
assert.equal(params.op, "params");

const users = ["0xA11CE", "0xB0B", "0xCA201"];
const state = emptyBooks(params.markets.length, BigInt(params.reserve));
// The books' clock, in seconds. Every step carries the block time it happened at.
let clock = 0;
const books = createBooks(
  state,
  { stakerCap: BigInt(params.stakerCap), miningScale: BigInt(params.miningScale), autoHarvest: params.autoHarvest, markets: params.markets },
  () => clock,
);

/** Every position ever opened, by the order it was opened in: how the session refers to them. */
const opened = [];
const seen = { open: 0, charged: 0, chargedWin: 0, win: 0, loss: 0, bust: 0, queuedWin: 0, queueFunded: 0, feeTaken: 0, push: 0, sweep: 0, sweepHeldBack: 0, wait: 0, claim: 0, mined: 0 };

function apply(step, n) {
  switch (step.op) {
    case "deposit":
      books.credit(users[step.u], BigInt(step.amount));
      break;
    case "donate":
      books.donate(BigInt(step.amount));
      break;
    case "open": {
      const position = books.open(
        { id: String(opened.length), owner: users[step.u], market: step.m, isLong: step.long, leverage: step.lev, margin: BigInt(step.margin), entryPrice: BigInt(step.price), entryTime: clock },
        step.useQueued,
      );
      // What the position is charged on for its size is fixed here, and has to be the contract's.
      assert.equal(position.impactNotional, BigInt(step.charge), `step ${n}: what the position is charged on`);
      if (position.impactNotional > 100_000n) seen.charged += 1;
      opened.push(position);
      seen.open += 1;
      if (position.debtMargin > 0n) seen.queueFunded += 1;
      break;
    }
    case "price": {
      const price = BigInt(step.price);
      // Which positions this price busts is the books' own call, and it has to be the contract's.
      const busts = [];
      opened.forEach((position, i) => {
        if (position.market === step.m && state.positions.includes(position) && books.isBusted(position, price)) busts.push(i);
      });
      assert.deepEqual(busts, step.liq, `step ${n}: which positions bust at ${step.price}`);
      for (const i of step.liq) {
        const result = books.settlePosition(opened[i], price, true);
        assert.equal(result.busted, true);
        assert.equal(result.pnl, -opened[i].margin, "a bust forfeits the whole margin");
        seen.bust += 1;
        if (result.mined > 0n) seen.mined += 1;
      }
      break;
    }
    case "close": {
      const result = books.settlePosition(opened[step.i], BigInt(step.price), false);
      assert.equal(result.busted, false, `step ${n}: a close inside the bust price is not a bust`);
      if (result.pnl > 0n) seen.win += 1;
      else seen.loss += 1;
      if (result.pnl > 0n && opened[step.i].impactNotional > 100_000n) seen.chargedWin += 1;
      if (result.queued > 0n) seen.queuedWin += 1;
      if (result.fee > 0n) seen.feeTaken += 1;
      if (result.mined > 0n) seen.mined += 1;
      break;
    }
    case "harvest":
      books.harvest(step.n);
      break;
    case "push":
      assert.ok(books.pushStakerFees() > 0n, `step ${n}: there were fees to push`);
      seen.push += 1;
      break;
    case "sweep": {
      // How much the open positions hold back is the books' own sum, and it has to be the sweeper's.
      const excess = books.lpExcess();
      const moved = books.sweep(step.prices.map(BigInt));
      assert.equal(moved, BigInt(step.moved), `step ${n}: what the sweep sent to stakers`);
      if (moved > 0n) seen.sweep += 1;
      if (moved < excess) seen.sweepHeldBack += 1;
      break;
    }
    case "wait":
      seen.wait += 1;
      break;
    case "stake":
      books.stake(users[step.u], BigInt(step.amount));
      break;
    case "unstake":
      books.unstake(users[step.u], BigInt(step.amount));
      break;
    case "claim":
      assert.ok(books.claim(users[step.u]) > 0n);
      seen.claim += 1;
      break;
    default:
      throw new Error(`unknown step ${step.op}`);
  }
}

const perUser = (read) => users.map((user) => read(user).toString());
const key = (user) => user.toLowerCase();

function snapshot() {
  return {
    b: perUser(books.balanceOf),
    q: perUser(books.queuedOf),
    lp: state.lpCash.toString(),
    tq: state.totalQueued.toString(),
    sf: state.stakerFees.toString(),
    df: state.devFees.toString(),
    dm: state.debtMarginOpen.toString(),
    cm: state.totalCashMargin.toString(),
    tr: books.treasury().toString(),
    sz: state.size.flat().map(String),
    c: perUser((user) => state.coin.wallet[key(user)] ?? 0n),
    s: perUser((user) => state.coin.staked[key(user)] ?? 0n),
    p: perUser(books.pendingReward),
    res: state.coin.reserve.toString(),
    cl: state.coin.cumulativeLossUsd.toString(),
    un: books.unstreamed().toString(),
    wt: state.coin.waiting.toString(),
    rr: state.coin.rewardRate.toString(),
    rc: state.coin.received.toString(),
    ts: state.coin.totalStaked.toString(),
  };
}

const LABELS = {
  b: "trading balances",
  q: "queued winnings",
  lp: "house cash",
  tq: "total queued",
  sf: "fees owed to stakers",
  df: "fees owed to the developer",
  dm: "queue-funded margin in open positions",
  cm: "cash margin in open positions",
  tr: "everything the exchange holds",
  sz: "open size per market and side",
  c: "coin in wallets",
  s: "coin staked",
  p: "claimable staking rewards",
  res: "coin left to mine",
  cl: "cumulative losses",
  un: "USDC still to be streamed to stakers",
  wt: "USDC waiting for a first staker",
  rr: "the stream's rate",
  rc: "USDC staking has received",
  ts: "total coin staked",
};

steps.forEach((step, n) => {
  clock = step.t;
  apply(step, n);
  const got = snapshot();
  for (const field of Object.keys(LABELS)) {
    assert.deepEqual(got[field], step[field], `after step ${n} (${step.op}): ${LABELS[field]}\n  contract: ${JSON.stringify(step[field])}\n  preview:  ${JSON.stringify(got[field])}`);
  }
  // And the books have to add up on their own terms after every step.
  assert.deepEqual(books.audit(0n), [], `after step ${n} (${step.op}): the books do not add up`);
});

for (const [what, count] of Object.entries(seen)) assert.ok(count > 0, `the session never exercised: ${what}`);
console.log(
  `ok: ${steps.length} steps, every one of ${Object.keys(LABELS).length} figures identical to the contracts after each\n` +
    `    ${seen.open} opens (${seen.queueFunded} with queue-funded margin, ${seen.charged} charged for size), ${seen.win} wins (${seen.queuedWin} queued, ${seen.chargedWin} charged for size),\n` +
    `    ${seen.loss} losses, ${seen.bust} busts,\n` +
    `    ${seen.feeTaken} closes that paid a fee, ${seen.push} fee payments to stakers, ${seen.sweep} sweeps of house cash above the cap\n` +
    `    (${seen.sweepHeldBack} held something back for open positions), ${seen.claim} claims, ${seen.mined} losses paid in coin`,
);
