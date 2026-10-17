/**
 * End-to-end smoke test against a running relayer and a local chain (script/DevDeploy.s.sol).
 *
 * Plays one trader through the whole product the way the site does: sign in with a session key,
 * deposit with a permit, open, watch the fill, close, open past a market's depth and be charged for
 * the size, get busted at 1000x, receive the coin, stake it, collect the stakers' share, withdraw.
 *
 * It can be run again and again on the same chain. Each run leaves the trader with less USDC and
 * leaves winners waiting in the house's queue, so a run first tops the trader up and pays off
 * whoever an earlier run left waiting (possible because a local chain's USDC can be minted by
 * anyone), and then starts as it would on a new exchange.
 *
 *   node test/smoke.mjs [relayer-url]
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseSignature } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { domain as buildDomain, sessionDomain, types, permitTypes } from "../../shared/eip712.mjs";
import { quoteClose, bustPrice, impactNotionalFor, REFERENCE_NOTIONAL } from "../../shared/math.mjs";

const API = process.argv[2] ?? "http://127.0.0.1:8787";
const RPC = process.argv[3] ?? "http://127.0.0.1:8545";
const abi = (name) => JSON.parse(readFileSync(new URL(`../../abi/${name}.json`, import.meta.url), "utf8"));
// anvil account 2.
const trader = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const session = privateKeyToAccount(generatePrivateKey());

const get = async (path) => {
  const res = await fetch(`${API}${path}`);
  const json = await res.json();
  if (!res.ok) throw new Error(`GET ${path}: ${json.error}`);
  return json;
};
const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)) });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status });
  return json;
};
const usd = (v) => (Number(v) / 1e6).toFixed(2);
const px = (v) => (Number(v) / 1e8).toFixed(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name) => console.log(`\n== ${name}`);

async function waitIntent(id, want, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const intent = await get(`/intent/${id}`);
    if (intent.status === "failed") throw new Error(`intent failed: ${intent.error}`);
    if (want.includes(intent.status)) return intent;
    if (Date.now() > until) throw new Error(`intent stuck at ${intent.status}`);
    await sleep(150);
  }
}

const config = await get("/config");
const domain = buildDomain(config.name, config.chainId, config.addresses.exchange);
const offset = config.time - Date.now();
const now = () => Math.floor((Date.now() + offset) / 1000);
// Orders are stamped the way the site stamps them: never with a second that has already passed.
const stamp = () => BigInt(Math.floor((Date.now() + offset) / 1000 + 0.25));
const btc = config.markets.find((m) => m.symbol === "BTC");
const eth = config.markets.find((m) => m.symbol === "ETH");
const rpc = createPublicClient({ chain: foundry, transport: http(RPC) });
const wallet = createWalletClient({ account: trader, chain: foundry, transport: http(RPC) });
console.log(`relayer ${API}: ${config.name} on chain ${config.chainId}, prices from ${config.priceSource}, BTC ${px(btc.price ?? 0)}`);

// A chain this has run on before: put back what the steps below take for granted.
{
  const usdcAbi = [
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  ];
  const usdc = { address: config.addresses.usdc, abi: usdcAbi };
  const exchange = { address: config.addresses.exchange, abi: abi("Exchange") };
  const send = async (call) => rpc.waitForTransactionReceipt({ hash: await wallet.writeContract(call) });
  // What the run deposits, with room to spare.
  const wanted = 60_000_000000n;
  const has = await rpc.readContract({ ...usdc, functionName: "balanceOf", args: [trader.address] });
  // Winners an earlier run left waiting, less whatever cash the house already has for them. Asked of
  // the chain itself: the relayer's copy is a moment behind.
  const [queued, cash] = await Promise.all([rpc.readContract({ ...exchange, functionName: "totalQueued" }), rpc.readContract({ ...exchange, functionName: "lpCash" })]);
  const owed = queued > cash ? queued - cash : 0n;
  const short = (wanted > has ? wanted - has : 0n) + owed;
  if (short > 0n) {
    step("a chain that has been used before is put back in order");
    await send({ ...usdc, functionName: "mint", args: [trader.address, short] });
    if (wanted > has) console.log(`the trader was down to ${usd(has)} USDC: topped up to ${usd(wanted)}`);
  }
  if (owed > 0n) {
    // Money given to the house is nobody's but the house's, and the queue is the first thing it pays.
    await send({ ...usdc, functionName: "approve", args: [config.addresses.exchange, owed] });
    await send({ ...exchange, functionName: "donate", args: [owed] });
    for (const until = Date.now() + 30_000; ; ) {
      await send({ ...exchange, functionName: "harvest", args: [100n] });
      if ((await rpc.readContract({ ...exchange, functionName: "totalQueued" })) === 0n) break;
      if (Date.now() > until) throw new Error("the queue an earlier run left could not be paid off");
    }
    // The relayer learns of it from the chain a moment later.
    for (const until = Date.now() + 15_000; Date.now() < until && BigInt((await get("/house")).house.totalQueued) !== 0n; ) await sleep(300);
    console.log(`earlier winners were still owed ${usd(owed)}: the house was given it and paid them, so nobody is waiting`);
  }
}

step("session key: one wallet signature, then no more popups");
let account = await get(`/account/${trader.address}`);
const validUntil = now() + 30 * 86_400;
const registered = await post("/session", {
  owner: trader.address,
  key: session.address,
  validUntil,
  signature: await trader.signTypedData({
    domain: sessionDomain(config.name, config.chainId, config.addresses.sessions),
    types,
    primaryType: "SessionKey",
    message: { owner: trader.address, key: session.address, validUntil: BigInt(validUntil), nonce: BigInt(account.sessionNonce) },
  }),
});
console.log(`registered ${session.address}; it starts signing in ${registered.validFrom - now()}s`);

// Until then the key signs nothing: an order stamped before its start is refused.
{
  const message = { owner: trader.address, market: btc.id, isLong: true, useQueued: false, leverage: 10, margin: 10_000000n, priceLimit: 0n, impactLimit: 0, timestamp: stamp(), salt: 1n };
  const signature = await session.signTypedData({ domain, types, primaryType: "Open", message });
  await assert.rejects(post("/open", { intent: message, signature }), /switching on/);
  console.log("an order signed before the key's start is refused");
}

step("a referral: the trading key says who sent this wallet, with no wallet popup");
// A wallet is bound once, and only before it has traded: on a chain an earlier run has used, this
// trader has its answer already, and the checks at the end use whoever it was bound to then.
const referralText = (owner, code) => `Tape: ${owner} was referred by ${String(code).toLowerCase()}`;
let referrer = (await get(`/account/${trader.address}`)).referrer;
if (!referrer && account.stats.trades === 0) {
  const sent = privateKeyToAccount(generatePrivateKey()).address;
  // Somebody else's key cannot bind this wallet, and the wallet cannot refer itself.
  const stranger = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(post("/referral", { owner: trader.address, referrer: sent, signature: await stranger.signMessage({ message: referralText(trader.address, sent) }) }), /Not signed/);
  await assert.rejects(post("/referral", { owner: trader.address, referrer: trader.address, signature: await trader.signMessage({ message: referralText(trader.address, trader.address) }) }), /cannot refer itself/);
  while (now() < registered.validFrom) await sleep(250);
  const bound = await post("/referral", { owner: trader.address, referrer: sent, signature: await session.signMessage({ message: referralText(trader.address, sent) }) });
  assert.equal(bound.referrer, sent);
  referrer = (await get(`/account/${trader.address}`)).referrer;
  assert.equal(referrer, sent, "the account says who referred it");
  // Once, for good.
  await assert.rejects(post("/referral", { owner: trader.address, referrer: stranger.address, signature: await session.signMessage({ message: referralText(trader.address, stranger.address) }) }), /already has a referrer/);
  console.log(`bound to ${sent} by the trading key; a stranger's signature, the wallet's own link and a second referrer are refused`);
} else {
  console.log(referrer ? `this trader was bound to ${referrer} by an earlier run` : "this trader traded on this chain before referrals: it stays unreferred");
}

step("deposit with a USDC permit: the trader spends no ETH");
const depositAmount = 45_000_000000n;
const deadline = BigInt(now() + 3600);
const permit = parseSignature(
  await trader.signTypedData({
    domain: { name: config.usdcPermit.name, version: config.usdcPermit.version, chainId: config.chainId, verifyingContract: config.addresses.usdc },
    types: permitTypes,
    primaryType: "Permit",
    message: { owner: trader.address, spender: config.addresses.gateway, value: depositAmount, nonce: BigInt(account.wallet.usdcNonce), deadline },
  }),
);
const before = BigInt(account.balance);
await post("/deposit", { owner: trader.address, amount: depositAmount, deadline, v: Number(permit.v ?? 27n + BigInt(permit.yParity)), r: permit.r, s: permit.s });
account = await get(`/account/${trader.address}`);
assert.equal(BigInt(account.balance) - before, depositAmount);
console.log(`balance ${usd(account.balance)}`);

step("deposit by a plain transfer to the wallet's own deposit address: no permit, no approval");
if (config.addresses.deposits) {
  const box = await get(`/deposit-address/${trader.address}`);
  assert.ok(/^0x[0-9a-fA-F]{40}$/.test(box.address), "the wallet has a deposit address");
  assert.equal((await get(`/deposit-address/${trader.address}`)).address, box.address, "and it is the same every time");
  const sent = 1_000_000000n;
  const balanceBefore = BigInt((await get(`/account/${trader.address}`)).balance);
  const hash = await wallet.writeContract({
    address: config.addresses.usdc,
    abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
    functionName: "transfer",
    args: [box.address, sent],
  });
  await rpc.waitForTransactionReceipt({ hash });
  // The relayer watches the address of a wallet that was asked about, and collects what arrives.
  let credited = 0n;
  for (const until = Date.now() + 40_000; Date.now() < until && credited < sent; ) {
    await sleep(700);
    await get(`/deposit-address/${trader.address}`);
    credited = BigInt((await get(`/account/${trader.address}`)).balance) - balanceBefore;
  }
  assert.equal(credited, sent, "the transfer became the wallet's balance, to the cent");
  // Asked of the chain itself: the relayer's answer is a second or two old.
  assert.equal(await rpc.readContract({ address: config.addresses.deposits, abi: abi("Deposits"), functionName: "pending", args: [trader.address] }), 0n, "and nothing is left at the address");
  console.log(`sent ${usd(sent)} to ${box.address}; balance ${usd(balanceBefore + credited)}`);
} else console.log("this deployment has no Deposits contract: skipped");

// The deposits above took a block or two; wait out whatever is left of the key's first slot.
while (now() < registered.validFrom) await sleep(250);

async function open({ isLong, margin, leverage, market = btc, impactLimit = 0 }) {
  const message = { owner: trader.address, market: market.id, isLong, useQueued: false, leverage, margin, priceLimit: 0n, impactLimit, timestamp: stamp(), salt: BigInt(Math.floor(Math.random() * 2 ** 48)) };
  const signature = await session.signTypedData({ domain, types, primaryType: "Open", message });
  const sent = Date.now();
  const accepted = await post("/open", { intent: message, signature });
  const acceptedMs = Date.now() - sent;
  const filled = await waitIntent(accepted.id, ["filled", "confirmed"]);
  console.log(`${isLong ? "long" : "short"} ${usd(margin)} x${leverage}: accepted in ${acceptedMs}ms, filled at ${px(filled.fill.price)} after ${((Date.now() - sent) / 1000).toFixed(1)}s`);
  return { id: accepted.id, message, entry: BigInt(filled.fill.price) };
}

async function close(id) {
  const message = { owner: trader.address, positionId: id, timestamp: stamp() };
  const signature = await session.signTypedData({ domain, types, primaryType: "Close", message });
  const accepted = await post("/close", { intent: message, signature });
  return waitIntent(accepted.id, ["confirmed"]);
}

step("open, see the fill before the block, close");
const first = await open({ isLong: true, margin: 100_000000n, leverage: 20 });
await waitIntent(first.id, ["confirmed"]);
account = await get(`/account/${trader.address}`);
const position = account.positions.find((p) => p.id === first.id);
assert.ok(position, "position is listed");
assert.equal(position.status, "open");
assert.equal(BigInt(position.bust), bustPrice(first.entry, 20, true, btc));
// $2,000 on a side nowhere near its depth: charged on the reference, as the reference exchange charges everyone.
assert.equal(BigInt(position.impactNotional), REFERENCE_NOTIONAL);
console.log(`on-chain, bust at ${px(position.bust)}`);

await sleep(1500);
const balanceBeforeClose = BigInt((await get(`/account/${trader.address}`)).balance);
const closed = await close(first.id);
const expected = quoteClose({ entryPrice: first.entry, margin: 100_000000n, leverage: 20, isLong: true, impactNotional: position.impactNotional }, btc, BigInt(closed.fill.price));
assert.equal(BigInt(closed.fill.pnl), expected.pnl, "the relayer's quote matches the shared math");
await sleep(400);
account = await get(`/account/${trader.address}`);
// A win may be queued (the house starts empty); a loss or flat settles in full at once.
const settled = BigInt(account.balance) - balanceBeforeClose + (expected.pnl > 0n ? BigInt(account.queued) : 0n);
console.log(`closed at ${px(closed.fill.price)}, pnl ${usd(expected.pnl)}, balance ${usd(account.balance)}, queued ${usd(account.queued)}`);
assert.ok(settled >= 100_000000n + (expected.pnl < 0n ? expected.pnl : 0n) - 1n, "margin came back with the result");

step("take-profit and stop-loss: signed once, held by the relayer, closed on-chain when touched");
{
  const tpsl = await open({ isLong: true, margin: 100_000000n, leverage: 20 });
  await waitIntent(tpsl.id, ["confirmed"]);
  const trigger = async (price, above) => {
    const message = { owner: trader.address, positionId: tpsl.id, price, above, timestamp: stamp() };
    return post("/trigger", { intent: message, signature: await session.signTypedData({ domain, types, primaryType: "Trigger", message }) });
  };
  const tp = tpsl.entry + (tpsl.entry * 10n) / 10_000n;
  const sl = tpsl.entry - (tpsl.entry * 30n) / 10_000n;
  await trigger(tp, true);
  await trigger(sl, false);
  let held = (await get(`/account/${trader.address}`)).positions.find((p) => p.id === tpsl.id);
  assert.equal(BigInt(held.takeProfit), tp);
  assert.equal(BigInt(held.stopLoss), sl);
  console.log(`take-profit ${px(tp)}, stop-loss ${px(sl)}, entry ${px(tpsl.entry)}`);

  // A stop past the liquidation price, a stop on the wrong side, and a stranger's signature: refused.
  await assert.rejects(trigger(BigInt(held.bust) - 1n, false), /liquidation price/);
  await assert.rejects(trigger(tpsl.entry + (tpsl.entry * 50n) / 10_000n, false), /already past/);
  {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const message = { owner: trader.address, positionId: tpsl.id, price: sl, above: false, timestamp: stamp() };
    await assert.rejects(post("/trigger", { intent: message, signature: await stranger.signTypedData({ domain, types, primaryType: "Trigger", message }) }), /session keys/);
  }

  // Taking the stop off again.
  {
    const message = { owner: trader.address, positionId: tpsl.id, above: false, timestamp: stamp() };
    await post("/trigger/cancel", { intent: message, signature: await session.signTypedData({ domain, types, primaryType: "CancelTrigger", message }) });
    held = (await get(`/account/${trader.address}`)).positions.find((p) => p.id === tpsl.id);
    assert.equal(held.stopLoss, null);
    assert.equal(BigInt(held.takeProfit), tp);
    console.log("stop-loss removed; take-profit kept");
  }

  // Up 15 bps: past the take-profit. The relayer closes it on-chain at the first price two seconds later.
  await post("/dev/nudge", { market: btc.id, bps: 15 });
  let hit = null;
  for (const until = Date.now() + 40_000; Date.now() < until && !hit; ) {
    await sleep(500);
    hit = (await get(`/history/${trader.address}?limit=10`)).trades.find((t) => t.id === tpsl.id);
  }
  await post("/dev/nudge", { market: btc.id, bps: 0 });
  assert.ok(hit, "the take-profit closed the position");
  assert.ok(!hit.busted);
  assert.ok(BigInt(hit.exitPrice) >= tp, "closed at or past the take-profit");
  console.log(`closed by its take-profit at ${px(hit.exitPrice)}, pnl ${usd(hit.pnl)}`);
}

step("policy: a stale timestamp is refused");
{
  const message = { owner: trader.address, market: btc.id, isLong: true, useQueued: false, leverage: 10, margin: 10_000000n, priceLimit: 0n, impactLimit: 0, timestamp: BigInt(now() - 30), salt: 7n };
  const signature = await session.signTypedData({ domain, types, primaryType: "Open", message });
  await assert.rejects(post("/open", { intent: message, signature }), /timestamp/);
  console.log("refused");
}

step("policy: a stranger's signature is refused");
{
  const stranger = privateKeyToAccount(generatePrivateKey());
  const message = { owner: trader.address, market: btc.id, isLong: true, useQueued: false, leverage: 10, margin: 10_000000n, priceLimit: 0n, impactLimit: 0, timestamp: stamp(), salt: 8n };
  const signature = await stranger.signTypedData({ domain, types, primaryType: "Open", message });
  await assert.rejects(post("/open", { intent: message, signature }), /session keys/);
  console.log("refused");
}

step("1000x both ways: one side busts as soon as the price moves 5 bps");
const coinBefore = BigInt((await get(`/account/${trader.address}`)).coin.wallet);
const long = await open({ isLong: true, margin: 250_000000n, leverage: 1000 });
const short = await open({ isLong: false, margin: 250_000000n, leverage: 1000 });
await Promise.all([waitIntent(long.id, ["confirmed"]), waitIntent(short.id, ["confirmed"])]);
console.log(`long busts at ${px(bustPrice(long.entry, 1000, true, btc))}, short at ${px(bustPrice(short.entry, 1000, false, btc))}; pushing the price up 12 bps`);
await post("/dev/nudge", { market: btc.id, bps: 12 });
let busted = null;
for (const until = Date.now() + 30_000; Date.now() < until && !busted; ) {
  await sleep(500);
  const history = await get(`/history/${trader.address}?limit=5`);
  busted = history.trades.find((t) => t.id === short.id && t.busted);
}
assert.ok(busted, "the short was busted");
assert.equal(BigInt(busted.pnl), -250_000000n);
console.log(`short busted at ${px(busted.exitPrice)}: margin ${usd(-BigInt(busted.pnl))} forfeited`);
account = await get(`/account/${trader.address}`);
for (const p of account.positions) await close(p.id).catch((e) => console.log(`close ${p.id.slice(0, 10)}: ${e.message}`));

step("the loss mined coin, straight into the wallet");
const coinInfo = await get("/coin");
account = await get(`/account/${trader.address}`);
const minedNow = BigInt(account.coin.wallet) - coinBefore;
assert.ok(minedNow > 0n, "coin arrived with the loss");
console.log(`${(Number(minedNow) / 1e18).toFixed(2)} ${coinInfo.symbol} for $250 lost; wallet holds ${(Number(account.coin.wallet) / 1e18).toFixed(2)}`);

// On a brand-new exchange the house starts empty: the winning side of that pair was paid in part
// and queued for the rest, and no fee is taken from a loss while anyone is queued (the next loss
// pays the queue instead). Stakers are only paid from a loss that settles with nobody waiting, so
// keep losing until one does.
//
// One position at a time, on the side about to lose, and nothing on the other side: a winner
// there would join the very queue these losses are paying off, and whether the queue ever
// emptied would be left to how far the price happened to run. Each loss is $250 to the house and
// that pair's winner is owed a few hundred dollars at most, so a handful of rounds is always enough.
step("losses pay the queue first; the first one with nobody queued pays the 2% fee");
{
  let paid = null;
  const ROUNDS = 8;
  for (let round = 0; round < ROUNDS && !paid; round++) {
    const down = round % 2 === 0;
    const loser = await open({ isLong: down, margin: 250_000000n, leverage: 1000 });
    await waitIntent(loser.id, ["confirmed"]);
    await post("/dev/nudge", { market: btc.id, bps: down ? -12 : 12 });
    let lost = null;
    for (const until = Date.now() + 30_000; Date.now() < until && !lost; ) {
      await sleep(500);
      const history = await get(`/history/${trader.address}?limit=8`);
      lost = history.trades.find((t) => t.id === loser.id && t.busted);
    }
    assert.ok(lost, "the position was busted");
    console.log(`${down ? "long" : "short"} busted at ${px(lost.exitPrice)}: fee ${usd(BigInt(lost.fee))}${BigInt(lost.fee) === 0n ? " (winners were queued; it paid them)" : ", half of it the stakers'"}`);
    if (BigInt(lost.fee) > 0n) paid = lost;
    account = await get(`/account/${trader.address}`);
    for (const p of account.positions) await close(p.id).catch((e) => console.log(`close ${p.id.slice(0, 10)}: ${e.message}`));
  }
  assert.ok(paid, `${ROUNDS} losses in a row and none paid a fee`);
}

step("stake it, and the stakers' share of the fees shows up");
{
  account = await get(`/account/${trader.address}`);
  const stakeAmount = BigInt(account.coin.wallet);
  const stakedBefore = BigInt(account.coin.staked);
  const stakeDeadline = BigInt(now() + 3600);
  const nonce = await rpc.readContract({ address: coinInfo.address, abi: abi("Coin"), functionName: "nonces", args: [trader.address] });
  const sig = parseSignature(
    await trader.signTypedData({
      domain: { name: coinInfo.name, version: "1", chainId: config.chainId, verifyingContract: coinInfo.address },
      types: permitTypes,
      primaryType: "Permit",
      message: { owner: trader.address, spender: coinInfo.staking, value: stakeAmount, nonce, deadline: stakeDeadline },
    }),
  );
  const hash = await wallet.writeContract({
    address: coinInfo.staking,
    abi: abi("Staking"),
    functionName: "stakeWithPermit",
    args: [stakeAmount, stakeDeadline, Number(sig.v ?? 27n + BigInt(sig.yParity)), sig.r, sig.s],
  });
  await rpc.waitForTransactionReceipt({ hash });
  let pending = 0n;
  for (const until = Date.now() + 40_000; Date.now() < until && pending === 0n; ) {
    await sleep(1000);
    // A local chain only makes a block when something is sent, and what a staker has earned is
    // read at the latest block's time. A real chain makes one every twelve seconds by itself.
    await rpc.request({ method: "evm_mine" });
    pending = BigInt((await get(`/account/${trader.address}`)).coin.pending);
  }
  assert.ok(pending > 0n, "the stream reached the staker");
  account = await get(`/account/${trader.address}`);
  assert.equal(BigInt(account.coin.staked), stakedBefore + stakeAmount);
  console.log(`staked ${(Number(stakeAmount) / 1e18).toFixed(2)}; ${usd(pending)} USDC claimable`);

  const balanceBefore = BigInt(account.balance);
  // The indexer's figure is a lifetime total: on a chain this has run on before it starts above zero.
  const claimedBefore = BigInt(account.coin.claimed);
  const claimHash = await wallet.writeContract({ address: coinInfo.staking, abi: abi("Staking"), functionName: "claim", args: [] });
  await rpc.waitForTransactionReceipt({ hash: claimHash });
  // The balance is read from the chain; the lifetime total comes from the indexer a moment later.
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    await sleep(400);
    account = await get(`/account/${trader.address}`);
    if (BigInt(account.coin.claimed) - claimedBefore >= pending) break;
  }
  assert.ok(BigInt(account.balance) - balanceBefore >= pending, "the claim landed in the trading balance");
  assert.ok(BigInt(account.coin.claimed) - claimedBefore >= pending, "the indexer counted the claim");
  console.log(`claimed into the trading balance: ${usd(account.balance)}`);
}

step("the account's history has every kind of entry");
{
  const history = await get(`/history/${trader.address}?limit=50`);
  assert.ok(history.trades.length >= 3);
  assert.ok(history.transfers.some((t) => t.type === "deposit"));
  assert.ok(history.transfers.some((t) => t.type === "reward"));
  assert.ok(history.staking.some((t) => t.type === "stake") && history.staking.some((t) => t.type === "claim"));
  assert.ok(history.emissions.length >= 1);
  console.log(`${history.trades.length} trades, ${history.transfers.length} transfers, ${history.staking.length} staking, ${history.queue.length} queue, ${history.emissions.length} emissions`);
}

step("claim a username");
{
  const name = `smoke_${Math.floor(Math.random() * 1e6)}`;
  const message = `Claim the username "${name}" for ${trader.address}`;
  await post("/username", { owner: trader.address, name, signature: await trader.signMessage({ message }) });
  assert.equal((await get(`/account/${trader.address}`)).name, name);
  await assert.rejects(post("/username", { owner: session.address, name, signature: await session.signMessage({ message: `Claim the username "${name}" for ${session.address}` }) }), /taken/);
  console.log(`${name}; a second claim of the same name is refused`);
}

step("the cash limit: a side holds no more than the floor plus a multiple of the vault's cash");
const cashLimit = (await get("/status")).cashLimit;
if (cashLimit === null) console.log("off on this relayer (CASH_MULTIPLE=0)");
else {
  const ahead = BigInt((await get("/house")).markets[eth.id].oiLong);
  const room = BigInt(cashLimit) - ahead;
  // One order past the room that is left: refused at the door, nothing opened.
  await assert.rejects(open({ isLong: true, margin: room / 100n + 1_000000n, leverage: 100, market: eth }), /vault's cash/);
  assert.equal(BigInt((await get("/house")).markets[eth.id].oiLong), ahead, "the refused order opened nothing");
  console.log(`a side may hold $${usd(cashLimit)} now: an order past that is refused`);
}

step("size costs: a position opened past the depth keeps less of a win, on the contract's own terms");
if (cashLimit !== null && BigInt((await get("/house")).markets[eth.id].oiLong) + 4_000_000_000000n > BigInt(cashLimit)) {
  console.log("skipped: the immutable cash limit is below this step's $4M position. Seed genuine local house cash to test larger size costs.");
} else {
  const margin = 40_000_000000n;
  const leverage = 100;
  const notional = margin * BigInt(leverage);
  const ahead = BigInt((await get("/house")).markets[eth.id].oiLong);
  // An order that says it will take no more than the reference charge is refused, not opened on
  // worse terms than it asked for.
  await assert.rejects(open({ isLong: true, margin, leverage, market: eth, impactLimit: Number(REFERENCE_NOTIONAL) }), /size impact went past your limit/);
  assert.equal(BigInt((await get("/house")).markets[eth.id].oiLong), ahead, "the refused order opened nothing");
  console.log("an order whose size impact would be past the limit it signed is refused");
  // $4,000,000 of ETH longs. On an empty side its middle stands at $2,000,000: two of the launch depths.
  const whale = await open({ isLong: true, margin, leverage, market: eth, impactLimit: Number(impactNotionalFor(ahead, notional, eth.depth)) });
  await waitIntent(whale.id, ["confirmed"]);
  const listed = (await get(`/account/${trader.address}`)).positions.find((p) => p.id === whale.id);
  const onChain = await rpc.readContract({ address: config.addresses.exchange, abi: abi("Exchange"), functionName: "getPosition", args: [whale.id] });
  const charge = impactNotionalFor(ahead, notional, eth.depth);
  assert.ok(charge > REFERENCE_NOTIONAL, "a position this size is past the depth");
  assert.equal(BigInt(onChain.impactNotional), charge, "the contract charged what the shared math says");
  assert.equal(BigInt(listed.impactNotional), charge, "and the relayer reports the contract's figure");
  console.log(`$${usd(notional)} of ETH longs on top of $${usd(ahead)}, depth $${eth.depth.toLocaleString("en-US")}: charged on $${charge.toLocaleString("en-US")} instead of $100,000`);

  // Up 30 basis points and out.
  await post("/dev/nudge", { market: eth.id, bps: 30 });
  await sleep(2500);
  const out = await close(whale.id);
  const exit = BigInt(out.fill.price);
  const charged = quoteClose({ entryPrice: whale.entry, margin, leverage, isLong: true, impactNotional: charge }, eth, exit);
  const plain = quoteClose({ entryPrice: whale.entry, margin, leverage, isLong: true, impactNotional: REFERENCE_NOTIONAL }, eth, exit);
  assert.equal(BigInt(out.fill.pnl), charged.pnl, "the fill is priced on the position's own charge");
  assert.ok(charged.pnl > 0n, "a 30 bps move in its favour is a win");
  assert.ok(charged.pnl < plain.pnl, "and it keeps less than the reference would have paid");
  console.log(`closed ${((Number(exit - whale.entry) * 1e4) / Number(whale.entry)).toFixed(1)} bps up: kept ${usd(charged.pnl)}, where the reference price would have paid ${usd(plain.pnl)}`);
  await post("/dev/nudge", { market: eth.id, bps: 0 });
  // Paid or queued, the win is the trader's either way; the margin is back in the balance.
  await sleep(600);
}

step("withdraw on the wallet's signature");
account = await get(`/account/${trader.address}`);
const out = BigInt(account.balance) / 2n;
const wDeadline = BigInt(now() + 300);
const walletBefore = BigInt(account.wallet.usdc);
await post("/withdraw", {
  owner: trader.address,
  to: trader.address,
  amount: out,
  deadline: wDeadline,
  signature: await trader.signTypedData({ domain, types, primaryType: "Withdraw", message: { owner: trader.address, to: trader.address, amount: out, nonce: BigInt(account.withdrawNonce), deadline: wDeadline } }),
});
account = await get(`/account/${trader.address}`);
assert.equal(BigInt(account.wallet.usdc) - walletBefore, out);
console.log(`withdrew ${usd(out)}; wallet ${usd(account.wallet.usdc)}, balance ${usd(account.balance)}`);

step("a session key cannot withdraw");
{
  const message = { owner: trader.address, to: session.address, amount: 1_000000n, nonce: BigInt(account.withdrawNonce), deadline: wDeadline };
  const signature = await session.signTypedData({ domain, types, primaryType: "Withdraw", message });
  await assert.rejects(post("/withdraw", { ...message, signature }), /signature/);
  console.log("refused");
}

step("the public pages have data");
const house = await get("/house");
const coin = await get("/coin");
const board = await get("/leaderboard?window=all");
console.log(`house cash ${usd(house.house.lpCash)}, queued ${usd(house.house.totalQueued)}, ${house.totals.trades} trades, ${house.totals.busts} busts`);
console.log(`coin ${coin.symbol}: ${(Number(coin.mining.mined) / 1e18).toFixed(0)} mined, ${(Number(coin.mining.perDollar) / 1e18).toFixed(2)} per $1 lost now, ${usd(coin.pendingFees)} waiting for stakers`);
console.log(`leaderboard: ${board.positions.length} winning positions, ${board.accounts.length} accounts`);
assert.ok(house.totals.trades >= 1);

if (referrer) {
  step("the referrer's books: a quarter of every fee this trader paid");
  const page = await get(`/referrals/${referrer}`);
  const mine = page.referred.find((r) => r.address === trader.address);
  assert.ok(mine, "the trader is on its referrer's page");
  assert.equal(page.shareOfFeeBps, 2500);
  assert.ok(mine.trades >= 1 && BigInt(mine.fees) > 0n, "its trades and their fees are counted");
  // Half of the team's half of each fee (the team's half rounds up, the cut down): a quarter of
  // the total, give or take a millionth of a dollar a trade.
  const quarter = BigInt(mine.fees) / 4n;
  const apart = BigInt(mine.reward) > quarter ? BigInt(mine.reward) - quarter : quarter - BigInt(mine.reward);
  assert.ok(apart <= BigInt(mine.trades), `reward ${mine.reward} against fees ${mine.fees}`);
  assert.equal(BigInt(page.earned), page.referred.reduce((sum, r) => sum + BigInt(r.reward), 0n));
  const unpaid = BigInt(page.earned) - BigInt(page.paid);
  assert.equal(BigInt(page.owed), unpaid > 0n ? unpaid : 0n, "an overpayment never becomes negative debt");
  const everyone = await get("/referrals");
  assert.ok(everyone.referrers.some((r) => r.address === referrer && BigInt(r.earned) === BigInt(page.earned)), "the payout list has the referrer");
  console.log(`${mine.trades} trades, ${usd(mine.fees)} of fees: the referrer earned ${usd(page.earned)} (paid ${usd(page.paid)}, owed ${usd(page.owed)})`);
}

const status = await get("/status");
const series = await get("/series");
assert.ok(status.ok && status.feeds.every((f) => f.time !== null), "every feed is live");
assert.ok(series.points.length >= 1, "the sampler has data");
console.log(`status: block ${status.block}, ${status.feeds.length} feeds live, ${series.points.length} chart samples, ${config.tape.length >= 0 ? (await get("/config")).tape.length : 0} tape entries`);

// The books still balance.
const held = await rpc.readContract({ address: config.addresses.usdc, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [config.addresses.exchange] });
// Read again: what the relayer had a moment ago may be from before the last withdrawal.
const treasuryNow = await rpc.readContract({ address: config.addresses.exchange, abi: abi("Exchange"), functionName: "treasury" });
assert.ok(held >= treasuryNow, "the Exchange holds what it accounts for");
console.log(`\nALL GOOD: exchange holds ${usd(held)} USDC against ${usd(treasuryNow)} accounted`);
