/**
 * Chain access: clients, contract handles, and the transaction queue.
 *
 * Trades go through one lane that keeps exactly one transaction in flight. Everything that arrives
 * while it is in flight is batched into the next one through the Batcher contract, in arrival
 * order. The Batcher makes each Exchange call separately, so one that no longer applies fails alone.
 * That makes ordering trivial to reason about (a close signed after an open always executes after
 * it) and lets one block carry any number of trades.
 *
 * Calls to other contracts (a deposit through the Gateway, a session-key registration) go through
 * a second lane, one at a time, so that onboarding never holds trades up. The two lanes share one
 * account: broadcasting is serialised and nonces are handed out in order.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  encodeFunctionData,
  decodeErrorResult,
  parseEventLogs,
  parseAbi,
  BaseError,
  ContractFunctionRevertedError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadAbi } from "./config.mjs";

const MAX_BATCH = 40;
/** The tip is the median, over the last ten blocks, of what this share of each block's gas paid. */
const TIP_PERCENTILE = 60;
/** How many times a transaction that is not being mined is sent again, paying more each time. */
const MAX_BUMPS = 5;
// Closes and liquidations must leave room for the loss-mining hook (see Exchange._mine).
const GAS_HEADROOM = 250_000n;

export function createChain(config) {
  const chain = defineChain({
    id: config.chainId,
    name: config.chainId === 1 ? "Ethereum" : `chain-${config.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const transport = http(config.rpcUrl, { timeout: 20_000, retryCount: 2, batch: true });
  const account = privateKeyToAccount(config.operatorKey);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  // The main operator wallet first, then the backups: the queue sends from the first with gas.
  const operators = [account, ...(config.backupOperatorKeys ?? []).map((key) => privateKeyToAccount(key))].map((a) => ({
    account: a,
    wallet: a === account ? walletClient : createWalletClient({ chain, transport, account: a }),
  }));

  const d = config.deployment;
  if (!d.batcher) throw new Error("The deployment file has no batcher address. It was written by an older deploy script: redeploy.");
  const abis = {
    exchange: [...loadAbi("Exchange"), ...(config.executionMode === "order-bound" ? parseAbi(["event PositionPricingTime(bytes32 indexed id, uint64 observedAt)"]) : [])],
    sessions: loadAbi("Sessions"),
    lens: loadAbi("Lens"),
    gateway: loadAbi("Gateway"),
    deposits: loadAbi("Deposits"),
    batcher: loadAbi("Batcher"),
    sweeper: loadAbi("Sweeper"),
    staking: loadAbi("Staking"),
    lossMining: loadAbi("LossMining"),
    jackpot: loadAbi("Jackpot"),
    coin: loadAbi("Coin"),
  };
  const addresses = {
    exchange: d.exchange,
    sessions: d.sessions,
    lens: d.lens,
    gateway: d.gateway,
    batcher: d.batcher,
    // A deposit address for every wallet. Deployed after the Exchange; absent on older deployments.
    deposits: d.deposits ?? null,
    // Attached together with the coin; absent until then.
    sweeper: d.sweeper ?? null,
    oracle: d.oracle,
    usdc: d.usdc,
    coin: d.coin ?? null,
    staking: d.staking ?? null,
    lossMining: d.lossMining ?? null,
    // The Rekt Jackpot, deployed with the coin; absent on deployments without one.
    jackpot: d.jackpot ?? null,
  };

  const read = (contract, functionName, args = []) =>
    publicClient.readContract({ address: addresses[contract], abi: abis[contract], functionName, args });

  return { chain, account, operators, publicClient, walletClient, abis, addresses, read };
}

// Errors raised below the Exchange: by the oracle (signed or Pyth's adapter) and by Pyth itself.
const ORACLE_ERRORS = parseAbi([
  "error BadUpdate()",
  "error BadSignature()",
  "error NoPriceInWindow()",
  "error NotExchange()",
  "error EmptyUpdate()",
  "error InsufficientFloat(uint256 fee, uint256 balance)",
  "error NonPositivePrice()",
  "error PriceOutOfRange()",
  "error PriceFeedNotFoundWithinRange()",
  "error PriceFeedNotFound()",
  "error InvalidUpdateData()",
  "error InvalidUpdateDataSource()",
  "error InvalidWormholeVaa()",
  "error InsufficientFee()",
  "error NoFreshUpdate()",
  "error StalePrice()",
]);

/** Names the custom error in raw revert data, trying every ABI we know. */
function explainBytes(abis, bytes) {
  if (!bytes || bytes === "0x") return "reverted";
  for (const abi of [...Object.values(abis), ORACLE_ERRORS]) {
    try {
      return decodeErrorResult({ abi, data: bytes }).errorName;
    } catch {
      // Not this contract's error.
    }
  }
  return `revert ${bytes.slice(0, 10)}`;
}

/** Turns a failed call into the contract's own error name where it can. */
export function explainRevert(abis, error) {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.data?.errorName) return reverted.data.errorName;
      if (reverted.raw && reverted.raw !== "0x") return explainBytes(abis, reverted.raw);
      if (reverted.reason) return reverted.reason;
    }
    return error.shortMessage;
  }
  return error?.message ?? String(error);
}

/**
 * @typedef {Object} Job
 * @property {string} label           for logs
 * @property {string} functionName    Exchange function (batchable) or the standalone call's function
 * @property {any[]} args
 * @property {"exchange"|"gateway"|"deposits"|"sessions"|"sweeper"} [contract]   defaults to the Exchange;
 *           anything else goes through the second lane, on its own
 * @property {bigint} [value]         ETH to send with a standalone call
 * @property {(result: {ok: boolean, reason?: string, hash?: string, receipt?: any}) => void} done
 */
export function createTxQueue({ chain, log, config = {}, onSettled = () => {}, onLowGas = () => {} }) {
  const { publicClient, abis, addresses } = chain;
  const operators = chain.operators ?? [{ account: chain.account, wallet: chain.walletClient }];
  const minGas = BigInt(Math.round((config.gasMinEth ?? 0.02) * 1e18));
  /** address -> { balance, at }: each operator wallet's ETH, looked at every half minute at most. */
  const gas = new Map();
  const warned = new Map();
  async function balanceOf(operator) {
    const seen = gas.get(operator.account.address);
    if (seen && Date.now() - seen.at < 30_000) return seen.balance;
    const balance = await publicClient.getBalance({ address: operator.account.address });
    gas.set(operator.account.address, { balance, at: Date.now() });
    if (balance < minGas && Date.now() - (warned.get(operator.account.address) ?? 0) > 3_600_000) {
      warned.set(operator.account.address, Date.now());
      const text = `operator wallet ${operator.account.address} is down to ${(Number(balance) / 1e18).toFixed(4)} ETH${operators.length > 1 ? "; sending from the next wallet that has gas" : ""}. Top it up.`;
      log.error(`gas: ${text}`);
      onLowGas(text);
    }
    return balance;
  }
  /** The wallet the next transaction is sent from: the first one that still has gas. */
  let current = operators[0];
  async function pick() {
    for (const operator of operators) {
      const balance = await balanceOf(operator).catch(() => minGas);
      if (balance >= minGas) {
        if (operator !== current) log.warn(`gas: now sending from ${operator.account.address}`);
        current = operator;
        return operator;
      }
    }
    // None has the minimum: the one with the most is the best there is.
    return current;
  }
  // The rest of the queue speaks of `account` and `walletClient`: whichever wallet is current.
  const accountNow = () => current.account;
  const gwei = (n) => BigInt(Math.round(n * 1e9));
  const tipFloor = gwei(config.tipFloorGwei ?? 0.05);
  const tipCap = gwei(config.tipCapGwei ?? 3);
  const bumpAfterMs = config.bumpAfterMs ?? 15_000;
  const receiptPollMs = config.receiptPollMs ?? 1_500;
  /** @type {{trades: {jobs: Job[], busy: boolean, timer: any}, others: {jobs: Job[], busy: boolean, timer: any}}} */
  const lanes = { trades: { jobs: [], busy: false, timer: null }, others: { jobs: [], busy: false, timer: null } };

  // Broadcasting is one at a time across both lanes, with nonces from a local counter. After any
  // failed send the counter is thrown away and re-read from the node.
  let broadcasting = Promise.resolve();
  /** address -> the next nonce of that wallet. */
  const nonces = new Map();

  function broadcast(request) {
    const run = broadcasting.then(async () => {
      const operator = await pick();
      const address = operator.account.address;
      if (!nonces.has(address)) nonces.set(address, await publicClient.getTransactionCount({ address, blockTag: "pending" }));
      const nonce = nonces.get(address);
      try {
        const hash = await operator.wallet.writeContract({ ...request, account: operator.account, nonce });
        nonces.set(address, nonce + 1);
        gas.delete(address);
        return { hash, nonce, operator };
      } catch (error) {
        nonces.delete(address);
        throw error;
      }
    });
    broadcasting = run.catch(() => {});
    return run;
  }

  // What a transaction pays. The node's own suggestion is not used: on a quiet day it suggests a
  // tip of nothing, and block builders leave a transaction that tips nothing lying for minutes (a
  // bust once waited eleven blocks that way). The tip is what recent blocks actually took, never
  // under the floor, never over the cap.
  const sorted = (list) => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let feesSeen = { at: 0, base: 0n, tip: 0n };
  async function fees() {
    if (Date.now() - feesSeen.at > 5_000) {
      try {
        const history = await publicClient.getFeeHistory({ blockCount: 10, rewardPercentiles: [TIP_PERCENTILE] });
        const tips = sorted((history.reward ?? []).map((r) => r[0] ?? 0n));
        feesSeen = { at: Date.now(), base: history.baseFeePerGas.at(-1) ?? 0n, tip: tips[Math.floor(tips.length / 2)] ?? 0n };
      } catch (error) {
        // No fee history from this node: the block's own base fee, and the floor as the tip.
        const block = await publicClient.getBlock();
        feesSeen = { at: Date.now(), base: block.baseFeePerGas ?? 0n, tip: 0n };
      }
    }
    const tip = feesSeen.tip < tipFloor ? tipFloor : feesSeen.tip > tipCap ? tipCap : feesSeen.tip;
    // Twice the base fee: it can rise an eighth a block, and only what is used is paid.
    return { maxPriorityFeePerGas: tip, maxFeePerGas: feesSeen.base * 2n + tip };
  }

  /**
   * Sends a transaction and stays with it until it is in a block. One that is not mined within
   * `bumpAfterMs` is sent again with the same nonce, paying more, so that it replaces the first:
   * a transaction left waiting holds up every one behind it, and a bust that waits is a bust that
   * can be escaped.
   */
  async function sendAndWait(request, label) {
    let paying = await fees();
    const { hash: first, nonce, operator } = await broadcast({ ...request, ...paying });
    const hashes = [first];
    const started = Date.now();
    let sentAt = started;
    let bumps = 0;
    for (;;) {
      for (const hash of hashes) {
        const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
        if (receipt) return { hash, receipt };
      }
      if (Date.now() - started > 180_000) throw new Error("The transaction was not mined in three minutes.");
      if (Date.now() - sentAt > bumpAfterMs && bumps < MAX_BUMPS && paying.maxPriorityFeePerGas < tipCap) {
        bumps += 1;
        sentAt = Date.now();
        feesSeen.at = 0;
        const now = await fees().catch(() => paying);
        // A replacement must pay at least a tenth more of both; this pays half as much again.
        const raised = (old, fresh) => (fresh > (old * 3n) / 2n ? fresh : (old * 3n) / 2n + 1n);
        let tip = raised(paying.maxPriorityFeePerGas, now.maxPriorityFeePerGas);
        if (tip > tipCap) tip = tipCap;
        paying = { maxPriorityFeePerGas: tip, maxFeePerGas: raised(paying.maxFeePerGas, now.maxFeePerGas - now.maxPriorityFeePerGas + tip) };
        try {
          hashes.push(await operator.wallet.writeContract({ ...request, ...paying, account: operator.account, nonce }));
          log.warn(`tx ${label}: not mined after ${Math.round((Date.now() - started) / 1000)}s, sent again with a tip of ${(Number(tip) / 1e9).toFixed(3)} gwei`);
        } catch (error) {
          // Usually "nonce too low": an earlier send was mined a moment ago, and the next look finds it.
          log.warn(`tx ${label}: could not be sent again (${error.shortMessage ?? error.message})`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, receiptPollMs));
    }
  }

  function push(job) {
    if (config.recoveryState?.paused) return Promise.resolve({ ok: false, error: "Emergency recovery is active. Use emergency withdrawal." });
    return new Promise((resolve) => {
      const queued = { contract: "exchange", ...job };
      let settled = false;
      queued.done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
        onSettled(queued, result);
      };
      const lane = queued.contract === "exchange" ? lanes.trades : lanes.others;
      lane.jobs.push(queued);
      schedule(lane, 60);
    });
  }

  function schedule(lane, ms) {
    if (lane.timer || lane.busy) return;
    lane.timer = setTimeout(() => {
      lane.timer = null;
      flush(lane).catch((err) => log.error("queue", err));
    }, ms);
  }

  async function flush(lane) {
    if (lane.busy || lane.jobs.length === 0) return;
    lane.busy = true;
    const taken = lane === lanes.others ? [lane.jobs.shift()] : lane.jobs.splice(0, MAX_BATCH);
    try {
      if (config.recoveryState?.paused) {
        for (const job of taken) job.done({ ok: false, error: "Emergency recovery is active." });
        return;
      }
      if (lane === lanes.others) await sendAlone(taken[0]);
      else await sendBatch(taken);
    } catch (error) {
      // Whatever went wrong, every caller gets an answer. A job left without one keeps its
      // balance reservation, and its position's "closing" mark, until the relayer restarts.
      log.error("queue", error);
      for (const job of taken) job.done({ ok: false, reason: "The transaction could not be sent." });
    } finally {
      lane.busy = false;
      if (lane.jobs.length) schedule(lane, 20);
    }
  }

  async function sendAlone(job) {
    const request = { account: accountNow(), address: addresses[job.contract], abi: abis[job.contract], functionName: job.functionName, args: job.args };
    if (job.value) request.value = job.value;
    try {
      const gas = await publicClient.estimateContractGas(request);
      const { hash, receipt } = await sendAndWait({ ...request, gas: (gas * 12n) / 10n + 30_000n }, job.label);
      log.info(`tx ${job.label} ${receipt.status} ${hash}`);
      job.done({ ok: receipt.status === "success", hash, receipt, reason: receipt.status === "success" ? undefined : "reverted" });
    } catch (error) {
      const reason = explainRevert(abis, error);
      log.warn(`tx ${job.label} failed: ${reason}`);
      job.done({ ok: false, reason });
    }
  }

  async function sendBatch(jobs) {
    // A call that cannot be encoded (a number outside its type) fails on its own. It used to throw
    // here and take every other trade in the batch with it.
    const batch = [];
    const calls = [];
    for (const job of jobs) {
      try {
        calls.push(encodeFunctionData({ abi: abis.exchange, functionName: job.functionName, args: job.args }));
        batch.push(job);
      } catch (error) {
        log.warn(`skip ${job.label}: ${error.shortMessage ?? error.message}`);
        job.done({ ok: false, reason: "Malformed request." });
      }
    }
    if (batch.length === 0) return;
    // The Batcher passes each call on to the Exchange, where it arrives from an operator (the
    // Batcher itself), and reports which went through.
    const request = { account: accountNow(), address: addresses.batcher, abi: abis.batcher, functionName: "multicall", args: [calls] };

    // Dry run: learn which calls would fail and drop them before paying for anything.
    let ok;
    try {
      ({ result: ok } = await publicClient.simulateContract(request));
    } catch (error) {
      const reason = explainRevert(abis, error);
      log.error(`batch simulation failed outright: ${reason}`);
      for (const job of batch) job.done({ ok: false, reason });
      return;
    }

    const failed = batch.filter((_, i) => !ok[i]);
    const live = batch.filter((_, i) => ok[i]);
    for (const job of failed) {
      // Ask the node why, one call at a time. Only failures pay this extra round trip.
      let reason = "would revert";
      try {
        await publicClient.simulateContract({ account: accountNow(), address: addresses.exchange, abi: abis.exchange, functionName: job.functionName, args: job.args });
      } catch (error) {
        reason = explainRevert(abis, error);
      }
      log.warn(`skip ${job.label}: ${reason}`);
      job.done({ ok: false, reason });
    }
    if (live.length === 0) return;

    const liveCalls = live.map((job) => encodeFunctionData({ abi: abis.exchange, functionName: job.functionName, args: job.args }));
    const liveRequest = { ...request, args: [liveCalls] };
    try {
      const gas = await publicClient.estimateContractGas(liveRequest);
      const { hash, receipt } = await sendAndWait({ ...liveRequest, gas: (gas * 12n) / 10n + GAS_HEADROOM }, `batch of ${live.length}`);
      const failures = new Map(
        parseEventLogs({ abi: abis.batcher, logs: receipt.logs, eventName: "CallFailed" }).map((l) => [Number(l.args.index), l.args.reason]),
      );
      log.info(`batch of ${live.length} ${receipt.status} gas=${receipt.gasUsed} ${hash}`);
      live.forEach((job, i) => {
        if (receipt.status !== "success") job.done({ ok: false, reason: "batch reverted", hash });
        else if (failures.has(i)) job.done({ ok: false, reason: explainBytes(abis, failures.get(i)), hash });
        else job.done({ ok: true, hash, receipt });
      });
    } catch (error) {
      const reason = explainRevert(abis, error);
      log.error(`batch send failed: ${reason}`);
      for (const job of live) job.done({ ok: false, reason });
    }
  }

  return {
    push,
    /** Every operator wallet and its ETH, for the status page. */
    gasReport: async () => Promise.all(operators.map(async (o) => ({ address: o.account.address, eth: await balanceOf(o).catch(() => null), current: o === current }))),
  };
}
