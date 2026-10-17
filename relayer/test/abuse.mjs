/**
 * API abuse suite. Runs against a running relayer and a local chain (script/DevDeploy.s.sol) and
 * tries to make the relayer crash, answer 500, accept something it should refuse, or let one
 * account get in another's way.
 *
 *   node relayer/test/abuse.mjs [relayer-url] [--rpc=http://127.0.0.1:8545] [--quick] [--only=a,b] [--forwarded]
 *
 *   --forwarded   names each client in an X-Forwarded-For header instead of sending from its own
 *                 loopback address. For machines whose firewall refuses connections from
 *                 127.0.0.2 and up (Windows does this at times). The relayer has to be started
 *                 with TRUST_PROXY=1, so that the header is what it limits by.
 *   --quick       skips the position-cap run (about five minutes: 200 positions at 40 orders a
 *                 minute) and the two waits for a rate limit to recover (a minute each)
 *   --only=...    run only the named sections: get, post, sign, money, isolate, limits, cap
 *                 (and proxy, which is never run otherwise: it needs a relayer started with
 *                 TRUST_PROXY=1 and checks that a sender cannot choose the address it is limited by)
 *
 * Prints one line per check and exits non-zero if any failed. It makes its own accounts (fresh
 * keys funded with mock USDC) and leaves the built-in test wallets alone. The position-cap run
 * leaves 200 one-dollar positions open on the local chain.
 *
 * The relayer limits writes per client address. The suite talks to it from many loopback addresses
 * (127.0.0.x), so each kind of traffic has its own allowance, and so a check can tell "this client
 * is limited" from "everybody is". Where the machine has no such addresses, run it with
 * --forwarded. Without either it paces itself to one client's allowance, and the checks that are
 * about one client against another cannot all pass.
 */
import http from "node:http";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http as rpcHttp, parseSignature, parseAbi, parseAbiItem } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { domain as buildDomain, sessionDomain, types, permitTypes } from "../../shared/eip712.mjs";

const args = process.argv.slice(2);
const API = new URL(args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787");
const RPC = args.find((a) => a.startsWith("--rpc="))?.slice(6) ?? "http://127.0.0.1:8545";
const QUICK = args.includes("--quick");
const FORWARDED = args.includes("--forwarded");
const ONLY = args.find((a) => a.startsWith("--only="))?.slice(7).split(",") ?? null;
const wants = (section) => !ONLY || ONLY.includes(section);

const abi = (name) => JSON.parse(readFileSync(new URL(`../../abi/${name}.json`, import.meta.url), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toJson = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const usd = (v) => (Number(v) / 1e6).toFixed(2);
const USDC = (dollars) => BigInt(Math.round(dollars * 1e6));

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

let passed = 0;
const failures = [];
const skipped = [];

async function check(name, fn) {
  try {
    const note = await fn();
    passed += 1;
    console.log(`  ok   ${name}${note ? `  [${note}]` : ""}`);
  } catch (error) {
    failures.push(name);
    const lines = String(error?.message ?? error).split("\n").slice(0, 14);
    console.log(`  FAIL ${name}\n       ${lines.join("\n       ")}`);
  }
}
const skip = (name, why) => {
  skipped.push(name);
  console.log(`  skip ${name}  [${why}]`);
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const section = (name) => console.log(`\n${name}`);
const brief = (res) => (!res ? "(none)" : res.status ? `${res.status} ${String(res.text ?? "").slice(0, 110)}` : `no answer (${res.error})`);

// ---------------------------------------------------------------------------------------------
// HTTP, from any loopback address
// ---------------------------------------------------------------------------------------------

/** relayer/src/server.mjs: writes one client address may send in a minute. */
const POSTS_PER_MINUTE = 400;

let multiClient = false;
/** The loopback address a client's requests leave from, where the machine allows that. */
const localAddress = (client) => (multiClient && !FORWARDED && client ? `127.0.0.${client}` : undefined);
/** With --forwarded: the header that names the client instead. */
const namedAs = (client) => (multiClient && FORWARDED && client ? { "x-forwarded-for": `127.0.0.${client}` } : {});
/** The same, as a line of a request written out by hand. */
const namedAsLine = (client) => (multiClient && FORWARDED && client ? `X-Forwarded-For: 127.0.0.${client}\r\n` : "");

// With one address only, everything shares one client's writes a minute.
const sentAt = [];
async function pace() {
  if (multiClient) return;
  for (;;) {
    const cutoff = Date.now() - 61_000;
    while (sentAt.length && sentAt[0] < cutoff) sentAt.shift();
    if (sentAt.length < POSTS_PER_MINUTE - 30) break;
    await sleep(500);
  }
  sentAt.push(Date.now());
}

let rotation = 0;
/** A client address for traffic that does not care who it comes from: 180 of them in turn. */
const anyClient = () => 10 + (rotation++ % 180);

function request({ method = "GET", path, body, headers = {}, client = 1, timeout = 10_000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : toJson(body));
    const done = (result) => resolve({ ms: Date.now() - started, ...result });
    let req;
    try {
      req = http.request(
        {
          host: API.hostname,
          port: API.port,
          method,
          path,
          agent: false,
          localAddress: localAddress(client),
          timeout,
          headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...namedAs(client), ...headers },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              // Not JSON; the caller sees `text`.
            }
            done({ status: res.statusCode, text, json, headers: res.headers });
          });
          res.on("error", (error) => done({ status: 0, error: error.code ?? error.message }));
        },
      );
    } catch (error) {
      return done({ status: 0, error: error.code ?? error.message });
    }
    req.on("timeout", () => {
      req.destroy();
      done({ status: 0, error: "timeout" });
    });
    req.on("error", (error) => done({ status: 0, error: error.code ?? error.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (path, client = 1) => request({ path, client });
async function post(path, body, client = anyClient(), paced = false) {
  if (!paced) await pace();
  return request({ method: "POST", path, body, client });
}
/** GET that must work: for reading state, not for testing the route. */
async function read(path) {
  const res = await get(path);
  if (res.status !== 200) throw new Error(`GET ${path}: ${brief(res)}`);
  return res.json;
}

/** Bytes straight onto a socket, for requests no HTTP client would agree to send. */
function raw(text, { client = 1, timeout = 4_000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: API.hostname, port: Number(API.port), localAddress: localAddress(client) });
    let data = "";
    const finish = (error) => {
      clearTimeout(timer);
      socket.destroy();
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0);
      resolve({ status, text: data.slice(0, 300), error: status ? undefined : (error ?? "closed without an answer") });
    };
    const timer = setTimeout(() => finish("timeout"), timeout);
    socket.on("connect", () => socket.write(text));
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      // One response is all we want.
      if (/\r\n\r\n/.test(data)) setTimeout(() => finish(), 60);
    });
    socket.on("error", (error) => finish(error.code));
    socket.on("close", () => finish());
  });
}

/** Opens an event stream and leaves it open. Resolves once the status line is in. */
function openStream(client, query = "") {
  return new Promise((resolve) => {
    const req = http.request({ host: API.hostname, port: API.port, path: `/stream${query}`, agent: false, localAddress: localAddress(client), headers: namedAs(client) }, (res) => {
      res.on("data", () => {});
      res.on("error", () => {});
      resolve({ status: res.statusCode, type: res.headers["content-type"], close: () => req.destroy() });
    });
    req.on("error", (error) => resolve({ status: 0, error: error.code, close: () => {} }));
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------
// The chain, the relayer's settings, signing
// ---------------------------------------------------------------------------------------------

const rpc = createPublicClient({ chain: foundry, transport: rpcHttp(RPC) });
// anvil account 9: nothing else in the project uses it. Mints mock USDC for the suite's accounts.
const funder = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");
const funderWallet = createWalletClient({ account: funder, chain: foundry, transport: rpcHttp(RPC) });
const MINT = parseAbi(["function mint(address to, uint256 amount)"]);
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const exchangeAbi = abi("Exchange");
const sessionsAbi = abi("Sessions");

const first = await get("/config");
if (first.status !== 200) {
  console.error(`No relayer at ${API.href}: ${brief(first)}`);
  process.exit(2);
}
const config = first.json;
if (config.chainId !== 31337) {
  console.error("This suite is for the local chain only: it mints mock USDC and moves the simulated price.");
  process.exit(2);
}
// Whether this machine lets a request leave from other loopback addresses has to be found out with
// requests that really do: `request` only uses them once this is set. (It used to be asked through
// `request` itself, which was still sending from the default address, so the answer was always
// yes; on a machine whose firewall refuses those connections every later check then failed.)
const reaches = (from) =>
  new Promise((resolve) => {
    const probe = http.request({ host: API.hostname, port: API.port, path: "/health", agent: false, localAddress: from, timeout: 2_000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200));
    });
    probe.on("error", () => resolve(false));
    probe.on("timeout", () => probe.destroy());
    probe.end();
  });
if (FORWARDED) {
  // The relayer only goes by the header if it was started with TRUST_PROXY=1. Find out: one
  // client's read allowance is used up under one name, and a read under another name still works.
  multiClient = true;
  const flood = await Promise.all(Array.from({ length: POSTS_PER_MINUTE + 5 }, () => request({ method: "POST", path: "/open", body: "{}", client: 250 })));
  const limited = flood.some((r) => r.status === 429);
  const other = await request({ method: "POST", path: "/open", body: "{}", client: 251 });
  if (!limited || other.status === 429) {
    console.error("--forwarded needs a relayer started with TRUST_PROXY=1: it is not limiting by the X-Forwarded-For header.");
    process.exit(2);
  }
} else {
  multiClient = (await reaches("127.0.0.2")) && (await reaches("127.0.0.10")) && (await reaches("127.0.0.199"));
}

const A = config.addresses;
const domain = buildDomain(config.name, config.chainId, A.exchange);
const usdcDomain = { name: config.usdcPermit.name, version: config.usdcPermit.version, chainId: config.chainId, verifyingContract: A.usdc };
const offset = config.time - Date.now();
const now = () => Math.floor((Date.now() + offset) / 1000);
// Orders are stamped the way the site stamps them: never with a second that has already passed.
const stamp = () => BigInt(Math.floor((Date.now() + offset) / 1000 + 0.25));
/** Resolves in the middle part of a second by the relayer's clock. */
async function midSecond() {
  for (;;) {
    const part = (Date.now() + offset) % 1000;
    if (part >= 150 && part <= 600) return;
    await sleep(40);
  }
}
let saltCounter = BigInt(Date.now()) * 1000n;
const salt = () => (saltCounter += 1n);
const fresh = () => privateKeyToAccount(generatePrivateKey());
const exRead = (functionName, params = []) => rpc.readContract({ address: A.exchange, abi: exchangeAbi, functionName, args: params });
const usdcOf = (address) => rpc.readContract({ address: A.usdc, abi: ERC20, functionName: "balanceOf", args: [address] });

// Transactions from the funder go out one at a time.
let funding = Promise.resolve();
function mint(to, amount) {
  const run = funding.then(async () => {
    const hash = await funderWallet.writeContract({ address: A.usdc, abi: MINT, functionName: "mint", args: [to, amount] });
    await rpc.waitForTransactionReceipt({ hash });
  });
  funding = run.catch(() => {});
  return run;
}
const giveEth = (address) => rpc.request({ method: "anvil_setBalance", params: [address, "0xde0b6b3a7640000"] });

async function permitFor(wallet, amount, spender = A.gateway) {
  const account = await read(`/account/${wallet.address}`);
  const deadline = BigInt(now() + 3600);
  const sig = parseSignature(
    await wallet.signTypedData({ domain: usdcDomain, types: permitTypes, primaryType: "Permit", message: { owner: wallet.address, spender, value: amount, nonce: BigInt(account.wallet.usdcNonce), deadline } }),
  );
  return { owner: wallet.address, amount, deadline, v: Number(sig.v ?? 27n + BigInt(sig.yParity)), r: sig.r, s: sig.s };
}

/** A fresh account with `dollars` on the exchange (deposited through the relayer, with a permit). */
const made = [];
async function trader(dollars = 0, inWallet = 0) {
  const wallet = fresh();
  made.push(wallet);
  if (dollars + inWallet > 0) await mint(wallet.address, USDC(dollars + inWallet));
  if (dollars > 0) {
    const res = await post("/deposit", await permitFor(wallet, USDC(dollars)));
    if (res.status !== 200) throw new Error(`setup deposit failed: ${brief(res)}`);
  }
  return wallet;
}

const openMessage = (owner, overrides = {}) => ({
  owner,
  market: 0,
  isLong: true,
  useQueued: false,
  leverage: 2,
  margin: 1_000000n,
  priceLimit: 0n,
  impactLimit: 0,
  timestamp: stamp(),
  salt: salt(),
  ...overrides,
});
const signOpen = (signer, message) => signer.signTypedData({ domain, types, primaryType: "Open", message });
const signClose = (signer, message) => signer.signTypedData({ domain, types, primaryType: "Close", message });
/** Signs and sends an open. `signer` defaults to the wallet itself. */
async function sendOpen(wallet, overrides = {}, { signer = wallet, client } = {}) {
  // With one client address every write waits its turn, and an order is stamped with the present
  // second: so it waits first and is stamped and signed after, or it would go out stale.
  await pace();
  const message = openMessage(wallet.address, overrides);
  const signature = await signOpen(signer, message);
  const res = await post("/open", { intent: message, signature }, client, true);
  return { res, message, signature, id: res.json?.id };
}
async function sendClose(wallet, positionId, { signer = wallet, client, owner = wallet.address } = {}) {
  await pace();
  const message = { owner, positionId, timestamp: stamp() };
  const signature = await signClose(signer, message);
  return { res: await post("/close", { intent: message, signature }, client, true), message, signature };
}
async function withdrawBody(wallet, amount, { to = wallet.address, signer = wallet, deadline = BigInt(now() + 300), nonce } = {}) {
  const useNonce = nonce ?? (await exRead("withdrawNonces", [wallet.address]));
  const message = { owner: wallet.address, to, amount, nonce: useNonce, deadline };
  return { ...message, signature: await signer.signTypedData({ domain, types, primaryType: "Withdraw", message }) };
}
async function sessionBody(wallet, key, validUntil, { signer = wallet } = {}) {
  const nonce = await rpc.readContract({ address: A.sessions, abi: sessionsAbi, functionName: "nonces", args: [wallet.address] });
  const signature = await signer.signTypedData({
    domain: sessionDomain(config.name, config.chainId, A.sessions),
    types,
    primaryType: "SessionKey",
    message: { owner: wallet.address, key: key.address, validUntil: BigInt(validUntil), nonce },
  });
  return { owner: wallet.address, key: key.address, validUntil, signature };
}
const usernameBody = async (wallet, name, { signer = wallet, signedName = name.toLowerCase(), signedFor = wallet.address } = {}) => ({
  owner: wallet.address,
  name,
  signature: await signer.signMessage({ message: `Claim the username "${signedName}" for ${signedFor}` }),
});

async function waitIntent(id, want = ["confirmed"], timeoutMs = 25_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await get(`/intent/${id}`);
    if (res.status === 200 && want.includes(res.json.status)) return res.json;
    if (res.status === 200 && res.json.status === "failed" && !want.includes("failed")) throw new Error(`intent failed: ${res.json.error}`);
    if (Date.now() > until) throw new Error(`intent ${id.slice(0, 10)} stuck at ${res.json?.status ?? res.status}`);
    await sleep(150);
  }
}
const accountOf = (wallet) => read(`/account/${wallet.address}`);
async function waitFor(what, fn, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

// ---------------------------------------------------------------------------------------------
// The relayer process, seen from outside: its PID and how much memory it holds
// ---------------------------------------------------------------------------------------------

function pidListening(port) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] === "TCP" && cols[1]?.endsWith(`:${port}`) && cols[3] === "LISTENING") return Number(cols[4]);
      }
      return null;
    }
    return Number(execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n")[0]) || null;
  } catch {
    return null;
  }
}
/** Resident memory in MB. Asks only for the number: never the command line. */
function memoryOf(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
      const kb = Number((out.trim().split('","')[4] ?? "").replace(/[^0-9]/g, ""));
      return kb ? kb / 1024 : null;
    }
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024 || null;
  } catch {
    return null;
  }
}

const startStatus = await read("/status");
const startPid = pidListening(API.port);
const startMemory = startPid ? memoryOf(startPid) : null;
const suiteStarted = Date.now();
console.log(
  `\nrelayer ${API.origin}: ${config.name} on chain ${config.chainId}, pid ${startPid ?? "unknown"}, ${startMemory ? `${startMemory.toFixed(0)} MB` : "memory unknown"}, ` +
    `${multiClient ? (FORWARDED ? "many clients, named by header" : "many client addresses") : "ONE client address (paced; client isolation checks are skipped)"}${QUICK ? ", quick run" : ""}`,
);

// ---------------------------------------------------------------------------------------------
// The position cap: 200 positions at 40 orders a minute takes five minutes, so it runs in the
// background from the start and is looked at near the end.
// ---------------------------------------------------------------------------------------------

const CAP = 200;
const capRun = { wallet: null, accepted: 0, refused: [], done: null, extra: null };
async function fillToCap() {
  capRun.wallet = await trader(260);
  // The deposit above was the account's first request of this minute.
  for (let sent = 0, round = 0; sent < CAP; round++) {
    const roundStarted = Date.now();
    const size = Math.min(round === 0 ? 39 : 40, CAP - sent);
    const orders = [];
    for (let i = 0; i < size; i++, sent++) {
      orders.push(sendOpen(capRun.wallet, { leverage: 1, isLong: sent % 2 === 0 }, { client: 4 }));
      // Not all in one instant: every order must be stamped with a second that is still current.
      await sleep(40);
    }
    for (const { res, id } of await Promise.all(orders)) {
      if (res.status === 200) capRun.accepted += 1;
      else capRun.refused.push(brief(res));
      if (id) waitIntent(id, ["confirmed", "failed"], 40_000).catch(() => {});
    }
    // Wait the minute out, unless the cap is reached and this minute still has room for one more.
    if (sent < CAP || size === 40) await sleep(Math.max(0, 61_500 - (Date.now() - roundStarted)));
  }
  // One more than the cap:
  capRun.extra = await sendOpen(capRun.wallet, { leverage: 1 }, { client: 4 });
}
if (wants("cap") && !QUICK) capRun.done = fillToCap().catch((error) => (capRun.error = error));

// =============================================================================================
if (wants("get")) {
  section("GET routes with garbage");

  const someone = fresh().address;
  const NO_5XX = (res) => res.status >= 200 && res.status < 500;

  await check("every documented GET route answers 200 with JSON", async () => {
    for (const path of ["/health", "/config", "/house", "/coin", "/status", "/series", "/leaderboard", "/prices", `/account/${someone}`, `/history/${someone}`, "/health/", "/health?x=1&x=2", `/account/${someone.toLowerCase()}`]) {
      const res = await get(path);
      assert(res.status === 200 && res.json, `${path}: ${brief(res)}`);
    }
  });

  await check("unknown paths, traversal strings and malformed addresses get 404, never data and never 500", async () => {
    const hex40 = "ab".repeat(20);
    const paths = [
      "/",
      "/nope",
      "/account",
      "/account/",
      "/history",
      "/history/",
      "/intent",
      "/intent/",
      "/favicon.ico",
      "/.env",
      "/.git/config",
      "/../../etc/passwd",
      "/account/../../../../etc/passwd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/..%2f..%2f..%2fetc%2fpasswd",
      "/..%5c..%5cwindows%5cwin.ini",
      "/relayer/data/names-31337.json",
      "/account/..%2f..%2frelayer%2fdata%2fnames-31337.json",
      "/account/%00",
      "/account/0x",
      "/account/0x123",
      `/account/0x${"zz".repeat(20)}`,
      `/account/0x${hex40}0`,
      `/account/${hex40}`,
      // Mixed case with a wrong checksum.
      "/account/0x3C44CdDdB6a900fa2b585dd299e03d12FA4293Bc",
      "/account/undefined",
      "/account/null",
      "/account/__proto__",
      "/account/constructor",
      `/history/0x${hex40}%00`,
      "/history/__proto__",
      "/intent/__proto__",
      "/intent/constructor",
      "/intent/toString",
      "/intent/0x00",
      `/intent/0x${"00".repeat(32)}`,
      "/intent/%F0%9F%92%A5",
      "/intent/%",
      "/intent/%zz",
      "/dev/nudge",
      "/open",
      "/close",
      "/withdraw",
      "/stream/extra",
      "/health/extra",
      "/HEALTH",
      "/account/<script>alert(1)</script>",
      `/${"a".repeat(8000)}`,
      `/account/${"0x".repeat(3000)}`,
      `/${"../".repeat(2000)}etc/passwd`,
    ];
    const bad = [];
    for (const path of paths) {
      const res = await get(path);
      if (res.status !== 404 && res.status !== 400) bad.push(`${path.slice(0, 70)} -> ${brief(res)}`);
    }
    assert(bad.length === 0, bad.join("\n"));
    return `${paths.length} paths`;
  });

  await check("a path too long for the header limit is refused cleanly (431/414/400), not 500", async () => {
    const res = await get(`/${"a".repeat(40_000)}`);
    assert([431, 414, 400, 404].includes(res.status) || res.error === "ECONNRESET", brief(res));
    return res.status ? String(res.status) : "connection reset";
  });

  // Query values go out as typed, except for the characters an HTTP client refuses to send raw.
  const q = (value) => value.replace(/[^\x21-\xff]/g, (c) => encodeURIComponent(c));
  const NUMBERS = ["-1", "0", "1", "1e309", "-1e309", "NaN", "Infinity", "-Infinity", "abc", "", "99999999999999999999999", "0x10", "1.5", "-0", "null", "undefined", "[]", "{}", "__proto__", "%00", "%F0%9F%92%A5", "1;DROP TABLE x", "1,2", "1 2", "٣", "１２", "true"];

  await check("/prices with garbage numbers: 200, a bounded list, and nothing for a market that does not exist", async () => {
    const bad = [];
    for (const market of NUMBERS) {
      const real = [0, 1].includes(Number(decodeURIComponent(market)));
      for (const seconds of NUMBERS) {
        const res = await get(`/prices?market=${q(market)}&seconds=${q(seconds)}`);
        if (res.status !== 200 || !Array.isArray(res.json?.points) || res.json.points.length > 1800) bad.push(`market=${market}&seconds=${seconds} -> ${brief(res)}`);
        else if (!real && res.json.points.length > 0) bad.push(`market=${market} is not a market but returned ${res.json.points.length} points`);
      }
    }
    assert(bad.length === 0, bad.slice(0, 10).join("\n"));
    return `${NUMBERS.length ** 2} combinations`;
  });

  await check("/series, /history?limit and /leaderboard?window with garbage: 200 and bounded", async () => {
    const bad = [];
    for (const value of [...NUMBERS, "24h", "7d", "30d", "all", "ALL", "24H", "constructor", "toString", "hasOwnProperty", "valueOf", "24h%00", "all&window=7d"]) {
      const series = await get(`/series?seconds=${q(value)}`);
      if (series.status !== 200 || !Array.isArray(series.json?.points) || series.json.points.length > 361) bad.push(`/series?seconds=${value} -> ${brief(series)}`);
      const history = await get(`/history/${someone}?limit=${q(value)}`);
      if (history.status !== 200 || !["trades", "transfers", "staking", "queue", "emissions"].every((k) => Array.isArray(history.json?.[k]) && history.json[k].length <= 500)) {
        bad.push(`/history?limit=${value} -> ${brief(history)}`);
      }
      const board = await get(`/leaderboard?window=${q(value)}`);
      if (board.status !== 200 || !Array.isArray(board.json?.positions) || !Array.isArray(board.json?.accounts)) bad.push(`/leaderboard?window=${value} -> ${brief(board)}`);
      else if (!["24h", "7d", "30d", "all"].includes(board.json.window)) bad.push(`/leaderboard?window=${value} answered for a window called "${board.json.window}"`);
      else if (board.json.positions.length > 100 || board.json.accounts.length > 100) bad.push(`/leaderboard?window=${value} is not bounded`);
    }
    assert(bad.length === 0, bad.slice(0, 10).join("\n"));
  });

  await check("request targets no client would send (//, /\\, a bare scheme, binary) are refused without a 500", async () => {
    const targets = ["//", "/\\", "\\\\", "///", "//[", "//[::1", "http://", "http://[", "https://", "*", "/health\\..\\x", "//a b", "/%", "?", "#", "/\x7f\x80\xff"];
    const bad = [];
    for (const target of targets) {
      const res = await raw(`GET ${target} HTTP/1.1\r\nHost: relayer\r\nConnection: close\r\n\r\n`);
      if (!res.status || res.status >= 500) bad.push(`GET ${JSON.stringify(target)} -> ${res.status || res.error} ${res.text.split("\r\n\r\n")[1]?.slice(0, 80) ?? ""}`);
    }
    assert(bad.length === 0, bad.join("\n"));
    return `${targets.length} targets`;
  });

  await check("broken HTTP (no version, bad header, binary junk, huge header) is answered or dropped; the next request works", async () => {
    const junk = [
      "GET\r\n\r\n",
      "GET /health\r\n\r\n",
      "GET /health HTTP/9.9\r\nHost: x\r\n\r\n",
      "\x00\x01\x02\x03\x04\r\n\r\n",
      "GET /health HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n",
      `GET /health HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(70_000)}\r\n\r\n`,
      "POST /open HTTP/1.1\r\nHost: x\r\nContent-Length: -5\r\n\r\n",
      "POST /open HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\n\r\n{}",
      "POST /open HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nZZZ\r\n",
      "POST /open HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nContent-Length: 9\r\n\r\n{}",
      "GET /health HTTP/1.1\r\nHost: x\r\n\r\nGET /config HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    ];
    const bad = [];
    for (const text of junk) {
      const res = await raw(text, { client: anyClient(), timeout: 2_500 });
      if (res.status >= 500) bad.push(`${JSON.stringify(text.slice(0, 50))} -> ${res.status}`);
    }
    const health = await get("/health");
    assert(health.status === 200, `health after junk: ${brief(health)}`);
    assert(bad.length === 0, bad.join("\n"));
  });

  await check("wrong methods: PUT, DELETE, PATCH, HEAD get 405; POST to a GET route and GET to a POST route get 404; OPTIONS gets 204", async () => {
    const bad = [];
    for (const method of ["PUT", "DELETE", "PATCH", "HEAD", "PROPFIND", "TRACE"]) {
      for (const path of ["/health", "/open", `/account/${someone}`, "/stream"]) {
        const res = await request({ method, path, client: anyClient() });
        if (![405, 400, 404].includes(res.status)) bad.push(`${method} ${path} -> ${brief(res)}`);
      }
    }
    for (const path of ["/health", "/config", "/house", "/stream", `/account/${someone}`, "/intent/0x00"]) {
      const res = await post(path, {});
      if (res.status !== 404) bad.push(`POST ${path} -> ${brief(res)}`);
    }
    for (const path of ["/open", "/close", "/session", "/deposit", "/withdraw", "/username", "/dev/nudge"]) {
      const res = await get(path);
      if (res.status !== 404) bad.push(`GET ${path} -> ${brief(res)}`);
    }
    const options = await request({ method: "OPTIONS", path: "/open" });
    if (options.status !== 204) bad.push(`OPTIONS /open -> ${brief(options)}`);
    assert(bad.length === 0, bad.join("\n"));
  });

  await check("/stream with a garbage owner still opens (public topics only) and /stream never 500s", async () => {
    for (const query of ["?owner=nope", "?owner=", "?owner=0x", "?owner=__proto__", `?owner=${"0x".repeat(500)}`, "?owner[]=1", "?x=%00"]) {
      const stream = await openStream(anyClient(), query);
      stream.close();
      assert(stream.status === 200 && /event-stream/.test(stream.type ?? ""), `/stream${query} -> ${stream.status || stream.error}`);
    }
  });
}

// =============================================================================================
/** Sends every case, a handful at a time, and returns the ones that were not refused with a 4xx. */
async function refusedAll(cases, { allow = [] } = {}) {
  const bad = [];
  for (let i = 0; i < cases.length; i += 20) {
    await Promise.all(
      cases.slice(i, i + 20).map(async ({ label, path, body }) => {
        const res = await post(path, body);
        const refused = res.status >= 400 && res.status < 500 && res.status !== 429;
        if (!refused && !allow.some((ok) => ok(res))) bad.push(`${path} ${label} -> ${brief(res)}`);
      }),
    );
  }
  return bad;
}
const POST_ROUTES = ["/open", "/close", "/session", "/deposit", "/withdraw", "/username", "/dev/nudge"];

if (wants("post")) {
  section("POST routes with garbage bodies");

  const deep = (n) => `${"[".repeat(n)}${"]".repeat(n)}`;
  const BODIES = {
    "an empty body": "",
    "spaces": "   \n\t ",
    "a word": "hello",
    "an open brace": "{",
    "single quotes": "{'a':1}",
    "XML": "<xml/>",
    "a form": "owner=0x00&amount=1",
    "binary": Buffer.from([0, 1, 2, 3, 255, 254, 253]),
    "a BOM then {}": "﻿{}",
    "undefined": "undefined",
    "NaN": "NaN",
    "null": "null",
    "true": "true",
    "zero": "0",
    "a negative number": "-1",
    "a float": "1.5",
    "1e400": "1e400",
    "a string": '"str"',
    "an empty string": '""',
    "an empty array": "[]",
    "nested arrays": "[[[]]]",
    "an array of numbers": "[1,2,3]",
    "an array holding an order": '[{"intent":{},"signature":"0x"}]',
    "an empty object": "{}",
    "intent null": '{"intent":null,"signature":null}',
    "intent an array": '{"intent":[],"signature":[]}',
    "intent a string": '{"intent":"x","signature":"0x"}',
    "intent a number": '{"intent":5,"signature":5}',
    "intent empty": '{"intent":{},"signature":"0x"}',
    "owner null": '{"intent":{"owner":null},"owner":null,"signature":"0x00"}',
    "owner an object": '{"intent":{"owner":{}},"owner":{},"key":{},"to":{},"signature":"0x00","r":"0x00","s":"0x00"}',
    "__proto__ keys": '{"__proto__":{"polluted":"yes","intent":{},"owner":"0x0000000000000000000000000000000000000001"},"constructor":{"prototype":{"polluted":"yes"}}}',
    "__proto__ inside the order": `{"intent":{"__proto__":{"owner":"0x0000000000000000000000000000000000000001","timestamp":"${now()}"}},"signature":"0x00"}`,
    "duplicate keys": '{"owner":"0x0000000000000000000000000000000000000001","owner":"zzz","intent":{"owner":"a","owner":"b"},"intent":7,"signature":"0x","signature":1}',
    "control characters": '{"intent":{"owner":"\\u0000\\u0001\\u001f"},"owner":"\\u0000","name":"ab\\u0000cd","signature":"0x00"}',
    "right-to-left and emoji": '{"intent":{"owner":"\\u202e\\ud83d\\udca5"},"owner":"\\ud83d\\udca5","name":"\\u202eadmin","signature":"0x00"}',
    "a lone surrogate": '{"owner":"\\ud800","name":"\\udfff\\ud800","signature":"0x00"}',
    "arrays 5,000 deep": deep(5_000),
    "arrays 15,000 deep": deep(15_000),
    "objects 4,000 deep": `${'{"a":'.repeat(4_000)}1${"}".repeat(4_000)}`,
    "a 30 KB string": toJson({ intent: { owner: "a".repeat(30_000) }, signature: "0x" }),
    "30 KB of hex as a signature": toJson({ intent: { owner: "0x0000000000000000000000000000000000000001", timestamp: now() }, owner: "0x0000000000000000000000000000000000000001", signature: `0x${"ab".repeat(15_000)}` }),
    "one byte over the size limit": `{"a":"${"x".repeat(32 * 1024 - 7)}"}`,
  };

  // Somebody honest keeps trading while all of this goes on.
  const honest = { done: 0, error: null, running: true };
  const honestRun = (async () => {
    const wallet = await trader(50);
    while (honest.running) {
      const order = await sendOpen(wallet, { margin: 5_000000n }, { client: 2 });
      if (order.res.status !== 200) throw new Error(`open: ${brief(order.res)}`);
      await waitIntent(order.id);
      await sleep(1_100);
      const close = await sendClose(wallet, order.id, { client: 2 });
      if (close.res.status !== 200) throw new Error(`close: ${brief(close.res)}`);
      await waitIntent(close.res.json.id);
      honest.done += 1;
    }
  })().catch((error) => (honest.error = error));

  for (const route of POST_ROUTES) {
    await check(`POST ${route}: ${Object.keys(BODIES).length} kinds of malformed body are all refused with a 4xx`, async () => {
      const cases = Object.entries(BODIES).map(([label, body]) => ({ label, path: route, body }));
      const bad = await refusedAll(cases);
      assert(bad.length === 0, bad.join("\n"));
    });
  }

  await check("a 1 MB body is refused on every POST route (413, or the connection is cut), and costs no memory", async () => {
    const megabyte = Buffer.from(`{"intent":{"owner":"${"a".repeat(1024 * 1024)}"}}`);
    const bad = [];
    const answers = new Set();
    for (const route of POST_ROUTES) {
      const res = await post(route, megabyte);
      const cut = ["ECONNRESET", "EPIPE", "ECONNABORTED"].includes(res.error);
      if (res.status !== 413 && !cut) bad.push(`${route} -> ${brief(res)}`);
      answers.add(res.status === 413 ? "413" : `cut (${res.error})`);
    }
    assert(bad.length === 0, bad.join("\n"));
    return [...answers].join(", ");
  });

  await check("a wrong or missing content type, and a chunked body, change nothing", async () => {
    const body = "{}";
    for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }, { "content-type": "" }, { "content-encoding": "gzip" }, { "transfer-encoding": "chunked", "content-length": undefined }]) {
      const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
      const res = await request({ method: "POST", path: "/open", body: headers["transfer-encoding"] ? undefined : body, headers: clean, client: anyClient() });
      assert(res.status === 400, `${toJson(headers)} -> ${brief(res)}`);
    }
  });

  // -----------------------------------------------------------------------------------------
  // Field by field: a well-formed request with one field replaced by something wrong. The owner
  // is a fresh, empty account each time, so nothing here should ever be accepted.
  // -----------------------------------------------------------------------------------------

  const MISSING = Symbol("missing");
  const BAD = [
    MISSING,
    null,
    true,
    false,
    0,
    -1,
    1.5,
    -0.0001,
    1e21,
    1e308,
    2 ** 53,
    -(2 ** 31),
    65536,
    "",
    " ",
    "0",
    "-1",
    "1.5",
    "1e9",
    "0x",
    "0x1",
    "0xzz",
    "abc",
    "NaN",
    "Infinity",
    "-Infinity",
    "١٢٣",
    [],
    [1],
    [[]],
    {},
    { a: 1 },
    { toString: 1 },
    "\u0000",
    "💥",
    "9".repeat(100),
    `0x${"f".repeat(40)}`,
    `0x${"f".repeat(64)}`,
    `0x${"f".repeat(130)}`,
    `0x${"f".repeat(300)}`,
    "18446744073709551615",
    "18446744073709551616",
    "79228162514264337593543950336",
    "340282366920938463463374607431768211456",
    "115792089237316195423570985008687907853269984665640564039457584007913129639936",
    "-18446744073709551616",
  ];
  const mutate = (object, field, value) => {
    const copy = { ...object };
    if (value === MISSING) delete copy[field];
    else copy[field] = value;
    return copy;
  };
  const label = (field, value) => `${field}=${value === MISSING ? "(missing)" : typeof value === "string" ? JSON.stringify(value.length > 24 ? `${value.slice(0, 20)}…(${value.length})` : value) : toJson(value)}`;

  await check("POST /open: every field of a signed order replaced with wrong types and extremes is refused", async () => {
    const cases = [];
    for (const field of ["owner", "market", "isLong", "useQueued", "leverage", "margin", "priceLimit", "impactLimit", "timestamp", "salt"]) {
      for (const value of BAD) {
        const wallet = fresh();
        const message = openMessage(wallet.address);
        cases.push({ label: label(field, value), path: "/open", body: { intent: mutate(message, field, value), signature: await signOpen(wallet, message) } });
      }
    }
    for (const value of BAD) {
      const wallet = fresh();
      cases.push({ label: label("signature", value), path: "/open", body: mutate({ intent: openMessage(wallet.address), signature: "0x" }, "signature", value) });
    }
    const bad = await refusedAll(cases);
    assert(bad.length === 0, `${bad.length} of ${cases.length} cases:\n${bad.slice(0, 12).join("\n")}`);
    return `${cases.length} cases`;
  });

  await check("POST /close: every field replaced with wrong types and extremes is refused", async () => {
    const cases = [];
    for (const field of ["owner", "positionId", "timestamp"]) {
      for (const value of BAD) {
        const wallet = fresh();
        const message = { owner: wallet.address, positionId: `0x${"12".repeat(32)}`, timestamp: stamp() };
        cases.push({ label: label(field, value), path: "/close", body: { intent: mutate(message, field, value), signature: await signClose(wallet, message) } });
      }
    }
    for (const value of BAD) {
      const wallet = fresh();
      cases.push({ label: label("signature", value), path: "/close", body: mutate({ intent: { owner: wallet.address, positionId: `0x${"12".repeat(32)}`, timestamp: stamp() }, signature: "0x" }, "signature", value) });
    }
    const bad = await refusedAll(cases);
    assert(bad.length === 0, `${bad.length} of ${cases.length} cases:\n${bad.slice(0, 12).join("\n")}`);
    return `${cases.length} cases`;
  });

  await check("POST /session: every field replaced with wrong types and extremes is refused", async () => {
    const cases = [];
    for (const field of ["owner", "key", "validUntil", "signature"]) {
      for (const value of BAD) {
        const wallet = fresh();
        const body = await sessionBody(wallet, fresh(), now() + 86_400);
        // A well-formed expiry is still an expiry the wallet did not sign.
        cases.push({ label: label(field, value), path: "/session", body: mutate(body, field, value) });
      }
    }
    const bad = await refusedAll(cases);
    assert(bad.length === 0, `${bad.length} of ${cases.length} cases:\n${bad.slice(0, 12).join("\n")}`);
    return `${cases.length} cases`;
  });

  await check("POST /deposit: every field replaced with wrong types and extremes is refused", async () => {
    const cases = [];
    for (const field of ["owner", "amount", "deadline", "v", "r", "s"]) {
      for (const value of BAD) {
        const wallet = fresh();
        const deadline = BigInt(now() + 3600);
        const sig = parseSignature(await wallet.signTypedData({ domain: usdcDomain, types: permitTypes, primaryType: "Permit", message: { owner: wallet.address, spender: A.gateway, value: 1_000000n, nonce: 0n, deadline } }));
        const body = { owner: wallet.address, amount: 1_000000n, deadline, v: Number(sig.v ?? 27n + BigInt(sig.yParity)), r: sig.r, s: sig.s };
        cases.push({ label: label(field, value), path: "/deposit", body: mutate(body, field, value) });
      }
    }
    const bad = await refusedAll(cases);
    assert(bad.length === 0, `${bad.length} of ${cases.length} cases:\n${bad.slice(0, 12).join("\n")}`);
    return `${cases.length} cases`;
  });

  await check("POST /withdraw: every field replaced with wrong types and extremes is refused", async () => {
    const cases = [];
    for (const field of ["owner", "to", "amount", "deadline", "signature"]) {
      for (const value of BAD) {
        const wallet = fresh();
        const body = await withdrawBody(wallet, 1_000000n, { nonce: 0n });
        cases.push({ label: label(field, value), path: "/withdraw", body: mutate(body, field, value) });
      }
    }
    const bad = await refusedAll(cases);
    assert(bad.length === 0, `${bad.length} of ${cases.length} cases:\n${bad.slice(0, 12).join("\n")}`);
    return `${cases.length} cases`;
  });

  await check("POST /username: every field replaced with wrong types and extremes is refused", async () => {
    const cases = [];
    for (const field of ["owner", "name", "signature"]) {
      for (const value of BAD) {
        const wallet = fresh();
        const name = `fz_${Math.floor(Math.random() * 1e9)}`;
        // Signed by a stranger, so even an untouched request must be refused.
        cases.push({ label: label(field, value), path: "/username", body: mutate(await usernameBody(wallet, name, { signer: fresh() }), field, value) });
      }
    }
    const bad = await refusedAll(cases);
    assert(bad.length === 0, `${bad.length} of ${cases.length} cases:\n${bad.slice(0, 12).join("\n")}`);
    return `${cases.length} cases`;
  });

  await check("POST /dev/nudge: wrong types and out-of-range moves never 500 and never move a market that does not exist", async () => {
    const bad = [];
    for (const value of BAD) {
      // A market that is not there, so nothing in the price feed changes whatever `bps` turns into.
      const res = await post("/dev/nudge", mutate({ market: 99, bps: 1 }, "bps", value));
      if (res.status >= 500 || !res.status || (res.status === 200 && res.json?.ok !== false)) bad.push(`${label("bps", value)} -> ${brief(res)}`);
      const other = await post("/dev/nudge", mutate({ market: 0, bps: 501 }, "market", value));
      if (other.status !== 400) bad.push(`${label("market", value)} with bps 501 -> ${brief(other)}`);
    }
    for (const bps of [501, -501, 1e9, "600", 500.0001]) {
      const res = await post("/dev/nudge", { market: 0, bps });
      if (res.status !== 400) bad.push(`bps=${bps} -> ${brief(res)}`);
    }
    assert(bad.length === 0, bad.slice(0, 12).join("\n"));
  });

  await check("an address wrapped in an array, where the relayer has seen that address before, is refused on every route", async () => {
    const known = await trader(3);
    const wrapped = [known.address];
    const cases = [
      { label: "open", path: "/open", body: { intent: { ...openMessage(known.address), owner: wrapped }, signature: `0x${"11".repeat(65)}` } },
      { label: "close", path: "/close", body: { intent: { owner: wrapped, positionId: `0x${"12".repeat(32)}`, timestamp: stamp() }, signature: `0x${"11".repeat(65)}` } },
      { label: "session owner", path: "/session", body: { owner: wrapped, key: known.address, validUntil: now() + 86_400, signature: `0x${"11".repeat(65)}` } },
      { label: "session key", path: "/session", body: { owner: known.address, key: wrapped, validUntil: now() + 86_400, signature: `0x${"11".repeat(65)}` } },
      { label: "deposit", path: "/deposit", body: { owner: wrapped, amount: 1_000000n, deadline: BigInt(now() + 3600), v: 27, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` } },
      { label: "withdraw owner", path: "/withdraw", body: { owner: wrapped, to: known.address, amount: 1_000000n, deadline: BigInt(now() + 300), signature: `0x${"11".repeat(65)}` } },
      { label: "withdraw to", path: "/withdraw", body: { owner: known.address, to: wrapped, amount: 1_000000n, deadline: BigInt(now() + 300), signature: `0x${"11".repeat(65)}` } },
      { label: "username", path: "/username", body: { owner: wrapped, name: `wr_${Math.floor(Math.random() * 1e9)}`, signature: `0x${"11".repeat(65)}` } },
    ];
    const bad = await refusedAll(cases);
    assert(bad.length === 0, bad.join("\n"));
  });

  await check("an honest trader kept opening and closing through the whole barrage", async () => {
    honest.running = false;
    await honestRun;
    if (honest.error) throw honest.error;
    assert(honest.done >= 1, "not one round trip completed");
    return `${honest.done} round trips`;
  });

  await check("the simulated price cannot be nudged out of range: a run of +500 bps is stopped, and bps 0 puts it back", async () => {
    // On ETH, where this suite holds no positions. Unbounded, about three hundred of these push
    // the price past what the oracle's integer holds and the relayer's price timer throws.
    const priceOf = async () => Number((await read("/config")).markets[1].price) / 1e8;
    const before = await priceOf();
    const up = [];
    for (let i = 0; i < 20; i++) up.push(await post("/dev/nudge", { market: 1, bps: 500 }));
    const stoppedUp = up.findIndex((r) => r.status === 400);
    await post("/dev/nudge", { market: 1, bps: 0 });
    const down = [];
    for (let i = 0; i < 20; i++) down.push(await post("/dev/nudge", { market: 1, bps: -500 }));
    const stoppedDown = down.findIndex((r) => r.status === 400);
    const reset = await post("/dev/nudge", { market: 1, bps: 0 });
    assert(reset.status === 200 && reset.json.ok === true, `the reset: ${brief(reset)}`);
    assert(stoppedUp !== -1 && stoppedDown !== -1, `twenty nudges ${stoppedUp === -1 ? "up" : "down"} were all accepted`);
    await sleep(1_600);
    const after = await priceOf();
    assert(Math.abs(after / before - 1) < 0.02, `ETH was ${before} before and is ${after} after the reset`);
    return `stopped at nudge ${stoppedUp + 1} up and ${stoppedDown + 1} down`;
  });

  await check("after all of that the relayer's own objects are unpolluted and /config is unchanged", async () => {
    const after = await read("/config");
    assert(after.polluted === undefined && after.addresses.polluted === undefined, "a __proto__ key leaked into /config");
    assert(toJson(after.addresses) === toJson(config.addresses) && after.name === config.name, "config changed");
    const account = await read(`/account/${fresh().address}`);
    assert(account.polluted === undefined && account.balance === "0" && account.positions.length === 0, "a fresh account is not empty");
  });
}

// =============================================================================================
if (wants("sign")) {
  section("Signature rules");

  const [alice, bob, erin] = await Promise.all([trader(500), trader(500), trader(500)]);
  const stranger = fresh();
  const aliceKey = fresh();
  const bobKey = fresh();
  const shortKey = fresh();
  await Promise.all([giveEth(alice.address), giveEth(bob.address)]);

  await check("an order signed by a stranger is refused (401) and nothing is reserved", async () => {
    const { res } = await sendOpen(alice, {}, { signer: stranger });
    assert(res.status === 401, brief(res));
    assert((await accountOf(alice)).reserved === "0", "balance was set aside for a refused order");
  });

  await check("an order with no signature, a short one, an all-zero one, or 65 bytes of junk is refused", async () => {
    for (const signature of ["0x", "0x00", `0x${"00".repeat(65)}`, `0x${"ff".repeat(65)}`, `0x${"ab".repeat(64)}`, `0x${"ab".repeat(66)}`]) {
      const res = await post("/open", { intent: openMessage(erin.address), signature });
      assert(res.status === 400 || res.status === 401, `${signature.slice(0, 12)}… -> ${brief(res)}`);
    }
    await sleep(3_000);
    const account = await accountOf(erin);
    assert(account.positions.length === 0 && account.reserved === "0" && account.balance === "500000000", "a forged order touched the account");
  });

  let aliceSession;
  let bobSession;
  await check("a wallet registers a session key; a session signed by somebody else is refused", async () => {
    const forged = await post("/session", await sessionBody(alice, fresh(), now() + 86_400, { signer: stranger }));
    assert(forged.status === 400 && /signature/i.test(forged.text), `forged registration: ${brief(forged)}`);
    const [a, b] = await Promise.all([post("/session", await sessionBody(alice, aliceKey, now() + 86_400)), post("/session", await sessionBody(bob, bobKey, now() + 86_400))]);
    assert(a.status === 200 && b.status === 200, `${brief(a)} / ${brief(b)}`);
    aliceSession = a.json;
    bobSession = b.json;
  });

  await check("a session key signs nothing before it activates (425)", async () => {
    assert(aliceSession, "no session");
    assert(now() < aliceSession.validFrom, "the key was already active; cannot test");
    const { res } = await sendOpen(alice, {}, { signer: aliceKey });
    assert(res.status === 425, brief(res));
  });

  await check("a replayed session registration is refused", async () => {
    const body = await sessionBody(alice, aliceKey, now() + 86_400);
    // Signed over the nonce that the registration above already used.
    const nonce = (await rpc.readContract({ address: A.sessions, abi: sessionsAbi, functionName: "nonces", args: [alice.address] })) - 1n;
    const signature = await alice.signTypedData({ domain: sessionDomain(config.name, config.chainId, A.sessions), types, primaryType: "SessionKey", message: { owner: alice.address, key: aliceKey.address, validUntil: BigInt(body.validUntil), nonce } });
    const res = await post("/session", { ...body, signature });
    assert(res.status === 400, brief(res));
  });

  // A short-lived key for the expiry check, registered now so its life runs out while other checks run.
  let shortSession;
  await check("a key can be registered for a few seconds only; an expiry in the past or 91 days out is refused", async () => {
    const chainNow = Number((await rpc.getBlock()).timestamp);
    const past = await post("/session", await sessionBody(alice, fresh(), chainNow - 10));
    assert(past.status === 400, `expiry in the past: ${brief(past)}`);
    const far = await post("/session", await sessionBody(alice, fresh(), chainNow + 91 * 86_400));
    assert(far.status === 400, `expiry in 91 days: ${brief(far)}`);
    const res = await post("/session", await sessionBody(alice, shortKey, chainNow + 24));
    assert(res.status === 200, brief(res));
    shortSession = res.json;
  });

  await check("stale and future timestamps are refused whoever signs", async () => {
    for (const delta of [-1, -2, -30, -3600, 3, 4, 60, 86_400]) {
      // Away from the turn of a second, so that "now" here is "now" there when the order arrives.
      await midSecond();
      const { res } = await sendOpen(erin, { timestamp: BigInt(now() + delta) });
      assert(res.status === 400 && /timestamp/i.test(res.text), `now${delta >= 0 ? "+" : ""}${delta}: ${brief(res)}`);
    }
    for (const timestamp of [0n, 1n, 2n ** 40n, 2n ** 63n]) {
      const { res } = await sendOpen(erin, { timestamp });
      assert(res.status === 400, `timestamp ${timestamp}: ${brief(res)}`);
    }
  });

  let firstOrder;
  await check("the wallet's own signature opens a position (the control for everything below)", async () => {
    firstOrder = await sendOpen(alice, { margin: 5_000000n, leverage: 3 });
    assert(firstOrder.res.status === 200, brief(firstOrder.res));
    await waitIntent(firstOrder.id);
    const account = await accountOf(alice);
    assert(account.positions.some((p) => p.id === firstOrder.id && p.status === "open"), "the position is not listed");
    assert(account.reserved === "0", `reserved is ${account.reserved} after the order landed`);
  });

  await check("a valid order replayed is refused, while it is in flight and after it lands", async () => {
    const order = await sendOpen(alice, { margin: 2_000000n });
    assert(order.res.status === 200, brief(order.res));
    const again = await post("/open", { intent: order.message, signature: order.signature });
    assert(again.status === 400 && /duplicate/i.test(again.text), `replay in flight: ${brief(again)}`);
    await waitIntent(order.id);
    const later = await post("/open", { intent: order.message, signature: order.signature });
    assert(later.status === 400, `replay after landing: ${brief(later)}`);
    const old = await post("/open", { intent: firstOrder.message, signature: firstOrder.signature });
    assert(old.status === 400, `replay of an older order: ${brief(old)}`);
    assert((await accountOf(alice)).positions.length === 2, "a replay opened a position");
  });

  await check("numbers written as strings are the same order; a boolean written as a string is refused, never guessed", async () => {
    const message = openMessage(bob.address, { margin: 2_000000n, leverage: 4, isLong: false });
    const signature = await signOpen(bob, message);
    const asStrings = Object.fromEntries(Object.entries(message).map(([k, v]) => [k, typeof v === "boolean" ? v : String(v)]));
    // "false" is a non-empty string. Read loosely it would turn this short into a long.
    const guessed = await post("/open", { intent: { ...asStrings, isLong: "false" }, signature });
    assert(guessed.status === 401 || guessed.status === 400, `isLong: "false" -> ${brief(guessed)}`);
    const res = await post("/open", { intent: asStrings, signature });
    assert(res.status === 200, `every number as a string: ${brief(res)}`);
    await waitIntent(res.json.id);
    const position = await waitFor("the position", async () => (await accountOf(bob)).positions.find((p) => p.id === res.json.id && p.status === "open"));
    assert(position.isLong === false && position.leverage === 4 && position.margin === "2000000", `opened ${toJson(position)}`);
    await sleep(1_500);
    const close = await post("/close", { intent: { owner: bob.address, positionId: position.id, timestamp: String(stamp()) }, signature: await signClose(bob, { owner: bob.address, positionId: position.id, timestamp: stamp() }) });
    // The two stamps above can fall either side of a second: then the signature is for another order.
    if (close.status !== 200) {
      const again = await sendClose(bob, position.id);
      assert(again.res.status === 200, `close: ${brief(close)} then ${brief(again.res)}`);
      await waitIntent(again.res.json.id);
    } else await waitIntent(close.json.id);
    await waitFor("the position to go", async () => (await accountOf(bob)).positions.length === 0, 8_000);
  });

  await check("the same signed order sent three times in the same instant is taken once", async () => {
    const before = await exRead("balances", [bob.address]);
    const message = openMessage(bob.address, { margin: 3_000000n });
    const signature = await signOpen(bob, message);
    const answers = await Promise.all([0, 1, 2].map(() => post("/open", { intent: message, signature })));
    const taken = answers.filter((r) => r.status === 200);
    assert(taken.length === 1 && answers.filter((r) => r.status === 400).length === 2, answers.map(brief).join(" / "));
    assert((await accountOf(bob)).reserved === "3000000", `reserved ${(await accountOf(bob)).reserved} for one order of 3`);
    const end = await waitIntent(taken[0].json.id, ["confirmed", "failed"]);
    assert(end.status === "confirmed", `it then ${end.status}: ${end.error}`);
    await sleep(600);
    const account = await accountOf(bob);
    assert(account.positions.length === 1 && account.reserved === "0" && before - BigInt(account.balance) === 3_000000n, `${account.positions.length} positions, reserved ${account.reserved}`);
    // Two closes for it in the same instant: one is taken.
    await sleep(1_500);
    const closes = await Promise.all([0, 1].map(async (i) => {
      const m = { owner: bob.address, positionId: taken[0].json.id, timestamp: stamp() + BigInt(i) };
      return post("/close", { intent: m, signature: await signClose(bob, m) });
    }));
    assert(closes.filter((r) => r.status === 200).length === 1 && closes.filter((r) => r.status === 400).length === 1, `two closes at once: ${closes.map(brief).join(" / ")}`);
    await waitIntent(closes.find((r) => r.status === 200).json.id);
    await waitFor("the position to go", async () => (await accountOf(bob)).positions.length === 0, 8_000);
  });

  await check("one field changed after signing (margin, leverage, market, side, owner, useQueued, priceLimit, impactLimit, salt, timestamp) is refused", async () => {
    const changes = {
      margin: (m) => m.margin + 1n,
      leverage: (m) => m.leverage + 1,
      market: () => 1,
      isLong: (m) => !m.isLong,
      owner: () => bob.address,
      useQueued: (m) => !m.useQueued,
      priceLimit: () => 2n ** 60n,
      impactLimit: () => 4_000_000_000,
      salt: (m) => m.salt + 1n,
      timestamp: (m) => m.timestamp + 1n,
    };
    for (const [field, change] of Object.entries(changes)) {
      const message = openMessage(erin.address, { margin: 2_000000n });
      const signature = await signOpen(erin, message);
      const res = await post("/open", { intent: { ...message, [field]: change(message) }, signature });
      assert(res.status === 401 || res.status === 400, `${field} changed: ${brief(res)}`);
    }
    await sleep(3_500);
    assert((await accountOf(erin)).positions.length + (await accountOf(bob)).positions.length === 0, "a tampered order opened a position");
    assert((await accountOf(erin)).balance === "500000000", "a tampered order moved money");
  });

  await check("a session key works for its own account once active", async () => {
    await waitFor("the session to activate", () => now() >= Math.max(aliceSession.validFrom, bobSession.validFrom) + 1, 30_000);
    const order = await sendOpen(alice, { margin: 2_000000n }, { signer: aliceKey });
    assert(order.res.status === 200, brief(order.res));
    await waitIntent(order.id);
  });

  await check("a session key that belongs to another account is refused (401), for opens and for closes", async () => {
    const asAlice = await sendOpen(alice, {}, { signer: bobKey });
    assert(asAlice.res.status === 401, `open: ${brief(asAlice.res)}`);
    const close = await sendClose(alice, firstOrder.id, { signer: bobKey });
    assert(close.res.status === 401, `close: ${brief(close.res)}`);
  });

  await check("closing somebody else's position is refused, whoever is named as owner", async () => {
    const asBob = await sendClose(bob, firstOrder.id);
    assert(asBob.res.status === 404, `bob as owner: ${brief(asBob.res)}`);
    const bobSigned = await sendClose(alice, firstOrder.id, { signer: bob });
    assert(bobSigned.res.status === 401, `alice as owner, bob's signature: ${brief(bobSigned.res)}`);
    const bobKeySigned = await sendClose(bob, firstOrder.id, { signer: bobKey });
    assert(bobKeySigned.res.status === 404, `bob's session key: ${brief(bobKeySigned.res)}`);
    await sleep(3_000);
    assert((await accountOf(alice)).positions.some((p) => p.id === firstOrder.id), "the position was closed");
  });

  await check("closing a position that does not exist is refused (404)", async () => {
    for (const id of [`0x${"00".repeat(32)}`, `0x${"ab".repeat(32)}`, firstOrder.id.toUpperCase().replace("0X", "0x")]) {
      const { res } = await sendClose(alice, id);
      // Upper-case hex is the same position: closing it is legitimate.
      if (id !== firstOrder.id && id.toLowerCase() === firstOrder.id) assert(res.status === 404 || res.status === 200, brief(res));
      else assert(res.status === 404, `${id.slice(0, 12)}: ${brief(res)}`);
    }
  });

  await check("a close with a changed position or timestamp after signing is refused; the real close then works once", async () => {
    const others = (await accountOf(alice)).positions.filter((p) => p.id !== firstOrder.id);
    assert(others.length >= 1, "no second position to aim at");
    const message = { owner: alice.address, positionId: firstOrder.id, timestamp: stamp() };
    const signature = await signClose(alice, message);
    const moved = await post("/close", { intent: { ...message, positionId: others[0].id }, signature });
    assert(moved.status === 401, `position changed: ${brief(moved)}`);
    const shifted = await post("/close", { intent: { ...message, timestamp: message.timestamp + 1n }, signature });
    assert(shifted.status === 401, `timestamp changed: ${brief(shifted)}`);
    const real = await sendClose(alice, firstOrder.id);
    assert(real.res.status === 200, `the real close: ${brief(real.res)}`);
    const twice = await post("/close", { intent: real.message, signature: real.signature });
    assert(twice.status === 400, `the same close again while in flight: ${brief(twice)}`);
    const second = await sendClose(alice, firstOrder.id);
    assert(second.res.status === 400, `a second close while the first is in flight: ${brief(second.res)}`);
    await waitIntent(real.res.json.id);
    const after = await post("/close", { intent: real.message, signature: real.signature });
    assert(after.status === 404 || after.status === 400, `replay after it landed: ${brief(after)}`);
    await waitFor("the close to reach the account's history", async () => (await read(`/history/${alice.address}?limit=50`)).trades.some((t) => t.id === firstOrder.id), 8_000);
    await sleep(1_500);
    const history = await read(`/history/${alice.address}?limit=50`);
    assert(history.trades.filter((t) => t.id === firstOrder.id).length === 1, "the position was not closed exactly once");
  });

  await check("a session key that has expired is refused (401)", async () => {
    assert(shortSession, "no short-lived session");
    await waitFor("the short key to expire", () => now() > shortSession.validUntil + 1, 40_000);
    const { res } = await sendOpen(alice, {}, { signer: shortKey });
    assert(res.status === 401, brief(res));
  });

  await check("a revoked session key is refused once the revocation takes effect (one slot later)", async () => {
    // The relayer may remember what it last read about a key. Whatever it remembers now is more
    // than 31 s old by the second order below, so that order makes it read the key afresh, a
    // moment before the revocation: the best case for a stale answer afterwards.
    const first = await sendOpen(alice, { margin: 1_000000n }, { signer: aliceKey });
    assert(first.res.status === 200, `before revoking: ${brief(first.res)}`);
    await sleep(31_000);
    const warm = await sendOpen(alice, { margin: 1_000000n }, { signer: aliceKey });
    assert(warm.res.status === 200, `just before revoking: ${brief(warm.res)}`);
    const wallet = createWalletClient({ account: alice, chain: foundry, transport: rpcHttp(RPC) });
    const hash = await wallet.writeContract({ address: A.sessions, abi: sessionsAbi, functionName: "revokeSessionKey", args: [aliceKey.address] });
    await rpc.waitForTransactionReceipt({ hash });
    const [, cutoff] = await rpc.readContract({ address: A.sessions, abi: sessionsAbi, functionName: "sessionKeys", args: [alice.address, aliceKey.address] });
    await waitFor("the cut-off to pass", () => now() > Number(cutoff), 30_000);
    const { res, id } = await sendOpen(alice, { margin: 1_000000n }, { signer: aliceKey });
    if (res.status === 200) {
      const end = await waitIntent(id, ["confirmed", "failed"]);
      throw new Error(`accepted ${now() - Number(cutoff)}s after the cut-off, then ${end.status}${end.error ? `: ${end.error}` : ""}`);
    }
    assert(res.status === 401, brief(res));
  });

  await check("a withdrawal to a different address than the one signed is refused and moves nothing", async () => {
    const before = await exRead("balances", [alice.address]);
    const body = await withdrawBody(alice, 10_000000n);
    const res = await post("/withdraw", { ...body, to: stranger.address });
    assert(res.status === 400 && /signature/i.test(res.text), brief(res));
    const more = await post("/withdraw", { ...body, amount: 11_000000n });
    assert(more.status === 400, `amount changed: ${brief(more)}`);
    const owner = await post("/withdraw", { ...body, owner: bob.address });
    assert(owner.status === 400, `owner changed: ${brief(owner)}`);
    assert((await exRead("balances", [alice.address])) === before && (await usdcOf(stranger.address)) === 0n, "money moved");
  });

  await check("a withdrawal signed by a session key, or by a stranger, is refused", async () => {
    const order = await sendOpen(bob, { margin: 1_000000n }, { signer: bobKey });
    assert(order.res.status === 200, `bob's key is not live: ${brief(order.res)}`);
    const byKey = await post("/withdraw", await withdrawBody(bob, 5_000000n, { signer: bobKey, to: bobKey.address }));
    assert(byKey.status === 400 && /signature/i.test(byKey.text), `session key: ${brief(byKey)}`);
    const byStranger = await post("/withdraw", await withdrawBody(bob, 5_000000n, { signer: stranger, to: stranger.address }));
    assert(byStranger.status === 400 && /signature/i.test(byStranger.text), `stranger: ${brief(byStranger)}`);
    assert((await usdcOf(bobKey.address)) === 0n && (await usdcOf(stranger.address)) === 0n, "money moved");
  });

  await check("a withdrawal that is expired, or replayed, is refused; a good one pays exactly once", async () => {
    const expired = await post("/withdraw", await withdrawBody(alice, 1_000000n, { deadline: BigInt(now() - 5) }));
    assert(expired.status === 400, `expired: ${brief(expired)}`);
    const walletBefore = await usdcOf(alice.address);
    const body = await withdrawBody(alice, 7_000000n);
    const good = await post("/withdraw", body);
    assert(good.status === 200, brief(good));
    const replay = await post("/withdraw", body);
    assert(replay.status === 400, `replay: ${brief(replay)}`);
    assert((await usdcOf(alice.address)) - walletBefore === 7_000000n, "the wallet did not receive exactly 7 USDC");
  });

  const tag = Math.floor(Math.random() * 1e8);
  await check("a username claimed with somebody else's signature is refused (401)", async () => {
    const res = await post("/username", await usernameBody(alice, `st_${tag}`, { signer: bob }));
    assert(res.status === 401, brief(res));
    const other = await post("/username", await usernameBody(alice, `st_${tag}`, { signer: bob, signedFor: bob.address }));
    assert(other.status === 401, `signed for the signer's own address: ${brief(other)}`);
    assert((await accountOf(alice)).name === null, "a name was set");
  });

  await check("a taken username cannot be taken again, in any letter case", async () => {
    const name = `kelvin_${tag}`;
    const claim = await post("/username", await usernameBody(alice, name));
    assert(claim.status === 200 && claim.json.name === name, brief(claim));
    for (const variant of [name, name.toUpperCase(), `Kelvin_${tag}`, `kElViN_${tag}`]) {
      const res = await post("/username", await usernameBody(bob, variant));
      assert(res.status === 409, `"${variant}": ${brief(res)}`);
    }
    assert((await accountOf(alice)).name === name && (await accountOf(bob)).name === null, "the name moved");
  });

  await check("look-alike names (Kelvin sign, Cyrillic, full-width, zero-width, padded) cannot stand in for a taken one", async () => {
    const taken = `kelvin_${tag}`;
    const lookalikes = [`Kelvin_${tag}`, `kеlvin_${tag}`, `ｋelvin_${tag}`, `kelvin​_${tag}`, ` kelvin_${tag}`, `kelvin_${tag} `, `kelvin_${tag}\n`, `kelvin_${tag}\u0000`, `kelvın_${tag}`, `kelvİn_${tag}`];
    for (const variant of lookalikes) {
      for (const signedName of [variant.toLowerCase(), variant, taken]) {
        const res = await post("/username", await usernameBody(bob, variant, { signedName }));
        assert(res.status === 400 || res.status === 409 || res.status === 401, `${JSON.stringify(variant)}: ${brief(res)}`);
      }
    }
    assert((await accountOf(bob)).name === null, "bob got a name out of it");
    const board = await read("/leaderboard?window=all");
    const holders = Object.entries(board.names).filter(([, n]) => n.normalize("NFKC").toLowerCase() === taken);
    assert(holders.every(([address]) => address === alice.address.toLowerCase()), "somebody else shows under that name");
  });

  await check("names that are too short, too long or not plain letters are refused; a mixed-case claim is stored lower-case", async () => {
    for (const name of ["ab", "a".repeat(17), "has space", "dash-ed", "dot.ted", "<b>x</b>", "a/b/c", "../etc", "naïve", "名前名前", "ab\tcd", "", "a b", "ab;", "ab'--", "${1}", "%00abc"]) {
      const res = await post("/username", await usernameBody(bob, name));
      assert(res.status === 400, `${JSON.stringify(name)}: ${brief(res)}`);
    }
    const mixed = await post("/username", await usernameBody(bob, `MiXeD_${tag}`));
    assert(mixed.status === 200 && mixed.json.name === `mixed_${tag}`, brief(mixed));
    assert((await accountOf(bob)).name === `mixed_${tag}`, "not stored lower-case");
  });
}

// =============================================================================================
if (wants("money")) {
  section("Money rules");

  const carol = await trader(100);
  const balanceOf = (wallet) => exRead("balances", [wallet.address]);

  await check("an order for more margin than the balance is refused", async () => {
    for (const margin of [100_000001n, 101_000000n, 10_000_000000n]) {
      const { res } = await sendOpen(carol, { margin, leverage: 1 });
      assert(res.status === 400 && /balance/i.test(res.text), `${usd(margin)}: ${brief(res)}`);
    }
    const queued = await sendOpen(carol, { margin: 101_000000n, leverage: 1, useQueued: true });
    assert(queued.res.status === 400, `with "use queued winnings" and nothing queued: ${brief(queued.res)}`);
    assert((await accountOf(carol)).reserved === "0", "something stayed reserved");
  });

  await check("margin below the minimum, zero and negative are refused", async () => {
    for (const margin of [999_999n, 1n, 0n, -1n, -1_000000n]) {
      const res = await post("/open", { intent: { ...openMessage(fresh().address), margin }, signature: `0x${"11".repeat(65)}` });
      assert(res.status === 400, `${margin}: ${brief(res)}`);
    }
    const { res } = await sendOpen(carol, { margin: 999_999n });
    assert(res.status === 400 && /minimum/i.test(res.text), `signed, 0.999999: ${brief(res)}`);
  });

  await check("leverage 0, 1001, 65536, 65537, negative and fractional are refused", async () => {
    for (const leverage of [0, 1001, 65_535]) {
      const { res } = await sendOpen(carol, { leverage });
      assert(res.status === 400 && /leverage/i.test(res.text), `${leverage}: ${brief(res)}`);
    }
    for (const leverage of [65_536, 65_537, 66_536, -1, 1.5, 1000.5, 4_294_967_297, "1000x", "١٠"]) {
      const res = await post("/open", { intent: { ...openMessage(fresh().address), leverage }, signature: `0x${"11".repeat(65)}` });
      assert(res.status === 400, `${leverage}: ${brief(res)}`);
    }
  });

  await check("a position larger than the market allows is refused", async () => {
    const btc = config.markets[0];
    const limit = BigInt(btc.maxNotional);
    for (const [margin, leverage] of [[limit / 1000n + 1n, 1000], [limit + 1n, 1], [2n ** 95n, 1], [2n ** 96n, 1000]]) {
      const res = await post("/open", { intent: { ...openMessage(fresh().address), margin, leverage }, signature: `0x${"11".repeat(65)}` });
      assert(res.status === 400, `${margin} x${leverage}: ${brief(res)}`);
    }
    const { res } = await sendOpen(carol, { margin: limit / 1000n + 1n, leverage: 1000 });
    assert(res.status === 400 && /larger/i.test(res.text), `signed: ${brief(res)}`);
  });

  await check("an unknown market is refused", async () => {
    for (const market of [2, 99, 65_535, 65_536, -1, 0.5]) {
      const res = await post("/open", { intent: { ...openMessage(fresh().address), market }, signature: `0x${"11".repeat(65)}` });
      assert(res.status === 400, `${market}: ${brief(res)}`);
    }
  });

  await check("two orders in the same instant that together exceed the balance: one is taken, the other refused", async () => {
    const one = openMessage(carol.address, { margin: 60_000000n, leverage: 1 });
    const two = openMessage(carol.address, { margin: 60_000000n, leverage: 1, isLong: false });
    const [sigOne, sigTwo] = await Promise.all([signOpen(carol, one), signOpen(carol, two)]);
    const [a, b] = await Promise.all([post("/open", { intent: one, signature: sigOne }), post("/open", { intent: two, signature: sigTwo })]);
    const statuses = [a.status, b.status].sort().join(",");
    assert(statuses === "200,400", `answers were ${brief(a)} / ${brief(b)}`);
    const reserved = (await accountOf(carol)).reserved;
    assert(reserved === "60000000" || reserved === "0", `reserved ${reserved}`);
    await waitIntent((a.status === 200 ? a : b).json.id);
    assert((await balanceOf(carol)) === 40_000000n, `balance is ${usd(await balanceOf(carol))}`);
    assert((await accountOf(carol)).positions.length === 1, "not exactly one position");
  });

  await check("five orders in the same instant for 15 each against 40: two are taken, three refused", async () => {
    const messages = Array.from({ length: 5 }, () => openMessage(carol.address, { margin: 15_000000n, leverage: 1 }));
    const signatures = await Promise.all(messages.map((m) => signOpen(carol, m)));
    const answers = await Promise.all(messages.map((m, i) => post("/open", { intent: m, signature: signatures[i] })));
    const taken = answers.filter((r) => r.status === 200);
    assert(taken.length === 2 && answers.filter((r) => r.status === 400).length === 3, answers.map(brief).join(" / "));
    await Promise.all(taken.map((r) => waitIntent(r.json.id)));
    assert((await balanceOf(carol)) === 10_000000n, `balance is ${usd(await balanceOf(carol))}`);
  });

  await check("a withdrawal while an order is in flight cannot take the order's margin", async () => {
    // 10 free. An order for 8 is accepted and waits two seconds for its price.
    const order = await sendOpen(carol, { margin: 8_000000n, leverage: 1 });
    assert(order.res.status === 200, brief(order.res));
    const greedy = await post("/withdraw", await withdrawBody(carol, 10_000000n));
    assert(greedy.status === 400 && /balance/i.test(greedy.text), `withdraw of all 10 with 8 spoken for: ${brief(greedy)}`);
    const three = await post("/withdraw", await withdrawBody(carol, 3_000000n));
    assert(three.status === 400, `withdraw of 3 with 2 free: ${brief(three)}`);
    const fine = await post("/withdraw", await withdrawBody(carol, 2_000000n));
    assert(fine.status === 200, `withdraw of the 2 that are free: ${brief(fine)}`);
    const filled = await waitIntent(order.id);
    assert(filled.status === "confirmed", "the order did not land");
    assert((await balanceOf(carol)) === 0n, `balance is ${usd(await balanceOf(carol))}`);
  });

  const dave = await trader(50);
  await check("an order and a withdrawal in the same instant that together exceed the balance: exactly one is taken", async () => {
    const message = openMessage(dave.address, { margin: 40_000000n, leverage: 1 });
    const [signature, body] = await Promise.all([signOpen(dave, message), withdrawBody(dave, 40_000000n)]);
    const [order, withdrawal] = await Promise.all([post("/open", { intent: message, signature }), post("/withdraw", body)]);
    const taken = [order, withdrawal].filter((r) => r.status === 200).length;
    assert(taken === 1, `order: ${brief(order)} / withdrawal: ${brief(withdrawal)}`);
    if (order.status === 200) {
      const end = await waitIntent(order.json.id, ["confirmed", "failed"]);
      assert(end.status === "confirmed", `the order was accepted and then failed: ${end.error}`);
    }
    await sleep(500);
    assert((await balanceOf(dave)) === 10_000000n, `balance is ${usd(await balanceOf(dave))}`);
  });

  await check("two withdrawals in the same instant for the whole balance: one pays, the other is refused", async () => {
    const wallet = await trader(30);
    const before = await usdcOf(wallet.address);
    const [x, y] = await Promise.all([withdrawBody(wallet, 30_000000n), withdrawBody(wallet, 30_000000n, { to: fresh().address })]);
    const [a, b] = await Promise.all([post("/withdraw", x), post("/withdraw", y)]);
    assert([a.status, b.status].sort().join(",") === "200,400", `${brief(a)} / ${brief(b)}`);
    assert((await balanceOf(wallet)) === 0n, "balance not zero");
    assert((await usdcOf(wallet.address)) - before === (a.status === 200 ? 30_000000n : 0n), "the wrong withdrawal paid");
  });

  await check("withdrawing more than the balance, zero, a negative amount or to the zero address is refused", async () => {
    const wallet = await trader(20);
    for (const amount of [20_000001n, 10n ** 30n, 0n, -1n, -20_000000n]) {
      const res = await post("/withdraw", await withdrawBody(wallet, amount < 0n ? 1n : amount).then((b) => ({ ...b, amount })));
      assert(res.status === 400, `${amount}: ${brief(res)}`);
    }
    const zero = await post("/withdraw", await withdrawBody(wallet, 1_000000n, { to: "0x0000000000000000000000000000000000000000" }));
    assert(zero.status === 400, `to the zero address: ${brief(zero)}`);
    assert((await balanceOf(wallet)) === 20_000000n, "balance changed");
    assert((await accountOf(wallet)).reserved === "0", "something stayed reserved");
  });

  await check("an order whose price limit cannot be met is dropped and its margin is free again", async () => {
    const wallet = await trader(20);
    const order = await sendOpen(wallet, { margin: 20_000000n, priceLimit: 1n });
    assert(order.res.status === 200, brief(order.res));
    assert((await accountOf(wallet)).reserved === "20000000", "the margin was not set aside while the order was in flight");
    const end = await waitIntent(order.id, ["failed", "confirmed"]);
    assert(end.status === "failed" && /limit/i.test(end.error), `${end.status} ${end.error}`);
    const after = await accountOf(wallet);
    assert(after.reserved === "0" && after.balance === "20000000" && after.positions.length === 0, `reserved ${after.reserved}, balance ${after.balance}, ${after.positions.length} positions`);
  });

  await check("a deposit of more USDC than the wallet holds, of zero, or with a permit for another amount is refused", async () => {
    const wallet = await trader(0, 50);
    const tooMuch = await post("/deposit", await permitFor(wallet, 51_000000n));
    assert(tooMuch.status === 400, `more than the wallet: ${brief(tooMuch)}`);
    const zero = await post("/deposit", await permitFor(wallet, 0n));
    assert(zero.status === 400, `zero: ${brief(zero)}`);
    const permit = await permitFor(wallet, 10_000000n);
    const other = await post("/deposit", { ...permit, amount: 50_000000n });
    assert(other.status === 400, `permit for 10, deposit of 50: ${brief(other)}`);
    const forSomeoneElse = await post("/deposit", { ...permit, owner: fresh().address });
    assert(forSomeoneElse.status === 400, `another owner: ${brief(forSomeoneElse)}`);
    assert((await balanceOf(wallet)) === 0n && (await usdcOf(wallet.address)) === 50_000000n, "money moved");
    const good = await post("/deposit", await permitFor(wallet, 50_000000n));
    assert(good.status === 200 && (await balanceOf(wallet)) === 50_000000n, `the real deposit: ${brief(good)}`);
    const replay = await post("/deposit", permit);
    assert(replay.status === 400, `an old permit afterwards: ${brief(replay)}`);
  });
}

// =============================================================================================
if (wants("isolate")) {
  section("One account must not be able to get in another's way");

  const victim = await trader(200);
  const attacker = fresh();
  const garbageSig = `0x${"11".repeat(65)}`;

  await check("orders sent in a victim's name without their signature do not use up the victim's order allowance", async () => {
    // 60 refused orders naming the victim, from another client address. The allowance is 40 a minute.
    const junk = [];
    for (let i = 0; i < 60; i++) {
      const message = openMessage(victim.address);
      junk.push(post("/open", { intent: message, signature: i % 2 ? garbageSig : await signOpen(attacker, message) }, 3));
    }
    const answers = await Promise.all(junk);
    assert(answers.every((r) => r.status >= 400 && r.status < 500), `a forged order was not refused: ${brief(answers.find((r) => r.status < 400 || r.status >= 500))}`);
    const { res, id } = await sendOpen(victim, { margin: 1_000000n }, { client: 2 });
    assert(res.status === 200, `the victim's own order afterwards: ${brief(res)}`);
    await waitIntent(id);
  });

  await check("forged closes, sessions, deposits and withdrawals in a victim's name do not use it up either", async () => {
    const position = (await accountOf(victim)).positions[0];
    const junk = [];
    for (let i = 0; i < 15; i++) {
      junk.push(post("/close", { intent: { owner: victim.address, positionId: position.id, timestamp: stamp() }, signature: garbageSig }, 3));
      junk.push(post("/session", { owner: victim.address, key: attacker.address, validUntil: now() + 86_400, signature: garbageSig }, 3));
      junk.push(post("/deposit", { owner: victim.address, amount: 1_000000n, deadline: BigInt(now() + 3600), v: 27, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` }, 3));
      junk.push(post("/withdraw", { owner: victim.address, to: attacker.address, amount: 1_000000n, deadline: BigInt(now() + 300), signature: garbageSig }, 3));
    }
    const answers = await Promise.all(junk);
    const wrong = answers.filter((r) => r.status === 429 ? false : r.status < 400 || r.status >= 500);
    assert(wrong.length === 0, `not refused: ${brief(wrong[0] ?? {})}`);
    const { res } = await sendClose(victim, position.id, { client: 2 });
    assert(res.status === 200, `the victim's own close afterwards: ${brief(res)}`);
    await waitIntent(res.json.id);
    assert((await usdcOf(attacker.address)) === 0n, "the attacker was paid");
  });

  await check("forged withdrawals for a victim's whole balance do not block the victim's orders", async () => {
    const wallet = await trader(100);
    let stop = false;
    let forged = 0;
    const flood = (async () => {
      while (!stop) {
        // Three at a time, so that one is always waiting in the relayer's queue.
        await Promise.all(
          [0, 1, 2].map(() => post("/withdraw", { owner: wallet.address, to: attacker.address, amount: 100_000000n, deadline: BigInt(now() + 300), signature: garbageSig }, 100 + (forged++ % 60))),
        );
      }
    })();
    await sleep(300);
    const answers = [];
    for (let i = 0; i < 8; i++) {
      answers.push((await sendOpen(wallet, { margin: 10_000000n, leverage: 1 }, { client: 2 })).res);
      await sleep(120);
    }
    stop = true;
    await flood;
    const blocked = answers.filter((r) => r.status !== 200);
    assert(blocked.length === 0, `${blocked.length} of 8 of the victim's orders were refused during ${forged} forged withdrawals: ${brief(blocked[0] ?? {})}`);
    await waitFor("the orders to land", async () => (await accountOf(wallet)).positions.filter((p) => p.status === "open").length === 8, 20_000);
    assert((await usdcOf(attacker.address)) === 0n, "the attacker was paid");
    return `${forged} forged withdrawals`;
  });

  await check("a withdrawal with a deadline that does not fit the contract's type is refused at once, and holds nothing back", async () => {
    const wallet = await trader(40);
    for (const deadline of ["18446744073709551616", "-1", -1, 1e21, 1.5, null, "abc", "", {}, [], true, "340282366920938463463374607431768211456"]) {
      const started = Date.now();
      const res = await request({ method: "POST", path: "/withdraw", client: anyClient(), timeout: 6_000, body: { owner: wallet.address, to: attacker.address, amount: 40_000000n, deadline, signature: garbageSig } });
      assert(res.status >= 400 && res.status < 500, `deadline ${toJson(deadline).slice(0, 26)}: ${res.status ? brief(res) : `no answer after ${Date.now() - started} ms (${res.error})`}`);
    }
    // Signed by the wallet itself this time: still not something the contract can take.
    const own = await withdrawBody(wallet, 40_000000n, { deadline: 2n ** 64n - 1n });
    const res = await request({ method: "POST", path: "/withdraw", client: anyClient(), timeout: 6_000, body: { ...own, deadline: "18446744073709551616" } });
    assert(res.status >= 400 && res.status < 500, `signed by the owner: ${res.status ? brief(res) : `no answer (${res.error})`}`);
    await sleep(300);
    assert((await accountOf(wallet)).reserved === "0", `the account's balance is still set aside: ${(await accountOf(wallet)).reserved}`);
    const order = await sendOpen(wallet, { margin: 40_000000n, leverage: 1 });
    assert(order.res.status === 200, `the owner's order afterwards: ${brief(order.res)}`);
    await waitIntent(order.id);
  });

  await check("trades that share a block with a malformed withdrawal still land", async () => {
    const wallet = await trader(60);
    // Any funded account will do as the name on the malformed request. Several, in turn.
    const baits = await Promise.all(Array.from({ length: 8 }, () => trader(2)));
    const orders = [];
    let stop = false;
    // Malformed withdrawals in a steady stream while honest orders are priced and submitted.
    const flood = (async () => {
      for (let i = 0; !stop; i++) {
        request({ method: "POST", path: "/withdraw", client: 100 + (i % 60), timeout: 3_000, body: { owner: baits[i % baits.length].address, to: attacker.address, amount: 1n, deadline: "18446744073709551616", signature: garbageSig } });
        await sleep(25);
      }
    })();
    for (let i = 0; i < 6; i++) {
      orders.push(await sendOpen(wallet, { margin: 10_000000n, leverage: 1 }, { client: 2 }));
      await sleep(350);
    }
    await sleep(3_500);
    stop = true;
    await flood;
    const refused = orders.filter((o) => o.res.status !== 200);
    assert(refused.length === 0, `an honest order was refused: ${brief(refused[0]?.res ?? {})}`);
    const ends = await Promise.all(orders.map((o) => waitIntent(o.id, ["confirmed", "failed"], 12_000).catch((error) => ({ status: "stuck", error: error.message }))));
    const lost = ends.filter((e) => e.status !== "confirmed");
    assert(lost.length === 0, `${lost.length} of 6 honest orders never landed: ${lost[0]?.status} ${lost[0]?.error ?? ""}`);
    assert((await accountOf(wallet)).reserved === "0", "the honest account's balance is still set aside");
    for (const bait of baits) assert((await accountOf(bait)).reserved === "0", "a bait account's balance is still set aside");
  });

  await check("nobody can push a wallet's USDC onto the exchange without that wallet's permit", async () => {
    // The wallet has, at some point, approved the deposit contract directly.
    const wallet = await trader(0, 500);
    await giveEth(wallet.address);
    const client = createWalletClient({ account: wallet, chain: foundry, transport: rpcHttp(RPC) });
    await rpc.waitForTransactionReceipt({ hash: await client.writeContract({ address: A.usdc, abi: ERC20, functionName: "approve", args: [A.gateway, 2n ** 255n] }) });
    const res = await post("/deposit", { owner: wallet.address, amount: 500_000000n, deadline: BigInt(now() + 3600), v: 27, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` }, 3);
    const moved = 500_000000n - (await usdcOf(wallet.address));
    assert(res.status >= 400 && res.status < 500 && moved === 0n, `answer: ${brief(res)}; ${usd(moved)} USDC left the wallet for the exchange without a signature`);
  });

  await check("one account's data never shows up under another's", async () => {
    const [mine, theirs] = await Promise.all([read(`/account/${victim.address}`), read(`/account/${attacker.address}`)]);
    assert(theirs.positions.length === 0 && theirs.intents.length === 0 && theirs.balance === "0", "the attacker's account is not empty");
    assert(mine.intents.every((i) => i.owner === victim.address), "foreign intents in the victim's account");
    const history = await read(`/history/${attacker.address}`);
    assert(history.trades.length === 0 && history.transfers.length === 0, "the attacker has history");
  });
}

// =============================================================================================
const recover = [];
if (wants("limits")) {
  section("Limits");

  await check("reads are limited per caller: a flood from one address is refused, and nobody else notices", async () => {
    if (!multiClient) return "skipped: needs more than one loopback address";
    const flooder = 9;
    let sent = 0;
    let refusedAt = 0;
    // Batches of 200 until the relayer starts refusing; the limit on a local chain is 6000 a minute.
    while (!refusedAt && sent < 9_000) {
      const answers = await Promise.all(Array.from({ length: 200 }, () => get("/config", flooder)));
      const bad = answers.find((r) => r.status !== 200 && r.status !== 429);
      assert(!bad, `a read answered ${brief(bad)}`);
      const first = answers.findIndex((r) => r.status === 429);
      if (first !== -1) refusedAt = sent + first + 1;
      sent += answers.length;
    }
    assert(refusedAt > 0, `${sent} reads in a row from one address and none was refused`);
    assert(refusedAt > 500, `refused already at read ${refusedAt}`);
    const other = await get("/config", 10);
    assert(other.status === 200, `another address was caught by it: ${brief(other)}`);
    const health = await get("/health", flooder);
    assert(health.status === 200, `the health check is limited too: ${brief(health)}`);
    const account = await get(`/account/${fresh().address}`, flooder);
    assert(account.status === 429, `the flooder can still read accounts: ${brief(account)}`);
  });

  const limited = await trader(5);
  await check("the per-account order limit triggers: 40 a minute, the 41st gets 429", async () => {
    // Properly signed orders the account cannot afford: refused, but they are the account's own.
    const answers = [];
    for (let i = 0; i < 40; i++) answers.push((await sendOpen(limited, { margin: 1_000_000000n, leverage: 1 }, { client: 5 })).res);
    const early = answers.findIndex((r) => r.status === 429);
    assert(early === -1, `limited already at order ${early + 1}`);
    assert(answers.every((r) => r.status === 400), `an order was not refused for balance: ${brief(answers.find((r) => r.status !== 400))}`);
    const over = await sendOpen(limited, { margin: 1_000000n }, { client: 5 });
    assert(over.res.status === 429, `order 41: ${brief(over.res)}`);
    const close = await sendClose(limited, `0x${"12".repeat(32)}`, { client: 5 });
    assert(close.res.status === 429 || close.res.status === 404, `a close while limited: ${brief(close.res)}`);
    recover.push({ at: Date.now() + 61_000, name: "the per-account order limit recovers a minute later", run: async () => {
      const { res, id } = await sendOpen(limited, { margin: 1_000000n }, { client: 5 });
      assert(res.status === 200, brief(res));
      await waitIntent(id);
    } });
  });

  await check("another account is not limited while that one is", async () => {
    const other = await trader(5);
    const { res, id } = await sendOpen(other, { margin: 1_000000n }, { client: 5 });
    assert(res.status === 200, brief(res));
    await waitIntent(id);
  });

  if (multiClient) {
    await check(`the per-client write limit triggers: ${POSTS_PER_MINUTE} a minute, the next gets 429 on every POST route`, async () => {
      const answers = await Promise.all(Array.from({ length: POSTS_PER_MINUTE }, () => request({ method: "POST", path: "/open", body: "{}", client: 201 })));
      const early = answers.filter((r) => r.status === 429).length;
      assert(early === 0, `${early} of the first ${POSTS_PER_MINUTE} were limited`);
      assert(answers.every((r) => r.status === 400), `unexpected answer: ${brief(answers.find((r) => r.status !== 400))}`);
      for (const route of [...POST_ROUTES, "/nope"]) {
        const res = await request({ method: "POST", path: route, body: "{}", client: 201 });
        assert(res.status === 429, `${route}: ${brief(res)}`);
      }
      const gets = await request({ path: "/health", client: 201 });
      assert(gets.status === 200, `reads from the limited client: ${brief(gets)}`);
      recover.push({ at: Date.now() + 61_000, name: "the per-client write limit recovers a minute later", run: async () => {
        const res = await request({ method: "POST", path: "/open", body: "{}", client: 201 });
        assert(res.status === 400, brief(res));
      } });
    });

    await check("another client is not limited while that one is", async () => {
      const res = await request({ method: "POST", path: "/open", body: "{}", client: 202 });
      assert(res.status === 400, brief(res));
    });

    await check("event streams are capped per client (12): the 13th gets 429, another client is fine, closing one frees a slot", async () => {
      const baseline = (await read("/status")).streams;
      const held = [];
      for (let i = 0; i < 12; i++) held.push(await openStream(203));
      assert(held.every((s) => s.status === 200), `one of the first twelve was refused: ${held.find((s) => s.status !== 200)?.status}`);
      const extra = await openStream(203);
      extra.close();
      assert(extra.status === 429, `the 13th: ${extra.status || extra.error}`);
      const other = await openStream(204);
      other.close();
      assert(other.status === 200, `another client: ${other.status || other.error}`);
      held.pop().close();
      await sleep(300);
      const again = await openStream(203);
      held.push(again);
      assert(again.status === 200, `after closing one: ${again.status || again.error}`);
      for (const s of held) s.close();
      await waitFor("the streams to be released", async () => (await read("/status")).streams <= baseline, 5_000);
      const after = await openStream(203);
      after.close();
      assert(after.status === 200, "the client stayed capped after closing everything");
    });
  } else {
    skip("the per-client write limit and the per-client stream cap", "this machine has one loopback address only");
  }

  await check("300 event streams opened and dropped leave none behind", async () => {
    const baseline = (await read("/status")).streams;
    for (let i = 0; i < 300; i += 30) {
      const batch = await Promise.all(Array.from({ length: 30 }, (_, j) => openStream(20 + ((i + j) % 150), `?owner=${fresh().address}`)));
      assert(batch.every((s) => s.status === 200), `refused: ${batch.find((s) => s.status !== 200)?.status}`);
      for (const s of batch) s.close();
    }
    await waitFor("the streams to be released", async () => (await read("/status")).streams <= baseline, 5_000);
  });

  await check("200 half-open and stalled requests do not hold the server up", async () => {
    const sockets = [];
    const openSocket = (text, client) =>
      new Promise((resolve) => {
        const socket = net.connect({ host: API.hostname, port: Number(API.port), localAddress: localAddress(client) });
        socket.on("error", () => {});
        socket.on("connect", () => {
          socket.write(text);
          resolve();
        });
        sockets.push(socket);
      });
    const stalls = [];
    for (let i = 0; i < 200; i++) {
      const kind = i % 4;
      const text =
        kind === 0
          ? "GET /hea" // a request line that never ends
          : kind === 1
            ? `GET /house HTTP/1.1\r\nHost: x\r\n${namedAsLine(20 + (i % 150))}X-Slow: ` // headers that never end
            : kind === 2
              ? `POST /open HTTP/1.1\r\nHost: x\r\n${namedAsLine(20 + (i % 150))}Content-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"intent":` // a body that never arrives
              : `POST /withdraw HTTP/1.1\r\nHost: x\r\n${namedAsLine(20 + (i % 150))}Transfer-Encoding: chunked\r\n\r\n5\r\n{"own`; // a chunk that never ends
      stalls.push(openSocket(text, 20 + (i % 150)));
    }
    await Promise.all(stalls);
    await sleep(500);
    const timings = [];
    for (let i = 0; i < 8; i++) {
      const res = await get(i % 2 ? "/health" : "/house");
      assert(res.status === 200, `while they hang: ${brief(res)}`);
      timings.push(res.ms);
    }
    const order = await sendOpen(await trader(3), { margin: 1_000000n });
    assert(order.res.status === 200, `an order while they hang: ${brief(order.res)}`);
    for (const socket of sockets) socket.destroy();
    const slowest = Math.max(...timings);
    assert(slowest < 1_500, `a read took ${slowest} ms`);
    await waitIntent(order.id);
    return `slowest read ${slowest} ms`;
  });

  await check("600 reads at once (accounts, house, coin, board, status) all answer, none with a 500, while /health stays quick", async () => {
    const someone = fresh().address;
    const paths = [`/account/${someone}`, "/house", "/coin", "/leaderboard?window=all", "/status", `/history/${someone}`, "/config", "/series", "/prices?market=0&seconds=1800"];
    const started = Date.now();
    const flood = Promise.all(Array.from({ length: 600 }, (_, i) => request({ path: paths[i % paths.length], client: 20 + (i % 150), timeout: 30_000 })));
    const health = [];
    for (let i = 0; i < 6; i++) {
      await sleep(60);
      health.push((await get("/health")).ms);
    }
    const answers = await flood;
    const wrong = answers.filter((r) => r.status !== 200);
    assert(wrong.length === 0, `${wrong.length} of 600 did not answer 200: ${brief(wrong[0] ?? {})}`);
    const slowest = Math.max(...health);
    assert(slowest < 2_000, `/health took ${slowest} ms during the flood`);
    return `all 600 in ${Date.now() - started} ms; /health at most ${slowest} ms meanwhile`;
  });
}

// =============================================================================================
if (wants("cap") && !QUICK) {
  section("The position cap (this waits for the background run: about five minutes from the start)");

  await check(`an account can hold ${CAP} positions and no more`, async () => {
    await capRun.done;
    if (capRun.error) throw capRun.error;
    assert(capRun.accepted === CAP, `${capRun.accepted} of ${CAP} orders were accepted; first refusal: ${capRun.refused[0]}`);
    await waitFor(`${CAP} positions on-chain`, async () => (await exRead("openIdsOf", [capRun.wallet.address])).length === CAP, 30_000).catch(async () => {
      throw new Error(`${(await exRead("openIdsOf", [capRun.wallet.address])).length} positions on-chain`);
    });
    const res = capRun.extra.res;
    assert(res.status === 400 && /most an account can hold/i.test(res.text), `order ${CAP + 1}: ${brief(res)}`);
    const account = await accountOf(capRun.wallet);
    assert(account.positions.length === CAP && account.reserved === "0", `${account.positions.length} positions listed, reserved ${account.reserved}`);
  });

  await check("closing one makes room for exactly one more", async () => {
    const account = await accountOf(capRun.wallet);
    const close = await sendClose(capRun.wallet, account.positions[0].id, { client: 4 });
    assert(close.res.status === 200, `close: ${brief(close.res)}`);
    await waitIntent(close.res.json.id);
    await waitFor("the position to go", async () => (await accountOf(capRun.wallet)).positions.length === CAP - 1, 10_000);
    const one = openMessage(capRun.wallet.address, { leverage: 1 });
    const two = openMessage(capRun.wallet.address, { leverage: 1, isLong: false });
    const [a, b] = await Promise.all([post("/open", { intent: one, signature: await signOpen(capRun.wallet, one) }, 4), post("/open", { intent: two, signature: await signOpen(capRun.wallet, two) }, 4)]);
    const taken = [a, b].filter((r) => r.status === 200);
    assert(taken.length === 1, `two orders for the one free slot: ${brief(a)} / ${brief(b)}`);
    const end = await waitIntent(taken[0].json.id, ["confirmed", "failed"]);
    assert(end.status === "confirmed", `the accepted one then failed: ${end.error}`);
  });
} else if (wants("cap")) {
  skip(`an account can hold ${CAP} positions and no more`, "--quick");
}

// =============================================================================================
// Only on request (--only=proxy), and only against a relayer started with TRUST_PROXY=1: the
// requests below carry the X-Forwarded-For a reverse proxy would pass on.
if (ONLY?.includes("proxy")) {
  section("Behind a reverse proxy (the relayer must be running with TRUST_PROXY=1)");
  const forwarded = (value) => request({ method: "POST", path: "/open", body: "{}", headers: { "x-forwarded-for": value } });
  const octet = () => 1 + Math.floor(Math.random() * 250);

  await check("an address the sender writes into X-Forwarded-For itself is not believed: its limit still applies", async () => {
    // A proxy that appends passes on "<what the sender wrote>, <the sender's real address>".
    const real = `198.51.100.${octet()}`;
    const answers = await Promise.all(Array.from({ length: 200 }, (_, i) => forwarded(`10.${octet()}.${i >> 8}.${i & 255}, ${real}`)));
    const limited = answers.filter((r) => r.status === 429).length;
    assert(limited === 20, `${limited} of 200 writes from one address were limited (20 should be); each claimed a different first hop`);
  });

  await check("writing somebody else's address first does not use up their allowance", async () => {
    const victim = `203.0.113.${octet()}`;
    const attacker = `198.51.100.${octet()}`;
    await Promise.all(Array.from({ length: 185 }, () => forwarded(`${victim}, ${attacker}`)));
    const res = await forwarded(victim);
    assert(res.status === 400, `the named address's own next write: ${brief(res)}`);
  });
}

// =============================================================================================
if (recover.length) {
  section("Limits recover");
  for (const item of recover) {
    if (QUICK) {
      skip(item.name, "--quick");
      continue;
    }
    const wait = item.at - Date.now();
    if (wait > 0) await sleep(wait);
    await check(item.name, item.run);
  }
}

// =============================================================================================
section("After the barrage");

await check("/health answers and prices are still flowing", async () => {
  const health = await get("/health");
  assert(health.status === 200 && health.json.ok, brief(health));
  const status = await read("/status");
  for (const feed of status.feeds) assert(feed.time !== null && now() - feed.time <= 4, `${feed.symbol} last printed ${now() - feed.time}s ago`);
});

await check("it is the same process: same start time, same PID", async () => {
  const status = await read("/status");
  assert(status.startedAt === startStatus.startedAt, `the relayer restarted: started ${new Date(status.startedAt).toISOString()}, was ${new Date(startStatus.startedAt).toISOString()}`);
  const pid = pidListening(API.port);
  if (startPid === null || pid === null) return "PID not readable on this machine; start time unchanged";
  assert(pid === startPid, `PID is ${pid}, was ${startPid}`);
  return `pid ${pid}`;
});

await check("memory has not ballooned", async () => {
  if (!startPid || !startMemory) return "memory not readable on this machine";
  const nowMemory = memoryOf(startPid);
  assert(nowMemory !== null, "the process is gone");
  assert(nowMemory < startMemory + 200, `resident memory went from ${startMemory.toFixed(0)} MB to ${nowMemory.toFixed(0)} MB`);
  return `${startMemory.toFixed(0)} MB -> ${nowMemory.toFixed(0)} MB after ${((Date.now() - suiteStarted) / 1000).toFixed(0)} s`;
});

await check("nothing is left half-done: no stream held, no order stuck in flight", async () => {
  const status = await read("/status");
  assert(status.streams <= startStatus.streams, `${status.streams} streams open, ${startStatus.streams} at the start`);
  await sleep(4_000);
  const stuck = [];
  for (let i = 0; i < made.length; i += 20) {
    for (const account of await Promise.all(made.slice(i, i + 20).map(accountOf))) {
      if (account.reserved !== "0") stuck.push(`${account.address.slice(0, 10)} has ${usd(account.reserved)} set aside`);
      const waiting = account.intents.filter((x) => x.status === "accepted" && x.pinTime < now() - 15);
      if (waiting.length) stuck.push(`${account.address.slice(0, 10)} has ${waiting.length} order(s) accepted and never settled`);
      const pending = account.positions.filter((p) => p.status === "pending" && p.entryTime < now() - 15);
      if (pending.length) stuck.push(`${account.address.slice(0, 10)} has ${pending.length} position(s) shown that never reached the chain`);
    }
  }
  assert(stuck.length === 0, stuck.slice(0, 8).join("\n"));
  return `${made.length} accounts checked`;
});

await check("an honest trader still gets all the way through: session, deposit, open, close, withdraw", async () => {
  const wallet = await trader(0, 300);
  const key = fresh();
  const session = await post("/session", await sessionBody(wallet, key, now() + 30 * 86_400));
  assert(session.status === 200, `session: ${brief(session)}`);
  const deposit = await post("/deposit", await permitFor(wallet, 300_000000n));
  assert(deposit.status === 200, `deposit: ${brief(deposit)}`);
  await waitFor("the session to activate", () => now() >= session.json.validFrom + 1, 30_000);
  const order = await sendOpen(wallet, { margin: 100_000000n, leverage: 5 }, { signer: key });
  assert(order.res.status === 200, `open: ${brief(order.res)}`);
  const filled = await waitIntent(order.id);
  assert(filled.fill?.price, "no fill price");
  await sleep(1_200);
  const close = await sendClose(wallet, order.id, { signer: key });
  assert(close.res.status === 200, `close: ${brief(close.res)}`);
  const closed = await waitIntent(close.res.json.id);
  const closedAt = Date.now();
  const account = await waitFor("the closed position to leave the account", async () => {
    const a = await accountOf(wallet);
    return a.positions.length === 0 ? a : null;
  }, 8_000);
  const lag = Date.now() - closedAt;
  assert(account.reserved === "0", `reserved ${account.reserved}`);
  assert(lag < 2_000, `the account still listed the position ${lag} ms after its close was confirmed`);
  const total = BigInt(account.balance) + BigInt(account.queued);
  assert(total >= 300_000000n + (BigInt(closed.fill.pnl) < 0n ? BigInt(closed.fill.pnl) : 0n) - 1n, `balance ${usd(account.balance)} + queued ${usd(account.queued)} after pnl ${usd(closed.fill.pnl)}`);
  const out = BigInt(account.balance);
  const withdrawal = await post("/withdraw", await withdrawBody(wallet, out));
  assert(withdrawal.status === 200, `withdraw: ${brief(withdrawal)}`);
  assert((await usdcOf(wallet.address)) === out, "the wallet did not get its money back");
  return `pnl ${usd(closed.fill.pnl)}, ${usd(out)} USDC back in the wallet`;
});

await check("the books balance: the Exchange holds what it accounts for, and treasury = balances + margin + house cash + fees", async () => {
  // Let anything still on its way land, then read the chain itself and compare the relayer to it.
  await sleep(1_500);
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const { house } = await read("/house");
    const [held, treasury, totalBalances, totalCashMargin, lpCash, stakerFees, devFees, totalQueued, debtMarginOpen] = await Promise.all([
      usdcOf(A.exchange),
      ...["treasury", "totalBalances", "totalCashMargin", "lpCash", "stakerFees", "devFees", "totalQueued", "debtMarginOpen"].map((name) => exRead(name)),
    ]);
    const settled =
      BigInt(house.treasury) === treasury && BigInt(house.totalBalances) === totalBalances && BigInt(house.totalCashMargin) === totalCashMargin && BigInt(house.lpCash) === lpCash;
    if (!settled) {
      last = `the relayer's /house does not match the chain (treasury ${usd(house.treasury)} vs ${usd(treasury)})`;
      await sleep(1_000);
      continue;
    }
    assert(held >= treasury, `the Exchange holds ${usd(held)} USDC but accounts for ${usd(treasury)}`);
    assert(treasury === totalBalances + totalCashMargin + lpCash + stakerFees + devFees, "treasury != balances + margin + house cash + fees");
    assert(BigInt(house.treasury) === BigInt(house.totalBalances) + BigInt(house.totalCashMargin) + BigInt(house.lpCash) + BigInt(house.stakerFees) + BigInt(house.devFees), "/house does not add up");

    // The same totals rebuilt account by account, from the chain's own events.
    const logs = await rpc.getLogs({ address: A.exchange, event: parseAbiItem("event Deposited(address indexed user, address indexed from, uint256 amount)"), fromBlock: 0n });
    const users = [...new Set(logs.map((l) => l.args.user))];
    let balances = 0n;
    let queued = 0n;
    let cashMargin = 0n;
    let debtMargin = 0n;
    let positions = 0;
    for (let i = 0; i < users.length; i += 25) {
      await Promise.all(
        users.slice(i, i + 25).map(async (user) => {
          const [balance, owed, ids] = await Promise.all([exRead("balances", [user]), exRead("queuedOf", [user]), exRead("openIdsOf", [user])]);
          balances += balance;
          queued += owed;
          for (let j = 0; j < ids.length; j += 50) {
            for (const p of await Promise.all(ids.slice(j, j + 50).map((id) => exRead("getPosition", [id])))) {
              cashMargin += p.margin - p.debtMargin;
              debtMargin += p.debtMargin;
              positions += 1;
            }
          }
        }),
      );
    }
    assert(balances === totalBalances, `accounts add up to ${usd(balances)}, the Exchange says ${usd(totalBalances)}`);
    assert(cashMargin === totalCashMargin, `open positions hold ${usd(cashMargin)} of cash margin, the Exchange says ${usd(totalCashMargin)}`);
    assert(debtMargin === debtMarginOpen, `open positions hold ${usd(debtMargin)} of queued margin, the Exchange says ${usd(debtMarginOpen)}`);
    assert(queued === totalQueued, `accounts are owed ${usd(queued)}, the Exchange says ${usd(totalQueued)}`);
    return `holds ${usd(held)}, accounts for ${usd(treasury)} = ${usd(totalBalances)} balances + ${usd(totalCashMargin)} margin + ${usd(lpCash)} house + ${usd(stakerFees + devFees)} fees; ${users.length} accounts, ${positions} positions, ${usd(totalQueued)} queued`;
  }
  throw new Error(last);
});

const total = passed + failures.length;
console.log(`\n${passed}/${total} passed${skipped.length ? `, ${skipped.length} skipped` : ""}${failures.length ? `\nfailed:\n  - ${failures.join("\n  - ")}` : ""}\n`);
process.exit(failures.length ? 1 : 0);
