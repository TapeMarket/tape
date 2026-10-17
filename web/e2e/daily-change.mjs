// A slow or failed daily-reference request must not permanently hide the live 24h change.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { marketFixture, PRICES } from "./market-fixture.mjs";
const site = process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:4173";
const browser = await chromium.launch(), errors = [], prices = { ...PRICES };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await marketFixture(context, { prices, errors });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await context.route("https://api.hyperliquid.xyz/info", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type !== "metaAndAssetCtxs" || body.dex) return route.fallback();
    await held;
    const names = Object.keys(prices).filter((name) => !name.includes(":"));
    await route.fulfill({ json: [{ universe: names.map((name) => ({ name })) }, names.map((name) => ({ prevDayPx: String(prices[name] * .99), oraclePx: String(prices[name]) }))] });
  });
  const page = await context.newPage(); await page.goto(`${site}/trade`);
  await page.locator(".mcard").first().waitFor();
  assert.equal(await page.locator(".mcard").first().locator(".mcard-num .dim").count(), 1);
  await page.locator(".mcard").nth(5).getByText("+1.01%", { exact: true }).waitFor({ timeout: 1500 });
  console.log("PASS: a slow crypto reference does not hide the other markets' daily percentages.");
  release();
  await page.locator(".mcard").first().getByText("+1.01%", { exact: true }).waitFor({ timeout: 8000 });
  await page.locator(".board-chg").getByText("+1.01%", { exact: true }).waitFor();
  await page.locator(".quote").first().getByText("+1.01%", { exact: true }).waitFor();
  console.log("PASS: late daily references recover in the market rail, chart and header without reloading.");
  prices.BTC = 80800;
  await page.locator(".mcard").first().getByText("+2.02%", { exact: true }).waitFor();
  await page.locator(".board-chg").getByText("+2.02%", { exact: true }).waitFor();
  await page.locator(".quote").first().getByText("+2.02%", { exact: true }).waitFor();
  await page.locator(".mcard").nth(1).click(); await page.locator(".board-chg").getByText("+1.01%", { exact: true }).waitFor();
  await page.locator(".mcard").first().click(); await page.locator(".board-chg").getByText("+2.02%", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator(".board-chg").getByText("+2.02%", { exact: true }).waitFor();
  console.log("PASS: the daily percentage follows live ticks, pair switches and mobile layout.");
  await context.close();
  const retryContext = await browser.newContext(); await marketFixture(retryContext, { errors }); let attempts = 0;
  await retryContext.route("https://api.hyperliquid.xyz/info", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type !== "metaAndAssetCtxs" || body.dex) return route.fallback();
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    return route.fallback();
  });
  const retryPage = await retryContext.newPage(); await retryPage.goto(`${site}/trade`); await retryPage.locator(".mcard").first().waitFor();
  assert.equal(await retryPage.locator(".mcard").first().locator(".mcard-num .dim").count(), 1);
  await retryPage.locator(".mcard").first().getByText("+1.01%", { exact: true }).waitFor({ timeout: 22000 });
  assert.ok(attempts >= 2); assert.deepEqual(errors, []);
  console.log("PASS: a failed daily-reference request retries and restores the percentage without a reload.");
} finally { await browser.close(); }
