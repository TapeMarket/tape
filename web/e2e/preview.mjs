/**
 * Browser check of preview mode: the static build with no relayer and no chain, as it is hosted.
 * Prices are real (Coinbase), so this needs the internet; everything else happens in the tab.
 *
 *   npm run build && npx vite preview      (in web/, with VITE_API_URL unset)
 *   node e2e/preview.mjs [site-url] [--headed]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const SITE = args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4173";
const HEADED = args.includes("--headed");
const SHOTS = new URL("./shots/", import.meta.url);
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
let page = await context.newPage();
page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console: ${message.text().slice(0, 160)}`);
});

const shot = (name) => page.screenshot({ path: new URL(`preview-${name}.png`, SHOTS).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
// `page` changes when the test moves to a second tab, so nothing here holds on to the first one.
const mainNav = () => page.getByRole("navigation", { name: "Main" });
const nav = (label) => mainNav().getByRole("link", { name: label, exact: true }).click();
const more = async (label) => {
  await mainNav().getByRole("button", { name: /More/ }).click();
  await page.getByRole("menu").getByRole("link", { name: label, exact: true }).click();
};
const barBalance = async () => money(await page.locator(".bar-btn.acct b").innerText());
const row = (text) => page.locator(".trade-bottom .tbl tbody tr", { hasText: text });

console.log(`\n${SITE} (preview mode)\n`);
const started = Date.now();
await page.goto(`${SITE}/trade`);

await check("it says plainly that this is a preview", async () => {
  await page.locator(".banner", { hasText: "Preview" }).waitFor({ timeout: 15_000 });
});

await check("a real BTC price is on screen within a few seconds", async () => {
  await page.waitForFunction(() => /\$\d{2,3},\d{3}\.\d{2}/.test(document.querySelector(".market-pill .px")?.textContent ?? ""), null, { timeout: 20_000 });
  console.log(`       first price after ${((Date.now() - started) / 1000).toFixed(1)}s`);
});

await check("the exchange is already busy: tape, volume, open interest", async () => {
  await page.locator(".trade-bottom .tape .tchip").first().waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => /\$[1-9]/.test(document.querySelector(".pills")?.textContent ?? ""), null, { timeout: 15_000 });
});

await check("the chart is drawn in true black", async () => {
  await page.locator(".chart canvas").first().waitFor({ timeout: 8_000 });
  const colors = await page.evaluate(() => [".ticket", ".trade-chart", ".trade-bottom"].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor).concat(getComputedStyle(document.body).backgroundColor));
  for (const color of colors) assert(color === "rgba(0, 0, 0, 0)" || color === "rgb(0, 0, 0)", `found ${color}`);
  await shot("trade");
});

await check("a play account starts with $10,000 and no signing", async () => {
  await page.locator(".ticket .btn.big").click();
  await page.getByRole("button", { name: /Play account/ }).click();
  await page.locator(".bar-btn.acct b").waitFor({ timeout: 8_000 });
  await page.waitForFunction(() => /10,000\.00/.test(document.querySelector(".bar-btn.acct b")?.textContent ?? ""), null, { timeout: 8_000 });
});

await check("an order fills about two seconds later at the live price", async () => {
  await page.locator("#leverage").fill("100");
  await page.locator("#margin").fill("100");
  await page.getByRole("button", { name: "Long BTC", exact: true }).click();
  await row("100x").waitFor({ timeout: 12_000 });
  const cells = await row("100x").locator("td").allInnerTexts();
  assert(/\$10,000/.test(cells[2]), `size is ${cells[2]}`);
  assert(Math.abs((await barBalance()) - 9900) < 0.01, "the margin did not leave the balance");
});

await check("closing it settles and records the trade", async () => {
  await page.waitForTimeout(2500);
  await row("100x").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByText("No open positions").waitFor({ timeout: 15_000 });
  await page.getByRole("tab", { name: "History" }).click();
  await row("Long").first().waitFor({ timeout: 8_000 });
  await page.getByRole("tab", { name: "Positions" }).click();
  await page.waitForTimeout(600);
  const after = await barBalance();
  // A win beyond what the house can pay right now waits in the queue; the margin always comes back.
  const queuedText = await page.locator(".equity .kv", { hasText: "Queued Winnings" }).locator("span").last().innerText().catch(() => "0");
  assert(Math.abs(after + money(queuedText) - 10_000) < 60, `balance ${after} plus queued ${queuedText} is far from the $10,000 it started with`);
});

await check("play money moves between the wallet and the exchange", async () => {
  const before = await barBalance();
  await page.locator(".bar-end").getByRole("button", { name: "Deposit", exact: true }).click();
  await page.getByLabel("Amount in USDC").fill("1000");
  await page.getByRole("dialog").getByRole("button", { name: "Deposit", exact: true }).click();
  await page.waitForFunction((was) => Number((document.querySelector(".bar-btn.acct b")?.textContent ?? "").replace(/[^0-9.]/g, "")) >= was + 1000, before, { timeout: 8_000 });
});

await check("a large order shows what its size will cost before the click, and the position keeps that figure", async () => {
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  // $2,400,000 of BTC longs. On an empty side its middle would stand at $1.2M, 1.2 times the
  // $1,000,000 depth; whatever the simulated crowd has open on that side comes on top.
  await page.locator("#leverage").fill("300");
  await page.locator("#margin").fill("8000");
  const impact = page.locator(".ticket .kv", { hasText: "Size Impact" });
  await impact.waitFor({ timeout: 6_000 });
  const quoted = Number((await impact.locator("span").last().innerText()).replace(/[^0-9.]/g, ""));
  assert(quoted >= 1.2, `the ticket quotes a size impact of ${quoted}; the order alone makes it 1.2`);
  await page.locator(".ticket .note", { hasText: "crowded" }).waitFor({ timeout: 3_000 });
  await page.getByRole("button", { name: "Long BTC", exact: true }).click();
  await row("300x").waitFor({ timeout: 12_000 });
  const held = Number((await row("300x").locator(".size-level").innerText()).replace(/[^0-9.]/g, ""));
  // The crowd keeps trading during the two seconds before the fill, so the two can differ a little.
  assert(held >= 1.2 && Math.abs(held - quoted) < 1, `the ticket said ×${quoted}, the position holds ×${held}`);
  await shot("size-impact");
  await page.waitForTimeout(2500);
  await row("300x").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByText("No open positions").waitFor({ timeout: 15_000 });
  // A small order on a side inside its depth says nothing about size at all.
  await page.locator("#leverage").fill("100");
  await page.locator("#margin").fill("100");
});

await check("the house, the coin and the leaderboard have life in them", async () => {
  await nav("Vault");
  await page.waitForFunction(() => /\$[1-9]/.test([...document.querySelectorAll(".house .kv")].find((el) => el.textContent.includes("Volume"))?.lastElementChild.textContent ?? ""), null, { timeout: 12_000 });
  await page.locator(".house .panel canvas").first().waitFor({ timeout: 8_000 });
  await shot("house");
  await page.locator('nav[aria-label="Main"] a[href="/staking"]').click();
  await page.locator(".staking .tbl tbody tr").first().waitFor({ timeout: 12_000 });
  await shot("staking");
  await nav("Leaderboard");
  await page.locator(".lb-row").first().waitFor({ timeout: 12_000 });
  await shot("leaderboard");
});

await check("stats, status, dashboard and docs load", async () => {
  await more("Stats");
  assert((await page.locator(".tiles .tile").count()) === 6, "stats does not have six tiles");
  await shot("stats");
  await more("Status");
  await page.getByRole("heading", { name: "All systems normal" }).waitFor({ timeout: 10_000 });
  await shot("status");
  await more("Dashboard");
  await page.locator(".dash .widget").first().waitFor({ timeout: 8_000 });
  await shot("dashboard");
  await more("Docs");
  await page.locator(".docs .callout").first().waitFor({ timeout: 8_000 });
});

await check("a second tab shows the same account and the two stay in step", async () => {
  await page.evaluate(() => {
    history.pushState(null, "", "/trade");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  const second = await context.newPage();
  second.on("pageerror", (error) => problems.push(`second tab: ${error.message}`));
  second.on("console", (message) => {
    if (message.type() === "error") problems.push(`second tab console: ${message.text().slice(0, 160)}`);
  });
  await second.goto(`${SITE}/trade`);
  await second.locator(".bar-btn.acct b").waitFor({ timeout: 15_000 });
  const read = async (p) => money(await p.locator(".bar-btn.acct b").innerText());
  assert(Math.abs((await read(second)) - (await barBalance())) < 0.01, "the second tab shows a different balance");
  // Trade in the second tab; the first has to see it.
  await second.locator("#leverage").fill("50");
  await second.locator("#margin").fill("250");
  await second.getByRole("button", { name: "Long BTC", exact: true }).click();
  await second.locator(".trade-bottom .tbl tbody tr", { hasText: "50x" }).waitFor({ timeout: 12_000 });
  await row("50x").waitFor({ timeout: 6_000 });
  await page.waitForFunction((want) => Math.abs(Number((document.querySelector(".bar-btn.acct b")?.textContent ?? "").replace(/[^0-9.]/g, "")) - want) < 0.01, await read(second), { timeout: 6_000 });
  // Close the tab that has been running the exchange. The other one has to take over by itself.
  await page.close();
  await second.waitForTimeout(1500);
  await second.locator(".trade-bottom .tbl tbody tr", { hasText: "50x" }).getByRole("button", { name: "Close", exact: true }).click();
  await second.getByText("No open positions").waitFor({ timeout: 20_000 });
  const ticking = await second.locator(".market-pill .px").innerText();
  assert(/\$\d/.test(ticking), "the surviving tab has no price");
  page = second;
});

await check("a reload remembers the account and the world", async () => {
  // What the account has: its balance, and winnings still waiting in the queue. The house may pay
  // some of the queue at any moment, which moves money from the second to the first; the sum only
  // changes when the account trades.
  const worth = async () => {
    const queued = await page.locator(".equity .kv", { hasText: "Queued Winnings" }).locator("span").last().innerText({ timeout: 1_000 }).catch(() => "0");
    return (await barBalance()) + money(queued);
  };
  const before = await worth();
  await page.waitForTimeout(4500);
  await page.goto(`${SITE}/trade`);
  await page.locator(".bar-btn.acct b").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
  const after = await worth();
  assert(Math.abs(after - before) < 0.02, `balance plus queued winnings went from ${before} to ${after} across a reload`);
  await page.locator(".trade-bottom .tape .tchip").first().waitFor({ timeout: 10_000 });
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
  await page.waitForTimeout(500);
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
