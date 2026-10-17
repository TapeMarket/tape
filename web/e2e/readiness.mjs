// Production-build preview checks. Market data is deterministic; no chain or real funds.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const site = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4173";
const capture = !process.argv.includes("--no-shots");
const shots = new URL("./shots/", import.meta.url);
mkdirSync(shots, { recursive: true });
const prices = { BTC: 80000, ETH: 2500, SOL: 150, XRP: 1, DOGE: 0.2, "xyz:GOLD": 2600, "xyz:SP500": 6000, "xyz:TSLA": 250, "xyz:NVDA": 140, "xyz:AAPL": 230 };
const errors = [];
const browser = await chromium.launch();
let passed = 0;
async function check(name, fn) { await fn(); console.log(`ok ${++passed}: ${name}`); }
async function fixture(context) {
  if (process.argv.includes("--local")) await context.route(`${site}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    const root = fileURLToPath(new URL(path.startsWith("/img/") ? "../public/" : "../dist/", import.meta.url));
    const file = resolve(root, /^\/(assets|img)\//.test(path) ? path.slice(1) : "index.html");
    assert.ok(file.startsWith(resolve(root) + sep));
    return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
  });
  await context.route("https://api.hyperliquid.xyz/info", async (route) => {
    const b = route.request().postDataJSON();
    const names = Object.keys(prices).filter((coin) => coin.includes(":") === Boolean(b.dex));
    let data;
    if (b.type === "allMids") data = Object.fromEntries(names.map((n) => [n, String(prices[n])]));
    else if (b.type === "metaAndAssetCtxs") data = [{ universe: names.map((name) => ({ name })) }, names.map((n) => ({ prevDayPx: String(prices[n] * .99), oraclePx: String(prices[n]) }))];
    else if (b.type === "recentTrades") data = Array.from({ length: 100 }, (_, i) => ({ px: String(prices[b.coin]), time: Date.now() - (99 - i) * 1000 }));
    else if (b.type === "candleSnapshot") { const p = String(prices[b.req.coin]); data = Array.from({ length: 300 }, (_, i) => ({ t: Math.floor(Date.now() / 60000) * 60000 - (299 - i) * 60000, o: p, h: p, l: p, c: p })); }
    else throw Error(`Unexpected request ${b.type}`);
    await route.fulfill({ json: data });
  });
  await context.routeWebSocket("wss://api.hyperliquid.xyz/ws", (ws) => {
    const coins = new Set();
    const tick = () => { for (const coin of coins) { const p = prices[coin]; ws.send(JSON.stringify({ channel: "bbo", data: { coin, time: Date.now(), bbo: [{ px: String(p * .999999) }, { px: String(p * 1.000001) }] } })); } };
    ws.onMessage((msg) => { const b = JSON.parse(String(msg)); if (b.method === "subscribe") { coins.add(b.subscription.coin); tick(); } });
    const timer = setInterval(tick, 300); ws.onClose(() => clearInterval(timer));
  });
  context.on("page", (page) => page.on("pageerror", (e) => errors.push(e.message)));
}
async function ready(page) { await page.locator(".mcard").first().waitFor(); await page.waitForFunction(() => document.querySelector(".board-px")?.textContent !== "–"); }
async function fits(page) { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow: ${new URL(page.url()).pathname} at ${page.viewportSize().width}px`); }
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await fixture(ctx);
  const page = await ctx.newPage(); await page.goto(`${site}/trade?preview=1`); await ready(page);
  await check("ten markets, an empty activity feed and no overflow", async () => { assert.equal(await page.locator(".mcard").count(), 10); await page.getByText("No trades yet. Yours will show here.", { exact: true }).waitFor(); await fits(page); });
  await check("cached charts survive every pair, chart step and client-side navigation", async () => {
    // The candle fixture includes the unfinished current minute, as Hyperliquid does.
    // Warm the cache, then switch pairs: its future close must never precede an older live update.
    await page.waitForTimeout(1000);
    for (const step of ["0", "15", "60", "300", "0"]) {
      await page.getByLabel("Chart step").selectOption(step);
      for (const i of [1, 2, 7, 0, 3, 4, 5, 6, 8, 9, 0]) {
        const symbol = Object.keys(prices)[i].replace("xyz:", "").replace("SP500", "SPX");
        await page.locator(".mcard").nth(i).click();
        await page.waitForFunction((s) => document.querySelector(".board-sym")?.textContent?.includes(s), symbol);
        assert.equal(await page.getByText("The page stopped working in this tab.").count(), 0);
      }
    }
    for (const route of ["/vault", "/staking", "/leaderboard", "/trade"]) {
      await page.locator(`a[href='${route}']`).first().click();
      await page.waitForFunction((path) => location.pathname === path && (document.querySelector("main")?.innerText.length ?? 0) > 40, route);
      assert.equal(await page.getByText("The page stopped working in this tab.").count(), 0);
    }
    await ready(page);
  });
  await check("clearly labelled practice account", async () => { await page.locator(".wallet-connect").click(); await page.getByRole("dialog").locator(".wallet-option").click(); await page.locator(".wallet-main").waitFor(); assert.match(await page.locator(".wallet-main").innerText(), /10,000/); assert.match(await page.locator(".wallet-main").innerText(), /practice/i); });
  await check("invalid leverage disables trading", async () => { await page.locator("#margin").fill("100"); await page.locator("#leverage").fill("2.5"); await page.waitForFunction(() => document.querySelector(".slip-go")?.disabled); await page.locator("#leverage").fill("100"); await page.locator("#margin").click(); });
  await check("order opens, closes and enters history", async () => { await page.locator(".slip-go").click(); await page.locator(".strip").waitFor({ timeout: 15000 }); assert.equal(await page.locator(".strip").count(), 1); await page.locator(".strip").getByRole("button", { name: "Close", exact: true }).click(); await page.locator(".strip").waitFor({ state: "detached", timeout: 15000 }); await page.getByRole("tab", { name: "History", exact: true }).click(); await page.locator(".tt-book tbody tr").waitFor(); assert.equal(await page.locator(".tt-book tbody tr").count(), 1); });
  await check("withdraw and deposit move practice cash correctly", async () => {
    await page.locator(".wallet-withdraw").click(); let d = page.getByRole("dialog", { name: "Withdraw USDC" }); await d.getByLabel("Amount in USDC").fill("50"); await d.getByRole("button", { name: "Withdraw", exact: true }).click(); await d.getByText("Back in your wallet.", { exact: true }).waitFor(); await d.getByRole("button", { name: "Done", exact: true }).click(); await d.waitFor({ state: "detached" }); assert.match(await page.locator(".wallet-main").innerText(), /9,950/);
    await page.getByRole("button", { name: "Deposit", exact: true }).click(); d = page.getByRole("dialog", { name: "Deposit USDC" }); await d.getByLabel("Amount in USDC").fill("50"); await d.getByRole("button", { name: "Deposit", exact: true }).click(); await d.getByText("Deposit received.", { exact: true }).waitFor(); await d.getByRole("button", { name: "Back to trading", exact: true }).click(); await d.waitFor({ state: "detached" }); assert.match(await page.locator(".wallet-main").innerText(), /10,000/);
  });
  await check("dialog Escape restores keyboard focus", async () => { await page.getByRole("button", { name: "Deposit", exact: true }).click(); await page.getByRole("dialog").waitFor(); await page.keyboard.press("Escape"); assert.equal(await page.getByRole("dialog").count(), 0); assert.equal(await page.getByRole("button", { name: "Deposit", exact: true }).evaluate((el) => el === document.activeElement), true); });
  await check("account and history survive reload", async () => { await page.reload(); await ready(page); await page.locator(".wallet-main").waitFor(); assert.match(await page.locator(".wallet-main").innerText(), /10,000/); await page.getByRole("tab", { name: "History", exact: true }).click(); await page.locator(".tt-book tbody tr").waitFor(); });
  await page.getByRole("tab", { name: /^Positions/ }).click(); if (capture) await page.screenshot({ path: fileURLToPath(new URL("tape-desktop.png", shots)), fullPage: true });
  const routes = ["portfolio", "vault", "jackpot", "staking", "leaderboard", "stats", "dashboard", "status", "docs", "referrals"];
  await check("all pages render on desktop and mobile", async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await fixture(phone); const mobile = await phone.newPage();
    await mobile.goto(`${site}/trade?preview=1`); await ready(mobile); await fits(mobile); if (capture) await mobile.screenshot({ path: fileURLToPath(new URL("tape-mobile.png", shots)), fullPage: true });
    for (const p of [page, mobile]) for (const route of routes) { await p.goto(`${site}/${route}?preview=1`); await p.waitForFunction(() => (document.querySelector("main")?.innerText.length ?? 0) > 40); assert.equal(await p.getByText("The page stopped working in this tab.").count(), 0, route); await fits(p); }
  });
  assert.deepEqual(errors, [], "browser exceptions"); console.log(`${passed} checks passed${capture ? '; screenshots in web/e2e/shots' : ''}.`);
} finally { await browser.close(); }
