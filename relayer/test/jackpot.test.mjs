import { test } from "node:test";
import assert from "node:assert/strict";
import { createJackpot } from "../src/jackpot.mjs";

const ALICE = "0x00000000000000000000000000000000000a11ce";
const ZERO = "0x0000000000000000000000000000000000000000";

function rig({ current = 100, cursor = 0, entries = {}, states = {}, fail, logs = [] } = {}) {
  const sent = [], announced = [], warnings = [];
  const state = { cursor, block: 100n };
  const chain = {
    addresses: { jackpot: ALICE }, abis: { jackpot: [] },
    publicClient: {
      getContractEvents: async () => logs,
      getBlock: async () => ({ number: state.block, timestamp: BigInt(current * 3600) }),
    },
    read: async (contract, name, args = []) => {
      if (name === "start") return 0n;
      if (name === "roundLength") return 3600n;
      if (name === "payoutBps") return 10000n;
      if (name === "nextRound") return BigInt(state.cursor);
      if (name === "rounds") return states[Number(args[0])] ?? [0n, false, ZERO, 0n];
      if (name === "tickets") return entries[Number(args[0])] ?? 0n;
      if (name === "pot") return 0n;
      throw new Error(`unexpected read ${name}`);
    },
  };
  const keeper = createJackpot({
    chain,
    queue: { push: async request => {
      sent.push(request);
      if (fail === request.functionName) return { ok: false, reason: "fixture rejection" };
      const round = Number(request.args[0]);
      assert.equal(round, state.cursor, "only the oldest unsettled round is serviced");
      if (request.functionName === "close" && !(entries[round] > 0n)) {
        states[round] = [0n, true, ZERO, 0n];
        state.cursor++;
      } else if (request.functionName === "close") states[round] = [state.block + 5n, false, ZERO, 10n];
      else {
        states[round] = [states[round][0], true, ALICE, 10n];
        state.cursor++;
      }
      return { ok: true };
    } },
    hub: { publish: (...args) => announced.push(args) },
    log: { warn: message => warnings.push(message), info() {} },
  });
  return { keeper, state, sent, announced, warnings };
}

test("keeper catches up from the on-chain cursor beyond 48 hours, with a bounded batch of empty rounds", async t => {
  const r = rig();
  t.after(() => r.keeper.stop());
  await r.keeper.start();
  assert.deepEqual(r.sent.map(tx => [tx.functionName, Number(tx.args[0])]), Array.from({ length: 8 }, (_, i) => ["close", i]));
  assert.equal(r.state.cursor, 8);
  assert.equal(r.announced.length, 0, "empty settlements are not advertised as winners");
  assert.deepEqual(r.warnings, []);
});

test("keeper closes the earliest populated round and waits for its future hash", async t => {
  const r = rig({ cursor: 2, entries: { 2: 100n } });
  t.after(() => r.keeper.stop());
  await r.keeper.start();
  assert.deepEqual(r.sent.map(tx => [tx.functionName, tx.args[0]]), [["close", 2n]]);
  assert.equal(r.state.cursor, 2);
  assert.deepEqual(r.warnings, []);
});

test("keeper finalizes a ready round even when prize delivery is still pending", async t => {
  const r = rig({ current: 3, cursor: 2, entries: { 2: 100n }, states: { 2: [90n, false, ZERO, 10n] } });
  t.after(() => r.keeper.stop());
  await r.keeper.start();
  assert.deepEqual(r.sent.map(tx => tx.functionName), ["draw"]);
  assert.equal(r.state.cursor, 3);
  assert.equal(r.announced.length, 1);
  const payload = await r.keeper.payload(null);
  assert.equal(payload.winners[0].winner, ALICE);
  assert.equal(payload.winners[0].prize, 10n);
});

test("failed close and expired hash never let newer rounds bypass the oldest", async t => {
  const failed = rig({ fail: "close" });
  const expired = rig({ current: 3, entries: { 0: 100n }, states: { 0: [1n, false, ZERO, 10n] } });
  expired.state.block = 300n;
  t.after(() => { failed.keeper.stop(); expired.keeper.stop(); });
  await failed.keeper.start();
  await expired.keeper.start();
  assert.equal(failed.sent.length, 1);
  assert.equal(failed.state.cursor, 0);
  assert.equal(failed.warnings.length, 1);
  assert.deepEqual(expired.sent.map(tx => [tx.functionName, tx.args[0]]), [["close", 0n]]);
});

test("winner history excludes empty settlements and repeated starts do not duplicate work", async t => {
  const r = rig({ current: 0, logs: [
    { args: { round: 1n, winner: ALICE, prize: 10n, tickets: 100n } },
    { args: { round: 2n, winner: ZERO, prize: 0n, tickets: 0n } },
  ] });
  t.after(() => r.keeper.stop());
  const first = r.keeper.start();
  assert.equal(r.keeper.start(), undefined);
  await first;
  const payload = await r.keeper.payload(null);
  assert.equal(payload.winners.length, 1);
  assert.equal(payload.winners[0].winner, ALICE);
  assert.equal(r.sent.length, 0);
});
