import assert from "node:assert/strict";
import { chromium } from "playwright";
import { marketFixture } from "./market-fixture.mjs";
const site = process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:4173";
const browser = await chromium.launch(), errors = [], paused = new Set();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await marketFixture(context, { paused, errors }); const page = await context.newPage();
  await page.goto(`${site}/trade`); await page.locator(".mcard").first().waitFor();
  await page.locator(".wallet-connect").click(); await page.getByRole("dialog").locator(".wallet-option").click();
  await page.locator(".mcard").nth(1).click(); await page.getByRole("button", { name: /^Long ETH/ }).waitFor();
  paused.add("ETH");
  await page.getByRole("button", { name: "Waiting for live prices", exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await page.locator(".slip-go").isDisabled(), true);
  await page.locator(".mcard").nth(0).click(); assert.equal(await page.getByRole("button", { name: /^Long BTC/ }).isEnabled(), true);
  await page.locator(".mcard").nth(1).click(); assert.equal(await page.locator(".slip-go").isDisabled(), true);
  paused.delete("ETH"); await page.getByRole("button", { name: /^Long ETH/ }).waitFor();
  console.log("PASS: silent ETH disables only ETH, active BTC still trades, and ETH recovers.");
  await page.goto(`${site}/docs`); await page.locator(".page .sheet").waitFor();
  await page.locator(".page").evaluate((el) => { el.scrollTop = 800; });
  assert.ok(await page.locator(".page").evaluate((el) => el.scrollTop > 100));
  await page.locator(".top-nav").getByRole("link", { name: "Trade", exact: true }).click();
  await page.locator(".mcard").first().waitFor(); assert.equal(await page.locator(".page").evaluate((el) => el.scrollTop), 0);
  console.log("PASS: long-page navigation restores the top of the next page.");
  await page.goto(`${site}/status`); await page.locator('[title*="Source: Hyperliquid, preview"]').waitFor();
  assert.deepEqual(errors, []); console.log("PASS: Status names Hyperliquid and no runtime errors occurred.");
  await context.close();
} finally { await browser.close(); }
