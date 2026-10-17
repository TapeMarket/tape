import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeEventTopics, encodeAbiParameters } from "viem";
import { readAccountSnapshot, balanceSnapshot } from "../src/account-balance.mjs";
import { createIndexer, createStore } from "../src/indexer.mjs";

const owner = "0x1000000000000000000000000000000000000001";
const abi = JSON.parse(readFileSync(new URL("../../abi/Exchange.json", import.meta.url), "utf8"));
const cash = { balance: 17_299835n, queued: 0n, marginInUse: 0n, withdrawNonce: 1n };
test("collateral reads pin an uncached head and retain exact amounts and its block", async () => {
  const calls = [], chain = { addresses: { lens: owner }, abis: { lens: [] }, publicClient: {
    async getBlockNumber(options) { assert.equal(options.cacheTime, 0); return 33n; },
    async readContract(request) { calls.push(request); return cash; },
  } };
  const result = await readAccountSnapshot(chain, owner);
  assert.equal(result.blockNumber, 33n); assert.equal(calls[0].blockNumber, 33n);
  assert.deepEqual(balanceSnapshot(owner, result), { address: owner, blockNumber: 33n, balance: cash.balance, queued: 0n, marginInUse: 0n });
  await readAccountSnapshot(chain, owner, 0n); assert.equal(calls[1].blockNumber, 0n);
});

function fixture(t, reserved = 0n) {
  let head = 1n, fail = false;
  const events = [], reads = [], logs = [];
  const store = createStore();
  const chain = { addresses: { exchange: owner, lens: owner }, abis: { exchange: abi, lossMining: [], staking: [], lens: [] }, publicClient: {
    async getBlockNumber() { return head; }, async getLogs() { return logs; }, async getBlock() { return { timestamp: 100n }; },
    async readContract(request) { reads.push(request); if (fail === 'hang') return new Promise(() => {}); if (fail) throw Error("RPC unavailable"); return cash; },
  }, async read(_contract, name) { return name === "markets" ? [] : name === "house" ? {} : 0n; } };
  const indexer = createIndexer({ config: { deployment: { block: 1n }, pollMs: 60_000 }, chain, store, reservedOf: () => reserved, hub: { publish(topic, type, data) { events.push({ topic, type, data }); } }, log: { info() {}, warn() {} } });
  t.after(() => indexer.stop());
  const addClose = n => {
    const id = `0x${n.toString(16).padStart(64, "0")}`;
    const args = { id, owner, market: 0, kind: 0, exitPrice: 10n, pnl: -2_700165n, credited: cash.balance, queued: 0n, fee: 54003n };
    const event = abi.find(item => item.type === "event" && item.name === "PositionClosed");
    logs.push({ address: owner, blockNumber: head, transactionHash: `0x${"ab".repeat(32)}`, logIndex: n, topics: encodeEventTopics({ abi, eventName: "PositionClosed", args }), data: encodeAbiParameters(event.inputs.filter(i => !i.indexed), event.inputs.filter(i => !i.indexed).map(i => args[i.name])) });
  };
  return { indexer, events, reads, addClose, advance() { logs.length = 0; head++; }, fail(hang = false) { fail = hang ? 'hang' : true; } };
}
test("live closes carry one authoritative snapshot per wallet; historical replay does not add account RPCs", async t => {
  const f = fixture(t); f.addClose(1); await f.indexer.start(); assert.equal(f.reads.length, 0);
  f.events.length = 0; f.advance(); f.addClose(2); f.addClose(3); await f.indexer.tick();
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].blockNumber, 2n);
  const closes = f.events.filter(e => e.type === "closed"); assert.equal(closes.length, 2);
  for (const event of closes) assert.deepEqual(event.data.accountBalance, { address: owner, blockNumber: 2n, balance: cash.balance, queued: 0n, marginInUse: 0n, reserved: 0n });
  assert.ok(f.events.filter(e => e.type === "trade").every(e => !("accountBalance" in e.data)));
});
test("a snapshot RPC failure still delivers the actual close and preserves the refresh fallback", async t => {
  const f = fixture(t); await f.indexer.start(); f.advance(); f.addClose(4); f.fail(); await f.indexer.tick();
  assert.equal(f.events.filter(e => e.type === "closed").length, 1);
  assert.equal(f.events.find(e => e.type === "closed").data.accountBalance, undefined);
});

test("settlement balances retain funds reserved for other accepted orders", async t => {
  const f = fixture(t, 3_000000n); await f.indexer.start(); f.advance(); f.addClose(4); await f.indexer.tick();
  assert.equal(f.events.find(e => e.type === 'closed').data.accountBalance.reserved, 3_000000n);
});

test("a stalled snapshot is bounded and cannot hold up confirmed close notifications", async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t); await f.indexer.start(); f.advance(); f.addClose(5); f.fail(true);
  const pending = f.indexer.tick();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(1500); await pending;
  assert.equal(f.events.filter(e => e.type === 'closed').length, 1);
});
