// Real Stats component, isolated API fixtures. No fabricated activity enters the preview engine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
const site = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4173";
const shots = process.argv.includes("--shots");
const capture = async (page, name) => {
  // Expand only the screenshot document so an inner scrolling page can be inspected in full.
  const style = await page.addStyleTag({ content: 'html,body,#root {height:auto!important}.app {height:auto!important;min-height:100vh}.page {overflow:visible!important}' });
  await page.screenshot({ path: fileURLToPath(new URL(`./shots/${name}.png`, import.meta.url)), fullPage: true });
  await style.evaluate((el) => el.remove());
};
const root = fileURLToPath(new URL("../", import.meta.url));
const css = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8").match(/href="(\/assets\/index-[^"]+\.css)"/)[1];
const now = Math.floor(Date.now() / 1000);
const symbols = ["BTC", "ETH", "SOL", "XRP", "DOGE", "GOLD", "SPX", "TSLA", "NVDA", "AAPL"];
const money = (n) => String(BigInt(Math.round(n * 1e6)));
const marketVolumes = [750000, 350000, 150000, 0, 0, 0, 0, 0, 0, 0];
const markets = symbols.map((symbol, id) => ({ id, symbol, oiLong: money(id === 0 ? 12000 : id === 1 ? 8000 : 0), oiShort: money(id === 0 ? 8000 : id === 1 ? 2000 : 0) }));
const fixture = {
  house: { house: { treasury: money(50000) }, markets, totals: { volume: money(1250000), volumeByMarket: marketVolumes.map(money), bustVolume: money(60000), trades: 128, traders: 38, pnl: money(-2000) } },
  coin: { attached: true, stakingState: { totalReceived: money(5000) } },
  series: Array.from({ length: 97 }, (_, i) => {
    const f = i / 96;
    return { t: now - (96 - i) * 900, vol: f * 1250000, volm: marketVolumes.map((v) => v * f), oi: symbols.map((_, id) => [id === 0 ? 12000 * f : id === 1 ? 8000 * f : 0, id === 0 ? 8000 * f : id === 1 ? 2000 * f : 0]), pnl: -2000 * f, tvl: 50000 * f, paid: 5000 * f, users: Math.round(38 * f) };
  }),
};
const built = await build({
  stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {Stats} from './src/pages/Stats';import {setState} from './src/lib/store';
    window.__stats=${JSON.stringify(fixture)};window.__requests=[];window.__failHistory=false;window.__delay=0;
    window.__setStats=(patch)=>setState(patch);setState({config:{markets:window.__stats.house.markets}});
    createRoot(document.getElementById('root')).render(React.createElement('div',{className:'app'},React.createElement('main',{className:'page'},React.createElement(Stats))));`, resolveDir: root, loader: "js" },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", alias: { "@shared": fileURLToPath(new URL("../../shared", import.meta.url)) }, define: { "import.meta.env": '{"VITE_PREVIEW":"1"}', "__MAINNET_DEPOSITS__": "null" }, logLevel: "silent",
  plugins: [{ name: "stats-fixture", setup(builder) {
    builder.onResolve({ filter: /lib\/api$/ }, (args) => args.importer.endsWith("pages/Stats.tsx") || args.importer.endsWith("pages\\Stats.tsx") ? { path: "stats-api", namespace: "fixture" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      async function load(key){window.__requests.push(key);await new Promise(r=>setTimeout(r,window.__delay));if(key==='history'&&window.__failHistory)throw Error('Offline');window.__setStats(key==='history'?{series:window.__stats.series}:{[key]:window.__stats[key]});}
      export const loadHouse=()=>load('house');export const loadCoin=()=>load('coin');export const loadSeries=()=>load('history');`, loader: "js" }));
  } }],
});
const browser = await chromium.launch();
try {
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route(`${site}/__stats-test`, (route) => route.fulfill({ contentType: "text/html", body: `<link rel="stylesheet" href="${css}"><div id="root"></div>` }));
  const page = await context.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${site}/__stats-test`); await page.addScriptTag({ content: built.outputFiles[0].text });
  await page.locator(".stats-summary").getByText("$1.25M", { exact: true }).waitFor({ timeout: 5000 }).catch(async (error) => { console.log({ errors, requests: await page.evaluate(() => window.__requests), content: (await page.locator("body").innerText()).slice(0, 1000) }); throw error; });
  await page.locator(".stats-chart canvas").first().waitFor();
  assert.equal(await page.locator(".stats-chart").count(), 6);
  assert.equal(await page.locator(".stats-markets tbody tr").count(), 10);
  await page.getByLabel("Chart market").selectOption("0");
  assert.equal(await page.getByRole("region", { name: "BTC volume", exact: true }).locator("header b").innerText(), "$750.0K");
  assert.equal(await page.getByRole("region", { name: "BTC open interest", exact: true }).locator("header b").innerText(), "$20.0K");
  await page.getByRole("button", { name: "Show ETH charts", exact: true }).click();
  assert.equal(await page.getByRole("region", { name: "ETH volume", exact: true }).locator("header b").innerText(), "$350.0K");
  assert.equal(await page.getByRole("region", { name: "ETH open interest", exact: true }).locator("header b").innerText(), "$10.0K");
  for (const name of ["1h", "6h", "All", "24h"]) {
    const button = page.getByRole("button", { name, exact: true }); await button.click(); assert.equal(await button.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".stats-summary").getByText("$1.25M", { exact: true }).count(), 1);
  }
  await page.getByLabel("Chart market").selectOption("-1");
  console.log("PASS: six charts, ten market rows, exact market totals, shared ranges and unchanged all-time headlines.");
  await page.evaluate(() => { window.__failHistory = true; });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("alert").waitFor(); assert.equal(await page.locator(".stats-chart canvas").count() > 0, true);
  await page.evaluate(() => { window.__failHistory = false; window.__delay = 150; });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Refreshing…", exact: true }).waitFor();
  await page.getByRole("alert").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  console.log("PASS: failed refresh preserves figures and charts; retry recovers with a disabled loading state.");
  if (shots) { await page.evaluate(() => document.fonts.ready); await capture(page, "stats-final-populated-desktop"); }
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: width === 768 ? 1024 : 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const button = page.getByRole("button", { name: "Show BTC charts", exact: true }); await button.focus(); await page.keyboard.press("Enter");
    assert.equal(await page.getByLabel("Chart market").inputValue(), "0");
    await page.getByLabel("Chart market").selectOption("-1");
    if (shots) { await page.evaluate(() => document.querySelector(".page").scrollTo(0, 0)); await capture(page, `stats-final-populated-${width}`); }
  }
  console.log("PASS: tablet, mobile and small-phone layouts fit; market selection works with keyboard input.");
  await page.evaluate(() => { window.__stats.series = []; window.__setStats({ series: [] }); });
  await page.locator(".stats-chart").first().getByText(/Collecting samples/).waitFor();
  assert.equal(await page.locator(".stats-chart canvas").count(), 0);
  await page.evaluate(() => { window.__failHistory = true; }); await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("region", { name: "Total volume", exact: true }).getByText(/History is unavailable/).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: missing and failed history have explicit empty/error states and no fabricated chart data.");
} finally { await browser.close(); }
