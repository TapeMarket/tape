/**
 * Referral payouts: who is owed what, and paying them.
 *
 *   node tools/referral-payouts.mjs --api https://api.tapemarket.io                       who is owed what
 *   node tools/referral-payouts.mjs --api URL --rpc URL --key FILE --send [--mainnet]    pay them, in USDC
 *
 *   --min 5        the smallest amount worth a transaction, in dollars (default 5)
 *   --only 0x..    pay this one referrer and nobody else
 *
 * The relayer keeps the books (relayer/src/referrals.mjs): what each referrer has earned, and what
 * the payer has already sent them, which it reads from the chain. So paying IS the record: this
 * sends USDC from the payer's wallet to each referrer, and a minute later the relayer shows it as
 * paid. Nothing has to be told to the relayer, and running this twice in a row pays nobody twice,
 * as long as the second run is after the relayer has seen the first (it checks, and stops if the
 * chain already shows a payment the relayer has not counted yet).
 *
 * The key must be the payer's: the wallet the relayer names (the one the Exchange sends the team's
 * fees to, unless REFERRAL_PAYER says otherwise). Claim the team's fees first (`claimDevFees`), or
 * have the USDC in that wallet some other way. Sending on a real chain needs --mainnet.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { payoutScanStart } from "./referral-payout-state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "relayer", "package.json"));
const { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, parseGwei, getAddress, defineChain } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  if (args[i + 1] === undefined || args[i + 1].startsWith("--")) throw new Error(`--${name} needs a value`);
  return args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
const isLocal = (url) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url);
const usd = (v) => `$${(Number(v) / 1e6).toFixed(2)}`;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

function loadKey(file) {
  const text = readFileSync(file, "utf8");
  const key = text.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? text.match(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/)?.[0];
  if (!key) throw new Error(`${file} holds no private key`);
  return key.startsWith("0x") ? key : `0x${key}`;
}

const api = (opt("api") ?? "").replace(/\/$/, "");
if (!api) throw new Error("--api is required: the relayer, such as https://api.tapemarket.io");
const get = async (path) => {
  const res = await fetch(`${api}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
};

const min = BigInt(Math.round(Number(opt("min", "5")) * 1e6));
const only = opt("only") ? getAddress(opt("only")) : null;
const [book, config] = await Promise.all([get("/referrals"), get("/config")]);
const owed = book.referrers
  .map((r) => ({ address: getAddress(r.address), earned: BigInt(r.earned), paid: BigInt(r.paid), owed: BigInt(r.owed), referred: r.referred }))
  .filter((r) => !only || r.address === only)
  .sort((a, b) => (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : 0));

console.log(`referrers earn ${book.shareOfFeeBps / 100}% of each fee their traders pay; payouts come from ${book.payer ?? "(no payer set)"}\n`);
if (!owed.length) console.log("nobody has earned anything yet");
for (const r of owed) console.log(`${r.address}  traders ${String(r.referred).padStart(3)}  earned ${usd(r.earned).padStart(10)}  paid ${usd(r.paid).padStart(10)}  owed ${usd(r.owed).padStart(10)}${r.owed < min ? "  (under the minimum)" : ""}`);
const due = owed.filter((r) => r.owed >= min);
const total = due.reduce((sum, r) => sum + r.owed, 0n);
console.log(`\n${due.length} to pay, ${usd(total)} in all (minimum ${usd(min)})`);
if (!flag("send") || !due.length) process.exit(0);

const rpc = opt("rpc");
if (!rpc) throw new Error("--rpc is required to send");
if (!opt("key")) throw new Error("--key FILE is required to send: the payer's key");
if (!isLocal(rpc) && !flag("mainnet")) throw new Error("This is a real chain. Add --mainnet to send real USDC.");
const chain = defineChain({ id: config.chainId, name: `chain-${config.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc) });
if ((await client.getChainId()) !== config.chainId) throw new Error(`the RPC is chain ${await client.getChainId()}, the relayer is on ${config.chainId}`);
const account = privateKeyToAccount(loadKey(resolve(opt("key"))));
if (!book.payer || getAddress(book.payer) !== account.address) {
  throw new Error(`that key is ${account.address}, and the relayer counts payouts from ${book.payer}: a payment from another wallet would never show as paid`);
}
const usdc = config.addresses.usdc;
const held = await client.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [account.address] });
if (held < total) throw new Error(`the payer holds ${usd(held)} USDC and ${usd(total)} is due: claim the team's fees first, or top it up`);

// Paid already, and the relayer has not counted it yet? Then its "owed" is stale: paying on it
// would pay twice. The relayer says how far it has looked; anything the payer sent after that is
// taken off what is owed here.
const head = await client.getBlockNumber();
const scanStart = payoutScanStart(book.lookedTo, head);
const uncounted = new Map();
for (let from = scanStart; from <= head; from += 500n) {
  const to = from + 499n > head ? head : from + 499n;
  for (const entry of await client.getLogs({ address: usdc, event: TRANSFER, args: { from: account.address }, fromBlock: from, toBlock: to })) {
    const receiver = getAddress(entry.args.to);
    uncounted.set(receiver, (uncounted.get(receiver) ?? 0n) + entry.args.value);
  }
}
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
for (const r of due) {
  const already = uncounted.get(r.address) ?? 0n;
  if (already > 0n) {
    console.log(`  ${r.address}: the payer sent it ${usd(already)} a moment ago that the relayer has not counted yet; skipped this time`);
    continue;
  }
  const block = await client.getBlock();
  const tip = parseGwei(opt("tip-gwei", "0.2"));
  const hash = await wallet.writeContract({ address: usdc, abi: erc20, functionName: "transfer", args: [r.address, r.owed], maxPriorityFeePerGas: tip, maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + tip });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (receipt.status !== "success") throw new Error(`the payment to ${r.address} reverted (${hash})`);
  console.log(`  paid ${r.address} ${usd(r.owed)}: ${hash}`);
}
console.log("\ndone. The relayer shows these as paid within about a minute.");
