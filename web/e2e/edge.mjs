/**
 * Edge cases in a real browser: what an impatient or hostile visitor does to the interface.
 *
 * Drives the site against a running relayer and a local chain (script/DevDeploy.s.sol), with the
 * built-in test wallets. No mocks: where a check needs to see exactly what the site would send, it
 * reads the request on its way out and, in a few places, answers it itself instead of the relayer.
 *
 *   node e2e/edge.mjs [site-url] [--api=http://127.0.0.1:8787] [--headed]
 *                     [--only=a,b] [--skip=a,b] [--quick] [--outage] [--soak-minutes=5]
 *
 *   sections   ticket, clicks, positions, session, queue, coin, money, nav, tabs, pages, keyboard, sizes,
 *              soak, timings, outage
 *   --quick    leaves out the five-minute soak
 *   --outage   also runs the relayer outage check. It STOPS the process listening on the API port
 *              and starts `node relayer/src/index.mjs` in its place (detached, logging to the
 *              system temp folder), so only run it against a relayer that is yours to restart.
 *
 * A check that fails here is a defect in the site (or the relayer), written down as what should
 * have happened. Screenshots of the failures land in e2e/shots/edge-*.png.
 */
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, parseSignature } from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { domain as buildDomain, types, permitTypes } from "../../shared/eip712.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const SITE = args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:5174";
const API = flag("api") ?? "http://127.0.0.1:8787";
const RPC = flag("rpc") ?? "http://127.0.0.1:8545";
const HEADED = args.includes("--headed");
const QUICK = args.includes("--quick");
const OUTAGE = args.includes("--outage");
const ONLY = flag("only")?.split(",") ?? null;
const SKIP = flag("skip")?.split(",") ?? [];
const SOAK_MINUTES = Number(flag("soak-minutes") ?? 5);
const SHOTS = new URL("./shots/", import.meta.url);
const wants = (name) => (!ONLY || ONLY.includes(name)) && !SKIP.includes(name);
mkdirSync(SHOTS, { recursive: true });

// anvil's accounts 2 to 5: the site's "Test wallet 1..4".
const WALLETS = ["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x90F79bf6EB2c4f870365E785982E1f101E93b906", "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (text) => Number(String(text).replace(/[^0-9.-]/g, ""));
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const toJson = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

let passed = 0;
const failures = [];
const skipped = [];
const timings = [];
let current = null;

async function check(name, fn) {
  try {
    const note = await fn();
    passed += 1;
    console.log(`  ok   ${name}${note ? `  [${note}]` : ""}`);
  } catch (error) {
    failures.push(name);
    const lines = String(error?.message ?? error).split("\n").slice(0, 10);
    let where = "";
    if (current) {
      const file = `edge-${failures.length}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}.png`;
      await current.screenshot({ path: fileURLToPath(new URL(file, SHOTS)) }).then(() => (where = `\n       screenshot: web/e2e/shots/${file}`), () => {});
    }
    console.log(`  FAIL ${name}\n       ${lines.join("\n       ")}${where}`);
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
const timing = (what, samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  timings.push({ what, n: samples.length, median: median(samples), min: sorted[0], max: sorted[sorted.length - 1] });
};

// ---------------------------------------------------------------------------------------------
// The relayer and the chain, for setting scenes up and checking what really happened
// ---------------------------------------------------------------------------------------------

const api = async (path, body) => {
  const res = await fetch(`${API}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: toJson(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${path}: ${json.error ?? res.status}`), { status: res.status });
  return json;
};
/** Moves the simulated BTC price by `bps` and holds it there (0 returns it to the real ticker). */
const nudge = (bps, market = 0) => api("/dev/nudge", { market, bps });
const accountOf = (address) => api(`/account/${address}`);
const historyOf = (address) => api(`/history/${address}?limit=200`);
const config = await api("/config").catch((error) => {
  console.error(`No relayer at ${API}: ${error.message}`);
  process.exit(2);
});
const COIN = config.coin?.symbol ?? "TAPE";
const domain = buildDomain(config.name, config.chainId, config.addresses.exchange);
const offset = config.time - Date.now();
const now = () => Math.floor((Date.now() + offset) / 1000);
const stamp = () => BigInt(Math.floor((Date.now() + offset) / 1000 + 0.25));

const rpc = createPublicClient({ chain: foundry, transport: http(RPC) });
// anvil account 8: mints mock USDC for the helper trader. Nothing else in the project uses it.
const funder = privateKeyToAccount("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97");
const funderWallet = createWalletClient({ account: funder, chain: foundry, transport: http(RPC) });

/** Another trader, driven over the API: somebody for the house to win from or lose to. */
async function helperTrader(dollars) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const amount = BigInt(dollars) * 1_000000n;
  const hash = await funderWallet.writeContract({ address: config.addresses.usdc, abi: parseAbi(["function mint(address to, uint256 amount)"]), functionName: "mint", args: [wallet.address, amount] });
  await rpc.waitForTransactionReceipt({ hash });
  const deadline = BigInt(now() + 3600);
  const sig = parseSignature(
    await wallet.signTypedData({
      domain: { name: config.usdcPermit.name, version: config.usdcPermit.version, chainId: config.chainId, verifyingContract: config.addresses.usdc },
      types: permitTypes,
      primaryType: "Permit",
      message: { owner: wallet.address, spender: config.addresses.gateway, value: amount, nonce: 0n, deadline },
    }),
  );
  await api("/deposit", { owner: wallet.address, amount, deadline, v: Number(sig.v ?? 27n + BigInt(sig.yParity)), r: sig.r, s: sig.s });
  const open = async (isLong, margin, leverage) => {
    const message = { owner: wallet.address, market: 0, isLong, useQueued: false, leverage, margin: BigInt(margin) * 1_000000n, priceLimit: 0n, impactLimit: 0, timestamp: stamp(), salt: BigInt(Math.floor(Math.random() * 2 ** 48)) };
    const { id } = await api("/open", { intent: message, signature: await wallet.signTypedData({ domain, types, primaryType: "Open", message }) });
    for (const until = Date.now() + 20_000; Date.now() < until; await sleep(150)) {
      const intent = await api(`/intent/${id}`);
      if (intent.status === "confirmed") return id;
      if (intent.status === "failed") throw new Error(`helper order failed: ${intent.error}`);
    }
    throw new Error("helper order stuck");
  };
  return { address: wallet.address, open };
}

/** Has somebody else lose `dollars` to the house: a 1000x long busted by a 12 bps drop. */
async function houseWins(dollars) {
  const trader = await helperTrader(dollars);
  await trader.open(true, dollars, 1000);
  await sleep(1_200);
  await nudge(-12);
  for (const until = Date.now() + 30_000; Date.now() < until; await sleep(300)) {
    const history = await historyOf(trader.address);
    if (history.trades.some((t) => t.busted)) break;
  }
  await nudge(0);
  await sleep(1_500);
}

// ---------------------------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------------------------

const browser = await chromium.launch({ headless: !HEADED, args: ["--enable-precise-memory-info"] });
const problems = [];

/** A fresh browser profile with one page on the site. */
async function visitor({ width = 1440, height = 900, label = "page", path = "/trade" } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text().slice(0, 200)}`);
  });
  page.on("pageerror", (error) => problems.push(`${label}: ${error.message}`));
  await page.goto(`${SITE}${path}`);
  return { context, page, errors };
}

/** The handles every check on a page uses. */
function ui(page) {
  const rows = () => page.locator(".trade-bottom .tbl tbody tr, section.panel .tbl tbody tr");
  return {
    page,
    cta: page.locator(".ticket .btn.big"),
    margin: page.locator("#margin"),
    leverage: page.locator("#leverage"),
    slider: page.locator("input.lev"),
    chip: (text) => page.locator(".ticket .chip", { hasText: text }).first(),
    rows,
    row: (text) => page.locator(".tbl tbody tr", { hasText: text }),
    positionRows: () => page.locator(".tbl tbody tr:has(td:nth-child(10))"),
    fillingRows: () => page.locator(".tbl tbody tr", { hasText: "Filling at the next price" }),
    side: (name) => page.getByRole("group", { name: "Direction" }).getByRole("button", { name: new RegExp(name) }).click(),
    nav: (label) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label, exact: true }).click(),
    more: async (label) => {
      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /More/ }).click();
      await page.getByRole("menu").getByRole("link", { name: label, exact: true }).click();
    },
    go: (path) =>
      page.evaluate((to) => {
        history.pushState(null, "", to);
        dispatchEvent(new PopStateEvent("popstate"));
      }, path),
    barBalance: async () => money(await page.locator(".bar-btn.acct b").innerText()),
    kv: async (scope, label) => (await page.locator(`${scope} .kv`, { hasText: label }).first().locator("span").last().innerText()).trim(),
    toasts: () => page.locator(".toast").allInnerTexts(),
    waitPrice: () => page.waitForFunction(() => /\d{1,3},\d{3}\.\d{2}/.test(document.querySelector(".market-pill .px")?.textContent ?? ""), null, { timeout: 15_000 }),
    dialog: page.getByRole("dialog"),
    async setOrder(leverage, margin) {
      await page.locator("#leverage").fill(String(leverage));
      await page.locator("#leverage").blur();
      await page.locator("#margin").fill(String(margin));
    },
    async label() {
      return { text: (await page.locator(".ticket .btn.big").innerText()).trim(), disabled: await page.locator(".ticket .btn.big").isDisabled() };
    },
  };
}

async function connect(page, wallet) {
  await page.locator(".bar-end").getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`Test wallet ${wallet}`) }).click();
  await page.locator(".bar-btn.acct b").waitFor({ timeout: 8_000 });
}

/** Connects `wallet`, turns one-click trading on and waits for it, and tops the balance up. */
async function ready(page, wallet, { balance = 0 } = {}) {
  const u = ui(page);
  await u.waitPrice();
  await connect(page, wallet);
  await page.waitForTimeout(800);
  if (/turn on one-click/i.test(await u.cta.innerText())) {
    await u.cta.click();
    await page.waitForFunction(() => !/turn on|trading on in|check your wallet/i.test(document.querySelector(".ticket .btn.big")?.textContent ?? ""), null, { timeout: 40_000 });
  }
  const have = Number((await accountOf(WALLETS[wallet - 1])).balance) / 1e6;
  if (have < balance) await depositVia(page, Math.ceil(balance - have));
  return u;
}

async function depositVia(page, dollars) {
  const before = Number((await accountOf(await ownerOf(page))).balance) / 1e6;
  await page.locator(".bar-end").getByRole("button", { name: "Deposit", exact: true }).click();
  await page.getByLabel("Amount in USDC").fill(String(dollars));
  await page.getByRole("dialog").getByRole("button", { name: "Deposit", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 20_000 });
  for (const until = Date.now() + 10_000; Date.now() < until; await sleep(200)) {
    if (Number((await accountOf(await ownerOf(page))).balance) / 1e6 >= before + dollars - 0.01) return;
  }
  throw new Error("the deposit did not arrive");
}

/** The address of the wallet a page is connected with, read from what the page remembers. */
async function ownerOf(page) {
  const id = await page.evaluate(() => localStorage.getItem("tape:wallet"));
  return WALLETS[Number(id?.split(":")[1] ?? 0)];
}

/** Every POST the page sends to `path`, as parsed bodies, from now on. */
function watchPosts(page, path) {
  const seen = [];
  const listener = (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === path) seen.push(request.postDataJSON());
  };
  page.on("request", listener);
  return { seen, stop: () => page.off("request", listener) };
}

/** Closes everything `address` has open, over the page's own Close buttons, and waits for it. */
async function flatten(page, address) {
  for (let i = 0; i < 30; i++) {
    const account = await accountOf(address);
    if (account.positions.length === 0 && account.intents.every((x) => x.status !== "accepted")) return;
    const button = page.locator(".tbl tbody tr").getByRole("button", { name: "Close", exact: true }).first();
    if (await button.count()) await button.click().catch(() => {});
    await page.waitForTimeout(1_500);
  }
  throw new Error("could not close everything");
}

async function waitAccount(address, what, test, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const account = await accountOf(address);
    if (test(account)) return account;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

console.log(`\n${SITE} against ${API}: ${config.name} on chain ${config.chainId}\n`);

// The five-minute soak runs on its own page from the start, while the other checks go on.
let soak = null;
if (wants("soak") && !QUICK) soak = startSoak().catch((error) => ({ error }));

// =============================================================================================
const main = await visitor({ label: "wallet 1" });
current = main.page;
const W1 = WALLETS[0];
let u = ui(main.page);
if (["ticket", "clicks", "positions", "session", "queue", "coin", "money", "nav", "pages", "keyboard", "sizes", "timings", "outage"].some(wants)) {
  section("Setting up: test wallet 1, one-click trading on, money on the exchange");
  await check("the wallet connects, the trading key switches on and a deposit arrives", async () => {
    u = await ready(main.page, 1, { balance: 3_000 });
    await flatten(main.page, W1);
  });
}

// =============================================================================================
if (wants("ticket")) {
  section("Ticket inputs");
  const page = main.page;

  // What the site would send is read off the wire and answered here, so that nothing in this
  // section opens a position.
  const sent = [];
  await page.route("**/open", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "Stopped by the test." }) });
  });
  const press = async () => {
    sent.length = 0;
    if (await u.cta.isDisabled()) return null;
    await u.cta.click();
    await page.waitForTimeout(350);
    return sent[0]?.intent ?? null;
  };
  const type = async (locator, text) => {
    await locator.click();
    await locator.press("Control+A");
    await locator.press("Delete");
    if (text !== "") await locator.pressSequentially(text, { delay: 5 });
  };
  const paste = async (locator, text) => {
    await locator.click();
    await locator.press("Control+A");
    await page.evaluate((value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
    // Chromium does not insert the text of a synthetic paste: do what the browser would do next.
    await page.keyboard.insertText(text);
  };
  const state = async () => ({ ...(await u.label()), margin: await u.margin.inputValue(), leverage: await u.leverage.inputValue(), value: await u.kv(".ticket", "Order Value"), bust: await u.kv(".ticket", "Bust Price") });

  await u.side("Long");
  await u.setOrder(10, 5);

  await check("an empty, zero or dot-only margin disables the button and says why", async () => {
    for (const text of ["", "0", "0.0", "0.000000", ".", "00"]) {
      await type(u.margin, text);
      const s = await state();
      assert(s.disabled && /enter a margin/i.test(s.text), `margin "${text}": button says "${s.text}"${s.disabled ? "" : " and is enabled"}`);
      assert((await press()) === null, `margin "${text}" sent an order`);
    }
  });

  await check("a margin under the minimum says so and cannot be sent", async () => {
    for (const text of ["0.5", ".99", "0.999999"]) {
      await type(u.margin, text);
      const s = await state();
      assert(s.disabled && /minimum \$1\.00/i.test(s.text), `margin "${text}": "${s.text}"`);
    }
  });

  await check("letters typed into the margin are ignored and never become a number", async () => {
    await type(u.margin, "abc");
    let s = await state();
    assert(s.margin === "" && s.disabled, `after "abc" the field holds "${s.margin}" and the button says "${s.text}"`);
    await type(u.margin, "1.2.3");
    s = await state();
    assert(s.disabled && /enter a margin/i.test(s.text), `"1.2.3": "${s.text}"`);
  });

  await check('pasting "1e9" into the margin does not quietly become a different amount', async () => {
    await paste(u.margin, "1e9");
    const s = await state();
    // Either take it for what it says (a billion: over the size limit) or refuse it.
    assert(s.margin === "" || s.margin === "1000000000" || s.disabled, `the field now reads "${s.margin}", the button says "${s.text}" and the order value is ${s.value}`);
  });

  await check('pasting "-250" into the margin does not quietly become +250', async () => {
    await paste(u.margin, "-250");
    const s = await state();
    assert(s.margin === "" || s.disabled, `the field now reads "${s.margin}" and the button says "${s.text}"`);
  });

  await check('pasting "$1,250.50" gives 1250.50', async () => {
    await paste(u.margin, "$1,250.50");
    const s = await state();
    assert(s.margin === "1250.50", `the field reads "${s.margin}"`);
  });

  await check("a margin with nine decimals is sent as exactly what the ticket shows, cut to six", async () => {
    await type(u.margin, "12.123456789");
    const s = await state();
    assert(!s.disabled && /long btc/i.test(s.text), `button: "${s.text}"`);
    const intent = await press();
    assert(intent && intent.margin === "12123456", `sent margin ${intent?.margin}`);
    assert(intent.leverage === 10 && intent.isLong === true && intent.market === 0, `sent ${JSON.stringify(intent)}`);
  });

  await check("a margin above the balance offers a deposit and sends no order", async () => {
    const balance = await u.barBalance();
    await type(u.margin, String(Math.floor(balance) + 1));
    const s = await state();
    assert(/deposit to trade/i.test(s.text), `button: "${s.text}"`);
    assert((await press()) === null, "an order was sent");
    await u.dialog.waitFor({ timeout: 3_000 });
    await page.keyboard.press("Escape");
    await u.dialog.waitFor({ state: "detached", timeout: 3_000 });
    // The whole balance, to the cent, is fine; one cent over is not.
    const held = Math.floor(Number((await accountOf(W1)).balance) / 1e4) / 100;
    await type(u.margin, held.toFixed(2));
    assert(/long btc/i.test((await state()).text), `the whole balance (${held.toFixed(2)}): "${(await state()).text}"`);
    await type(u.margin, (held + 0.01).toFixed(2));
    assert(/deposit to trade/i.test((await state()).text), `a cent over: "${(await state()).text}"`);
  });

  await check("the balance on screen is never more than the balance held (it is cut to the cent, not rounded up)", async () => {
    // Make the balance end in more than half a cent, so that rounding and cutting differ.
    const part = Number(BigInt((await accountOf(W1)).balance) % 10_000n);
    if (part < 5_000) {
      const add = (5_000 - part + 1_500) / 1e6;
      await page.locator(".bar-end").getByRole("button", { name: "Deposit", exact: true }).click();
      await page.getByLabel("Amount in USDC").fill(add.toFixed(6));
      await u.dialog.locator(".btn.big").click();
      await u.dialog.waitFor({ state: "detached", timeout: 15_000 });
      await page.waitForTimeout(1_200);
    }
    const exact = Number((await accountOf(W1)).balance) / 1e6;
    const bar = await u.barBalance();
    const collateral = money(await u.kv(".ticket", "Available Collateral"));
    await type(u.margin, bar.toFixed(2));
    const s = await state();
    assert(bar <= exact + 1e-9 && collateral <= exact + 1e-9, `the account holds ${exact}; the top bar says ${bar.toFixed(2)} and the ticket ${collateral.toFixed(2)}. Typing the amount shown as margin gives "${s.text}"`);
  });

  await check("an absurdly large margin is refused with the size limit, and the ticket still reads as numbers", async () => {
    await u.leverage.fill("1000");
    await u.leverage.blur();
    for (const text of ["10001", "99999999", "9".repeat(18), "9".repeat(40)]) {
      await type(u.margin, text);
      const s = await state();
      assert(s.disabled && /size limit is \$10\.00M/i.test(s.text), `margin ${text.length} digits: "${s.text}"`);
      assert(!/e\+|NaN|Infinity|undefined/.test(s.value), `order value reads "${s.value}"`);
      const overflow = await page.evaluate(() => {
        const ticket = document.querySelector(".ticket").getBoundingClientRect();
        return [...document.querySelectorAll(".ticket *")].filter((el) => el.getBoundingClientRect().right > ticket.right + 1 && el.getBoundingClientRect().width > 0).length;
      });
      assert(overflow === 0, `${overflow} elements spill out of the ticket at ${text.length} digits (order value "${s.value}")`);
    }
    // Exactly the limit is allowed (if it can be afforded it says Deposit, never an error).
    await type(u.margin, "10000");
    assert(/deposit to trade|long btc/i.test((await state()).text), `at the limit: "${(await state()).text}"`);
  });

  await u.setOrder(10, 5);

  await check("leverage 0 or empty cannot be sent as some other leverage", async () => {
    for (const text of ["0", "", "00"]) {
      await u.setOrder(1000, 5);
      await type(u.leverage, text);
      const s = await state();
      const intent = await press();
      assert(s.disabled || intent === null, `the field read "${s.leverage}", the button said "${s.text}", and an order went out at ${intent?.leverage}x for $${Number(intent?.margin) / 1e6}`);
    }
  });

  await check("leverage 1001 and 99999 are held to 1000, and the field says so before the order goes", async () => {
    for (const text of ["1001", "99999"]) {
      await u.setOrder(10, 5);
      await type(u.leverage, text);
      const s = await state();
      assert(s.value === "$5,000", `order value with "${text}" typed: ${s.value}`);
      assert(s.leverage === "1000", `the field reads "${s.leverage}" while the order would go at 1000x`);
    }
    await u.setOrder(10, 5);
    await type(u.leverage, "1001");
    const intent = await press();
    assert(intent?.leverage === 1000, `sent ${intent?.leverage}x`);
  });

  await check('typing "2.5" as leverage does not give 25x', async () => {
    await u.setOrder(10, 5);
    await type(u.leverage, "2.5");
    const s = await state();
    const intent = await press();
    assert(intent === null || intent.leverage === 2 || intent.leverage === 3, `the field reads "${s.leverage}", order value ${s.value}, and the order went out at ${intent?.leverage}x`);
  });

  await check('typing "-5" or "1e2" as leverage does not give 5x or 12x without saying so', async () => {
    await u.setOrder(10, 5);
    await type(u.leverage, "1e2");
    const s = await state();
    assert(s.leverage !== "12", `"1e2" became ${s.leverage}x (order value ${s.value})`);
  });

  await check("the 100x chip sets 100x; the slider's two ends are 1x and 1000x", async () => {
    await u.setOrder(7, 5);
    await u.chip("100x").click();
    assert((await u.leverage.inputValue()) === "100" && (await u.kv(".ticket", "Order Value")) === "$500", `after 100x: ${await u.leverage.inputValue()}, ${await u.kv(".ticket", "Order Value")}`);
    await u.slider.focus();
    await page.keyboard.press("Home");
    assert((await u.leverage.inputValue()) === "1", `slider at its left end: ${await u.leverage.inputValue()}x`);
    let intent = await press();
    assert(intent?.leverage === 1, `sent ${intent?.leverage}x from the left end`);
    await u.slider.focus();
    await page.keyboard.press("End");
    assert((await u.leverage.inputValue()) === "1000", `slider at its right end: ${await u.leverage.inputValue()}x`);
    intent = await press();
    assert(intent?.leverage === 1000, `sent ${intent?.leverage}x from the right end`);
    // Every stop of the slider lands on a whole leverage between the two.
    const seen = await page.evaluate(() => {
      const input = document.querySelector("input.lev");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      const out = [];
      for (let stop = 0; stop <= 1000; stop += 37) {
        setter.call(input, String(stop));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        out.push(Number(document.querySelector("#leverage").value));
      }
      return out;
    });
    assert(seen.every((v, i) => Number.isInteger(v) && v >= 1 && v <= 1000 && (i === 0 || v >= seen[i - 1])), `slider stops gave ${seen.join(",")}`);
  });

  await check("½× stops at the minimum, 2× runs into the size limit, and neither ever leaves a sendable lie", async () => {
    await u.setOrder(1000, 8);
    for (let i = 0; i < 12; i++) await u.chip("½×").click();
    let s = await state();
    assert(s.margin === "1" && /long btc/i.test(s.text), `after halving twelve times: margin "${s.margin}", "${s.text}"`);
    for (let i = 0; i < 70; i++) await u.chip("2×").click();
    s = await state();
    assert(s.disabled && /size limit/i.test(s.text), `after doubling seventy times: margin "${s.margin.slice(0, 30)}", "${s.text}"`);
    assert(!/e\+|NaN|Infinity/.test(s.value + s.margin), `the ticket reads ${s.value} / ${s.margin.slice(0, 30)}`);
    assert((await press()) === null, "an order was sent");
    // With nothing in the field the two do nothing.
    await type(u.margin, "");
    await u.chip("½×").click();
    await u.chip("2×").click();
    assert((await u.margin.inputValue()) === "", `empty margin became "${await u.margin.inputValue()}"`);
  });

  await check("½× never makes the margin bigger", async () => {
    await type(u.margin, "0.5");
    await u.chip("½×").click();
    const after = await u.margin.inputValue();
    assert(Number(after) <= 0.5, `½× on 0.5 gave ${after}`);
  });

  await check("% steps through 10, 25, 50 and 100 percent of the balance, and 100 percent can be sent", async () => {
    const balance = await u.barBalance();
    await u.leverage.fill("2");
    await u.leverage.blur();
    const seen = [];
    for (let i = 0; i < 5; i++) {
      await u.chip("%").click();
      seen.push(Number(await u.margin.inputValue()));
    }
    const want = [0.1, 0.25, 0.5, 1, 0.1].map((share) => balance * share);
    seen.forEach((value, i) => assert(Math.abs(value - want[i]) <= 0.011, `press ${i + 1}: ${value}, expected about ${want[i].toFixed(2)}`));
    for (let i = 0; i < 3; i++) await u.chip("%").click();
    const s = await state();
    assert(/long btc/i.test(s.text) && !s.disabled, `at 100 percent the button says "${s.text}"`);
    const intent = await press();
    assert(intent && Number(intent.margin) / 1e6 <= balance + 1e-9, `sent ${Number(intent?.margin) / 1e6} with ${balance} available`);
  });

  await check("switching side and market keeps the ticket truthful", async () => {
    await u.setOrder(50, 20);
    await u.side("Short");
    let s = await state();
    assert(/short btc/i.test(s.text), `after Short: "${s.text}"`);
    const mark = money(await page.locator(".market-pill .px").innerText());
    assert(money(s.bust) > mark, `a short's bust price (${s.bust}) is not above the price (${mark})`);
    let intent = await press();
    assert(intent?.isLong === false && intent.leverage === 50 && intent.margin === "20000000", `sent ${JSON.stringify(intent)}`);
    await page.locator(".market-pill").getByRole("button").first().click();
    await page.getByRole("menu").getByRole("button", { name: /ETH/ }).click();
    await page.waitForFunction(() => /short eth/i.test(document.querySelector(".ticket .btn.big")?.textContent ?? ""), null, { timeout: 5_000 });
    intent = await press();
    assert(intent?.market === 1 && intent.isLong === false, `on ETH, sent ${JSON.stringify(intent)}`);
    await page.locator(".market-pill").getByRole("button").first().click();
    await page.getByRole("menu").getByRole("button", { name: /BTC/ }).click();
    await u.side("Long");
  });

  await check("a refused order says so in a toast and leaves no ghost row behind", async () => {
    await u.setOrder(10, 5);
    await press();
    const toasts = await u.toasts();
    assert(toasts.some((t) => /order not placed/i.test(t) && /stopped by the test/i.test(t)), `toasts: ${JSON.stringify(toasts)}`);
    assert((await u.fillingRows().count()) === 0 && (await u.positionRows().count()) === 0, "a row appeared for an order that was refused");
    assert(/long btc/i.test((await u.label()).text) && !(await u.label()).disabled, `the button is stuck on "${(await u.label()).text}"`);
  });

  await page.unroute("**/open");
  assert((await accountOf(W1)).positions.length === 0, "this section opened a position");
}

// =============================================================================================
if (wants("clicks")) {
  section("Double and triple clicks");
  const page = main.page;
  await page.waitForTimeout(4_700); // let the toasts of the last section go
  await u.side("Long");

  const countOrders = async (clicks, gapMs) => {
    await u.setOrder(2, 3);
    const posts = watchPosts(page, "/open");
    const before = (await accountOf(W1)).positions.length;
    if (gapMs === 0) await u.cta.click({ clickCount: clicks, delay: 0 });
    else {
      for (let i = 0; i < clicks; i++) {
        await u.cta.click({ force: true, noWaitAfter: true }).catch(() => {});
        if (i < clicks - 1) await page.waitForTimeout(gapMs);
      }
    }
    await page.waitForTimeout(4_500);
    posts.stop();
    const after = await waitAccount(W1, "the orders to settle", (a) => a.intents.every((x) => x.status !== "accepted" && x.status !== "filled"));
    return { posts: posts.seen.length, opened: after.positions.length - before };
  };

  await check("a double click on the order button (no gap) places one order", async () => {
    const r = await countOrders(2, 0);
    assert(r.posts === 1 && r.opened === 1, `${r.posts} orders sent, ${r.opened} positions opened`);
  });
  await check("a triple click on the order button (no gap) places one order", async () => {
    const r = await countOrders(3, 0);
    assert(r.posts === 1 && r.opened === 1, `${r.posts} orders sent, ${r.opened} positions opened`);
  });
  // Windows calls anything up to 500 ms a double click. These two are well inside that.
  for (const gap of [60, 150]) {
    await check(`two clicks ${gap} ms apart (a human double click) place one order`, async () => {
      const r = await countOrders(2, gap);
      assert(r.posts === 1 && r.opened === 1, `${r.posts} orders sent, ${r.opened} positions opened`);
    });
  }

  await check("a double and a triple click on Close send one close each", async () => {
    await page.waitForTimeout(2_500);
    const before = (await accountOf(W1)).positions.length;
    assert(before >= 2, `only ${before} positions to close`);
    const posts = watchPosts(page, "/close");
    await page.locator(".tbl tbody tr").getByRole("button", { name: "Close", exact: true }).first().click({ clickCount: 2, delay: 0 });
    await page.waitForTimeout(150);
    await page.locator(".tbl tbody tr").getByRole("button", { name: "Close", exact: true }).first().click({ clickCount: 3, delay: 0 });
    await waitAccount(W1, "two positions to close", (a) => a.positions.length === before - 2);
    await page.waitForTimeout(1_000);
    posts.stop();
    assert(posts.seen.length === 2, `${posts.seen.length} closes sent for two positions`);
    const failed = (await u.toasts()).filter((t) => /close failed|not sent/i.test(t));
    assert(failed.length === 0, `toasts: ${JSON.stringify(failed)}`);
  });

  await check("two clicks on Close 120 ms apart send one close", async () => {
    const before = (await accountOf(W1)).positions.length;
    assert(before >= 1, "nothing to close");
    const posts = watchPosts(page, "/close");
    const button = page.locator(".tbl tbody tr").getByRole("button", { name: "Close", exact: true }).first();
    const box = await button.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(120);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await waitAccount(W1, "the position to close", (a) => a.positions.length === before - 1);
    await page.waitForTimeout(1_500);
    posts.stop();
    assert(posts.seen.length === 1, `${posts.seen.length} closes sent`);
    assert((await accountOf(W1)).positions.length === before - 1, "a second position was closed by the second click");
  });

  await check("a double click on Deposit makes one deposit", async () => {
    const before = BigInt((await accountOf(W1)).balance);
    const posts = watchPosts(page, "/deposit");
    await page.locator(".bar-end").getByRole("button", { name: "Deposit", exact: true }).click();
    await page.getByLabel("Amount in USDC").fill("7");
    await u.dialog.getByRole("button", { name: "Deposit", exact: true }).click({ clickCount: 3, delay: 0 });
    await u.dialog.waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForTimeout(1_500);
    posts.stop();
    const got = BigInt((await accountOf(W1)).balance) - before;
    assert(posts.seen.length === 1 && got === 7_000000n, `${posts.seen.length} deposits sent, balance up by ${Number(got) / 1e6}`);
  });

  await check("a double click on Withdraw makes one withdrawal", async () => {
    const before = BigInt((await accountOf(W1)).balance);
    const posts = watchPosts(page, "/withdraw");
    await page.locator(".bar-end").getByRole("button", { name: "Withdraw", exact: true }).click();
    await page.getByLabel("Amount in USDC").fill("7");
    await u.dialog.getByRole("button", { name: "Withdraw", exact: true }).click({ clickCount: 3, delay: 0 });
    await u.dialog.waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForTimeout(1_500);
    posts.stop();
    const got = before - BigInt((await accountOf(W1)).balance);
    assert(posts.seen.length === 1 && got === 7_000000n, `${posts.seen.length} withdrawals sent, balance down by ${Number(got) / 1e6}`);
  });

  await flatten(page, W1);
}

// =============================================================================================
if (wants("positions")) {
  section("Several positions at once");
  const page = main.page;
  await u.nav("Trade");
  await u.side("Long");

  await check("an order placed while another is still filling shows both, then two positions, and the balance drops at once", async () => {
    await flatten(page, W1);
    await u.setOrder(2, 4);
    const before = await u.barBalance();
    await u.cta.click();
    await page.waitForTimeout(450);
    await u.side("Short");
    await u.cta.click();
    await page.waitForFunction(() => [...document.querySelectorAll(".tbl tbody tr")].filter((tr) => /Filling at the next price/.test(tr.textContent)).length === 2, null, { timeout: 2_000 }).catch(async () => {
      throw new Error(`${await u.fillingRows().count()} "Filling" rows after two orders`);
    });
    await page.waitForTimeout(400);
    const during = await u.barBalance();
    assert(Math.abs(before - 8 - during) < 0.011, `balance read ${during} with two orders of 4 in flight (was ${before})`);
    await page.waitForFunction(() => document.querySelectorAll(".tbl tbody tr td:nth-child(10)").length === 2, null, { timeout: 12_000 });
    assert((await u.fillingRows().count()) === 0, "a Filling row stayed after its position appeared");
    await waitAccount(W1, "both to land", (a) => a.positions.filter((p) => p.status === "open").length === 2);
    await u.side("Long");
  });

  await check("closing a position in the same second it fills works, once", async () => {
    await u.setOrder(2, 4);
    const closes = watchPosts(page, "/close");
    const rowsBefore = await u.positionRows().count();
    await u.cta.click();
    // The newest position is the first row. Press its Close the moment it exists.
    await page.waitForFunction((n) => document.querySelectorAll(".tbl tbody tr td:nth-child(10)").length === n + 1, rowsBefore, { timeout: 12_000 });
    await page.locator(".tbl tbody tr:has(td:nth-child(10))").first().getByRole("button", { name: "Close", exact: true }).click({ timeout: 1_000 });
    await page.waitForFunction((n) => document.querySelectorAll(".tbl tbody tr td:nth-child(10)").length === n, rowsBefore, { timeout: 15_000 }).catch(async () => {
      throw new Error(`the row is still there after 15 s; it reads "${(await page.locator(".tbl tbody tr:has(td:nth-child(10))").first().innerText()).replace(/\s+/g, " ")}"; toasts ${JSON.stringify(await u.toasts())}`);
    });
    closes.stop();
    assert(closes.seen.length === 1, `${closes.seen.length} closes sent`);
    const bad = (await u.toasts()).filter((t) => /failed|not sent|not filled/i.test(t));
    assert(bad.length === 0, `toasts: ${JSON.stringify(bad)}`);
    await waitAccount(W1, "the account to settle", (a) => a.positions.length === rowsBefore && a.reserved === "0");
  });

  await check("Close All with six positions open closes all six, each once", async () => {
    await flatten(page, W1);
    await u.setOrder(2, 3);
    for (let i = 0; i < 6; i++) {
      await u.side(i % 2 ? "Short" : "Long");
      await u.cta.click();
      await page.waitForTimeout(700);
    }
    await waitAccount(W1, "six positions", (a) => a.positions.filter((p) => p.status === "open").length === 6, 25_000);
    await page.waitForFunction(() => document.querySelectorAll(".tbl tbody tr td:nth-child(10)").length === 6, null, { timeout: 5_000 });
    await page.locator(".ticket-foot", { hasText: /Open Positions\s*6/ }).waitFor({ timeout: 3_000 });
    await page.waitForTimeout(2_200);
    const closes = watchPosts(page, "/close");
    const started = Date.now();
    await page.locator(".ticket-foot").getByRole("button", { name: "Close All" }).click();
    await page.getByText("No open positions").waitFor({ timeout: 25_000 }).catch(async () => {
      throw new Error(`${await u.positionRows().count()} rows left after 25 s; toasts ${JSON.stringify(await u.toasts())}`);
    });
    const took = Date.now() - started;
    closes.stop();
    assert(closes.seen.length === 6, `${closes.seen.length} closes sent for six positions`);
    assert(new Set(closes.seen.map((c) => c.intent.positionId)).size === 6, "a position was closed twice");
    const history = await historyOf(W1);
    await waitAccount(W1, "the account to be flat", (a) => a.positions.length === 0 && a.reserved === "0");
    assert(history.trades.length >= 6, "the closes are not in the history");
    await u.side("Long");
    return `${took} ms from the click to an empty table`;
  });

  await check("a double click on Close All sends one close per position, and shows no error", async () => {
    await page.waitForTimeout(4_700);
    await u.setOrder(2, 3);
    for (let i = 0; i < 3; i++) {
      await u.cta.click();
      await page.waitForTimeout(700);
    }
    await waitAccount(W1, "three positions", (a) => a.positions.filter((p) => p.status === "open").length === 3, 25_000);
    await page.waitForFunction(() => document.querySelectorAll(".tbl tbody tr td:nth-child(10)").length === 3, null, { timeout: 5_000 });
    await page.waitForTimeout(2_200);
    const closes = watchPosts(page, "/close");
    await page.locator(".ticket-foot").getByRole("button", { name: "Close All" }).click({ clickCount: 2, delay: 0 });
    await page.waitForTimeout(1_200);
    const toasts = (await u.toasts()).map((t) => t.replace(/\s+/g, " "));
    await page.getByText("No open positions").waitFor({ timeout: 25_000 });
    closes.stop();
    await waitAccount(W1, "the account to be flat", (a) => a.positions.length === 0 && a.reserved === "0");
    const errors = toasts.filter((t) => /not sent|failed/i.test(t));
    assert(closes.seen.length === 3 && errors.length === 0, `${closes.seen.length} closes sent for three positions; ${errors.length} error toasts: ${errors.slice(0, 2).join(" | ")}`);
  });
}

// =============================================================================================
if (wants("session")) {
  section("The trading key stops being valid behind the site's back");
  const page = main.page;
  await u.nav("Trade");
  await flatten(page, W1);
  await u.side("Long");

  await check("an order is placed when it is clicked or not at all: never many seconds later, at another price", async () => {
    // The wallet revokes this browser's key from somewhere else (another device, a block explorer).
    const stored = await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("tape:session:")) return JSON.parse(localStorage.getItem(key));
      return null;
    });
    assert(stored?.address, "the page holds no trading key");
    // Test wallet 1 is anvil's account 2: a public test key.
    const wallet = createWalletClient({ account: privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"), chain: foundry, transport: http(RPC) });
    const sessions = parseAbi(["function revokeSessionKey(address key)", "function sessionKeys(address owner, address key) view returns (uint64 validFrom, uint64 validUntil)"]);
    await rpc.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: config.addresses.sessions, abi: sessions, functionName: "revokeSessionKey", args: [stored.address] }) });
    const [, cutoff] = await rpc.readContract({ address: config.addresses.sessions, abi: sessions, functionName: "sessionKeys", args: [W1, stored.address] });
    // Past the cut-off, and past the few seconds the relayer may remember the key for.
    while (now() <= Number(cutoff) + 6) await sleep(500);

    await u.setOrder(2, 4);
    const sent = [];
    const listener = (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/open") sent.push({ at: Date.now(), request });
    };
    page.on("request", listener);
    const clicked = Date.now();
    await u.cta.click();
    const labels = [];
    for (let i = 0; i < 80; i++) {
      const text = (await u.cta.innerText()).trim();
      if (labels[labels.length - 1]?.text !== text) labels.push({ text, at: Date.now() - clicked });
      if (sent.length >= 2 && Date.now() - sent[sent.length - 1].at > 2_500) break;
      await page.waitForTimeout(500);
    }
    page.off("request", listener);
    const answers = [];
    for (const { at, request } of sent) answers.push({ after: at - clicked, status: (await request.response())?.status() ?? 0 });
    const taken = answers.filter((a) => a.status === 200);
    const toasts = (await u.toasts()).map((t) => t.replace(/\s+/g, " "));
    await waitAccount(W1, "the account to settle", (a) => a.intents.every((x) => x.status !== "accepted" && x.status !== "filled"));
    await flatten(page, W1);
    const story = `the button went ${labels.map((l) => `"${l.text}" at ${(l.at / 1000).toFixed(1)}s`).join(", ")}; requests: ${answers.map((a) => `${a.status} at ${(a.after / 1000).toFixed(1)}s`).join(", ")}; toasts: ${JSON.stringify(toasts)}`;
    assert(taken.every((a) => a.after < 5_000), `the order was placed ${(Math.max(...taken.map((a) => a.after)) / 1000).toFixed(1)} s after the click, with no second click: ${story}`);
    return story;
  });
}

// =============================================================================================
if (wants("queue")) {
  section("Busts, queued winnings and the queue being paid");
  const page = main.page;
  await u.nav("Trade");
  // The section before this one had the wallet revoke this browser's trading key. The site no
  // longer makes a new one behind the trader's back: one-click trading is switched on again by hand.
  if (/one-click/i.test(await u.cta.innerText())) {
    await u.cta.click();
    await page.waitForFunction(() => /^(Long|Short) /.test(document.querySelector(".ticket .btn.big")?.textContent ?? ""), null, { timeout: 40_000 });
  }
  await u.side("Long");
  await flatten(page, W1);
  await page.waitForTimeout(4_700);

  await check("a position that busts while its Close is in flight ends as a bust, once, with nothing left hanging", async () => {
    await u.setOrder(1000, 20);
    // Balance and queued winnings together: the bust's own loss may pay this account's place in
    // the queue, which moves money from the second to the first and is no part of the bust.
    const worth = (a) => BigInt(a.balance) + BigInt(a.queued);
    const before = worth(await accountOf(W1));
    await u.cta.click();
    await page.locator(".tbl tbody tr:has(td:nth-child(10))", { hasText: "1000x" }).waitFor({ timeout: 12_000 });
    await waitAccount(W1, "the position to land", (a) => a.positions.some((p) => p.status === "open"));
    await page.waitForTimeout(1_200);
    const account = await accountOf(W1);
    if (account.positions.length === 0) throw new Error("the 1000x position busted on its own before the check could start; run again");
    const id = account.positions[0].id;
    // Close, and in the same instant the price falls through the bust line.
    await Promise.all([page.locator(".tbl tbody tr").getByRole("button", { name: "Close", exact: true }).first().click(), nudge(-12)]);
    await page.waitForFunction(() => document.querySelectorAll(".tbl tbody tr td:nth-child(10)").length === 0, null, { timeout: 20_000 }).catch(async () => {
      throw new Error(`the row is still there after 20 s: "${(await page.locator(".tbl tbody tr").first().innerText()).replace(/\s+/g, " ")}"`);
    });
    const toasts = await u.toasts();
    await nudge(0);
    await page.waitForTimeout(1_500);
    const trades = (await historyOf(W1)).trades.filter((t) => t.id === id);
    assert(trades.length === 1, `${trades.length} history entries for the position`);
    const after = await waitAccount(W1, "the account to settle", (a) => a.positions.length === 0 && a.reserved === "0" && a.intents.every((x) => x.status !== "accepted"));
    assert(trades[0].busted && BigInt(trades[0].pnl) === -20_000000n, `it ended ${trades[0].busted ? "busted" : "closed"} with pnl ${Number(trades[0].pnl) / 1e6}`);
    assert(before - worth(after) === 20_000000n, `balance plus queued winnings moved by ${Number(worth(after) - before) / 1e6}`);
    assert(toasts.some((t) => /busted/i.test(t)), `no bust toast: ${JSON.stringify(toasts)}`);
    assert(!toasts.some((t) => /closed [+-]?\$/i.test(t)), `a toast called it a close: ${JSON.stringify(toasts)}`);
    await page.getByRole("tab", { name: "History" }).click();
    await page.locator(".trade-bottom .tbl tbody tr .badge", { hasText: "Liquidated" }).first().waitFor({ timeout: 5_000 });
    await page.getByRole("tab", { name: "Positions" }).click();
    return toasts.map((t) => t.replace(/\s+/g, " ")).join(" | ");
  });

  let queued = 0n;
  await check("a win bigger than the house can pay is paid as far as the cash goes and the rest is queued, and the screen says so", async () => {
    await page.waitForTimeout(5_000);
    const { house } = await api("/house");
    const cash = Number(house.lpCash) / 1e6;
    assert(BigInt(house.totalQueued) === 0n, `somebody is already queued for ${Number(house.totalQueued) / 1e6}`);
    // At 500x a 30 bps move pays about 1.2 times the margin after the house's cut. Size the
    // position so that this is more than the house has.
    const margin = Math.max(50, Math.ceil((cash + 40) / 1.1));
    const have = Number((await accountOf(W1)).balance) / 1e6;
    if (have < margin + 5) await depositVia(page, Math.ceil(margin + 5 - have));
    await u.setOrder(500, margin);
    await u.cta.click();
    await page.locator(".tbl tbody tr:has(td:nth-child(10))", { hasText: "500x" }).waitFor({ timeout: 12_000 });
    await waitAccount(W1, "the position to land", (a) => a.positions.some((p) => p.status === "open"));
    await page.waitForTimeout(1_500);
    await nudge(30);
    await page.waitForFunction(() => document.querySelector(".tbl tbody tr td.up b")?.textContent?.startsWith("+$"), null, { timeout: 15_000 });
    const balanceBefore = BigInt((await accountOf(W1)).balance);
    await page.locator(".tbl tbody tr").getByRole("button", { name: "Close", exact: true }).first().click();
    await page.locator(".toast.good", { hasText: /closed \+\$/ }).waitFor({ timeout: 20_000 });
    const toast = (await page.locator(".toast.good", { hasText: /closed \+\$/ }).first().innerText()).replace(/\s+/g, " ");
    await nudge(0);
    const account = await waitAccount(W1, "the win to settle", (a) => a.positions.length === 0 && BigInt(a.queued) > 0n);
    queued = BigInt(account.queued);
    const trade = (await historyOf(W1)).trades[0];
    const paid = BigInt(account.balance) - balanceBefore - BigInt(margin) * 1_000000n;
    assert(BigInt(trade.pnl) === paid + queued, `pnl ${Number(trade.pnl) / 1e6} but ${Number(paid) / 1e6} paid and ${Number(queued) / 1e6} queued`);
    assert(/is queued/.test(toast) && toast.includes(`$${(Number(queued) / 1e6).toFixed(2)}`), `the toast reads "${toast}" with ${Number(queued) / 1e6} queued`);
    await page.waitForTimeout(600);
    const shown = money(await u.kv(".ticket .equity", "Queued Winnings"));
    assert(Math.abs(shown - Number(queued) / 1e6) < 0.006, `the ticket shows ${shown} queued, the account has ${Number(queued) / 1e6}`);
    const bar = await u.barBalance();
    assert(Math.abs(bar - Number(account.balance) / 1e6) < 0.0101, `the top bar shows ${bar}: it must be the cash balance (${Number(account.balance) / 1e6}), without the queued part`);
    const equity = money(await page.locator(".equity summary span").last().innerText());
    assert(Math.abs(equity - (Number(account.balance) + Number(queued)) / 1e6) < 0.02, `equity shows ${equity}`);
    return `house had ${cash.toFixed(2)}; won ${(Number(trade.pnl) / 1e6).toFixed(2)}, ${(Number(queued) / 1e6).toFixed(2)} of it queued`;
  });

  await check('"Use queued winnings first" spends the queued money as margin, not the cash, and the ticket adds up', async () => {
    assert(queued > 0n, "nothing is queued");
    const box = page.getByLabel(/Use queued winnings first/);
    await box.waitFor({ timeout: 3_000 });
    const before = await accountOf(W1);
    const cash = Number(before.balance) / 1e6;
    const owed = Number(before.queued) / 1e6;
    // More than the cash alone: only possible with the queued money.
    const over = Math.floor(cash + Math.min(owed, 5)) ;
    await u.setOrder(2, over);
    assert(/deposit to trade/i.test((await u.label()).text), `without the box, ${over} against ${cash} cash: "${(await u.label()).text}"`);
    await box.check();
    assert(Math.abs(money(await u.kv(".ticket", "Available Collateral")) - (cash + owed)) < 0.011, `available collateral shows ${await u.kv(".ticket", "Available Collateral")}`);
    assert(/long btc/i.test((await u.label()).text), `with the box: "${(await u.label()).text}"`);
    const use = Math.max(1, Math.min(Math.floor(owed), 10));
    await u.setOrder(2, use);
    const posts = watchPosts(page, "/open");
    await u.cta.click();
    const after = await waitAccount(W1, "the order to land", (a) => a.positions.some((p) => p.status === "open") && a.reserved === "0" && BigInt(a.queued) < BigInt(before.queued));
    posts.stop();
    assert(posts.seen[0]?.intent.useQueued === true, "the order did not ask for the queued money");
    assert(BigInt(before.queued) - BigInt(after.queued) === BigInt(use) * 1_000000n, `queued went down by ${Number(BigInt(before.queued) - BigInt(after.queued)) / 1e6}, margin was ${use}`);
    assert(BigInt(after.balance) === BigInt(before.balance), `cash moved by ${Number(BigInt(after.balance) - BigInt(before.balance)) / 1e6}`);
    await page.waitForTimeout(800);
    const shown = money(await u.kv(".ticket .equity", "Queued Winnings"));
    assert(Math.abs(shown - Number(after.queued) / 1e6) < 0.006, `the ticket still shows ${shown} queued; the account has ${Number(after.queued) / 1e6}`);
    assert(Math.abs((await u.barBalance()) - cash) < 0.0101, `the top bar moved to ${await u.barBalance()}`);
    queued = BigInt(after.queued);
  });

  await check("the queue is paid when the house next wins, and the screen follows without a reload", async () => {
    assert(queued > 0n, "nothing is queued");
    const before = await accountOf(W1);
    await houseWins(Math.ceil(Number(queued) / 1e6) + 40);
    const after = await waitAccount(W1, "the queue to be paid", (a) => BigInt(a.queued) === 0n, 30_000);
    assert(BigInt(after.balance) - BigInt(before.balance) === BigInt(before.queued), `balance rose by ${Number(BigInt(after.balance) - BigInt(before.balance)) / 1e6}, ${Number(before.queued) / 1e6} was owed`);
    await page.waitForFunction(() => ![...document.querySelectorAll(".ticket .kv")].some((el) => el.textContent.includes("Queued Winnings")), null, { timeout: 6_000 }).catch(() => {
      throw new Error("the ticket still shows queued winnings 6 s after they were paid");
    });
    const bar = await u.barBalance();
    assert(Math.abs(bar - Number(after.balance) / 1e6) < 0.0101, `the top bar shows ${bar}, the balance is ${Number(after.balance) / 1e6}`);
    assert((await page.getByLabel(/Use queued winnings first/).count()) === 0, "the queued-winnings box is still offered");
    await u.nav("Portfolio");
    await page.getByRole("tab", { name: "Queue Balance History" }).click();
    for (const kind of ["Queued", "Used as margin", "Paid out"]) await page.locator(".tbl tbody tr .badge", { hasText: kind }).first().waitFor({ timeout: 8_000 });
    await page.getByRole("tab", { name: "Open Queue Balances" }).click();
    await page.getByText("Nothing of yours is waiting in the payout queue.").waitFor({ timeout: 5_000 });
    await page.getByRole("tab", { name: "Open Positions" }).click();
    await u.nav("Trade");
  });

  await flatten(page, W1);
}

// =============================================================================================
if (wants("coin")) {
  section(`Stake, unstake and claim ${COIN}, clicked in a hurry`);
  const page = main.page;
  await u.nav(`$${COIN}`);
  await page.locator(".staking .panel .title", { hasText: "Claimable rewards" }).waitFor({ timeout: 8_000 });
  const staked = async () => BigInt((await accountOf(W1)).coin.staked);
  const form = (label) => page.locator(".stake-form > div").nth(label === "Stake" ? 0 : 1);

  await check("a triple click on Stake stakes once", async () => {
    const before = await staked();
    await page.getByLabel("Stake", { exact: true }).fill("25");
    await form("Stake").getByRole("button", { name: `Stake ${COIN}`, exact: true }).click({ clickCount: 3, delay: 0 });
    await page.locator(".toast.good", { hasText: /^Staked/ }).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2_000);
    assert((await staked()) - before === 25n * 10n ** 18n, `staked went up by ${Number(((await staked()) - before) / 10n ** 15n) / 1000}`);
    assert((await historyOf(W1)).staking.filter((e) => e.type === "stake").length >= 1, "no stake in the history");
  });

  await check("a triple click on Unstake unstakes once", async () => {
    const before = await staked();
    await page.getByLabel("Unstake", { exact: true }).fill("10");
    await form("Unstake").getByRole("button", { name: `Unstake ${COIN}`, exact: true }).click({ clickCount: 3, delay: 0 });
    await page.locator(".toast.good", { hasText: /^Unstaked/ }).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2_000);
    assert(before - (await staked()) === 10n * 10n ** 18n, `staked went down by ${Number((before - (await staked())) / 10n ** 15n) / 1000}`);
  });

  await check("the stake form refuses zero, more than the wallet holds and more than is staked", async () => {
    const stakeButton = form("Stake").getByRole("button").last();
    for (const text of ["", "0", "0.0", "."]) {
      await page.getByLabel("Stake", { exact: true }).fill(text);
      assert(await stakeButton.isDisabled(), `Stake is enabled with "${text}"`);
    }
    await page.getByLabel("Stake", { exact: true }).fill("999999999999");
    assert((await stakeButton.isDisabled()) && /more than you have/i.test(await stakeButton.innerText()), `Stake with a trillion: "${await stakeButton.innerText()}"`);
    const unstakeButton = form("Unstake").getByRole("button").last();
    const have = Number((await staked()) / 10n ** 18n);
    await page.getByLabel("Unstake", { exact: true }).fill(String(have + 1));
    assert((await unstakeButton.isDisabled()) && /more than you have/i.test(await unstakeButton.innerText()), `Unstake of ${have + 1} with ${have} staked: "${await unstakeButton.innerText()}"`);
    // Max fills in exactly what is there, and what it fills in can be sent.
    await form("Unstake").getByRole("button", { name: "Max" }).click();
    // Exactly: a stake is rarely a whole number of coins, and Max has to give all of it.
    const exact = Number(await staked()) / 1e18;
    assert(Math.abs(Number(await page.getByLabel("Unstake", { exact: true }).inputValue()) - exact) < 1e-6 && !(await unstakeButton.isDisabled()), `Max gave "${await page.getByLabel("Unstake", { exact: true }).inputValue()}" with ${exact} staked`);
    await form("Stake").getByRole("button", { name: "Max" }).click();
    const max = await page.getByLabel("Stake", { exact: true }).inputValue();
    assert(/^\d+(\.\d+)?$/.test(max) && !(await stakeButton.isDisabled()), `Max for the wallet gave "${max}" and the button says "${await stakeButton.innerText()}"`);
    await page.getByLabel("Stake", { exact: true }).fill("");
    await page.getByLabel("Unstake", { exact: true }).fill("");
  });

  await check("a triple click on Claim claims once, into the trading balance", async () => {
    // Stakers are paid from fees, and only while nobody is queued. Make the house a fee.
    await houseWins(300);
    const claim = page.getByRole("button", { name: "Claim to trading balance" });
    await claim.waitFor({ timeout: 45_000 });
    const before = await accountOf(W1);
    const pending = BigInt(before.coin.pending);
    const claims = (await historyOf(W1)).staking.filter((e) => e.type === "claim").length;
    await claim.click({ clickCount: 3, delay: 0 });
    await page.locator(".toast.good", { hasText: /Rewards claimed/ }).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2_500);
    const after = await accountOf(W1);
    assert(BigInt(after.balance) - BigInt(before.balance) >= pending && BigInt(after.balance) - BigInt(before.balance) < pending * 2n + 1n, `balance rose by ${Number(BigInt(after.balance) - BigInt(before.balance)) / 1e6}, ${Number(pending) / 1e6} was claimable`);
    assert((await historyOf(W1)).staking.filter((e) => e.type === "claim").length === claims + 1, "not exactly one claim in the history");
    const bad = (await u.toasts()).filter((t) => /failed/i.test(t));
    assert(bad.length === 0, `toasts: ${JSON.stringify(bad)}`);
  });

  await u.nav("Trade");
}

// =============================================================================================
if (wants("money")) {
  section("Deposit and withdraw dialogs");
  const page = main.page;
  await u.nav("Trade");
  await page.waitForTimeout(4_700);
  const open = async (kind) => {
    await page.locator(".bar-end").getByRole("button", { name: kind, exact: true }).click();
    await u.dialog.waitFor({ timeout: 3_000 });
  };
  const amount = page.getByLabel("Amount in USDC");
  const action = u.dialog.locator(".btn.big");
  const says = async () => ({ text: (await action.innerText()).trim(), disabled: await action.isDisabled() });

  await check("deposit: zero, nothing, too small to count and more than the wallet holds are all refused, with the reason on the button", async () => {
    await open("Deposit");
    const wallet = Number((await accountOf(W1)).wallet.usdc) / 1e6;
    for (const text of ["", "0", "0.00", ".", "0.0000001"]) {
      await amount.fill(text);
      const s = await says();
      assert(s.disabled && /enter an amount/i.test(s.text), `"${text}": "${s.text}"`);
    }
    await amount.fill(String(Math.floor(wallet) + 1));
    let s = await says();
    assert(s.disabled && /more than your wallet holds/i.test(s.text), `one dollar over: "${s.text}"`);
    await amount.fill("9".repeat(30));
    s = await says();
    assert(s.disabled && /more than your wallet holds/i.test(s.text), `thirty nines: "${s.text}"`);
    await u.dialog.getByRole("button", { name: "Max" }).click();
    s = await says();
    assert(!s.disabled && s.text === "Deposit" && Math.abs(Number(await amount.inputValue()) - wallet) < 0.011, `Max gave "${await amount.inputValue()}" with ${wallet} in the wallet; button "${s.text}"`);
    await page.keyboard.press("Escape");
    await u.dialog.waitFor({ state: "detached", timeout: 2_000 });
  });

  await check("deposit: the smallest amount there is (0.000001) goes through and is counted exactly", async () => {
    const before = BigInt((await accountOf(W1)).balance);
    await open("Deposit");
    await amount.fill("0.000001");
    assert(!(await says()).disabled, `button: "${(await says()).text}"`);
    await action.click();
    await u.dialog.waitFor({ state: "detached", timeout: 15_000 });
    await waitAccount(W1, "the deposit", (a) => BigInt(a.balance) === before + 1n);
    const toast = (await u.toasts()).find((t) => /deposited/i.test(t)) ?? "";
    assert(!/\$0\.00/.test(toast), `the toast says "${toast.replace(/\s+/g, " ")}" for a deposit of $0.000001`);
  });

  await check("withdraw: more than the free balance, zero and nothing are refused; Max is exactly what is free", async () => {
    await open("Withdraw");
    const free = Number((await accountOf(W1)).balance) / 1e6;
    for (const text of ["", "0", "."]) {
      await amount.fill(text);
      assert((await says()).disabled && /enter an amount/i.test((await says()).text), `"${text}": "${(await says()).text}"`);
    }
    await amount.fill((free + 0.01).toFixed(2));
    assert((await says()).disabled && /more than your free balance/i.test((await says()).text), `a cent over: "${(await says()).text}"`);
    await u.dialog.getByRole("button", { name: "Max" }).click();
    const max = Number(await amount.inputValue());
    assert(!(await says()).disabled && max <= free && free - max < 0.01, `Max gave ${max} with ${free} free`);
    await page.keyboard.press("Escape");
  });

  await check("withdraw: margin in an open position cannot be withdrawn, and the dialog says how much can", async () => {
    await u.setOrder(2, 50);
    await u.cta.click();
    await waitAccount(W1, "the position", (a) => a.positions.some((p) => p.status === "open") && a.reserved === "0");
    const account = await accountOf(W1);
    await open("Withdraw");
    const shown = money(await u.kv(".dialog", "Free balance"));
    assert(Math.abs(shown - Number(account.balance) / 1e6) < 0.0101, `the dialog shows ${shown} free; the balance is ${Number(account.balance) / 1e6}`);
    await amount.fill((Number(account.balance) / 1e6 + 25).toFixed(2));
    assert((await says()).disabled, "an amount that reaches into the margin can be sent");
    await page.keyboard.press("Escape");
    await flatten(page, W1);
  });

  await check("a withdrawal typed while an order is filling cannot take that order's margin", async () => {
    const free = Number((await accountOf(W1)).balance) / 1e6;
    await u.setOrder(2, Math.floor(free / 2));
    await u.cta.click();
    await open("Withdraw");
    await amount.fill(free.toFixed(2));
    await page.waitForTimeout(250);
    const s = await says();
    const posts = watchPosts(page, "/withdraw");
    if (!s.disabled) await action.click();
    await page.waitForTimeout(3_000);
    posts.stop();
    const toasts = await u.toasts();
    await page.keyboard.press("Escape");
    const after = await waitAccount(W1, "the order to land", (a) => a.reserved === "0" && a.intents.every((x) => x.status !== "accepted" && x.status !== "filled"));
    assert(after.positions.length === 1, `the order did not survive the withdrawal: ${after.positions.length} positions; toasts ${JSON.stringify(toasts)}`);
    assert(s.disabled || toasts.some((t) => /withdrawal failed/i.test(t)), `the button said "${s.text}" and was enabled, and no failure was shown: ${JSON.stringify(toasts)}`);
    await flatten(page, W1);
    return s.disabled ? `button: "${s.text}"` : "the dialog allowed it; the relayer refused it";
  });

  await check("Escape and a click outside close the dialog; a click or a drag that starts inside does not", async () => {
    await open("Deposit");
    await amount.fill("12");
    await u.dialog.locator(".note").click();
    assert(await u.dialog.isVisible(), "a click inside closed it");
    // Select the amount by dragging from the field out onto the backdrop.
    const box = await amount.boundingBox();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(20, 400, { steps: 4 });
    await page.mouse.up();
    assert(await u.dialog.isVisible(), "dragging out of the field closed it");
    assert((await amount.inputValue()) === "12", "the amount was lost");
    await page.mouse.click(20, 400);
    await u.dialog.waitFor({ state: "detached", timeout: 2_000 });
    await open("Withdraw");
    await page.keyboard.press("Escape");
    await u.dialog.waitFor({ state: "detached", timeout: 2_000 });
    // Opening it again starts clean.
    await open("Deposit");
    assert((await amount.inputValue()) === "", `the field came back holding "${await amount.inputValue()}"`);
    await page.keyboard.press("Escape");
  });

  await check("closing the dialog while a deposit is on its way does not hide what happened to the money", async () => {
    const before = BigInt((await accountOf(W1)).balance);
    await open("Deposit");
    await amount.fill("3");
    await action.click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(4_000);
    const moved = BigInt((await accountOf(W1)).balance) - before;
    const toasts = await u.toasts();
    assert(moved === 0n || toasts.some((t) => /deposited \$3\.00/i.test(t)), `${Number(moved) / 1e6} was deposited after the dialog was dismissed, and no message said so: ${JSON.stringify(toasts)}`);
    return moved === 0n ? "the deposit was called off" : "the deposit went through and a toast said so";
  });
}

// =============================================================================================
if (wants("nav")) {
  section("Reloads, back and forward, unknown addresses");
  const page = main.page;
  const errorsBefore = main.errors.length;
  await u.nav("Trade");
  await flatten(page, W1);

  await check("a reload while an order is filling brings the order back, once", async () => {
    await u.side("Long");
    await u.setOrder(2, 6);
    await u.cta.click();
    await u.fillingRows().first().waitFor({ timeout: 3_000 });
    await page.reload();
    await page.locator(".bar-btn.acct b").waitFor({ timeout: 10_000 });
    // Either still filling, or already a position: never nothing, never two.
    await page.waitForFunction(() => document.querySelectorAll(".tbl tbody tr").length >= 1, null, { timeout: 4_000 }).catch(() => {
      throw new Error("after the reload the table was empty while the order was still in flight");
    });
    await page.waitForFunction(() => document.querySelectorAll(".tbl tbody tr td:nth-child(10)").length === 1 && !/Filling/.test(document.querySelector(".tbl tbody").textContent), null, { timeout: 12_000 });
    await page.waitForTimeout(1_500);
    assert((await u.positionRows().count()) === 1 && (await accountOf(W1)).positions.length === 1, "not exactly one position after the reload");
    assert(!/turn on|trading on in/i.test((await u.label()).text), `the trading key was lost: "${(await u.label()).text}"`);
  });

  await check("a reload with a dialog open comes back without it, and nothing was sent", async () => {
    const posts = watchPosts(page, "/withdraw");
    await page.locator(".bar-end").getByRole("button", { name: "Withdraw", exact: true }).click();
    await page.getByLabel("Amount in USDC").fill("5");
    await page.reload();
    await page.locator(".bar-btn.acct b").waitFor({ timeout: 10_000 });
    posts.stop();
    assert((await u.dialog.count()) === 0 && posts.seen.length === 0, "the dialog or a request survived the reload");
  });

  const ROUTES = [
    ["/trade", ".ticket .btn.big"],
    ["/trade", ".ticket .btn.big"],
    ["/portfolio", ".portfolio-top"],
    ["/vault", ".house .panel"],
    ["/staking", ".staking .panel"],
    ["/leaderboard", ".lb-head"],
    ["/dashboard", ".dash .widget"],
    ["/stats", ".tiles .tile"],
    ["/status", "h1, h2"],
    ["/docs", ".docs"],
  ];
  await check("every address loads directly and again on reload, with the wallet still connected", async () => {
    const bad = [];
    for (const [path, marker] of ROUTES) {
      await page.goto(`${SITE}${path}`);
      await page.locator(marker).first().waitFor({ timeout: 10_000 }).catch(() => bad.push(`${path}: nothing rendered`));
      await page.reload();
      await page.locator(marker).first().waitFor({ timeout: 10_000 }).catch(() => bad.push(`${path}: nothing rendered after a reload`));
      await page.locator(".bar-btn.acct b").waitFor({ timeout: 8_000 }).catch(() => bad.push(`${path}: the wallet was forgotten`));
      if (new URL(page.url()).pathname !== path) bad.push(`${path}: the address became ${new URL(page.url()).pathname}`);
    }
    assert(bad.length === 0, bad.join("\n"));
  });

  await check("the portfolio opens on the tab named in the address, for every tab", async () => {
    const tabs = { history: "Trade History", cashflow: "Deposits / Withdrawals", staking: "Staking", queueOpen: "Open Queue Balances", queueHistory: "Queue Balance History", emissions: `${COIN} Emissions` };
    for (const [id, label] of Object.entries(tabs)) {
      await page.goto(`${SITE}/portfolio?tab=${id}`);
      await page.getByRole("tab", { name: label, exact: true }).waitFor({ timeout: 8_000 });
      assert((await page.getByRole("tab", { name: label, exact: true }).getAttribute("aria-selected")) === "true", `?tab=${id} did not select "${label}"`);
      await page.reload();
      await page.getByRole("tab", { name: label, exact: true }).waitFor({ timeout: 8_000 });
      assert((await page.getByRole("tab", { name: label, exact: true }).getAttribute("aria-selected")) === "true", `?tab=${id} lost its tab on reload`);
      await page.locator("section.panel .tbl").first().waitFor({ timeout: 5_000 });
    }
  });

  await check("a tab name that does not exist falls back to a real tab", async () => {
    for (const tab of ["nonsense", "__proto__", "<img src=x onerror=alert(1)>", ""]) {
      await page.goto(`${SITE}/portfolio?tab=${encodeURIComponent(tab)}`);
      await page.locator(".portfolio-top").waitFor({ timeout: 8_000 });
      await page.waitForTimeout(300);
      const selected = await page.locator('section.panel [role="tab"][aria-selected="true"]').count();
      const body = await page.locator("section.panel .tbl, section.panel .empty").count();
      assert(selected === 1 && body >= 1, `?tab=${tab || "(empty)"}: ${selected} tabs selected and ${body ? "a" : "no"} table under them`);
    }
  });

  await check("back and forward move between pages, and the page shown matches the address", async () => {
    await page.goto(`${SITE}/trade`);
    await u.waitPrice();
    await u.nav("Portfolio");
    await page.locator(".portfolio-top").waitFor();
    await u.nav("Vault");
    await page.locator(".house .panel").first().waitFor();
    await page.goBack();
    await page.locator(".portfolio-top").waitFor({ timeout: 4_000 });
    assert(new URL(page.url()).pathname === "/portfolio", `address ${page.url()}`);
    await page.goBack();
    await page.locator(".ticket").waitFor({ timeout: 4_000 });
    await page.goForward();
    await page.locator(".portfolio-top").waitFor({ timeout: 4_000 });
    await page.goForward();
    await page.locator(".house .panel").first().waitFor({ timeout: 4_000 });
    assert((await page.getByRole("navigation", { name: "Main" }).locator('[aria-current="page"]').innerText()) === "Vault", "the menu marks the wrong page");
  });

  await check("back from a portfolio tab shows the tab the address names", async () => {
    await page.goto(`${SITE}/portfolio`);
    await page.locator(".portfolio-top").waitFor();
    await page.getByRole("tab", { name: "Trade History", exact: true }).click();
    await page.getByRole("tab", { name: "Staking", exact: true }).click();
    assert(new URL(page.url()).search === "?tab=staking", `address ${page.url()}`);
    await page.goBack();
    await page.waitForTimeout(400);
    const url = new URL(page.url());
    const selected = (await page.locator('section.panel [role="tab"][aria-selected="true"]').innerText().catch(() => "(none)")).trim();
    assert(url.search === "?tab=history" && selected === "Trade History", `the address says ${url.search || "(no tab)"} and the tab shown is "${selected}"`);
  });

  await check("an address that does not exist says so, or goes home: it does not show the trade page under a wrong address", async () => {
    const bad = [];
    for (const path of ["/nope", "/portfolio/extra", "/Trade", "/house/", "/%E2%98%83", "/trade.php?id=1"]) {
      await page.goto(`${SITE}${path}`);
      await page.waitForTimeout(700);
      const shown = (await page.locator(".ticket").count()) ? "the trade page" : (await page.locator(".page > *").count()) ? "a page" : "nothing";
      const address = new URL(page.url()).pathname;
      const notFound = /not found|no such page|does not exist/i.test(await page.locator("body").innerText());
      // A real page's address written with a trailing slash is that page, at its real address.
      const tidied = shown === "a page" && address === path.replace(/\/+$/, "") && address !== path;
      if (!notFound && !tidied && !(shown === "the trade page" && (address === "/" || address === "/trade"))) bad.push(`${path}: shows ${shown} at ${address}`);
    }
    await page.goto(`${SITE}/trade`);
    assert(bad.length === 0, bad.join("\n"));
  });

  await check("none of that logged an error in the browser", async () => {
    const fresh = main.errors.slice(errorsBefore);
    assert(fresh.length === 0, fresh.slice(0, 4).join(" | "));
  });
  await u.waitPrice();
  await flatten(page, W1);
}

// =============================================================================================
if (wants("tabs")) {
  section("Two tabs, one wallet");
  const first = await visitor({ label: "wallet 2, tab A" });
  current = first.page;
  const W2 = WALLETS[1];

  await check("two tabs of the same wallet trading at the same moment agree on positions and balance within two seconds", async () => {
    const a = await ready(first.page, 2, { balance: 400 });
    await flatten(first.page, W2);
    const second = await first.context.newPage();
    second.on("pageerror", (error) => first.errors.push(`tab B: ${error.message}`));
    await second.goto(`${SITE}/trade`);
    const b = ui(second);
    await b.waitPrice();
    await second.locator(".bar-btn.acct b").waitFor({ timeout: 10_000 });
    await second.waitForTimeout(1_000);
    assert(!/turn on|trading on in/i.test((await b.label()).text), `tab B did not pick the trading key up: "${(await b.label()).text}"`);
    await a.setOrder(2, 5);
    await a.side("Long");
    await b.setOrder(3, 7);
    await b.side("Short");
    await Promise.all([a.cta.click(), b.cta.click()]);
    await waitAccount(W2, "both orders to land", (x) => x.positions.filter((p) => p.status === "open").length === 2);
    await sleep(2_000);
    const read = async (x) => ({ rows: await x.positionRows().count(), balance: await x.barBalance(), text: (await x.page.locator(".tbl tbody").innerText()).replace(/[\d,]+\.\d+/g, "#").replace(/\s+/g, " ") });
    let [ra, rb] = [await read(a), await read(b)];
    assert(ra.rows === 2 && rb.rows === 2, `tab A shows ${ra.rows} positions, tab B ${rb.rows}`);
    assert(ra.balance === rb.balance, `tab A shows a balance of ${ra.balance}, tab B ${rb.balance}`);
    assert(Math.abs(ra.balance - Number((await accountOf(W2)).balance) / 1e6) < 0.0101, `both show ${ra.balance}; the balance is ${Number((await accountOf(W2)).balance) / 1e6}`);

    // Close one in B: it goes in A too.
    await second.locator(".tbl tbody tr", { hasText: "3x" }).getByRole("button", { name: "Close", exact: true }).click();
    await waitAccount(W2, "the close to land", (x) => x.positions.length === 1);
    await sleep(2_000);
    [ra, rb] = [await read(a), await read(b)];
    assert(ra.rows === 1 && rb.rows === 1, `after a close in tab B: tab A shows ${ra.rows} positions, tab B ${rb.rows}`);
    assert(ra.balance === rb.balance, `after the close: ${ra.balance} against ${rb.balance}`);

    // Both tabs close the last one at the same moment.
    const closes = [watchPosts(first.page, "/close"), watchPosts(second, "/close")];
    await Promise.all([first.page.locator(".tbl tbody tr").getByRole("button", { name: "Close", exact: true }).first().click(), second.locator(".tbl tbody tr").getByRole("button", { name: "Close", exact: true }).first().click()]);
    await waitAccount(W2, "the last close", (x) => x.positions.length === 0 && x.intents.every((i) => i.status !== "accepted"));
    await sleep(2_500);
    [ra, rb] = [await read(a), await read(b)];
    assert(ra.rows === 0 && rb.rows === 0, `after both pressed Close: tab A shows ${ra.rows} rows ("${ra.text.slice(0, 80)}"), tab B ${rb.rows} ("${rb.text.slice(0, 80)}")`);
    assert(ra.balance === rb.balance, `at the end: ${ra.balance} against ${rb.balance}`);
    const trades = (await historyOf(W2)).trades;
    assert(new Set(trades.map((t) => t.id)).size === trades.length, "a position was settled twice");
    closes.forEach((c) => c.stop());
    return `closes sent: ${closes[0].seen.length} from tab A, ${closes[1].seen.length} from tab B`;
  });

  await check("neither tab logged an error", async () => {
    // One of the two simultaneous closes is refused by the relayer (400): the browser logs that
    // by itself. Anything else is the page's own doing.
    const own = first.errors.filter((e) => !/Failed to load resource: the server responded with a status of 400/.test(e));
    assert(own.length === 0, own.slice(0, 4).join(" | "));
  });
  await first.context.close();
  current = main.page;
}

// =============================================================================================
if (wants("pages")) {
  section("The other pages");
  const page = main.page;
  const errorsBefore = main.errors.length;
  const junk = /\b(NaN|undefined|Infinity|null)\b|\[object Object\]|e\+\d\d/;

  await check("leaderboard search takes anything typed into it and finds a trader by address or name", async () => {
    await u.nav("Leaderboard");
    await page.getByRole("group", { name: "Period" }).getByRole("button", { name: "All" }).click();
    await page.getByRole("button", { name: "Accounts", exact: true }).click();
    await page.locator(".lb-accounts .lb-row").first().waitFor({ timeout: 8_000 });
    const all = await page.locator(".lb-accounts .lb-row").count();
    const search = page.getByLabel("Search name or address");
    for (const text of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "%", "\\", ".*+?^${}()|[]", "'; DROP TABLE users;--", "‮💥", "a".repeat(5_000), "   ", "0x", "0X"]) {
      await search.fill(text);
      await page.waitForTimeout(60);
      const rows = await page.locator(".lb-accounts .lb-row").count();
      assert(rows <= all, `"${text.slice(0, 20)}" showed more rows`);
      if (text.trim() === "" || text === "0x") assert(rows === all, `"${text}" hid ${all - rows} of ${all} rows`);
    }
    // Upper case finds what lower case finds: an address is the same either way.
    await search.fill(W1.slice(0, 10).toLowerCase());
    const lower = await page.locator(".lb-accounts .lb-row").count();
    await search.fill(W1.slice(0, 10).toUpperCase().replace("0X", "0x"));
    const upper = await page.locator(".lb-accounts .lb-row").count();
    assert(lower === 1 && upper === 1, `searching for wallet 1 by address: ${lower} rows in lower case, ${upper} in upper case`);
    await search.fill("");
    assert((await page.locator("body").innerText()).match(junk) === null, `the page shows "${(await page.locator("body").innerText()).match(junk)?.[0]}"`);
  });

  await check("the username dialog refuses names that are not allowed, and says why", async () => {
    await page.getByRole("button", { name: /Claim a username|You are/ }).click();
    const field = page.getByLabel("Username", { exact: true });
    const button = u.dialog.locator(".btn.big");
    for (const name of ["", "ab", "has space", "dash-ed", "naïve", "kеlvin", "<b>", "a.b.c"]) {
      await field.fill(name);
      assert(await button.isDisabled(), `"${name}" can be claimed`);
    }
    await field.fill("x".repeat(40));
    assert((await field.inputValue()).length === 16, `forty letters left ${(await field.inputValue()).length} in the field`);
    await field.fill("  MiXeD_Case ");
    assert(!(await button.isDisabled()) && /claim mixed_case/i.test(await button.innerText()), `"  MiXeD_Case ": "${await button.innerText()}"`);
    await page.keyboard.press("Escape");
  });

  await check("a taken username is refused with a message, the dialog stays open, and a free one is then accepted", async () => {
    // Somebody else holds a name.
    const other = privateKeyToAccount(generatePrivateKey());
    const taken = `edge_${Math.floor(Math.random() * 1e9)}`;
    await api("/username", { owner: other.address, name: taken, signature: await other.signMessage({ message: `Claim the username "${taken}" for ${other.address}` }) });
    await page.getByRole("button", { name: /Claim a username|You are/ }).click();
    const field = page.getByLabel("Username", { exact: true });
    await field.fill(taken.toUpperCase());
    await u.dialog.locator(".btn.big").click();
    await page.locator(".toast.bad", { hasText: /taken/i }).waitFor({ timeout: 8_000 });
    assert(await u.dialog.isVisible(), "the dialog closed on a refusal");
    const mine = `w1_${Math.floor(Math.random() * 1e9)}`;
    await field.fill(mine);
    await u.dialog.locator(".btn.big").click({ clickCount: 2, delay: 0 });
    await page.locator(".toast.good", { hasText: `You are ${mine}` }).waitFor({ timeout: 10_000 });
    await u.dialog.waitFor({ state: "detached", timeout: 3_000 });
    assert((await accountOf(W1)).name === mine, "the name was not set");
    await page.locator(".bar-btn.acct", { hasText: mine }).waitFor({ timeout: 5_000 });
  });

  await check("every portfolio tab shows its rows for an account that has traded", async () => {
    await u.nav("Portfolio");
    const expect = { "Trade History": /Long|Short/, "Deposits / Withdrawals": /Deposit/, "Queue Balance History": null, [`${COIN} Emissions`]: /\/ \$1/, Staking: null, "Open Queue Balances": null, "Open Positions": null };
    for (const [tab, pattern] of Object.entries(expect)) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      if (pattern) await page.locator("section.panel .tbl tbody tr", { hasText: pattern }).first().waitFor({ timeout: 8_000 });
      else await page.locator("section.panel .tbl").first().waitFor();
      const text = await page.locator("section.panel:has([role=tablist])").innerText();
      assert(text.match(junk) === null, `${tab} shows "${text.match(junk)?.[0]}"`);
    }
    const available = money(await u.kv(".portfolio-top", "Available to Trade"));
    assert(Math.abs(available - (await u.barBalance())) < 0.006, "portfolio and top bar disagree");
  });

  await check("the trade-history pager turns pages and stops at both ends", async () => {
    await page.getByRole("tab", { name: "Trade History", exact: true }).click();
    const trades = (await historyOf(W1)).trades.length;
    const pages = Math.max(1, Math.ceil(trades / 25));
    const previous = page.getByRole("button", { name: /Previous/ });
    const next = page.getByRole("button", { name: /Next/ });
    assert(await previous.isDisabled(), "Previous is enabled on the first page");
    for (let i = 1; i < pages; i++) await next.click();
    assert(await next.isDisabled(), `Next is still enabled on page ${pages} of ${pages}`);
    const rows = await page.locator("section.panel .tbl tbody tr").count();
    assert(rows === trades - (pages - 1) * 25 || (rows === 25 && trades % 25 === 0), `the last page shows ${rows} rows of ${trades} trades`);
    await page.getByRole("tab", { name: "Open Positions", exact: true }).click();
  });

  await check("house, coin, stats, status and dashboard: every panel draws, with no junk values and no error", async () => {
    const bad = [];
    const look = async (name, marker, minPanels) => {
      await page.locator(marker).first().waitFor({ timeout: 10_000 }).catch(() => bad.push(`${name}: nothing rendered`));
      await page.waitForTimeout(1_200);
      const report = await page.evaluate((junkSource) => {
        const junk = new RegExp(junkSource);
        const panels = [...document.querySelectorAll(".page .panel, .page .tile, .page .widget")];
        const empty = panels.filter((p) => p.getBoundingClientRect().height < 20 || p.innerText.trim() === "").length;
        const canvases = [...document.querySelectorAll(".page canvas")].filter((c) => c.width === 0 || c.height === 0).length;
        const found = document.querySelector(".page").innerText.match(junk)?.[0] ?? null;
        return { panels: panels.length, empty, canvases, found };
      }, junk.source);
      if (report.panels < minPanels) bad.push(`${name}: ${report.panels} panels, expected at least ${minPanels}`);
      if (report.empty) bad.push(`${name}: ${report.empty} empty panels`);
      if (report.canvases) bad.push(`${name}: ${report.canvases} charts with no size`);
      if (report.found) bad.push(`${name}: shows "${report.found}"`);
    };
    await u.nav("Vault");
    await look("house", ".house .panel", 8);
    await u.nav(`$${COIN}`);
    await look("coin", ".staking .panel", 5);
    await u.more("Stats");
    await look("stats", ".tiles .tile", 6);
    await u.more("Status");
    await look("status", ".page h1, .page h2", 1);
    await page.getByRole("heading", { name: "All systems normal" }).waitFor({ timeout: 10_000 }).catch(async () => bad.push(`status: the heading reads "${await page.locator(".page h1, .page h2").first().innerText()}"`));
    await u.more("Dashboard");
    await look("dashboard", ".dash .widget", 5);
    assert(bad.length === 0, bad.join("\n"));
  });

  await check("the dashboard remembers panels removed, added and moved, across a reload", async () => {
    await page.goto(`${SITE}/dashboard`);
    await page.locator(".dash .widget").first().waitFor({ timeout: 8_000 });
    const titles = () => page.locator(".dash .widget").evaluateAll((list) => list.map((w) => w.querySelector(".close-x")?.getAttribute("aria-label")?.replace("Remove ", "") ?? "?"));
    const start = await titles();
    assert(start.length >= 5, `${start.length} panels`);
    // Remove the second panel.
    await page.locator(".dash .widget .close-x").nth(1).click();
    let now = await titles();
    assert(now.length === start.length - 1 && !now.includes(start[1]), `after removing "${start[1]}": ${now.join(", ")}`);
    assert((await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Custom" }).getAttribute("aria-pressed")) === "true", "the change did not move the board to Custom");
    await page.reload();
    await page.locator(".dash .widget").first().waitFor({ timeout: 8_000 });
    assert((await titles()).join("|") === now.join("|"), `after a reload: ${(await titles()).join(", ")}`);
    // Add it back: it goes to the end.
    await page.locator(".dash-bar").getByRole("button", { name: "Add" }).click();
    await page.getByRole("menuitem", { name: start[1], exact: true }).click();
    now = await titles();
    assert(now[now.length - 1] === start[1], `after adding "${start[1]}" back: ${now.join(", ")}`);
    // Move the last panel onto the first.
    await page.locator(".dash .widget").last().dragTo(page.locator(".dash .widget").first());
    const moved = await titles();
    assert(moved.join("|") !== now.join("|") && moved.length === now.length, `the drag changed nothing: ${moved.join(", ")}`);
    await page.reload();
    await page.locator(".dash .widget").first().waitFor({ timeout: 8_000 });
    assert((await titles()).join("|") === moved.join("|"), `the order after a reload: ${(await titles()).join(", ")}`);
    // Tidy, Clear, and back to the overview.
    await page.locator(".dash-bar").getByRole("button", { name: "Tidy" }).click();
    assert((await page.locator(".dash-bar").getByRole("button", { name: "Tidy" }).isDisabled()), "Tidy stays enabled after tidying");
    await page.locator(".dash-bar").getByRole("button", { name: "Clear" }).click();
    await page.getByText("Nothing on the board. Add a panel to start.").waitFor({ timeout: 3_000 });
    await page.reload();
    await page.getByText("Nothing on the board. Add a panel to start.").waitFor({ timeout: 8_000 });
    await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Overview" }).click();
    assert((await titles()).length === start.length, "the overview did not come back whole");
    // Garbage in the saved layout must not break the page.
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (/dash|board|layout/i.test(key)) localStorage.setItem(key, '{"view":"custom","custom":["nope",5,null,{"a":1}]}');
    });
    await page.reload();
    await page.locator(".dash-bar").waitFor({ timeout: 8_000 });
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (/dash|board|layout/i.test(key)) localStorage.setItem(key, "not json");
    });
    await page.reload();
    await page.locator(".dash .widget").first().waitFor({ timeout: 8_000 }).catch(() => {
      throw new Error("with a corrupt saved layout the dashboard shows nothing");
    });
  });

  await check("a visitor without a wallet, and a wallet that has never traded, see empty states on every portfolio tab, not errors", async () => {
    const guest = await visitor({ label: "guest", path: "/portfolio" });
    const g = ui(guest.page);
    await guest.page.locator(".portfolio-top").waitFor({ timeout: 10_000 });
    const tabs = ["Open Positions", "Trade History", "Deposits / Withdrawals", "Staking", "Open Queue Balances", "Queue Balance History", `${COIN} Emissions`];
    for (const tab of tabs) {
      await guest.page.getByRole("tab", { name: tab, exact: true }).click();
      const text = (await guest.page.locator("section.panel:has([role=tablist])").innerText()).replace(/\s+/g, " ");
      assert(/connect a wallet/i.test(text), `${tab} without a wallet: "${text.slice(-80)}"`);
    }
    for (const path of ["/vault", "/staking", "/leaderboard", "/stats", "/status", "/dashboard", "/docs", "/trade"]) {
      await g.go(path);
      await guest.page.waitForTimeout(700);
      const text = await guest.page.locator(".page").innerText();
      assert(text.length > 40 && text.match(junk) === null, `${path} without a wallet: ${text.length < 40 ? "nearly empty" : `shows "${text.match(junk)?.[0]}"`}`);
    }
    await g.go("/portfolio");
    await connect(guest.page, 3);
    await guest.page.waitForTimeout(1_000);
    const traded = (await historyOf(WALLETS[2])).trades.length;
    if (traded === 0) {
      const empties = { "Open Positions": /No open positions/, "Trade History": /No closed trades yet/, "Deposits / Withdrawals": /No deposits or withdrawals yet/, Staking: /Nothing staked yet/, "Open Queue Balances": /Nothing of yours is waiting/, "Queue Balance History": /No queue activity yet/, [`${COIN} Emissions`]: new RegExp(`No ${COIN} yet`) };
      for (const [tab, pattern] of Object.entries(empties)) {
        await guest.page.getByRole("tab", { name: tab, exact: true }).click();
        const text = (await guest.page.locator("section.panel:has([role=tablist])").innerText()).replace(/\s+/g, " ");
        assert(pattern.test(text), `${tab} for an unused wallet: "${text.slice(-90)}"`);
      }
    }
    assert(guest.errors.length === 0, guest.errors.slice(0, 3).join(" | "));
    await guest.context.close();
    return traded === 0 ? "test wallet 3 has never traded" : "test wallet 3 has history on this chain; its empty states were not checked";
  });

  await check("none of that logged an error in the browser", async () => {
    // The taken username is refused with a 409, which the browser logs by itself.
    const fresh = main.errors.slice(errorsBefore).filter((e) => !/Failed to load resource: the server responded with a status of 409/.test(e));
    assert(fresh.length === 0, fresh.slice(0, 4).join(" | "));
  });
  await page.goto(`${SITE}/trade`);
  await u.waitPrice();
}

// =============================================================================================
if (wants("keyboard")) {
  section("Keyboard only");
  const page = main.page;
  await page.goto(`${SITE}/trade`);
  await u.waitPrice();
  await page.locator(".bar-btn.acct b").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);

  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      let ring = (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none";
      if (!ring && el.tagName === "INPUT") {
        // A text field may mark focus with its border instead.
        const lit = style.borderTopColor;
        el.blur();
        ring = getComputedStyle(el).borderTopColor !== lit;
        el.focus();
      }
      return {
        what: el.id ? `#${el.id}` : (el.getAttribute("aria-label") ?? el.innerText?.trim().split("\n")[0] ?? el.tagName).slice(0, 40) || el.tagName.toLowerCase(),
        tag: el.tagName.toLowerCase(),
        inTicket: !!el.closest(".ticket"),
        inDialog: !!el.closest(".dialog"),
        ring,
        visible: el.getBoundingClientRect().width > 0,
      };
    });

  await check("Tab walks the ticket in reading order, and every stop shows where the focus is", async () => {
    await u.setOrder(10, 5);
    await page.locator(".ticket .equity summary").focus();
    const stops = [];
    for (let i = 0; i < 14; i++) {
      const f = await focused();
      if (!f?.inTicket) break;
      stops.push(f);
      await page.keyboard.press("Tab");
    }
    const names = stops.map((s) => s.what);
    const want = ["Account Equity", "Long", "Short", "½×", "2×", "%", "#margin", "100x", "#leverage", "Leverage"];
    let at = 0;
    for (const name of names) if (at < want.length && name.includes(want[at])) at += 1;
    assert(at === want.length, `the order was: ${names.join(" > ")}`);
    assert(/long btc/i.test(names[names.length - 1]) || names.some((n) => /long btc/i.test(n)), `the order button was not reached: ${names.join(" > ")}`);
    const noRing = stops.filter((s) => !s.ring).map((s) => s.what);
    assert(noRing.length === 0, `no visible focus on: ${noRing.join(", ")}`);
  });

  await check("the order can be placed and closed from the keyboard alone", async () => {
    await flatten(page, W1);
    await u.margin.focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("4");
    for (let i = 0; i < 6 && !/long btc/i.test((await focused())?.what ?? ""); i++) await page.keyboard.press("Tab");
    assert(/long btc/i.test((await focused())?.what ?? ""), `Tab from the margin did not reach the order button: focus is on "${(await focused())?.what}"`);
    await page.keyboard.press("Enter");
    await page.locator(".tbl tbody tr:has(td:nth-child(10))").first().waitFor({ timeout: 12_000 });
    await waitAccount(W1, "the position", (a) => a.positions.some((p) => p.status === "open"));
    const close = page.locator(".tbl tbody tr").getByRole("button", { name: "Close", exact: true }).first();
    await close.focus();
    assert((await focused())?.ring, "the Close button shows no focus");
    await page.keyboard.press("Space");
    await waitAccount(W1, "the close", (a) => a.positions.length === 0);
  });

  await check("in a dialog: focus starts in the field and Escape closes it", async () => {
    const opener = page.locator(".bar-end").getByRole("button", { name: "Deposit", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    await u.dialog.waitFor({ timeout: 3_000 });
    const f = await focused();
    assert(f?.inDialog && f.tag === "input", `focus opened on "${f?.what}"`);
    await page.keyboard.press("Escape");
    await u.dialog.waitFor({ state: "detached", timeout: 2_000 });
  });

  await check("in a dialog: after Escape the focus is back on the button that opened it", async () => {
    const opener = page.locator(".bar-end").getByRole("button", { name: "Deposit", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    await u.dialog.waitFor({ timeout: 3_000 });
    await page.keyboard.press("Escape");
    await u.dialog.waitFor({ state: "detached", timeout: 2_000 });
    const f = await focused();
    assert(f?.what === "Deposit", `the focus is on "${f?.what ?? "nothing (the page body)"}": the next Tab starts from the top of the page`);
  });

  await check("in a dialog: Enter in the amount field submits it", async () => {
    await page.locator(".bar-end").getByRole("button", { name: "Deposit", exact: true }).click();
    await u.dialog.waitFor({ timeout: 3_000 });
    await page.keyboard.type("2");
    const before = BigInt((await accountOf(W1)).balance);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3_000);
    const moved = BigInt((await accountOf(W1)).balance) - before;
    if (await u.dialog.count()) await page.keyboard.press("Escape");
    assert(moved === 2_000000n, "Enter did nothing: the deposit needs the mouse, or a Tab to the button and then Enter");
  });

  await check("Tab stays inside an open dialog", async () => {
    await page.locator(".bar-end").getByRole("button", { name: "Withdraw", exact: true }).click();
    await u.dialog.waitFor({ timeout: 3_000 });
    const escaped = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const f = await focused();
      if (f && !f.inDialog) escaped.push(f.what);
    }
    await page.keyboard.press("Escape");
    assert(escaped.length === 0, `Tab left the dialog for the page behind it: ${[...new Set(escaped)].join(", ")}`);
  });

  await check("the menus open with Enter and close with Escape", async () => {
    const more = page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /More/ });
    await more.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menu").waitFor({ timeout: 2_000 });
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached", timeout: 2_000 });
    await more.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    assert((await focused())?.what === "Dashboard", `Tab from the open menu went to "${(await focused())?.what}"`);
    await page.keyboard.press("Enter");
    await page.locator(".dash-bar").waitFor({ timeout: 4_000 });
    await page.goto(`${SITE}/trade`);
    await u.waitPrice();
  });
}

// =============================================================================================
if (wants("sizes")) {
  section("A phone (390 px) and a short laptop (1280 x 680)");
  const page = main.page;
  const PATHS = ["/trade", "/portfolio", "/vault", "/staking", "/leaderboard", "/dashboard", "/stats", "/status", "/docs"];

  /** Pairs of visible elements, among `selector`, whose boxes overlap by more than a sliver. */
  const overlaps = (selector) =>
    page.evaluate((sel) => {
      // The part of an element that can be seen: its box, cut down by every scrolling or clipping parent.
      const seen = (el) => {
        let { left, top, right, bottom } = el.getBoundingClientRect();
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflow === "visible") continue;
          const clip = parent.getBoundingClientRect();
          left = Math.max(left, clip.left);
          top = Math.max(top, clip.top);
          right = Math.min(right, clip.right);
          bottom = Math.min(bottom, clip.bottom);
        }
        return { left, top, right, bottom };
      };
      const items = [...document.querySelectorAll(sel)].filter((el) => getComputedStyle(el).visibility !== "hidden" && seen(el).right - seen(el).left > 0 && seen(el).bottom - seen(el).top > 0);
      const out = [];
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          if (items[i].contains(items[j]) || items[j].contains(items[i])) continue;
          const a = seen(items[i]);
          const b = seen(items[j]);
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 2 && h > 2) out.push(`"${items[i].innerText.trim().slice(0, 24)}" and "${items[j].innerText.trim().slice(0, 24)}" by ${Math.round(w)}x${Math.round(h)}`);
        }
      }
      return out;
    }, selector);

  /** True when the middle of `selector` is on screen and nothing lies on top of it. */
  const reachable = (selector) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return "missing";
      el.scrollIntoView({ block: "center" });
      const box = el.getBoundingClientRect();
      if (box.bottom > innerHeight + 1 || box.top < -1 || box.right > innerWidth + 1) return `off screen (${Math.round(box.top)}..${Math.round(box.bottom)} of ${innerHeight})`;
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return top === el || el.contains(top) ? "ok" : `covered by <${top?.tagName.toLowerCase()} class="${top?.className}">`;
    }, selector);

  for (const [name, width, height] of [["phone, 390 x 844", 390, 844], ["short laptop, 1280 x 680", 1280, 680]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${SITE}/trade`);
    await u.waitPrice();
    await page.waitForTimeout(600);

    await check(`${name}: no page scrolls sideways`, async () => {
      const bad = [];
      for (const path of PATHS) {
        await u.go(path);
        await page.waitForTimeout(600);
        const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
        if (overflow > 1) bad.push(`${path} is ${overflow}px too wide`);
      }
      await u.go("/trade");
      assert(bad.length === 0, bad.join("\n"));
    });

    await check(`${name}: nothing in the top bar or the ticket overlaps`, async () => {
      await page.waitForTimeout(500);
      const bar = await overlaps(".bar > *, .bar .nav > *, .bar-end > *");
      const ticket = await overlaps(".ticket .equity, .ticket .sides, .ticket .field-row, .ticket input.lev, .ticket .lev-ends, .ticket .btn.big, .ticket .ticket-foot, .ticket .note, .ticket .check");
      assert(bar.length === 0 && ticket.length === 0, [...bar, ...ticket].slice(0, 6).join("\n"));
    });

    await check(`${name}: the order button can be reached and pressed`, async () => {
      const state = await reachable(".ticket .btn.big");
      assert(state === "ok", `the order button is ${state}`);
      await flatten(page, W1);
      await u.setOrder(2, 3);
      await u.cta.click({ timeout: 3_000 });
      await page.locator(".tbl tbody tr:has(td:nth-child(10))").first().waitFor({ timeout: 12_000 });
      await waitAccount(W1, "the position", (a) => a.positions.some((p) => p.status === "open"));
      const close = await reachable(".tbl tbody tr .btn.small");
      assert(close === "ok", `the Close button of the new position is ${close}`);
      const closeAll = await reachable(".ticket-foot .btn");
      assert(closeAll === "ok", `Close All is ${closeAll}`);
      await flatten(page, W1);
    });

    await check(`${name}: deposit and withdraw can be found, and their dialog fits the screen`, async () => {
      await u.go("/trade");
      const direct = await page.locator(".bar-end").getByRole("button", { name: "Deposit", exact: true }).isVisible();
      if (direct) await page.locator(".bar-end").getByRole("button", { name: "Deposit", exact: true }).click();
      else {
        await page.locator(".bar-btn.acct").click();
        await page.getByRole("menu").getByRole("button", { name: "Deposit" }).click();
      }
      await u.dialog.waitFor({ timeout: 3_000 });
      const box = await u.dialog.boundingBox();
      const fits = box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1;
      if (!fits) await page.screenshot({ path: fileURLToPath(new URL(`edge-dialog-${width}.png`, SHOTS)) });
      await page.keyboard.press("Escape");
      assert(fits, `the dialog sits at ${Math.round(box.x)},${Math.round(box.y)} and is ${Math.round(box.width)}x${Math.round(box.height)} on a ${width}x${height} screen`);
    });

    await check(`${name}: every link of the main menu can be brought on screen and pressed`, async () => {
      await u.go("/trade");
      const nav = page.getByRole("navigation", { name: "Main" });
      const labels = await nav.locator("a").allInnerTexts();
      const bad = [];
      for (const label of labels) {
        const link = nav.getByRole("link", { name: label.trim(), exact: true });
        await link.scrollIntoViewIfNeeded();
        const hit = await link.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return top === el || el.contains(top);
        });
        if (!hit) bad.push(label.trim());
      }
      const strip = await nav.evaluate((el) => ({ shown: Math.round(el.clientWidth), all: el.scrollWidth }));
      assert(bad.length === 0, `cannot be pressed: ${bad.join(", ")}`);
      return strip.all > strip.shown + 1 ? `only ${strip.shown}px of a ${strip.all}px menu is on screen; the rest is reached by swiping it, with nothing to say so` : "";
    });

    await check(`${name}: the More menu opens and shows its pages`, async () => {
      await u.go("/trade");
      const more = page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /More/ });
      await more.scrollIntoViewIfNeeded();
      await more.click();
      await page.waitForTimeout(250);
      const menu = page.getByRole("navigation", { name: "Main" }).getByRole("menu");
      const state = (await menu.count())
        ? await menu.evaluate((el) => {
            const hidden = [...el.querySelectorAll("a")].filter((a) => {
              const box = a.getBoundingClientRect();
              const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
              return !(top === a || a.contains(top));
            });
            return { links: el.querySelectorAll("a").length, hidden: hidden.map((a) => a.innerText.trim()) };
          })
        : { links: 0, hidden: [] };
      const file = `edge-more-menu-${width}.png`;
      if (state.links === 0 || state.hidden.length) await page.screenshot({ path: fileURLToPath(new URL(file, SHOTS)) });
      await page.keyboard.press("Escape");
      assert(state.links > 0 && state.hidden.length === 0, `pressing More shows nothing: ${state.hidden.join(", ") || "no menu"} cannot be seen or pressed (web/e2e/shots/${file})`);
    });
  }

  await check("short laptop: the order button is on screen without scrolling the ticket", async () => {
    await page.setViewportSize({ width: 1280, height: 680 });
    await page.goto(`${SITE}/trade`);
    await u.waitPrice();
    await page.locator(".bar-btn.acct b").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(700);
    const seen = () =>
      page.evaluate(() => {
        document.querySelector(".ticket").scrollTop = 0;
        const button = document.querySelector(".ticket .btn.big").getBoundingClientRect();
        const ticket = document.querySelector(".ticket").getBoundingClientRect();
        const foot = document.querySelector(".ticket-foot").getBoundingClientRect();
        return { cut: Math.round(button.bottom - Math.min(ticket.bottom, innerHeight, foot.top > button.top ? foot.top : Infinity)), label: document.querySelector(".ticket .btn.big").innerText.trim() };
      });
    const at680 = await seen();
    await page.screenshot({ path: fileURLToPath(new URL("edge-laptop-1280x680.png", SHOTS)) });
    // How tall does the window have to be before the whole button shows?
    let needed = null;
    for (let height = 680; height <= 1000 && needed === null; height += 10) {
      await page.setViewportSize({ width: 1280, height });
      await page.waitForTimeout(60);
      if ((await seen()).cut <= 0) needed = height;
    }
    await page.setViewportSize({ width: 1280, height: 680 });
    assert(at680.cut <= 0, `at 1280 x 680 the "${at680.label}" button is ${at680.cut > 40 ? "entirely" : `${at680.cut}px`} below the bottom of the ticket; it only shows after scrolling the ticket, which has no scrollbar. The window must be ${needed ?? "over 1000"}px tall for it to show (web/e2e/shots/edge-laptop-1280x680.png)`);
  });

  await check("phone: with the wallet connected but one-click trading off, the explanation does not push the button off the ticket", async () => {
    const guest = await visitor({ width: 390, height: 844, label: "phone guest" });
    await ui(guest.page).waitPrice();
    await guest.page.locator(".bar-end").getByRole("button", { name: "Connect", exact: true }).click();
    await guest.page.getByRole("button", { name: /Test wallet 3/ }).click();
    await guest.page.waitForTimeout(1_200);
    current = guest.page;
    const label = (await guest.page.locator(".ticket .btn.big").innerText()).trim();
    const state = await guest.page.evaluate(() => {
      const el = document.querySelector(".ticket .btn.big");
      el.scrollIntoView({ block: "center" });
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const foot = document.querySelector(".ticket-foot").getBoundingClientRect();
      const note = document.querySelector(".ticket .note")?.getBoundingClientRect();
      return { ok: top === el || el.contains(top), clash: note ? Math.min(note.bottom, foot.bottom) - Math.max(note.top, foot.top) : 0 };
    });
    await guest.page.screenshot({ path: fileURLToPath(new URL("edge-phone-no-session.png", SHOTS)) });
    current = main.page;
    await guest.context.close();
    assert(state.ok, `"${label}" cannot be pressed`);
    assert(state.clash <= 2, `the note under the button and the "Open Positions" strip overlap by ${Math.round(state.clash)}px`);
  });

  await check("short laptop: with the wallet connected but one-click trading off, nothing in the ticket is cut off or overlapped", async () => {
    const guest = await visitor({ width: 1280, height: 680, label: "laptop guest" });
    await ui(guest.page).waitPrice();
    await guest.page.locator(".bar-end").getByRole("button", { name: "Connect", exact: true }).click();
    await guest.page.getByRole("button", { name: /Test wallet 3/ }).click();
    await guest.page.waitForTimeout(1_200);
    current = guest.page;
    const state = await guest.page.evaluate(() => {
      const foot = document.querySelector(".ticket-foot").getBoundingClientRect();
      const note = document.querySelector(".ticket .note")?.getBoundingClientRect();
      const button = document.querySelector(".ticket .btn.big").getBoundingClientRect();
      const body = document.querySelector(".ticket-body");
      return {
        clash: note ? Math.min(note.bottom, foot.bottom) - Math.max(note.top, foot.top) : 0,
        buttonVisible: button.bottom <= innerHeight && button.bottom <= foot.top + 1,
        scrolls: body ? body.scrollHeight - body.clientHeight : 0,
        canScroll: body ? getComputedStyle(body).overflowY : "",
      };
    });
    await guest.page.screenshot({ path: fileURLToPath(new URL("edge-laptop-no-session.png", SHOTS)) });
    current = main.page;
    await guest.context.close();
    assert(state.buttonVisible, "the button is below the fold or under the Open Positions strip");
    assert(state.clash <= 2 || /auto|scroll/.test(state.canScroll), `the explanation under the button runs ${Math.round(state.clash)}px into the "Open Positions" strip and the ticket does not scroll`);
    return state.scrolls > 0 ? `the ticket body scrolls by ${state.scrolls}px` : "";
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${SITE}/trade`);
  await u.waitPrice();
}

// =============================================================================================
if (wants("timings")) {
  section("Timings");
  const page = main.page;
  await page.goto(`${SITE}/trade`);
  await u.waitPrice();
  await page.locator(".bar-btn.acct b").waitFor({ timeout: 10_000 });
  await flatten(page, W1);
  await u.side("Long");
  await u.setOrder(2, 3);

  /**
   * Clicks `locator` inside the page and resolves with the ms until what is waited for is on
   * screen: a "filling" row, "fewer" than `arg` position rows, or an element matching `arg`.
   */
  const clickUntil = async (locator, what, arg, timeout = 30_000) => {
    const handle = await locator.elementHandle();
    return page.evaluate(
      ([el, kind, value, limit]) =>
        new Promise((resolve, reject) => {
          const tests = {
            filling: () => [...document.querySelectorAll(".tbl tbody tr")].some((tr) => tr.textContent.includes("Filling at the next price")),
            fewer: () => document.querySelectorAll(".tbl tbody tr td:nth-child(10)").length < value,
            element: () => document.querySelector(value) !== null,
          };
          const started = performance.now();
          const look = () => {
            if (!tests[kind]()) return;
            observer.disconnect();
            clearTimeout(timer);
            resolve(performance.now() - started);
          };
          const observer = new MutationObserver(look);
          observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error("nothing happened"));
          }, limit);
          el.click();
          look();
        }),
      [handle, what, arg ?? null, timeout],
    );
  };
  const positionCount = () => page.evaluate(() => document.querySelectorAll(".tbl tbody tr td:nth-child(10)").length);

  await check("navigation to first price, order to Filling, order to position, Close to gone, page to page: five or more of each", async () => {
    const toFilling = [];
    const toPosition = [];
    const toGone = [];
    for (let i = 0; i < 6; i++) {
      const have = await positionCount();
      // Both clocks start at the same click.
      const fillingAt = clickUntil(u.cta, "filling");
      const started = Date.now();
      toFilling.push(await fillingAt);
      await page.waitForFunction((n) => document.querySelectorAll(".tbl tbody tr td:nth-child(10)").length > n, have, { timeout: 15_000, polling: 16 });
      toPosition.push(Date.now() - started);
      await waitAccount(W1, "the position to land", (a) => a.positions.some((p) => p.status === "open") && a.intents.every((x) => x.status !== "accepted" && x.status !== "filled"));
      await page.waitForTimeout(1_300);
      const rows = await positionCount();
      toGone.push(await clickUntil(page.locator(".tbl tbody tr").getByRole("button", { name: "Close", exact: true }).first(), "fewer", rows));
      await page.waitForTimeout(900);
    }
    timing("click the order button -> the Filling row", toFilling);
    timing("click the order button -> the position row", toPosition);
    timing("click Close -> the row is gone", toGone);

    const hops = [];
    const nav = page.getByRole("navigation", { name: "Main" });
    const route = [["Portfolio", ".portfolio-top"], ["Vault", ".house .panel"], [`$${COIN}`, ".staking .panel"], ["Leaderboard", ".lb-head"], ["Trade", ".ticket .btn.big"], ["Portfolio", ".portfolio-top"], ["Trade", ".ticket .btn.big"], ["House", ".house .panel"], ["Trade", ".ticket .btn.big"]];
    for (const [label, marker] of route) {
      hops.push(await clickUntil(nav.getByRole("link", { name: label, exact: true }), "element", marker, 10_000));
      await page.waitForTimeout(250);
    }
    timing("click a menu link -> the next page is drawn", hops);

    const warm = [];
    for (let i = 0; i < 6; i++) {
      const started = Date.now();
      await page.goto(`${SITE}/trade`);
      await page.waitForFunction(() => /\d{1,3},\d{3}\.\d{2}/.test(document.querySelector(".market-pill .px")?.textContent ?? ""), null, { timeout: 15_000, polling: 16 });
      warm.push(Date.now() - started);
    }
    timing("open the site -> first price shown (files cached)", warm);

    const cold = [];
    for (let i = 0; i < 5; i++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const fresh = await context.newPage();
      const started = Date.now();
      await fresh.goto(`${SITE}/trade`);
      await fresh.waitForFunction(() => /\d{1,3},\d{3}\.\d{2}/.test(document.querySelector(".market-pill .px")?.textContent ?? ""), null, { timeout: 15_000, polling: 16 });
      cold.push(Date.now() - started);
      await context.close();
    }
    timing("open the site -> first price shown (new visitor, nothing cached)", cold);
    await flatten(page, W1);
  });
}

// =============================================================================================
if (soak) {
  section(`Left running: the trade page with a position open, for ${SOAK_MINUTES} minutes`);
  await check("the heap, the page's element count and its listeners stay level, and nothing is logged", async () => {
    const result = await soak;
    if (result.error) throw result.error;
    const mb = (bytes) => (bytes / 1048576).toFixed(1);
    const line = result.samples.map((s) => `${s.minute}m: ${mb(s.heap)} MB, ${s.nodes} nodes, ${s.listeners} listeners`).join("; ");
    console.log(`       ${line}`);
    const start = result.samples[1] ?? result.samples[0];
    const end = result.samples[result.samples.length - 1];
    assert(result.errors.length === 0, `logged: ${result.errors.slice(0, 3).join(" | ")}`);
    assert(end.heap - start.heap < 12 * 1048576, `the heap grew from ${mb(start.heap)} MB to ${mb(end.heap)} MB`);
    assert(end.nodes - start.nodes < 1_500, `elements grew from ${start.nodes} to ${end.nodes}`);
    assert(end.listeners - start.listeners < 400, `listeners grew from ${start.listeners} to ${end.listeners}`);
    assert(result.stillOpen, "the position on the soak page was gone at the end");
    return `heap ${mb(start.heap)} -> ${mb(end.heap)} MB, elements ${start.nodes} -> ${end.nodes}, listeners ${start.listeners} -> ${end.listeners} (first sample taken at ${start.minute} min)`;
  });
}

// =============================================================================================
if (wants("outage")) {
  if (!OUTAGE) skip("the relayer goes away and comes back", "it restarts the relayer: pass --outage to run it");
  else {
    section("The relayer goes away and comes back");
    const page = main.page;
    await page.goto(`${SITE}/trade`);
    await u.waitPrice();
    await page.locator(".bar-btn.acct b").waitFor({ timeout: 10_000 });
    await flatten(page, W1);
    await u.side("Long");
    await u.setOrder(2, 3);
    const port = new URL(API).port;
    const pidOnPort = () => {
      try {
        if (process.platform === "win32") {
          for (const line of execFileSync("netstat", ["-ano"], { encoding: "utf8" }).split(/\r?\n/)) {
            const cols = line.trim().split(/\s+/);
            if (cols[0] === "TCP" && cols[1]?.endsWith(`:${port}`) && cols[3] === "LISTENING") return Number(cols[4]);
          }
          return null;
        }
        return Number(execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n")[0]) || null;
      } catch {
        return null;
      }
    };
    const errorsBefore = main.errors.length;
    let stopped = false;

    await check("with the relayer stopped the site says it is offline within a few seconds", async () => {
      const pid = pidOnPort();
      assert(pid, `nothing is listening on port ${port}`);
      process.kill(pid);
      stopped = true;
      const started = Date.now();
      await page.locator(".banner.bad", { hasText: /offline/i }).waitFor({ timeout: 10_000 });
      const took = Date.now() - started;
      await page.waitForTimeout(7_000);
      const live = (await page.locator(".pills .live").innerText()).trim();
      assert(live !== "LIVE", `seven seconds after the last price the chart still says ${live}`);
      return `banner after ${took} ms: "${(await page.locator(".banner.bad").innerText()).replace(/\s+/g, " ")}"`;
    });

    await check("while offline the site does not pretend to trade", async () => {
      assert(stopped, "the relayer was not stopped");
      const s = await u.label();
      const rowsBefore = await u.rows().count();
      if (!s.disabled) await u.cta.click();
      await page.waitForTimeout(2_500);
      const toasts = await u.toasts();
      const rows = await u.rows().count();
      assert(rows === rowsBefore, `a row appeared for an order that went nowhere: "${(await page.locator(".tbl tbody").innerText()).replace(/\s+/g, " ").slice(0, 80)}"`);
      assert(s.disabled || toasts.some((t) => /not placed/i.test(t)), `the button said "${s.text}", took the click, and nothing told the visitor the order failed: ${JSON.stringify(toasts)}`);
      const message = toasts.find((t) => /not placed/i.test(t))?.replace(/\s+/g, " ") ?? "";
      assert(s.disabled || !/failed to fetch|networkerror|typeerror/i.test(message), `the order button stays live while offline, and the failure reads "${message}"`);
      return s.disabled ? `button: "${s.text}"` : `button stayed "${s.text}"; toast: "${message}"`;
    });

    await check("deposit and withdraw say they cannot work, in words a visitor understands", async () => {
      assert(stopped, "the relayer was not stopped");
      await page.waitForTimeout(4_700);
      await page.locator(".bar-end").getByRole("button", { name: "Withdraw", exact: true }).click();
      await page.getByLabel("Amount in USDC").fill("1");
      const button = u.dialog.locator(".btn.big");
      const disabled = await button.isDisabled();
      if (!disabled) await button.click();
      await page.waitForTimeout(2_000);
      const toasts = (await u.toasts()).map((t) => t.replace(/\s+/g, " "));
      await page.keyboard.press("Escape");
      assert(disabled || toasts.some((t) => /withdrawal failed/i.test(t)), `no word of the failure: ${JSON.stringify(toasts)}`);
      assert(disabled || !toasts.some((t) => /failed to fetch|typeerror/i.test(t)), `the message reads: ${toasts.join(" | ")}`);
    });

    await check("when the relayer returns the site recovers by itself and an order works without a reload", async () => {
      assert(stopped, "the relayer was not stopped");
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const log = openSync(join(tmpdir(), "tape-relayer-restart.log"), "a");
      const child = spawn(process.execPath, ["relayer/src/index.mjs"], { cwd: root, detached: true, stdio: ["ignore", log, log], windowsHide: true });
      child.unref();
      const started = Date.now();
      for (;;) {
        if (await fetch(`${API}/health`).then((r) => r.ok, () => false)) break;
        if (Date.now() - started > 30_000) throw new Error("the relayer did not come back");
        await sleep(250);
      }
      const up = Date.now();
      await page.locator(".banner.bad").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {
        throw new Error("20 s after the relayer came back the site still says Offline");
      });
      const recovered = Date.now() - up;
      await page.waitForFunction(() => document.querySelector(".pills .live")?.textContent.trim() === "LIVE", null, { timeout: 15_000 });
      const price = await page.locator(".market-pill .px").innerText();
      await page.waitForFunction((was) => document.querySelector(".market-pill .px")?.textContent !== was, price, { timeout: 8_000 });
      await page.waitForTimeout(1_000);
      await u.setOrder(2, 3);
      await u.cta.click();
      await page.locator(".tbl tbody tr:has(td:nth-child(10))").first().waitFor({ timeout: 15_000 }).catch(async () => {
        throw new Error(`no position 15 s after the order; toasts ${JSON.stringify(await u.toasts())}`);
      });
      await waitAccount(W1, "the position to land", (a) => a.positions.some((p) => p.status === "open"));
      const balance = await u.barBalance();
      assert(Math.abs(balance - Number((await accountOf(W1)).balance) / 1e6) < 0.006, `the balance shown (${balance}) is stale`);
      await flatten(page, W1);
      return `the banner cleared ${recovered} ms after the relayer answered again (pid ${pidOnPort()})`;
    });

    await check("the outage logged nothing but failed requests in the browser", async () => {
      const fresh = main.errors.slice(errorsBefore).filter((e) => !/ERR_CONNECTION_REFUSED|Failed to load resource|net::ERR/i.test(e));
      assert(fresh.length === 0, fresh.slice(0, 4).join(" | "));
    });
  }
}

await finish();

/** A page left alone on the trade page with a position open, measured once a minute. */
async function startSoak() {
  const v = await visitor({ label: "soak (wallet 4)" });
  const s = await ready(v.page, 4, { balance: 100 });
  await s.side("Long");
  await s.setOrder(2, 5);
  if ((await accountOf(WALLETS[3])).positions.length === 0) {
    await s.cta.click();
    await waitAccount(WALLETS[3], "the soak position", (a) => a.positions.some((p) => p.status === "open"));
  }
  const cdp = await v.context.newCDPSession(v.page);
  await cdp.send("Performance.enable");
  const sample = async (minute) => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
    return { minute, heap: get("JSHeapUsedSize"), nodes: get("Nodes"), listeners: get("JSEventListeners") };
  };
  const samples = [await sample(0)];
  for (let minute = 1; minute <= SOAK_MINUTES; minute++) {
    await sleep(60_000);
    samples.push(await sample(minute));
  }
  const stillOpen = (await accountOf(WALLETS[3])).positions.length > 0 && (await s.positionRows().count()) > 0;
  const errors = [...v.errors];
  await v.context.close();
  return { samples, errors, stillOpen };
}

async function finish() {
  current = null;
  await browser.close();
  if (timings.length) {
    console.log("\nTimings (ms)");
    for (const t of timings) console.log(`  ${t.what.padEnd(58)} median ${String(Math.round(t.median)).padStart(5)}   min ${String(Math.round(t.min)).padStart(5)}   max ${String(Math.round(t.max)).padStart(5)}   n=${t.n}`);
  }
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} passed${skipped.length ? `, ${skipped.length} skipped` : ""}${failures.length ? `\nfailed:\n  - ${failures.join("\n  - ")}` : ""}\n`);
  process.exit(failures.length ? 1 : 0);
}
