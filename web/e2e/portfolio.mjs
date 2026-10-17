// Real preview account flows with deterministic prices; no chain or real funds.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { marketFixture, PRICES } from "./market-fixture.mjs";
const site = process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:4173";
const capture = !process.argv.includes("--no-shots");
const browser = await chromium.launch(), errors = [], prices = { ...PRICES };
const shots = new URL("./shots/", import.meta.url); mkdirSync(shots, { recursive: true });
const fits = async (page) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await marketFixture(context, { prices, errors }); const page = await context.newPage();
  await page.goto(`${site}/trade`); await page.locator(".mcard").first().waitFor();
  await page.locator(".wallet-connect").click(); await page.getByRole("dialog").locator(".wallet-option").click();
  await page.locator("#margin").fill("100"); await page.locator("#leverage").fill("100"); await page.locator("#margin").click();
  await page.getByRole("button", { name: /^Long BTC/ }).click(); await page.locator(".strip").getByRole("button", { name: "Close", exact: true }).waitFor({ timeout: 15000 });
  await page.goto(`${site}/portfolio`); const row = page.locator(".book tbody tr").first(); await row.waitFor();
  await page.getByRole("tab", { name: "Open positions", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => new URLSearchParams(location.search).get('tab') === 'history');
  assert.equal(await page.getByRole("tab", { name: "Trade history", exact: true }).getAttribute("aria-selected"), "true");
  await page.keyboard.press("Home"); await row.waitFor();
  await row.getByRole("button", { name: "TP / SL", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Take profit and stop loss" });
  assert.equal(await dialog.getByLabel("Take-profit price").evaluate((el) => el === document.activeElement), true);
  await dialog.getByLabel("Take-profit price").fill("90000.12345678"); await dialog.getByLabel("Stop-loss price").fill("79900.12345678");
  await dialog.getByRole("button", { name: "Save", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  await row.getByRole("button", { name: /TP 90,000/ }).waitFor();
  assert.equal(await row.locator(".trigger-pop").evaluate((el) => el === document.activeElement), true);
  await row.locator(".trigger-pop").click(); await dialog.waitFor();
  assert.equal(await dialog.getByLabel("Take-profit price").inputValue(), "90000.12345678");
  assert.equal(await dialog.getByLabel("Stop-loss price").inputValue(), "79900.12345678");
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
  assert.equal(await row.locator(".trigger-pop").evaluate((el) => el === document.activeElement), true);
  console.log("PASS: Portfolio saves TP and SL, focuses the editor, and restores focus on Save and Escape.");
  await fits(page); if (capture) await page.screenshot({ path: fileURLToPath(new URL("portfolio-positions-desktop.png", shots)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await row.locator(".trigger-pop").scrollIntoViewIfNeeded(); await row.locator(".trigger-pop").click(); await dialog.waitFor();
  const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390);
  for (const field of ["Take-profit price", "Stop-loss price"]) {
    const input = await dialog.getByLabel(field).boundingBox(); assert.ok(input.x >= box.x && input.x + input.width <= box.x + box.width);
  }
  assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  await fits(page); if (capture) await page.screenshot({ path: fileURLToPath(new URL("portfolio-triggers-mobile.png", shots)), fullPage: true });
  await page.keyboard.press("Escape"); await page.setViewportSize({ width: 1440, height: 1000 });
  prices.BTC = 80080; await page.waitForFunction(() => document.querySelector('.book tbody tr')?.textContent?.includes('80,080'));
  await row.getByRole("button", { name: "Close", exact: true }).click(); await row.waitFor({ state: "detached", timeout: 15000 });
  await page.goto(`${site}/trade`); await page.locator(".mcard").nth(1).click();
  await page.locator("#margin").fill("100"); await page.locator("#leverage").fill("100"); await page.locator("#margin").click();
  await page.getByRole("button", { name: /^Long ETH/ }).click(); await page.locator(".strip").waitFor({ timeout: 15000 });
  await page.locator(".strip").getByRole("button", { name: "Close", exact: true }).click(); await page.locator(".strip").waitFor({ state: "detached", timeout: 15000 });
  await page.goto(`${site}/portfolio?tab=history`); await page.waitForFunction(() => document.querySelectorAll('.book tbody tr').length === 2);
  await page.getByLabel("History market").selectOption("0"); assert.equal(await page.locator(".book tbody tr").count(), 1);
  await page.getByLabel("History result").selectOption("wins"); assert.equal(await page.locator(".book tbody tr").count(), 1);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString("utf8"); assert.match(download.suggestedFilename(), /^tape-practice-trades-/);
  assert.equal(csv.trim().split("\r\n").length, 2); assert.ok(csv.includes('"BTC"')); assert.ok(!csv.includes('"ETH"'));
  await page.getByLabel("History result").selectOption("losses"); await page.getByText("No trades match these filters.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Export CSV" }).isDisabled(), true);
  await page.getByRole("button", { name: "Clear filters" }).click(); assert.equal(await page.locator(".book tbody tr").count(), 2);
  console.log("PASS: history filters, empty-state recovery and filtered CSV download work on a real practice account.");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 }); await fits(page);
    if (width < 1000) await page.locator(".history-tools").scrollIntoViewIfNeeded();
    if (capture) await page.screenshot({ path: fileURLToPath(new URL(`portfolio-history-${width}.png`, shots)), fullPage: true });
  }
  assert.deepEqual(errors, []); console.log("PASS: desktop, tablet and mobile fit without runtime errors.");
  await context.close();
} finally { await browser.close(); }
