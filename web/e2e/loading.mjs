// Loading boundaries and client-side navigation against the real, read-only Ethereum API.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";

const site = (process.argv.find(a => a.startsWith("http")) ?? "https://tapemarket.io").replace(/\/$/, "");
const local = process.argv.includes("--local");
const output = process.argv.find(a => a.startsWith("--output="))?.slice(9);
const browser = await chromium.launch();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(() => {
    window.__pairFrames = [];
    document.addEventListener("click", event => {
      if (!event.target.closest?.(".mcard")) return;
      const start = event.timeStamp;
      requestAnimationFrame(() => requestAnimationFrame(() => window.__pairFrames.push(performance.now() - start)));
    }, true);
  });
  if (local) await context.route(`${site}/**`, async route => {
    const url = new URL(route.request().url());
    const root = fileURLToPath(new URL(url.pathname.startsWith("/img/") ? "../public/" : "../dist/", import.meta.url));
    const file = resolve(root, /^\/(assets|img)\//.test(url.pathname) ? url.pathname.slice(1) : "index.html");
    assert.ok(file.startsWith(resolve(root) + sep));
    return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: "Missing asset" });
  });
  const page = await context.newPage(), requests = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", request => requests.push({ url: request.url(), body: request.postData(), document: request.isNavigationRequest() }));
  await page.goto(`${site}/?ref=SpeedCheck`);
  await page.locator(".lp-hero h1").waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => localStorage.getItem("tape:ref")), "speedcheck");
  assert.ok(!requests.some(r => /\/assets\/(viem|charts|Trade|Shell|ExchangeApp|Deposit|DepositQR)-/.test(r.url)));
  assert.ok(!requests.some(r => r.body?.includes("candleSnapshot") || new URL(r.url).pathname === "/stream"));
  console.log("PASS: landing captures referrals without loading wallets, charts, market history or the trading stream.");

  await page.locator(".lp-hero").getByRole("link", { name: "Start trading" }).hover();
  await page.waitForFunction(() => performance.getEntriesByType("resource").some(r => /\/assets\/Trade-.*\.js$/.test(r.name)));
  await page.locator(".lp-hero").getByRole("link", { name: "Start trading" }).click();
  await page.locator(".tt-chart canvas").first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".mcard-num span").length === 10 && [...document.querySelectorAll(".mcard-num span")].every(el => /\d/.test(el.textContent)));
  await page.evaluate(() => { window.__navigationMarker = true; });
  for (const name of ["Vault", "Jackpot", "Leaderboard", "Stats"]) {
    await page.locator(".top-nav").getByRole("link", { name, exact: true }).click();
    await page.locator(".page .hero").waitFor();
    assert.equal(await page.evaluate(() => window.__navigationMarker), true);
    assert.ok(await page.locator(".top").isVisible());
  }
  for (const name of ["Dashboard", "Referrals", "Docs", "Status"]) {
    await page.locator(".top-nav").getByRole("button", { name: "More", exact: true }).click();
    await page.locator(".top-nav").getByRole("link", { name, exact: true }).click();
    await page.locator(".page .hero").waitFor();
    assert.equal(await page.evaluate(() => window.__navigationMarker), true);
  }
  await page.locator(".top-nav").getByRole("link", { name: "Trade", exact: true }).click();
  await page.locator(".tt-chart canvas").first().waitFor();
  await page.goBack(); await page.locator(".page .hero").waitFor();
  await page.goForward(); await page.locator(".tt-chart canvas").first().waitFor();
  assert.equal(requests.filter(r => r.document).length, 1);
  assert.equal(requests.filter(r => new URL(r.url).pathname === "/stream").length, 1);
  console.log("PASS: hover preloads the exchange; eight supporting pages and back/forward navigation preserve the shell and one live stream.");

  // Measure from the actual click event rather than including Playwright's pointer positioning
  // and element-stability waits. This is a lab frame measurement, not field INP.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  for (const index of [1, 3, 7, 0, 8, 2, 0]) {
    await page.locator(".mcard").nth(index).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  const pairFrames = await page.evaluate(() => window.__pairFrames);
  assert.equal(pairFrames.length, 7);
  assert.ok(Math.max(...pairFrames) < 200, `Pair input-to-frame under 4x CPU: ${pairFrames}`);
  if (output) writeFileSync(output, `${JSON.stringify({ cpuSlowdown: 4, pairInputToFrameMs: pairFrames }, null, 2)}\n`);
  console.log(`PASS: seven pair clicks reach the next painted frame in ${Math.round(Math.max(...pairFrames))}ms or less under 4x CPU slowdown (lab, not field INP).`);

  const docs = await context.newPage(), docScripts = [];
  docs.on("pageerror", e => errors.push(e.message));
  docs.on("request", r => { if (r.url().includes("/assets/")) docScripts.push(r.url()); });
  await docs.goto(`${site}/docs`); await docs.locator(".page .hero").waitFor();
  assert.ok(!docScripts.some(url => /\/assets\/(charts|Chart|Trade)-/.test(url)));
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await docs.route("**/assets/Stats-*.js", async route => { await pending; return route.fallback(); });
  await docs.locator(".top-nav").getByRole("link", { name: "Stats", exact: true }).click();
  await docs.getByText("Loading page…", { exact: true }).waitFor();
  await docs.locator(".wallet-connect").click();
  await docs.getByRole("dialog", { name: "Connect a wallet" }).waitFor();
  await docs.keyboard.press("Escape");
  release(); await docs.locator(".page .hero h1").getByText("Stats", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: direct Docs avoids chart code; a slow page download keeps navigation/wallet controls responsive; no browser exceptions.");
  await context.close();
} finally { await browser.close(); }
