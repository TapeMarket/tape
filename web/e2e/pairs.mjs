// Exercise the published site's real price feed and cached charts; no wallet connection or orders.
import { chromium } from "playwright";
import assert from "node:assert/strict";
const site = process.argv[2] ?? "https://tapemarket.io";
const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /^Error:/.test(message.text())) errors.push(message.text()); });
  const response = await page.goto(`${site}/trade`);
  assert.equal(response.status(), 200);
  await page.locator(".mcard").first().waitFor();
  await page.waitForFunction(() => document.querySelector(".board-px")?.textContent !== "–");
  await page.waitForTimeout(2500);
  for (const step of ["0", "15", "60", "300", "0"]) {
    await page.getByLabel("Chart step").selectOption(step);
    for (const symbol of ["ETH", "SOL", "XRP", "DOGE", "GOLD", "SPX", "TSLA", "NVDA", "AAPL", "BTC"]) {
      await page.locator(".mcard").filter({ has: page.locator(".mcard-name b", { hasText: symbol }) }).click();
      await page.waitForFunction((s) => document.querySelector(".board-sym")?.textContent?.includes(s), symbol);
      await page.waitForTimeout(150);
      assert.equal(await page.getByText("The page stopped working in this tab.").count(), 0, `${symbol}, step ${step}`);
    }
    console.log(`PASS: all 10 pairs at chart step ${step}`);
  }
  for (const route of ["/vault", "/staking", "/leaderboard", "/trade"]) {
    await page.locator(`a[href='${route}']`).first().click();
    await page.waitForFunction((path) => location.pathname === path && (document.querySelector("main")?.innerText.length ?? 0) > 40, route);
    assert.equal(await page.getByText("The page stopped working in this tab.").count(), 0, route);
  }
  for (const route of ["/trade", "/vault", "/staking", "/leaderboard", "/docs", "/jackpot"]) {
    const direct = await page.goto(`${site}${route}`);
    assert.equal(direct.status(), 200, route);
    await page.waitForFunction(() => (document.querySelector("main")?.innerText.length ?? 0) > 40);
    assert.equal(await page.getByText("The page stopped working in this tab.").count(), 0, route);
  }
  assert.deepEqual(errors, [], "browser runtime errors");
  console.log(`PASS: live pair switches, navigation links and direct links at ${site}`);
} finally {
  await browser.close();
}
