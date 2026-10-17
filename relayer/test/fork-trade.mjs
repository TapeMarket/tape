/**
 * One trader through the real exchange on a FORK of mainnet, at Hyperliquid's real prices.
 *
 * Needs a relayer running against an anvil fork of mainnet (chain id 1) on which script/Deploy.s.sol
 * has run with ORACLE=hyperliquid, with PRICE_SOURCE=hyperliquid: tools/launch-rehearsal.sh sets
 * that up and runs this. Everything is the real thing except the chain being a copy: real USDC,
 * the contracts as they ship, Hyperliquid's live order book, the price signer signing it.
 *
 * It refuses any chain it cannot give itself USDC on, so it cannot be pointed at mainnet by mistake.
 *
 *   node relayer/test/fork-trade.mjs <relayer-url> <fork-rpc-url>
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, parseSignature, toHex } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { domain as buildDomain, sessionDomain, types, permitTypes } from "../../shared/eip712.mjs";
import { quoteClose, bustPrice } from "../../shared/math.mjs";
import { SIGNED_ORACLE_ABI } from "../src/prices/signer.mjs";

const API = process.argv[2] ?? "http://127.0.0.1:8797";
const RPC = process.argv[3] ?? "http://127.0.0.1:8614";
const BUST_WAIT_S = Number(process.env.BUST_WAIT ?? 120);
const abi = (name) => JSON.parse(readFileSync(new URL(`../../abi/${name}.json`, import.meta.url), "utf8"));
// Fresh keys every run: nothing here is anybody's wallet.
const trader = privateKeyToAccount(generatePrivateKey());
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
let passed = 0;
const ok = (what) => {
  passed++;
  console.log(`[ OK ] ${what}`);
};

async function waitIntent(id, want, timeoutMs = 40_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const intent = await get(`/intent/${id}`);
    if (intent.status === "failed") throw new Error(`intent failed: ${intent.error}`);
    if (want.includes(intent.status)) return intent;
    if (Date.now() > until) throw new Error(`intent stuck at ${intent.status}`);
    await sleep(200);
  }
}

/** Hyperliquid's own middle price, asked for directly: what the relayer's prints are checked against. */
async function hyperliquidMid(coin) {
  const res = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
  return Number((await res.json())[coin]);
}

const config = await get("/config");
assert.equal(config.chainId, 1, "this is for a fork of mainnet");
assert.equal(config.priceSource, "hyperliquid", "the relayer must be pricing from Hyperliquid");
const rpc = createPublicClient({ chain: mainnet, transport: http(RPC) });
const wallet = createWalletClient({ account: trader, chain: mainnet, transport: http(RPC) });
const domain = buildDomain(config.name, config.chainId, config.addresses.exchange);
const offset = config.time - Date.now();
const now = () => Math.floor((Date.now() + offset) / 1000);
const stamp = () => BigInt(Math.floor((Date.now() + offset) / 1000 + 0.25));
const btc = config.markets.find((m) => m.symbol === "BTC");
const eth = config.markets.find((m) => m.symbol === "ETH");
console.log(`relayer ${API}: ${config.name} on a fork of chain ${config.chainId}, prices from ${config.priceSource}, BTC ${px(btc.price ?? 0)}, ETH ${px(eth.price ?? 0)}`);

step("the trader: real USDC, on the fork only");
// Mainnet USDC keeps balances in the mapping at slot 9. Only a test chain lets anyone write it.
const funding = 5_000_000000n;
const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [trader.address, 9n]));
await rpc.request({ method: "anvil_setStorageAt", params: [config.addresses.usdc, slot, toHex(funding, { size: 32 })] });
await rpc.request({ method: "anvil_setBalance", params: [trader.address, toHex(10n ** 17n)] });
const erc20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
assert.equal(await rpc.readContract({ address: config.addresses.usdc, abi: erc20, functionName: "balanceOf", args: [trader.address] }), funding);
ok(`${trader.address} holds ${usd(funding)} USDC of the real USDC contract`);

step("session key, and a deposit by permit: the trader sends no transaction");
let account = await get(`/account/${trader.address}`);
const validUntil = now() + 86_400;
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
const depositAmount = 3_000_000000n;
const deadline = BigInt(now() + 3600);
const permit = parseSignature(
  await trader.signTypedData({
    domain: { name: config.usdcPermit.name, version: config.usdcPermit.version, chainId: config.chainId, verifyingContract: config.addresses.usdc },
    types: permitTypes,
    primaryType: "Permit",
    message: { owner: trader.address, spender: config.addresses.gateway, value: depositAmount, nonce: BigInt(account.wallet.usdcNonce), deadline },
  }),
);
await post("/deposit", { owner: trader.address, amount: depositAmount, deadline, v: Number(permit.v ?? 27n + BigInt(permit.yParity)), r: permit.r, s: permit.s });
account = await get(`/account/${trader.address}`);
assert.equal(BigInt(account.balance), depositAmount);
ok(`deposited ${usd(depositAmount)} with real USDC's own permit`);

if (config.addresses.deposits) {
  step("deposit by a plain transfer to the wallet's own deposit address");
  const box = await get(`/deposit-address/${trader.address}`);
  assert.ok(/^0x[0-9a-fA-F]{40}$/.test(box.address) && box.deposits === config.addresses.deposits);
  const sent = 1_000_000000n;
  const hash = await wallet.writeContract({
    address: config.addresses.usdc,
    abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
    functionName: "transfer",
    args: [box.address, sent],
  });
  await rpc.waitForTransactionReceipt({ hash });
  let balance = 0n;
  for (const until = Date.now() + 90_000; Date.now() < until && balance < depositAmount + sent; ) {
    await sleep(1500);
    await get(`/deposit-address/${trader.address}`);
    balance = BigInt((await get(`/account/${trader.address}`)).balance);
  }
  assert.equal(balance, depositAmount + sent);
  ok(`a plain transfer of ${usd(sent)} of real USDC to ${box.address} became the wallet's balance: no permit, no approval`);
}
while (now() < registered.validFrom) await sleep(250);

async function open({ isLong, margin, leverage, market }) {
  const message = { owner: trader.address, market: market.id, isLong, useQueued: false, leverage, margin, priceLimit: 0n, impactLimit: 0, timestamp: stamp(), salt: BigInt(Math.floor(Math.random() * 2 ** 48)) };
  const signature = await session.signTypedData({ domain, types, primaryType: "Open", message });
  const accepted = await post("/open", { intent: message, signature });
  const filled = await waitIntent(accepted.id, ["filled", "confirmed"]);
  return { id: accepted.id, message, entry: BigInt(filled.fill.price), time: filled.fill.time, market };
}
async function close(id) {
  const message = { owner: trader.address, positionId: id, timestamp: stamp() };
  const signature = await session.signTypedData({ domain, types, primaryType: "Close", message });
  const accepted = await post("/close", { intent: message, signature });
  return waitIntent(accepted.id, ["confirmed"]);
}
const positionOf = async (id) => (await get(`/account/${trader.address}`)).positions.find((p) => p.id === id);
const tradeOf = async (id) => (await get(`/history/${trader.address}`)).trades.find((t) => t.id === id);
/** The signer's first print at or after `time`, as the relayer serves it, read back by the contract on the fork. */
async function printAt(market, time) {
  const print = await get(`/print?market=${market.id}&time=${time}`);
  const [price, , publishTime, prev] = await rpc.readContract({ address: config.addresses.oracle, abi: SIGNED_ORACLE_ABI, functionName: "read", args: [market.feedId, [print.update]] });
  assert.equal(price, BigInt(print.price));
  assert.equal(Number(publishTime), print.time);
  assert.ok(Number(prev) < time && print.time >= time, "it is the first print at or after that second");
  return { price, time: print.time };
}

step("open at Hyperliquid's price");
const margin = BigInt(config.minMargin) > 100_000000n ? BigInt(config.minMargin) : 100_000000n;
const midBefore = await hyperliquidMid("BTC");
const first = await open({ isLong: true, margin, leverage: 100, market: btc });
const midAfter = await hyperliquidMid("BTC");
const fill = Number(first.entry) / 1e8;
const apart = (Math.abs(fill - (midBefore + midAfter) / 2) / fill) * 10_000;
console.log(`long ${usd(margin)} x100 filled at ${fill.toFixed(2)}; Hyperliquid's own mid was ${midBefore} before and ${midAfter} after`);
assert.ok(apart < 15, `the fill is ${apart.toFixed(1)} bps from Hyperliquid's mid`);
ok(`the fill is Hyperliquid's price (${apart.toFixed(1)} bps from the mid asked for directly, seconds apart)`);
await waitIntent(first.id, ["confirmed"]);
const onChain = await rpc.readContract({ address: config.addresses.exchange, abi: abi("Exchange"), functionName: "getPosition", args: [first.id] });
assert.equal(onChain.entryPrice, first.entry);
assert.equal(onChain.owner, trader.address);
ok("the position is on the Exchange at that price");
const pinned = await printAt(btc, Number(first.message.timestamp) + config.timing.execDelay);
assert.equal(pinned.price, first.entry);
ok(`and that price is the signer's first print ${config.timing.execDelay}s after the click, which the oracle contract reads back`);

step("close, and be settled by the contract's own arithmetic");
await sleep(3000);
const position = await positionOf(first.id);
const closed = await close(first.id);
const expected = quoteClose({ entryPrice: first.entry, margin, leverage: 100, isLong: true, impactNotional: position.impactNotional }, btc, BigInt(closed.fill.price));
assert.equal(BigInt(closed.fill.pnl), expected.pnl);
await sleep(1500);
const trade = await tradeOf(first.id);
assert.equal(BigInt(trade.pnl), expected.pnl, "what the chain settled is what the shared math said");
console.log(`closed at ${px(closed.fill.price)}: pnl ${usd(expected.pnl)}`);
ok("the close settled on-chain for exactly what the ticket's math gives");

step(`1000x both ways on BTC and ETH: a real 5 bps move busts one (waiting up to ${BUST_WAIT_S}s)`);
const small = BigInt(config.minMargin);
const pairs = [];
for (const market of [btc, eth]) {
  for (const isLong of [true, false]) pairs.push(await open({ isLong, margin: small, leverage: 1000, market }));
}
await Promise.all(pairs.map((p) => waitIntent(p.id, ["confirmed"])));
for (const p of pairs) console.log(`  ${p.market.symbol} ${p.message.isLong ? "long " : "short"} at ${px(p.entry)}, busts at ${px(bustPrice(p.entry, 1000, p.message.isLong, p.market))}`);
let busted = null;
for (const until = Date.now() + BUST_WAIT_S * 1000; Date.now() < until && !busted; ) {
  await sleep(1000);
  const open_ = new Set((await get(`/account/${trader.address}`)).positions.map((p) => p.id));
  const gone = pairs.find((p) => !open_.has(p.id));
  if (gone) busted = gone;
}
if (busted) {
  await sleep(1500);
  const record = await tradeOf(busted.id);
  assert.ok(record.busted, "it was a bust");
  assert.equal(BigInt(record.pnl), -small);
  const trigger = bustPrice(busted.entry, 1000, busted.message.isLong, busted.market);
  assert.ok(busted.message.isLong ? BigInt(record.exitPrice) <= trigger : BigInt(record.exitPrice) >= trigger, "the bust price was at or past the trigger");
  console.log(`  ${busted.market.symbol} ${busted.message.isLong ? "long" : "short"} busted at ${px(record.exitPrice)}: margin ${usd(small)} forfeited`);
  ok("the keeper busted a position with a signed Hyperliquid print the moment the market touched its line");
} else {
  console.log(`  no 5 bps move on either market in ${BUST_WAIT_S}s: nothing busted, which proves nothing either way`);
}
for (const p of pairs) if (await positionOf(p.id)) await close(p.id);
assert.equal((await get(`/account/${trader.address}`)).positions.length, 0);
ok("every other position closed");

step("the direct close: asked for from the wallet, priced by the signer, executed by the keeper");
const direct = await open({ isLong: false, margin, leverage: 100, market: eth });
await waitIntent(direct.id, ["confirmed"]);
const hash = await wallet.writeContract({ address: config.addresses.exchange, abi: abi("Exchange"), functionName: "requestClose", args: [direct.id] });
const receipt = await rpc.waitForTransactionReceipt({ hash });
const requestedAt = Number((await rpc.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
const pin = requestedAt + config.timing.directDelay;
console.log(`  requested in a block stamped ${requestedAt}; it is priced at the first print at or after ${pin}`);
for (const until = Date.now() + 90_000; Date.now() < until && (await positionOf(direct.id)); ) await sleep(1000);
assert.equal(await positionOf(direct.id), undefined, "the keeper executed it");
await sleep(1500);
const settledDirect = await tradeOf(direct.id);
const directPrint = await printAt(eth, pin);
assert.equal(BigInt(settledDirect.exitPrice), directPrint.price);
ok(`it closed at ${px(settledDirect.exitPrice)}, the signer's first print at its pinned second, which anyone can fetch from /print`);

step("withdraw on the wallet's signature");
account = await get(`/account/${trader.address}`);
const out = BigInt(account.balance);
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
ok(`withdrew ${usd(out)} USDC back to the wallet (${usd(account.queued)} of winnings queued behind the empty house)`);

step("the books");
const exchange = { address: config.addresses.exchange, abi: abi("Exchange") };
const [holds, treasury] = await Promise.all([
  rpc.readContract({ address: config.addresses.usdc, abi: erc20, functionName: "balanceOf", args: [config.addresses.exchange] }),
  rpc.readContract({ ...exchange, functionName: "treasury" }),
]);
assert.equal(holds, treasury);
const status = await get("/status");
assert.equal(status.oracleKind, "signed");
assert.ok(status.priceHealth.every((h) => h.stopped === null), "both markets are being priced");
ok(`the Exchange holds ${usd(holds)} USDC and accounts for ${usd(treasury)}; both markets priced, clock ${status.priceHealth[0].clockOffsetMs}ms from Hyperliquid's`);

console.log(`\nALL GOOD: ${passed} checks on a fork of mainnet at Hyperliquid's live prices`);
