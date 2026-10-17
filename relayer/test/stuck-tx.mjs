/**
 * A transaction that is not being mined: does the relayer's queue pay a real tip from the start,
 * send it again paying more, and still report the right result once it lands?
 *
 * Needs a local chain (anvil) with script/DevDeploy.s.sol on it, and NO relayer running against it
 * (this drives the relayer's own queue with the operator's key, and two would fight over nonces).
 * It turns the chain's automatic mining off for the middle of the run and back on at the end.
 *
 *   node relayer/test/stuck-tx.mjs
 */
import assert from "node:assert/strict";
import { createWalletClient, http, parseAbi } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { loadConfig } from "../src/config.mjs";
import { createChain, createTxQueue } from "../src/chain.mjs";

const config = { ...loadConfig({ ...process.env, CHAIN_ID: "31337" }), bumpAfterMs: 1_500, receiptPollMs: 150 };
const chain = createChain(config);
const { publicClient, account, addresses, read } = chain;
assert.ok(addresses.deposits, "the deployment has no Deposits contract");
const lines = [];
const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m, e) => lines.push(`${m} ${e?.message ?? ""}`) };
const queue = createTxQueue({ chain, log, config });
const rpc = (method, params = []) => publicClient.request({ method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gwei = (v) => (Number(BigInt(v)) / 1e9).toFixed(4);
/** The operator's transaction waiting in the pool, if there is one. */
const waiting = async () => Object.values((await rpc("txpool_content")).pending?.[account.address.toLowerCase()] ?? {})[0] ?? null;

// Somebody's deposit, waiting at their deposit address to be collected.
const user = privateKeyToAccount(generatePrivateKey()).address;
const minter = createWalletClient({ account: privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"), chain: foundry, transport: http(config.rpcUrl) });
const box = await read("deposits", "addressOf", [user]);
const minted = await minter.writeContract({ address: addresses.usdc, abi: parseAbi(["function mint(address,uint256)"]), functionName: "mint", args: [box, 25_000000n] });
await publicClient.waitForTransactionReceipt({ hash: minted });
assert.equal(await read("deposits", "pending", [user]), 25_000000n);

await rpc("evm_setAutomine", [false]);
try {
  const job = queue.push({ contract: "deposits", label: "collect (stuck)", functionName: "collect", args: [user] });
  let first = null;
  for (let i = 0; i < 40 && !first; i++) {
    await sleep(100);
    first = await waiting();
  }
  assert.ok(first, "the transaction never reached the pool");
  assert.ok(BigInt(first.maxPriorityFeePerGas) >= BigInt(Math.round(config.tipFloorGwei * 1e9)), `the first send tips ${gwei(first.maxPriorityFeePerGas)} gwei, under the floor`);
  console.log(`[ OK ] sent with a tip of ${gwei(first.maxPriorityFeePerGas)} gwei (floor ${config.tipFloorGwei}), max fee ${gwei(first.maxFeePerGas)} gwei`);

  // Nobody mines it. After bumpAfterMs it must be replaced, same nonce, paying at least a tenth more.
  let second = null;
  for (let i = 0; i < 60 && !second; i++) {
    await sleep(100);
    const now = await waiting();
    if (now && now.hash !== first.hash) second = now;
  }
  assert.ok(second, "it was never sent again");
  assert.equal(second.nonce, first.nonce, "the replacement must use the same nonce");
  assert.ok(BigInt(second.maxPriorityFeePerGas) * 10n >= BigInt(first.maxPriorityFeePerGas) * 11n, "the replacement does not tip enough more");
  assert.ok(BigInt(second.maxFeePerGas) * 10n >= BigInt(first.maxFeePerGas) * 11n, "the replacement's max fee is not enough higher");
  console.log(`[ OK ] not mined after ${config.bumpAfterMs} ms: sent again with the same nonce, tip ${gwei(second.maxPriorityFeePerGas)} gwei, max fee ${gwei(second.maxFeePerGas)} gwei`);

  // Left alone longer it keeps raising, and never past the cap.
  await sleep(config.bumpAfterMs * 2 + 600);
  const third = await waiting();
  assert.ok(third && BigInt(third.maxPriorityFeePerGas) > BigInt(second.maxPriorityFeePerGas), "it did not keep raising");
  assert.ok(BigInt(third.maxPriorityFeePerGas) <= BigInt(Math.round(config.tipCapGwei * 1e9)), "it went past the cap");
  console.log(`[ OK ] still not mined: raised again to ${gwei(third.maxPriorityFeePerGas)} gwei (cap ${config.tipCapGwei})`);

  await rpc("evm_mine");
  const result = await Promise.race([job, sleep(10_000).then(() => null)]);
  assert.ok(result, "the queue never noticed the replacement being mined");
  assert.equal(result.ok, true, `the job was reported as failed: ${result.reason}`);
  assert.equal(result.hash, third.hash, "the job reports a transaction other than the one that was mined");
  assert.equal(await read("deposits", "pending", [user]), 0n);
  assert.equal(await read("exchange", "balances", [user]), 25_000000n);
  assert.equal(await waiting(), null, "something of the operator's is still in the pool");
  console.log(`[ OK ] mined: the job is reported done with the hash that landed, and the deposit is the wallet's balance`);
} finally {
  await rpc("evm_setAutomine", [true]);
}

// And an ordinary one afterwards goes straight through: the nonce counter survived the replacements.
const again = privateKeyToAccount(generatePrivateKey()).address;
const second = await minter.writeContract({ address: addresses.usdc, abi: parseAbi(["function mint(address,uint256)"]), functionName: "mint", args: [await read("deposits", "addressOf", [again]), 7_000000n] });
await publicClient.waitForTransactionReceipt({ hash: second });
const result = await queue.push({ contract: "deposits", label: "collect (plain)", functionName: "collect", args: [again] });
assert.equal(result.ok, true, `the next transaction failed: ${result.reason}`);
assert.equal(await read("exchange", "balances", [again]), 7_000000n);
console.log("[ OK ] the next transaction goes through at once");
console.log("\nALL GOOD");
console.log(lines.map((l) => `  log: ${l}`).join("\n"));
process.exit(0);
