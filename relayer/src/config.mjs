/**
 * Configuration. Everything comes from the environment (or a .env file at the repo root), with
 * defaults that run against a local anvil chain deployed by script/DevDeploy.s.sol.
 *
 *   CHAIN_ID             chain the relayer serves                  31337
 *   RELAYER_RPC_URL      JSON-RPC endpoint (falls back to RPC_URL)   http://127.0.0.1:8545
 *   DEPLOYMENT           deployment file                           deployments/<chainId>.json
 *   OPERATOR_KEY         operator private key (hex)                anvil account 1 on chain 31337
 *   OPERATOR_KEY_FILE    file holding the operator key             -
 *   BACKUP_OPERATOR_KEY_FILES  files holding backup operator keys, comma separated: each must be an
 *                        operator of the Exchange too. The queue sends from the first wallet that
 *                        still has GAS_MIN_ETH, so trading carries on when the main one runs dry.
 *   GAS_MIN_ETH          below this an operator wallet is passed over, and reported   0.02
 *   CASH_FLOOR_USD       a side of a market may hold this much whatever the vault's cash   2000000
 *   CASH_MULTIPLE        ...plus this many times the vault's cash (0: relayer check off; on-chain ceiling remains)     50
 *   PRICE_SOURCE         "hyperliquid", "hermes" or "dev"          dev on 31337; elsewhere what the deployment's
 *                                                                  oracle takes: hyperliquid if its prices are
 *                                                                  signed (oracleKind "signed"), hermes if Pyth's
 *   PRICE_SIGNER_KEY     the price signer's private key (hex)      anvil account 9 on chain 31337
 *   PRICE_SIGNER_KEY_FILE  file holding the price signer's key     -
 *   HYPERLIQUID_WS_URL   Hyperliquid websocket                     wss://api.hyperliquid.xyz/ws
 *   HYPERLIQUID_API_URL  Hyperliquid REST base URL                 https://api.hyperliquid.xyz
 *   PRICE_SANITY_BPS     furthest a Hyperliquid price may be from the reference before nothing is signed
 *                        (0 = no cross-check)                      150
 *   PRICE_REFERENCE      second opinion for that check: "oracle" (Hyperliquid's oracle price, every market), "coinbase" or "none"   oracle
 *   PRICE_MAX_SPREAD_BPS widest Hyperliquid book whose middle is signed, bid to ask (0 = no limit)   100
 *   PYTH_API_KEY         Hermes key, entitled to the listed feeds  -
 *   HERMES_URL           Hermes base URL                           https://hermes.pyth.network
 *   PORT                 HTTP port                                 8787
 *   HOST                 interface to listen on (127.0.0.1 = this machine only)   every interface
 *   CORS_ORIGIN          allowed browser origin(s), comma separated *
 *   DATA_DIR             persistent Tape state and signed-price logs relayer/data
 *   RATE_LIMIT           intents per owner per minute              40
 *   DEPOSIT_MIN_USD      smallest amount at a deposit address worth collecting   5 (1 on 31337)
 *   READ_LIMIT           read requests per caller per minute       600 (6000 on 31337, where the test suites hammer it)
 *   TRUST_PROXY          how many reverse proxies are in front (each appends to X-Forwarded-For)   0
 *   ORACLE_TOPUP_ETH     top the oracle float up by this much when it runs low (0 = never)   0
 *   STAKER_PUSH_SECONDS  how often stakers are paid                5 on 31337, 300 elsewhere
 *   STAKER_PUSH_MIN_USD  smallest amount worth a payout transaction   1 on 31337, 25 elsewhere
 *   POLL_MS              how often to look for new blocks          700 on 31337, 4000 elsewhere
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// anvil's well-known account 1. Worthless anywhere but a local chain.
const ANVIL_OPERATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
// anvil's account 9: the price signer script/DevDeploy.s.sol gives its oracle.
const ANVIL_PRICE_SIGNER_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

function loadDotEnv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
  );
}

export function loadConfig(env = process.env) {
  const merged = { ...loadDotEnv(), ...env };
  const get = (name, fallback) => (merged[name] !== undefined && merged[name] !== "" ? merged[name] : fallback);

  const rpcUrl = get("RELAYER_RPC_URL", get("RPC_URL", "http://127.0.0.1:8545"));
  const chainId = Number(get("CHAIN_ID", "31337"));

  const deploymentPath = get("DEPLOYMENT", join("deployments", `${chainId}.json`));
  const deploymentFile = isAbsolute(deploymentPath) ? deploymentPath : join(ROOT, deploymentPath);
  if (!existsSync(deploymentFile)) {
    throw new Error(`No deployment file at ${deploymentFile}. Deploy first, or set DEPLOYMENT.`);
  }
  const deployment = JSON.parse(readFileSync(deploymentFile, "utf8"));
  const executionMode = deployment.executionMode ?? "delayed";
  if (!["delayed", "order-bound"].includes(executionMode)) throw new Error("Unknown deployment executionMode.");
  // The coin is attached later on mainnet and lives in its own file.
  const coinFile = deploymentFile.replace(/\.json$/, "-coin.json");
  if (existsSync(coinFile)) Object.assign(deployment, JSON.parse(readFileSync(coinFile, "utf8")));

  let operatorKey = get("OPERATOR_KEY");
  const keyFile = get("OPERATOR_KEY_FILE");
  if (!operatorKey && keyFile) operatorKey = readFileSync(keyFile, "utf8").trim();
  if (!operatorKey && chainId === 31337) operatorKey = ANVIL_OPERATOR_KEY;
  if (!operatorKey) throw new Error("Set OPERATOR_KEY or OPERATOR_KEY_FILE.");
  const backupOperatorKeys = (get("BACKUP_OPERATOR_KEY_FILES", "") ?? "")
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean)
    .map((file) => {
      const key = readFileSync(file, "utf8").trim();
      return key.startsWith("0x") ? key : `0x${key}`;
    });
  const gasMinEth = Number(get("GAS_MIN_ETH", "0.02"));
  if (!Number.isFinite(gasMinEth) || gasMinEth < 0) throw new Error("GAS_MIN_ETH is a finite nonnegative number of ETH, such as 0.02.");
  const cashFloorUsd = Number(get("CASH_FLOOR_USD", "2000000"));
  const cashMultiple = Number(get("CASH_MULTIPLE", "50"));
  if (!Number.isSafeInteger(cashFloorUsd) || cashFloorUsd < 0 || !Number.isSafeInteger(cashMultiple) || cashMultiple < 0) throw new Error("CASH_FLOOR_USD and CASH_MULTIPLE must be nonnegative safe integers; CASH_MULTIPLE 0 disables only the relayer's additional limit.");
  if (!operatorKey.startsWith("0x")) operatorKey = `0x${operatorKey}`;

  // "signed": the oracle takes prints signed by the deployment's price signer (SignedOracle).
  // "pyth": it takes Pyth's own updates. Deployments from before the choice existed are Pyth's.
  const oracleKind = deployment.oracleKind ?? "pyth";
  let priceSignerKey = get("PRICE_SIGNER_KEY");
  const signerFile = get("PRICE_SIGNER_KEY_FILE");
  if (!priceSignerKey && signerFile) priceSignerKey = readFileSync(signerFile, "utf8").trim();
  if (!priceSignerKey && chainId === 31337 && oracleKind === "signed") priceSignerKey = ANVIL_PRICE_SIGNER_KEY;
  if (priceSignerKey && !priceSignerKey.startsWith("0x")) priceSignerKey = `0x${priceSignerKey}`;

  // The guards on what gets signed. A typo here must stop the relayer, not quietly switch one off.
  const bps = (name, fallback) => {
    const text = get(name, fallback);
    if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`${name} is "${text}": it is a number of basis points, such as ${fallback}. 0 switches the check off.`);
    return Number(text);
  };
  const priceSanityBps = bps("PRICE_SANITY_BPS", "150");
  const priceMaxSpreadBps = bps("PRICE_MAX_SPREAD_BPS", "100");
  const priceReference = get("PRICE_REFERENCE", "oracle");
  // Weekly seasons: the share of each week's fees paid to its top ten, out of the team's half.
  const seasonPrizeBps = bps("SEASON_PRIZE_BPS", "1000");
  if (seasonPrizeBps > 5000) throw new Error(`SEASON_PRIZE_BPS is ${seasonPrizeBps}: prizes come out of the team's half of the fees, so at most 5000.`);
  if (!["oracle", "coinbase", "none"].includes(priceReference)) throw new Error(`PRICE_REFERENCE is "${priceReference}": it is oracle, coinbase or none.`);

  return {
    backupOperatorKeys,
    gasMinEth,
    cashFloorUsd,
    cashMultiple,
    seasonPrizeBps,
    root: ROOT,
    dataDir: get("DATA_DIR", join(ROOT, "relayer", "data")),
    rpcUrl,
    chainId,
    deployment,
    operatorKey,
    oracleKind,
    priceSignerKey,
    priceSource: get("PRICE_SOURCE", chainId === 31337 ? "dev" : oracleKind === "signed" ? "hyperliquid" : "hermes"),
    executionMode,
    readOnlyOpens: get("READ_ONLY_OPENS", "0") === "1",
    hyperliquidWsUrl: get("HYPERLIQUID_WS_URL", "wss://api.hyperliquid.xyz/ws"),
    hyperliquidApiUrl: get("HYPERLIQUID_API_URL", "https://api.hyperliquid.xyz"),
    priceSanityBps,
    priceMaxSpreadBps,
    priceReference,
    pythApiKey: get("PYTH_API_KEY"),
    hermesUrl: get("HERMES_URL", "https://hermes.pyth.network"),
    port: Number(get("PORT", "8787")),
    host: get("HOST"),
    supportAdmins: get("SUPPORT_ADMINS", "").split(",").map(value => value.trim()).filter(Boolean),
    supportDataDir: get("SUPPORT_DATA_DIR"),
    corsOrigin: get("CORS_ORIGIN", "*"),
    rateLimit: Number(get("RATE_LIMIT", "40")),
    depositMinUsd: Number(get("DEPOSIT_MIN_USD", chainId === 31337 ? "1" : "5")),
    // Referrals: the referrer's share of the TEAM's half of every fee a referred trader pays, in
    // basis points (5000 = half of the team's half = a quarter of the fee). Never above 10000:
    // the stakers' half is not the team's to give.
    referralShareBps: Math.min(10_000, Math.max(0, Math.floor(Number(get("REFERRAL_SHARE_BPS", "5000"))) || 0)),
    // The wallet referral payouts are sent from: USDC it sends a referrer counts as paid. Unset:
    // the wallet the Exchange sends the team's fees to.
    referralPayer: get("REFERRAL_PAYER"),
    // What the relayer's own transactions tip the block builder, in gwei: never less than the
    // floor (a tip of nothing is left lying for minutes), never more than the cap.
    tipFloorGwei: Number(get("TIP_FLOOR_GWEI", "0.05")),
    tipCapGwei: Number(get("TIP_CAP_GWEI", "3")),
    // A transaction not in a block after this long is sent again, same nonce, paying more.
    bumpAfterMs: Number(get("BUMP_AFTER_MS", "15000")),
    receiptPollMs: Number(get("RECEIPT_POLL_MS", chainId === 31337 ? "150" : "1500")),
    // Ten reads a second, every second, is far more than the site asks for.
    readLimit: Number(get("READ_LIMIT", chainId === 31337 ? "6000" : "600")),
    // A count, not a switch: the caller's address is that many entries from the right-hand end of
    // X-Forwarded-For. 1 is one reverse proxy; a CDN in front of that proxy makes it 2.
    trustProxy: Math.max(0, Math.floor(Number(get("TRUST_PROXY", "0"))) || 0),
    oracleTopUpEth: get("ORACLE_TOPUP_ETH", "0"),
    stakerPushSeconds: Number(get("STAKER_PUSH_SECONDS", chainId === 31337 ? "5" : "300")),
    stakerPushMinUsd: Number(get("STAKER_PUSH_MIN_USD", chainId === 31337 ? "1" : "25")),
    // How often to look for new blocks. Local chains mine on demand.
    pollMs: Number(get("POLL_MS", chainId === 31337 ? "700" : "4000")),
  };
}

export function loadAbi(name) {
  return JSON.parse(readFileSync(join(ROOT, "abi", `${name}.json`), "utf8"));
}
