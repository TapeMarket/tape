// Read-only checks against Tape's real API. --local serves the built files at the public origin
// inside this isolated browser, so CORS is tested without weakening the production server.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";

const site = process.argv.find((a) => a.startsWith("http")) ?? "https://tapemarket.io";
const local = process.argv.includes("--local");
const capture = process.argv.includes("--shots");
const api = "https://api.tapemarket.io";
const deployment = JSON.parse(readFileSync(new URL("../../deployments/1.json", import.meta.url), "utf8"));
const config = await (await fetch(`${api}/config`)).json();
assert.equal(config.chainId, 1);
assert.equal(config.addresses.exchange.toLowerCase(), deployment.exchange.toLowerCase());
assert.equal(config.addresses.deposits.toLowerCase(), deployment.deposits.toLowerCase());
assert.equal(config.coin, null);
assert.equal((await (await fetch(`${api}/coin`)).json()).attached, false);
console.log("PASS: real Ethereum API matches the fresh exchange and pinned Deposits; no coin attached.");

const browser = await chromium.launch();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (local) await context.route(`${site}/**`, async (route) => {
    const url = new URL(route.request().url());
    const root = fileURLToPath(new URL(url.pathname.startsWith("/img/") ? "../public/" : "../dist/", import.meta.url));
    const name = /^\/(assets|img)\//.test(url.pathname) ? url.pathname.slice(1) : "index.html";
    const file = resolve(root, name);
    assert.ok(file.startsWith(resolve(root) + sep));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: "Missing asset" });
    return route.fulfill({ path: file });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${site}/trade`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".mcard-num span").length === 10 && [...document.querySelectorAll(".mcard-num span")].every((el) => /\d/.test(el.textContent)), { timeout: 30000 });
  assert.equal(await page.locator(".mcard").count(), 10);
  assert.equal(await page.getByText("Practice preview", { exact: true }).count(), 0);
  const [meta, contexts] = await (await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }) })).json();
  const baseline = Number(contexts[meta.universe.findIndex((m) => m.name === "BTC")].prevDayPx);
  const current = Number((await page.locator(".mcard-num b").first().innerText()).replaceAll(",", ""));
  const shown = Number((await page.locator(".mcard-num span").first().innerText()).replace("%", "").replace("−", "-"));
  assert.ok(Math.abs(shown - (current / baseline - 1) * 100) < .04, "daily percentage uses the real 24h venue baseline");
  for (let i = 0; i < 10; i++) {
    await page.locator(".mcard").nth(i).click();
    await page.waitForFunction((symbol) => document.querySelector(".board-sym")?.textContent.includes(symbol), config.markets[i].symbol);
    assert.equal(await page.getByText("The page stopped working in this tab.").count(), 0);
  }
  await page.locator(".wallet-connect").click();
  await page.getByRole("dialog", { name: "Connect a wallet" }).waitFor();
  await page.keyboard.press("Escape");
  console.log("PASS: ten live prices/day percentages, real 24h baseline, pair switching and wallet connection dialog.");

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const path of ["vault", "stats", "portfolio", "dashboard", "leaderboard", "referrals", "status", "docs", "staking", "jackpot"]) {
      await page.goto(`${site}/${path}`, { waitUntil: "domcontentloaded" });
      await page.locator(".hero").waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${path} overflow at ${width}`);
      assert.equal(await page.getByText("The page stopped working in this tab.").count(), 0);
      if (path === "staking") await page.getByRole("heading", { name: "Coin launch pending", exact: true }).waitFor();
      if (path === "jackpot") await page.getByRole("heading", { name: "Jackpot not active yet", exact: true }).waitFor();
      if (path === "stats") {
        await page.getByLabel("Chart market").selectOption("1");
        await page.getByRole("region", { name: "ETH volume", exact: true }).waitFor();
      }
      if (capture && width !== 320 && ["vault", "staking", "jackpot"].includes(path)) {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: fileURLToPath(new URL(`./shots/live-${path}-${width}.png`, import.meta.url)) });
      }
    }
  }
  console.log("PASS: all ten supporting pages fit desktop and small phones; pending coin features are explicit.");
  await page.goto(site, { waitUntil: "domcontentloaded" });
  await page.getByText("Exchange live on Ethereum. Coin launch pending.", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Coin launch pending.", exact: true }).waitFor();
  assert.equal(await page.locator(".lp-jackpot").count(), 0);
  assert.equal(await page.locator(".band .mcard").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: landing clearly describes the current deployment; no false live jackpot or coin claims, no browser exceptions.");
} finally { await browser.close(); }
