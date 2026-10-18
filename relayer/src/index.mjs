/**
 * Relayer entry point: wires the price source, the indexer, the engine, the keeper and the API.
 *
 *   node src/index.mjs
 */
import { erc20Abi } from "viem";
import { loadConfig } from "./config.mjs";
import { createChain, createTxQueue } from "./chain.mjs";
import { createStore, createIndexer } from "./indexer.mjs";
import { createBook } from "./prices/book.mjs";
import { createDevSource } from "./prices/dev.mjs";
import { createHermesSource } from "./prices/hermes.mjs";
import { join } from "node:path";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { createHyperliquidSource, createCoinbaseReference, createOracleReference, coinOfFeed } from "./prices/hyperliquid.mjs";
import { createPrintLog } from "./prices/printlog.mjs";
import { createPrintSigner, SIGNED_ORACLE_ABI } from "./prices/signer.mjs";
import { createExecutionSigner, createExecutions } from "./prices/execution.mjs";
import { createEngine } from "./engine.mjs";
import { createKeeper } from "./keeper.mjs";
import { createDepositWatcher } from "./deposits.mjs";
import { createSampler } from "./series.mjs";
import { createReferrals } from "./referrals.mjs";
import { createApi } from "./server.mjs";
import { createFeed } from "./feed.mjs";
import { createJackpot } from "./jackpot.mjs";
import { createHub, createLogger } from "./util.mjs";
import { EXEC_DELAY, PIN_WINDOW, INTENT_TTL, DIRECT_DELAY, WITHDRAW_DELAY, GRACE, REQUEST_EXPIRY } from "../../shared/eip712.mjs";
import { FEE_BPS } from "../../shared/math.mjs";
import { refreshRecovery } from "./recovery.mjs";

/** The Exchange's own rules, as the code in shared/ assumes them. Checked against the contract at start. */
const RULES = { EXEC_DELAY, PIN_WINDOW, INTENT_TTL, DIRECT_DELAY, WITHDRAW_DELAY, GRACE, REQUEST_EXPIRY, FEE_BPS, MAX_OPEN_POSITIONS: 200, STAKER_SHARE_BPS: 5_000 };

const log = createLogger();
const config = loadConfig();
const chain = createChain(config);
await refreshRecovery({ config, chain });

const actualChainId = await chain.publicClient.getChainId();
if (actualChainId !== config.chainId) {
  throw new Error(`RPC is chain ${actualChainId} but CHAIN_ID is ${config.chainId}.`);
}
const signedPrices = config.oracleKind === "signed";
const orderBound = config.executionMode === "order-bound";
if (orderBound && (!signedPrices || config.priceSource !== "hyperliquid")) throw new Error("Order-bound execution requires the Hyperliquid ExecutionOracle deployment.");
if (!["dev", "hermes", "hyperliquid"].includes(config.priceSource)) {
  throw new Error(`PRICE_SOURCE is "${config.priceSource}": it is dev, hermes or hyperliquid.`);
}
if (config.priceSource === "dev" && config.chainId !== 31337) {
  throw new Error("The dev price source makes its prices up. It is for a local chain (31337) only.");
}
if (config.priceSource === "hermes" && signedPrices) {
  throw new Error("This deployment's oracle takes prices signed by its price signer, not Pyth's updates. Use PRICE_SOURCE=hyperliquid.");
}
if (config.priceSource === "hyperliquid" && !signedPrices) {
  throw new Error("This deployment's oracle reads Pyth. The Hyperliquid source signs prints for a SignedOracle deployment.");
}
// The deployment file names an oracle. It has to be the one the Exchange itself is priced by, or
// everything signed here would be signed for a contract nobody asks.
const exchangeOracle = await chain.read("exchange", "oracle");
if (exchangeOracle.toLowerCase() !== chain.addresses.oracle.toLowerCase()) {
  throw new Error(`The Exchange is priced by the oracle at ${exchangeOracle}; the deployment file says ${chain.addresses.oracle}. This is not the right deployment file.`);
}
// The price signer: on a signed deployment this key is where every price comes from.
let signer = null;
if (signedPrices) {
  if (!config.priceSignerKey) throw new Error("Set PRICE_SIGNER_KEY or PRICE_SIGNER_KEY_FILE: this deployment's prices are signed by its price signer.");
  signer = (orderBound ? createExecutionSigner : createPrintSigner)({ privateKey: config.priceSignerKey, chainId: config.chainId, oracle: chain.addresses.oracle });
  const expected = await chain.publicClient.readContract({ address: chain.addresses.oracle, abi: SIGNED_ORACLE_ABI, functionName: "signer" });
  if (expected.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`The oracle takes prices signed by ${expected}; the price signer key given is ${signer.address}'s. Give the right key, or have the owner call setSigner.`);
  }
  if (signer.address.toLowerCase() === chain.account.address.toLowerCase() && config.chainId !== 31337) {
    throw new Error("The price signer and the operator are the same key. Prices need a key of their own: the operator's sends every transaction, and one key doing both would send trades at prices it alone decides.");
  }
}
for (const { account } of chain.operators) {
  if (!(await chain.read("exchange", "isOperator", [account.address]))) {
    throw new Error(`${account.address} is not an operator of the Exchange. Call setOperator first.`);
  }
}
if (chain.operators.length > 1) log.info(`gas: ${chain.operators.length} operator wallets; the queue sends from the first with ${config.gasMinEth} ETH or more`);
// The timing rules live in the contract and, as plain numbers, in shared/ (the site prices and
// stamps orders with them too). They have to be the same numbers.
for (const [name, expected] of Object.entries(RULES)) {
  if (name === "EXEC_DELAY" && config.recoveryState?.paused) continue;
  const actual = await chain.read("exchange", name);
  const rule = name === "EXEC_DELAY" && orderBound ? 0 : expected;
  if (BigInt(actual) !== BigInt(rule)) {
    throw new Error(`The Exchange says ${name} is ${actual}; this execution mode expects ${rule}. This relayer was not built for this deployment.`);
  }
}

// The coin's ticker is shown all over the site; read it once.
if (chain.addresses.coin) {
  config.deployment.coinSymbol = await chain.publicClient.readContract({ address: chain.addresses.coin, abi: erc20Abi, functionName: "symbol" });
}

const hub = createHub();
const store = createStore();
// The queue, the indexer and the keeper all need each other; these late-bound hooks tie the knot.
const hooks = { onEvent: () => {}, onSettled: () => {} };
const queue = createTxQueue({ chain, log, config, onSettled: (...args) => hooks.onSettled(...args), onLowGas: (text) => feed.alert(text) });
// Referrals are added up from the trades the indexer replays, so they exist before it starts. What
// they ask of the engine and the API (made further down) is asked late, when somebody is bound.
const late = { engine: null, api: null };
const referrals = createReferrals({
  config,
  chain,
  log,
  tradesOf: (owner) => store.users.get(owner.toLowerCase())?.trades ?? 0,
  isSessionKey: (owner, key) => late.engine.isSessionKey(owner, key),
  addressOfName: (name) => late.api.addressOfName(name),
  payer: config.referralPayer ?? (await chain.read("exchange", "devRecipient").catch(() => null)),
});
/** Set once the API exists (it knows the usernames). Trades replayed before then are history, not news. */
let feed = { onTrade() {}, onJackpot() {}, alert() {} };
const indexer = createIndexer({ config, chain, store, hub, log, reservedOf: owner => late.engine?.reservedOf(owner) ?? 0n, onEvent: (...args) => hooks.onEvent(...args), onTrade: (trade) => {
    referrals.onTrade(trade);
    feed.onTrade(trade);
  } });
await indexer.start();

// A retired market settles at its frozen price for good and needs no more prices.
const markets = store.markets.filter((m) => m.feedId && !m.retired);
const book = createBook(markets.map((m) => m.id));
const source =
  config.priceSource === "hermes"
    ? createHermesSource({ markets, book, log, baseUrl: config.hermesUrl, apiKey: config.pythApiKey })
    : config.priceSource === "hyperliquid"
      ? createHyperliquidSource({
          markets,
          book,
          signer,
          orderBound,
          log,
          // Every print goes to disk before it is used, and a restart carries on from there.
          printLog: createPrintLog({ dir: config.dataDir, chainId: config.chainId, oracle: chain.addresses.oracle, signer: signer.address }),
          retired: (id) => Boolean(store.markets[id]?.retired),
          wsUrl: config.hyperliquidWsUrl,
          apiUrl: config.hyperliquidApiUrl,
          sanityBps: config.priceSanityBps,
          maxSpreadBps: config.priceMaxSpreadBps,
          // The coin to compare is the coin being priced: both come from the market's feed id.
          reference: (() => {
            if (!config.priceSanityBps || config.priceReference === "none") return null;
            const coins = [...new Set(markets.map((m) => coinOfFeed(m.feedId)).filter(Boolean))];
            if (config.priceReference === "coinbase") return createCoinbaseReference({ symbols: coins, log });
            return createOracleReference({ coins, log, apiUrl: config.hyperliquidApiUrl });
          })(),
        })
      : createDevSource({ markets, book, log, signer });
if (config.priceSource === "hyperliquid") {
  if (config.priceReference !== "none" && config.priceSanityBps > 0) log.info(`price cross-check: on. No price is signed while Hyperliquid's book is more than ${config.priceSanityBps} bps from ${config.priceReference === "coinbase" ? "Coinbase" : "Hyperliquid's own oracle price"}.`);
  else log.warn("price cross-check: OFF. Whatever Hyperliquid's feed says is signed.");
}

// The first print of each market is shown to the oracle before anything is built on it. If the
// contract refuses what this process signs (wrong chain, wrong oracle, wrong encoding), every
// order would fail on-chain after being shown as filled: better to stop here and say so.
if (signer) {
  const unchecked = new Set(markets.map((m) => m.id));
  const off = book.onTick(async (marketId, print) => {
    if (!unchecked.delete(marketId)) return;
    if (!unchecked.size) off();
    const market = markets.find((m) => m.id === marketId);
    // Only the contract saying no is a refusal. An RPC that did not answer is asked again.
    for (let attempt = 0; ; attempt++) {
      try {
        const [price] = await chain.publicClient.readContract({
          address: chain.addresses.oracle,
          abi: SIGNED_ORACLE_ABI,
          functionName: "read",
          args: [market.feedId, [print.blob]],
        });
        if (price !== print.price) throw Object.assign(new Error(`it read ${price} from a print of ${print.price}`), { refused: true });
        log.info(`price signer: the oracle accepts this relayer's ${market.symbol} prints`);
        return;
      } catch (error) {
        const refused = error.refused || (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError));
        if (refused || attempt >= 5) {
          log.error(`The oracle ${refused ? "REFUSES" : "could not be asked about"} the ${market.symbol} prints this relayer signs. Stopping.`, error);
          process.exit(1);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  });
  // The owner can replace the signer while this runs. From that block every print signed here is
  // refused, so there is nothing left for this process to do but say so and stop.
  setInterval(async () => {
    try {
      const current = await chain.publicClient.readContract({ address: chain.addresses.oracle, abi: SIGNED_ORACLE_ABI, functionName: "signer" });
      if (current.toLowerCase() === signer.address.toLowerCase()) return;
      log.error(`The oracle's price signer is now ${current}, not this relayer's ${signer.address}: nothing signed here counts any more. Stopping. Give the relayer the new key and start it again.`);
      process.exit(1);
    } catch {
      // The RPC did not answer; asked again in a moment.
    }
  }, 20_000).unref();
}

const executions = orderBound ? await createExecutions({ dir: config.dataDir, chainId: config.chainId, oracle: chain.addresses.oracle, signer, source }) : null;
const engine = createEngine({ config, chain, book, source, store, queue, hub, log, executions, onPricedOpen: id => keeper.rescan(id), onCloseReleased: id => keeper.rescan(id) });
const keeper = createKeeper({ config, chain, book, source, store, queue, engine, indexer, log });
const sampler = createSampler({ config, chain, store, book, log });
// A deposit lands in the Exchange's own event like any other; pick it up at once.
const deposits = createDepositWatcher({ config, chain, queue, log, onCollected: () => indexer.tick() });
// The Rekt Jackpot: closes and draws each hour's round, and its winners go to the feed too.
const jackpot = createJackpot({ chain, queue, hub, log, onDraw: (draw) => feed.onJackpot(draw), nameOf: (address) => api.nameOf(address) });
const api = createApi({ config, chain, book, store, engine, indexer, hub, source, sampler, deposits, referrals, jackpot, queue, log });
// Big wins and liquidations to Telegram and X, when configured (see feed.mjs). Names come from the API's usernames.
feed = createFeed({ config, store, log, nameOf: (address) => api.nameOf(address) });
late.engine = engine;
late.api = api;

// After any close, give the keeper a chance to pay the queue.
hooks.onEvent = (eventName, args) => {
  if (eventName === "PositionClosed") setTimeout(() => keeper.harvest(), 50);
  if (orderBound && eventName === "PositionOpened") keeper.rescan(args.id);
};
// One of our transactions settled: pick its events up now rather than at the next poll. And if a
// close fell through, re-check the position for a bust touch that was skipped on its account.
hooks.onSettled = (job, result) => {
  indexer.tick();
  if (!result.ok && job.functionName === "close") keeper.rescan(job.args[0].positionId);
};

if (!config.readOnlyOpens || store.positions.size > 0) source.start();
keeper.start();
deposits.start();
sampler.start();
referrals.start();
jackpot.start();
await api.listen();
log.info(
  `ready: chain ${config.chainId}, exchange ${chain.addresses.exchange}, operator ${chain.account.address}, prices from ${source.name}${signer ? ` signed by ${signer.address}` : ""}, ${markets.length} markets`,
);

// A promise somebody forgot to catch must not end the process: by default it does, and every
// trader's orders stop with it. It is logged, loudly, and the relayer carries on.
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", reason instanceof Error ? reason : new Error(String(reason)));
});
// A thrown error nobody caught leaves things in an unknown state. Say what it was and stop, so the
// service manager starts a clean process.
process.on("uncaughtException", (error) => {
  log.error("uncaught exception, exiting", error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    log.info(`${signal}: shutting down`);
    source.stop();
    keeper.stop();
    deposits.stop();
    sampler.stop();
    indexer.stop();
    await api.close();
    process.exit(0);
  });
}
