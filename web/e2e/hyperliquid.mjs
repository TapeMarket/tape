import assert from "node:assert/strict";
import { chromium } from "playwright";
import { marketFixture } from "./market-fixture.mjs";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

const site = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4173";
const local = process.argv.includes("--local");
const capture = process.argv.includes("--shots");
const browser = await chromium.launch();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  if (local) {
    await context.route(`${site}/**`, async (route) => {
      const url = new URL(route.request().url());
      const root = fileURLToPath(new URL(url.pathname.startsWith("/img/") ? "../public/" : "../dist/", import.meta.url));
      const name = /^\/(assets|img)\//.test(url.pathname) ? url.pathname.slice(1) : "index.html";
      const file = resolve(root, name);
      assert.ok(file.startsWith(resolve(root) + sep));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: "Missing asset" });
      return route.fulfill({ path: file });
    });
  }
  await marketFixture(context, { errors });
  const page = await context.newPage(); await page.goto(site);
  const credit = page.locator(".lp-data-credit"), logo = credit.locator("img");
  await logo.waitFor(); await page.waitForFunction(() => document.querySelector(".lp-data-credit img")?.naturalWidth > 0);
  const creditBox = await credit.boundingBox(), logoBox = await logo.boundingBox();
  assert.ok(logoBox.width >= 240); assert.ok(creditBox.y + creditBox.height <= 768, "Brand credit should be visible without scrolling");
  assert.equal(await credit.getAttribute("href"), "https://hyperliquid.xyz/");
  assert.equal(await page.locator(".lp-hyperliquid, .hl-live-price").count(), 0);
  assert.equal(await page.locator(".lp-hero").getByText(/\$[\d,]+/).count(), 0);
  await page.getByRole("button", { name: "Pause tape" }).click();
  assert.equal(await page.locator(".band-track").first().evaluate((el) => getComputedStyle(el).animationPlayState), "paused");
  await page.getByRole("button", { name: "Play tape" }).click();
  assert.equal(await page.locator(".band-track").first().evaluate((el) => getComputedStyle(el).animationPlayState), "running");
  console.log("PASS: large official Hyperliquid credit, brand-only hero and working motion controls.");
  await page.locator(".lp-cta").getByRole("link", { name: "Start trading" }).click();
  await page.locator(".mcard").nth(7).click();
  await page.locator(".board-sym").filter({ hasText: "TSLA" }).waitFor();
  assert.equal(await page.locator(".hl-context, .hl-metrics").count(), 0);
  assert.equal(await page.getByText("Hyperliquid market data ↗", { exact: true }).count(), 0);
  await page.getByText("Tape volume 24h", { exact: true }).waitFor();
  await page.locator(".board-oi").waitFor();
  if (capture) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: fileURLToPath(new URL("./shots/tape-only-trade-1366.png", import.meta.url)) });
  }
  console.log("PASS: pair switching preserves Tape's own volume and positions; external venue statistics are absent.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".mcard").first().click();
  await page.locator(".board-sym").filter({ hasText: "BTC" }).waitFor();
  assert.equal(await page.locator(".hl-context, .hl-metrics").count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  if (capture) await page.screenshot({ path: fileURLToPath(new URL("./shots/tape-only-trade-390.png", import.meta.url)) });
  await page.goto(site); await logo.waitFor();
  const mobileBox = await credit.boundingBox(); assert.ok(mobileBox.y + mobileBox.height <= 844);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const mobileShot = page.locator(".lp-frame-img img");
  await mobileShot.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector(".lp-frame-img img")?.currentSrc.includes("terminal-mobile.png"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.getByRole("button", { name: "Pause tape" }).isVisible(), false);
  assert.equal(await page.locator(".band-track").first().evaluate((el) => getComputedStyle(el).animationName), "none");
  console.log("PASS: mobile credit and app preview fit; pair changes and reduced-motion preferences work.");
  await context.close();

  assert.deepEqual(errors, []);
} finally { await browser.close(); }
