/**
 * Browser end-to-end test. Drives the real site against a running relayer and a local chain
 * (script/DevDeploy.s.sol), with the built-in test wallet. No mocks between the click and the chain.
 *
 *   anvil                                   (terminal 1)
 *   forge script script/DevDeploy.s.sol …   (once)
 *   node relayer/src/index.mjs              (terminal 2)
 *   npm run dev                             (terminal 3, in web/)
 *   node e2e/run.mjs [site-url] [--headed] [--wallet=N]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const SITE = args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:5173";
const HEADED = args.includes("--headed");
const WALLET = Number(args.find((a) => a.startsWith("--wallet="))?.split("=")[1] ?? 2);
const API = args.find((a) => a.startsWith("--api="))?.split("=")[1] ?? "http://127.0.0.1:8787";
const SHOTS = new URL("./shots/", import.meta.url);

/** Moves the simulated BTC price by `bps` and holds it there (0 returns it to the real ticker). */
const nudge = (bps) => fetch(`${API}/dev/nudge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market: 0, bps }) });
mkdirSync(SHOTS, { recursive: true });

let passed = 0;
const failures = [];
const problems = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(error.message).split("\n")[0]}`);
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const money = (text) => Number(text.replace(/[^0-9.-]/g, ""));

const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console: ${message.text().slice(0, 160)}`);
});

const shot = (name) => page.screenshot({ path: new URL(`${name}.png`, SHOTS).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
const mainNav = page.getByRole("navigation", { name: "Main" });
const nav = (label) => mainNav.getByRole("link", { name: label, exact: true }).click();
const more = async (label) => {
  await mainNav.getByRole("button", { name: /More/ }).click();
  await page.getByRole("menu").getByRole("link", { name: label, exact: true }).click();
};
const barBalance = async () => money(await page.locator(".bar-btn.acct b").innerText());
/** Waits for the balance in the top bar to be at least, above, or at most `target`. */
const waitBalance = (kind, target, timeout = 20_000) =>
  page.waitForFunction(
    ([how, value]) => {
      const now = Number((document.querySelector(".bar-btn.acct b")?.textContent ?? "").replace(/[^0-9.]/g, ""));
      return how === "atLeast" ? now >= value : how === "above" ? now > value : now <= value;
    },
    [kind, target],
    { timeout },
  );
const rows = () => page.locator(".trade-bottom .tbl tbody tr");
const row = (text) => page.locator(".trade-bottom .tbl tbody tr", { hasText: text });
const cta = page.locator(".ticket .btn.big");
const side = (name) => page.getByRole("group", { name: "Direction" }).getByRole("button", { name: new RegExp(name) }).click();
const setOrder = async (leverage, margin) => {
  await page.locator("#leverage").fill(String(leverage));
  await page.locator("#margin").fill(String(margin));
};
const toastGone = () => page.locator(".toast").first().waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});

const config = await (await fetch(`${API}/config`)).json();
const COIN = config.coin?.symbol ?? "TAPE";
const coinLink = `$${COIN}`;

console.log(`\n${SITE}, test wallet ${WALLET}\n`);

// ------------------------------------------------------------------------------------------
console.log("Loading");
await page.goto(`${SITE}/trade`);

await check("the terminal shows a live BTC price", async () => {
  await page.waitForFunction(() => /\d{2},\d{3}\.\d{2}/.test(document.querySelector(".market-pill .px")?.textContent ?? ""), null, { timeout: 15_000 });
});

await check("the price ticks", async () => {
  const first = await page.locator(".market-pill .px").innerText();
  await page.waitForFunction((was) => document.querySelector(".market-pill .px")?.textContent !== was, first, { timeout: 8_000 });
});

await check("the chart is drawn and previews the bust zone at 1000x", async () => {
  await page.locator(".chart canvas").first().waitFor({ timeout: 8_000 });
  await page.locator(".bust-zone").first().waitFor({ timeout: 8_000 });
});

await check("the page is true black, panels included", async () => {
  const colors = await page.evaluate(() => [".ticket", ".trade-chart", ".trade-bottom", ".bar"].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor).concat(getComputedStyle(document.body).backgroundColor));
  for (const color of colors) assert(color === "rgba(0, 0, 0, 0)" || color === "rgb(0, 0, 0)", `found ${color}`);
});

await check("the tape and the market figures are there", async () => {
  // On a chain nobody has traded on yet the tape is there and empty, which is not "visible".
  await page.locator(".trade-bottom .tape").waitFor({ state: "attached" });
  await page.locator(".pills .seg", { hasText: "Vol 24h" }).waitFor();
});

// ------------------------------------------------------------------------------------------
console.log("Wallet and money");

await check("a wallet connects", async () => {
  await page.locator(".bar-end").getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`Test wallet ${WALLET}`) }).click();
  await page.locator(".bar-btn.acct b").waitFor({ timeout: 8_000 });
});

// Start from a clean slate: close anything a previous run or a manual session left open.
async function closeEverything() {
  for (let i = 0; i < 12; i++) {
    const button = rows().getByRole("button", { name: "Close", exact: true }).first();
    if (!(await button.count())) break;
    await button.click().catch(() => {});
    await page.waitForTimeout(3500);
  }
  await page.getByText("No open positions").waitFor({ timeout: 30_000 });
}
await page.waitForTimeout(1200);

await check("one signature turns on one-click trading, after a short countdown", async () => {
  const label = (await cta.innerText()).toLowerCase();
  // A session from an earlier run on this chain is fine; a fresh browser never has one.
  if (label !== "turn on one-click trading") throw new Error(`ticket says "${label}"`);
  await cta.click();
  // The key starts signing one block-slot after it is registered: the ticket counts that down.
  await page.waitForFunction(() => /^trading on in \d+s$/i.test(document.querySelector(".ticket .btn.big")?.textContent ?? ""), null, { timeout: 15_000 });
  await page.waitForFunction(() => !/turn on|trading on in|check your wallet/i.test(document.querySelector(".ticket .btn.big")?.textContent ?? ""), null, { timeout: 25_000 });
});

await closeEverything();

let startBalance = 0;
await check("a deposit sent to the wallet's deposit address arrives", async () => {
  startBalance = await barBalance();
  await page.locator(".bar-end").getByRole("button", { name: "Deposit", exact: true }).click();
  await page.getByLabel("Amount in USDC").fill("2000");
  await page.getByRole("dialog").getByRole("button", { name: "Deposit", exact: true }).click();
  await waitBalance("atLeast", startBalance + 2000).catch(async () => {
    const toasts = await page.locator(".toast").allInnerTexts();
    const button = await page.getByRole("dialog").getByRole("button").last().innerText().catch(() => "no dialog");
    throw new Error(`balance went from ${startBalance} to ${await barBalance()}; dialog button "${button}"; toasts ${JSON.stringify(toasts)}`);
  });
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 5_000 });
});

// ------------------------------------------------------------------------------------------
console.log("Trading");

await check("an order shows as filling, then as a position", async () => {
  await side("Long");
  await setOrder(10, 100);
  await page.getByRole("button", { name: "Long BTC", exact: true }).click();
  await page.getByText(/Filling at the next price/).waitFor({ timeout: 5_000 });
  await row("10x").waitFor({ timeout: 12_000 });
});

await check("the next order goes straight through", async () => {
  await side("Short");
  await page.getByRole("button", { name: "Short BTC", exact: true }).click();
  await row("Short").waitFor({ timeout: 12_000 });
});

await check("the position's row is complete and the ticket counts it", async () => {
  const cells = await row("Long").locator("td").allInnerTexts();
  assert(cells.length === 10, `row has ${cells.length} cells`);
  assert(/\$1,000/.test(cells[2]), `size is ${cells[2]}`);
  await page.locator(".ticket-foot", { hasText: /Open Positions\s*2/ }).waitFor({ timeout: 8_000 });
});

await check("balance fell by the two margins, and equity still adds up", async () => {
  await page.waitForTimeout(1500);
  const now = await barBalance();
  assert(Math.abs(startBalance + 2000 - 200 - now) < 0.01, `balance is ${now}`);
  const equity = money(await page.locator(".equity summary span").last().innerText());
  assert(Math.abs(equity - (startBalance + 2000)) < 25, `equity is ${equity}`);
});

await shot("trade");

await check("closing removes the position and records it", async () => {
  const before = await rows().count();
  await row("Long").getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForFunction((n) => document.querySelectorAll(".trade-bottom .tbl tbody tr").length === n - 1, before, { timeout: 20_000 });
  await page.getByRole("tab", { name: "History" }).click();
  await row("Long").first().waitFor({ timeout: 8_000 });
  await page.getByRole("tab", { name: "Positions" }).click();
});

await check("Close All closes what is left", async () => {
  await page.locator(".ticket-foot").getByRole("button", { name: "Close All" }).click();
  await page.getByText("No open positions").waitFor({ timeout: 20_000 });
});

await check("a 1000x position busts when the price touches its trigger", async () => {
  await side("Long");
  await setOrder(1000, 300);
  await page.getByRole("button", { name: "Long BTC", exact: true }).click();
  await row("1000x").waitFor({ timeout: 12_000 });
  await page.locator(".bust-zone:not(.preview)").waitFor({ timeout: 5_000 });
  await page.waitForTimeout(2500);
  // Push the simulated price 9 bps down: past the trigger, which sits 5 bps below entry.
  await nudge(-9);
  await page.locator(".toast.bust").waitFor({ timeout: 25_000 });
  await shot("busted");
  await row("1000x").waitFor({ state: "detached", timeout: 10_000 });
  await page.getByRole("tab", { name: "History" }).click();
  await page.locator(".trade-bottom .tbl tbody tr .badge", { hasText: "Liquidated" }).first().waitFor({ timeout: 8_000 });
  await page.getByRole("tab", { name: "Positions" }).click();
  await nudge(0);
});

await check("a win is paid, or queued when the house is short", async () => {
  await setOrder(100, 50);
  await page.getByRole("button", { name: "Long BTC", exact: true }).click();
  await row("100x").waitFor({ timeout: 12_000 });
  await page.waitForTimeout(2500);
  await nudge(30);
  await page.waitForFunction(() => document.querySelector(".trade-bottom .tbl tbody tr td.up b")?.textContent?.startsWith("+$"), null, { timeout: 15_000 });
  await row("100x").getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".toast.good", { hasText: /closed \+\$/ }).waitFor({ timeout: 20_000 });
  await nudge(0);
});

await check("the tape shows what just happened", async () => {
  await page.locator(".trade-bottom .tape .tchip").first().waitFor({ timeout: 8_000 });
  assert((await page.locator(".trade-bottom .tape .tchip").count()) >= 3, "fewer than three entries on the tape");
});

await check("switching market switches the price, and the chart step changes", async () => {
  await page.locator(".market-pill").getByRole("button").first().click();
  await page.getByRole("menu").getByRole("button", { name: /ETH/ }).click();
  await page.waitForFunction(() => {
    const value = Number((document.querySelector(".market-pill .px")?.textContent ?? "").replace(/[$,]/g, ""));
    return value > 100 && value < 20_000;
  }, null, { timeout: 8_000 });
  await page.getByLabel("Chart step").selectOption("15");
  await page.locator(".chart canvas").first().waitFor({ timeout: 8_000 });
  await page.getByLabel("Chart step").selectOption("0");
  await page.locator(".market-pill").getByRole("button").first().click();
  await page.getByRole("menu").getByRole("button", { name: /BTC/ }).click();
});

// ------------------------------------------------------------------------------------------
console.log("The other pages");

await check("the house page shows the books, the charts and the queue", async () => {
  await nav("Vault");
  for (const title of ["User positions", "Stats", "House exposure", "Liquidation heatmap", "1% house PnL", "House position topology", "Queue stats", "Queue placement"]) {
    await page.locator(".house .panel .title", { hasText: title }).first().waitFor({ timeout: 8_000 });
  }
  await page.locator(".house .kv", { hasText: "House Funds" }).waitFor();
  await page.waitForFunction(() => /\$/.test([...document.querySelectorAll(".house .kv")].find((el) => el.textContent.includes("LP Balance"))?.lastElementChild.textContent ?? ""), null, { timeout: 8_000 });
  await page.locator(".house .tape, .tape").first().waitFor();
  await shot("house");
});

await check(`the loss was paid in ${COIN}, straight to the wallet, and it stakes`, async () => {
  await nav(coinLink);
  await page.locator(".staking .panel .title", { hasText: "Claimable rewards" }).waitFor({ timeout: 8_000 });
  await page.waitForFunction(() => /[1-9]/.test(document.querySelector(".staking .figure.small")?.textContent ?? ""), null, { timeout: 10_000 });
  const form = page.locator(".stake-form > div").first();
  await form.getByRole("button", { name: "Max" }).click();
  await form.getByRole("button", { name: `Stake ${COIN}` }).click();
  await page.locator(".toast.good", { hasText: /^Staked/ }).waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => /[1-9]/.test(document.querySelector(".staking .figure:not(.small):not(.up)")?.textContent ?? "") || /[1-9]/.test(document.querySelectorAll(".staking .figure")[1]?.textContent ?? ""), null, { timeout: 12_000 });
});

await check("the next loss pays the stakers, now that somebody is staked", async () => {
  // Fees only flow while no winner is waiting in the queue, so make a fresh loss the house keeps.
  await nav("Trade");
  await side("Long");
  await setOrder(1000, 300);
  await page.getByRole("button", { name: "Long BTC", exact: true }).click();
  await row("1000x").waitFor({ timeout: 12_000 });
  await page.waitForTimeout(2500);
  await nudge(-9);
  await page.locator(".toast.bust").waitFor({ timeout: 25_000 });
  await nudge(0);
  await row("1000x").waitFor({ state: "detached", timeout: 10_000 });
});

await check("the stakers' share arrives and can be claimed to the trading balance", async () => {
  await nav(coinLink);
  const claim = page.getByRole("button", { name: "Claim to trading balance" });
  await claim.waitFor({ timeout: 45_000 });
  const before = await barBalance();
  await claim.click();
  await page.locator(".toast.good", { hasText: /Rewards claimed/ }).waitFor({ timeout: 20_000 });
  // A payment is streamed over a day, so seconds after it only a sliver has been earned: the
  // balance does not have to show it, it only must not fall. The claim itself is in the history.
  await page.waitForTimeout(1500);
  assert((await barBalance()) >= before, "claiming took money out of the balance");
  await page.locator(".staking .tbl tbody tr", { hasText: /claim/i }).first().waitFor({ timeout: 12_000 });
  await shot("staking");
});

await check("the leaderboard lists positions and accounts", async () => {
  await nav("Leaderboard");
  await page.getByRole("group", { name: "Period" }).getByRole("button", { name: "All" }).click();
  await page.locator(".lb-row").first().waitFor({ timeout: 8_000 });
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.locator(".lb-accounts .lb-row").first().waitFor({ timeout: 8_000 });
  await shot("leaderboard");
});

await check("a username can be claimed and shows on the board", async () => {
  const name = `e2e_${Math.floor(Math.random() * 1e6)}`;
  await page.getByRole("button", { name: /Claim a username|You are/ }).click();
  await page.getByLabel("Username", { exact: true }).fill(name);
  await page.getByRole("dialog").getByRole("button", { name: `Claim ${name}` }).click();
  await page.locator(".toast.good", { hasText: `You are ${name}` }).waitFor({ timeout: 15_000 });
  await page.locator(".lb-accounts .lb-row .who", { hasText: name }).waitFor({ timeout: 15_000 });
});

await check("the portfolio adds up and every tab has its history", async () => {
  await nav("Portfolio");
  await page.locator(".portfolio-top .kv", { hasText: "Available to Trade" }).waitFor();
  const available = money(await page.locator(".portfolio-top .kv", { hasText: "Available to Trade" }).locator("span").last().innerText());
  assert(Math.abs(available - (await barBalance())) < 0.01, "portfolio and top bar disagree");
  const expect = { "Trade History": /Long|Short/, "Deposits / Withdrawals": /Deposit/, Staking: /Stake/, "Queue Balance History": null, [`${COIN} Emissions`]: /\/ \$1/ };
  for (const [tab, pattern] of Object.entries(expect)) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    if (pattern) await page.locator(".tbl tbody tr", { hasText: pattern }).first().waitFor({ timeout: 8_000 });
    else await page.locator(".tbl").first().waitFor();
  }
  await page.getByRole("tab", { name: "Open Queue Balances" }).click();
  await page.locator(".tbl").first().waitFor();
  await page.getByRole("tab", { name: "Open Positions" }).click();
  await shot("portfolio");
});

await check("stats, status and the dashboard load from the More menu", async () => {
  await more("Stats");
  assert((await page.locator(".tiles .tile").count()) === 6, "stats does not have six tiles");
  await page.locator(".charts-2 .panel canvas").first().waitFor({ timeout: 8_000 });
  await more("Status");
  await page.getByRole("heading", { name: "All systems normal" }).waitFor({ timeout: 10_000 });
  await shot("status");
  await more("Dashboard");
  await page.locator(".dash .widget").first().waitFor({ timeout: 8_000 });
  const before = await page.locator(".dash .widget").count();
  assert(before >= 5, `dashboard has ${before} panels`);
  await page.locator(".dash .widget .close-x").first().click();
  await page.waitForFunction((n) => document.querySelectorAll(".dash .widget").length === n - 1, before, { timeout: 5_000 });
  await shot("dashboard");
});

await check("the docs explain the product and state the risks", async () => {
  await more("Docs");
  const text = await page.locator(".docs").innerText();
  assert(text.length > 3000, "the docs are thin");
  assert(/bust price/i.test(text) && /queue/i.test(text) && /stak/i.test(text), "a core topic is missing");
  assert(/not upgradeable|cannot be patched|audit/i.test(text), "the risks are not stated");
});

await check("a withdrawal signed by the wallet leaves", async () => {
  await toastGone();
  const before = await barBalance();
  await page.locator(".bar-end").getByRole("button", { name: "Withdraw", exact: true }).click();
  await page.getByLabel("Amount in USDC").fill("500");
  await page.getByRole("dialog").getByRole("button", { name: "Withdraw", exact: true }).click();
  await waitBalance("atMost", before - 500 + 0.01);
});

// ------------------------------------------------------------------------------------------
console.log("Staying power");

await check("a reload keeps the wallet and the trading session", async () => {
  await page.goto(`${SITE}/trade`);
  await page.locator(".bar-btn.acct b").waitFor({ timeout: 10_000 });
  await side("Long");
  await setOrder(10, 10);
  assert(!/turn on|trading on in/i.test(await cta.innerText()), "one-click trading was not remembered");
  await page.getByRole("button", { name: "Long BTC", exact: true }).click();
  await row("10x").waitFor({ timeout: 12_000 });
  await page.waitForTimeout(3000);
  await row("10x").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByText("No open positions").waitFor({ timeout: 20_000 });
});

await check("it fits a phone without sideways scrolling", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  for (const path of ["/", "/trade", "/portfolio", "/vault", "/staking", "/stats", "/status", "/docs"]) {
    await page.evaluate((to) => {
      history.pushState(null, "", to);
      dispatchEvent(new PopStateEvent("popstate"));
    }, path);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `${path} overflows by ${overflow}px`);
  }
  await page.evaluate(() => {
    history.pushState(null, "", "/trade");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForTimeout(400);
  await shot("phone");
  await page.setViewportSize({ width: 1440, height: 900 });
});

await check("nothing was logged as an error along the way", async () => {
  assert(problems.length === 0, problems.slice(0, 3).join(" | "));
});

await browser.close();
const total = passed + failures.length;
console.log(`\n${passed}/${total} passed${failures.length ? `\nfailed: ${failures.join("; ")}` : ""}\n`);
process.exit(failures.length ? 1 : 0);
