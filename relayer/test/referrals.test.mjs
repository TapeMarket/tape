/**
 * The referral books: who may be bound to whom, what a referrer earns, and what counts as paid.
 *
 *   node --test relayer/test/referrals.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createReferrals, referralMessage, ReferralRefused } from "../src/referrals.mjs";

const wallet = () => privateKeyToAccount(generatePrivateKey());
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function rig({ trades = {}, sessions = {}, names = {}, payer = null, head = 1000n, logs = [], sessionCheck, file = null } = {}) {
  const asked = [];
  const chain = {
    addresses: { usdc: USDC },
    publicClient: {
      verifyMessage: async () => false,
      getBlockNumber: async () => state.head,
      getLogs: async (query) => {
        asked.push(query);
        return state.logs.filter((l) => l.blockNumber >= query.fromBlock && l.blockNumber <= query.toBlock);
      },
    },
  };
  const state = { head, logs };
  const referrals = createReferrals({
    config: { chainId: 31337, root: ".", referralShareBps: 5000 },
    chain,
    log: { info() {}, warn() {} },
    tradesOf: (owner) => trades[owner.toLowerCase()] ?? 0,
    isSessionKey: sessionCheck ?? (async (owner, key) => sessions[owner.toLowerCase()]?.toLowerCase() === key.toLowerCase()),
    addressOfName: (name) => names[name],
    payer,
    file,
  });
  return { referrals, state, asked, trades, sessions };
}

const trade = (owner, fee, time = Math.floor(Date.now() / 1000) + 5) => ({ owner, fee, margin: 100_000000n, leverage: 10, time });
const refuses = (promise, status) => assert.rejects(promise, (error) => error instanceof ReferralRefused && error.status === status);

test("concurrent referral claims cannot replace the first confirmed referrer or form a two-wallet cycle", async () => {
  const [alice, bob, carol] = [wallet(), wallet(), wallet()];
  const { referrals } = rig();
  const bodies = await Promise.all([bob, carol].map(async referrer => ({ owner: alice.address, referrer: referrer.address, signature: await alice.signMessage({ message: referralMessage(alice.address, referrer.address) }) })));
  const attempts = await Promise.allSettled(bodies.map(body => referrals.bind(body)));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(attempts.find(result => result.status === "rejected").reason.status, 409);
  assert.equal(referrals.referrerOf(alice.address), bob.address);
  const cycle = rig().referrals;
  const cycleBodies = await Promise.all([[alice,bob],[bob,alice]].map(async ([owner,referrer]) => ({ owner: owner.address, referrer: referrer.address, signature: await owner.signMessage({ message: referralMessage(owner.address, referrer.address) }) })));
  const paired = await Promise.allSettled(cycleBodies.map(body => cycle.bind(body)));
  assert.equal(paired.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(paired.find(result => result.status === "rejected").reason.status, 422);
});

test("a wallet that trades while referral authentication is pending is no longer a newcomer", async () => {
  const [alice, bob, key] = [wallet(),wallet(),wallet()];
  let release;
  const { referrals, trades } = rig({ sessionCheck: () => new Promise(resolve => { release = resolve; }) });
  const pending = referrals.bind({ owner: bob.address, referrer: alice.address, signature: await key.signMessage({ message: referralMessage(bob.address,alice.address) }) });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  trades[bob.address.toLowerCase()] = 1;
  release(true);
  await refuses(pending,422);
  assert.equal(referrals.referrerOf(bob.address),null);
});

test("a failed persistent write never reports a binding saved or changes its in-memory owner", async t => {
  const dir = mkdtempSync(join(tmpdir(),"tape-referral-storage-"));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+"tape-referral-storage-"));rmSync(dir,{recursive:true}); });
  const blocked=join(dir,"blocked");writeFileSync(blocked,"not a directory");
  const [alice,bob]=[wallet(),wallet()];
  const {referrals}=rig({file:join(blocked,"referrals.json")});
  await refuses(referrals.bind({owner:bob.address,referrer:alice.address,signature:await bob.signMessage({message:referralMessage(bob.address,alice.address)})}),503);
  assert.equal(referrals.referrerOf(bob.address),null);
});

test("referral owners must be address strings, not coercible JSON values", async () => {
  const [alice,bob]=[wallet(),wallet()];const {referrals}=rig();
  const signature=await bob.signMessage({message:referralMessage(bob.address,alice.address)});
  for(const owner of [[bob.address],{},null]) await refuses(referrals.bind({owner,referrer:alice.address,signature}),400);
});

test("a newcomer is bound by its own signature, and its referrer earns a quarter of each fee", async () => {
  const [alice, bob] = [wallet(), wallet()];
  const { referrals } = rig();
  const signature = await bob.signMessage({ message: referralMessage(bob.address, alice.address) });
  assert.deepEqual(await referrals.bind({ owner: bob.address, referrer: alice.address, signature }), { ok: true, referrer: alice.address });
  assert.equal(referrals.referrerOf(bob.address), alice.address);

  referrals.onTrade(trade(bob.address, 2_000000n)); // a $2.00 fee: $1.00 is the team's, half of that is the referrer's
  referrals.onTrade(trade(bob.address, 1_000001n)); // odd amounts round down, never up
  const page = referrals.payload(alice.address);
  assert.equal(page.earned, 500000n + 250000n);
  assert.equal(page.shareOfFeeBps, 2500);
  assert.equal(page.referred.length, 1);
  assert.equal(page.referred[0].address, bob.address);
  assert.equal(page.referred[0].trades, 2);
  assert.equal(page.referred[0].fees, 3_000001n);
  assert.equal(page.referred[0].volume, 2_000_000000n);
  assert.equal(referrals.payload(bob.address).referrer, alice.address);
  assert.equal(referrals.payload(bob.address).earned, 0n);
});

test("the trading key may sign instead of the wallet, and nobody else may", async () => {
  const [alice, bob, key, stranger] = [wallet(), wallet(), wallet(), wallet()];
  const { referrals } = rig({ sessions: { [bob.address.toLowerCase()]: key.address } });
  const message = referralMessage(bob.address, alice.address);
  await refuses(referrals.bind({ owner: bob.address, referrer: alice.address, signature: await stranger.signMessage({ message }) }), 401);
  // A signature over another referrer's name is not one over this one's.
  await refuses(referrals.bind({ owner: bob.address, referrer: alice.address, signature: await key.signMessage({ message: referralMessage(bob.address, stranger.address) }) }), 401);
  assert.equal((await referrals.bind({ owner: bob.address, referrer: alice.address, signature: await key.signMessage({ message }) })).ok, true);
});

test("who cannot be bound: itself, twice, a wallet that already traded, two wallets to each other, nobody", async () => {
  const [alice, bob, carol] = [wallet(), wallet(), wallet()];
  const { referrals } = rig({ trades: { [carol.address.toLowerCase()]: 3 }, names: { alice_: alice.address.toLowerCase() } });
  const sign = (who, referrer) => who.signMessage({ message: referralMessage(who.address, referrer) });

  await refuses(referrals.bind({ owner: bob.address, referrer: bob.address, signature: await sign(bob, bob.address) }), 422);
  await refuses(referrals.bind({ owner: carol.address, referrer: alice.address, signature: await sign(carol, alice.address) }), 422);
  await refuses(referrals.bind({ owner: bob.address, referrer: "nobody_here", signature: "0x00" }), 404);
  await refuses(referrals.bind({ owner: "not an address", referrer: alice.address, signature: "0x00" }), 400);

  // By username.
  assert.equal((await referrals.bind({ owner: bob.address, referrer: "Alice_", signature: await sign(bob, "alice_") })).referrer, alice.address);
  await refuses(referrals.bind({ owner: bob.address, referrer: carol.address, signature: await sign(bob, carol.address) }), 409);
  await refuses(referrals.bind({ owner: alice.address, referrer: bob.address, signature: await sign(alice, bob.address) }), 422);
});

test("only trades after the binding count, and a trader nobody referred earns nobody anything", async () => {
  const [alice, bob, dave] = [wallet(), wallet(), wallet()];
  const { referrals } = rig();
  await referrals.bind({ owner: bob.address, referrer: alice.address, signature: await bob.signMessage({ message: referralMessage(bob.address, alice.address) }) });
  referrals.onTrade(trade(bob.address, 4_000000n, Math.floor(Date.now() / 1000) - 3600)); // closed before it was bound
  referrals.onTrade(trade(dave.address, 4_000000n));
  assert.equal(referrals.payload(alice.address).earned, 0n);
  referrals.onTrade(trade(bob.address, 4_000000n));
  assert.equal(referrals.payload(alice.address).earned, 1_000000n);
  assert.deepEqual(referrals.all().map((r) => [r.address, r.earned, r.referred]), [[alice.address, 1_000000n, 1]]);
});

test("USDC the payer sends a referrer is what has been paid: nothing before the first look, nothing sent to others", async () => {
  const [alice, bob, payer, other] = [wallet(), wallet(), wallet(), wallet()];
  const { referrals, state, asked } = rig({ payer: payer.address, head: 5000n });
  await referrals.bind({ owner: bob.address, referrer: alice.address, signature: await bob.signMessage({ message: referralMessage(bob.address, alice.address) }) });
  referrals.onTrade(trade(bob.address, 40_000000n)); // $10.00 earned

  state.logs.push({ blockNumber: 4990n, args: { to: alice.address, value: 9_000000n } }); // before anything was looked at: not a payout
  await referrals.lookForPayouts();
  assert.equal(referrals.payload(alice.address).paid, 0n);
  assert.equal(asked.length, 0, "the first look only marks where to start");

  state.head = 6200n;
  state.logs.push({ blockNumber: 5100n, args: { to: alice.address, value: 4_000000n } });
  state.logs.push({ blockNumber: 6100n, args: { to: other.address, value: 7_000000n } });
  state.logs.push({ blockNumber: 6150n, args: { to: alice.address, value: 2_500000n } });
  await referrals.lookForPayouts();
  assert.ok(asked.every((q) => q.address === USDC && q.args.from === payer.address && q.toBlock - q.fromBlock <= 500n));
  const page = referrals.payload(alice.address);
  assert.equal(page.paid, 6_500000n);
  assert.equal(page.owed, 3_500000n);

  // Looked at again with nothing new: nothing is counted twice.
  await referrals.lookForPayouts();
  assert.equal(referrals.payload(alice.address).paid, 6_500000n);
});
