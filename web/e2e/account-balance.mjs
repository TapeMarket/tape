// Actual wallet menu and withdrawal form; isolated account snapshots, no signing or fund movements.
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../", import.meta.url));
const deployment = JSON.parse(readFileSync(new URL("../../deployments/1.json", import.meta.url), "utf8"));
const owner = "0x1000000000000000000000000000000000000001";
const css = readFileSync(resolve(root, "dist/index.html"), "utf8").match(/href="(\/assets\/index-[^"]+\.css)"/)[1];
const bundled = await build({ stdin: { resolveDir: root, loader: "js", contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{TopBar,Dialogs}from'./src/components/Shell';import{setState,getState}from'./src/lib/store';
window.__set=setState;window.__get=getState;
setState({owner:'${owner}',account:{address:'${owner}',balance:'20000000',queued:'776100',marginInUse:'0',reserved:'0',positions:[],intents:[],wallet:{usdc:'0',eth:'0'}},config:{name:'Tape',chainId:1,markets:[],addresses:${JSON.stringify(deployment)}},path:'/trade'});
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(TopBar),React.createElement(Dialogs)));
` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@shared": fileURLToPath(new URL("../../shared", import.meta.url)) },
  define: { "import.meta.env": JSON.stringify({ VITE_PREVIEW: "0", VITE_API_URL: "https://api.tapemarket.io/v3" }), __MAINNET_DEPOSITS__: "null" }, logLevel: "silent",
  plugins: [{ name: "no-route-prefetch", setup(b) {
    b.onResolve({ filter: /(?:lib\/route-preload|\.\/route-preload)$/ }, () => ({ path: "preload", namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export function preloadRoute(){}", loader: "js" }));
  } }],
});
const browser = await chromium.launch();
const errors = [], writes = [];
try {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  await context.route("http://tape.test/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (!/^\/(assets|img)\//.test(path)) return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"><div id="root"></div>` });
    const base = resolve(root, path.startsWith("/img/") ? "public" : "dist"), file = resolve(base, path.slice(1));
    assert.ok(file.startsWith(base + sep));
    return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
  });
  await context.route("https://api.tapemarket.io/**", route => {
    if (route.request().method() !== "GET") writes.push(route.request().url());
    return route.fulfill({ status: 503, json: { error: "Isolated display fixture" } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://tape.test/trade");
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const total = () => page.locator(".wallet-text b").innerText();
  const patch = values => page.evaluate(values => window.__set({ account: { ...window.__get().account, ...values } }), values);
  const expectTotal = async value => {
    await page.waitForFunction(value => document.querySelector(".wallet-text b")?.textContent === value, value);
    assert.equal(await total(), value);
  };
  const row = label => page.getByRole("group", { name: "Balance breakdown" }).locator("dl > div").filter({ has: page.locator("dt", { hasText: label }) }).locator("dd");
  mkdirSync(resolve(root, "e2e/shots"), { recursive: true });
  for (const [width, height] of [[1366, 900], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    await expectTotal("$20.78");
    assert.equal(await page.locator(".wallet-queue-label").innerText(), "$0.78 queued");
    await page.locator(".wallet-main").click();
    const menu = page.getByRole("menu"), box = await menu.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `menu overflow at ${width}`);
    assert.equal(await row("Available to withdraw").innerText(), "$20.00");
    assert.equal(await row("Queued winnings").innerText(), "$0.78");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(root, `e2e/shots/account-balance-${width}.png`) });
    await page.keyboard.press("Escape");
  }
  console.log("PASS: total $20.78 includes the queued $0.78, with $20 available; menu and header fit desktop/390/320.");
  await page.locator(".wallet-withdraw").click();
  const dialog = page.getByRole("dialog", { name: "Withdraw USDC" });
  await dialog.getByLabel("Amount in USDC").fill("20.78");
  assert.equal(await dialog.getByRole("button", { name: "Withdraw", exact: true }).isDisabled(), true);
  await dialog.getByRole("button", { name: "Max", exact: true }).click();
  assert.equal(await dialog.getByLabel("Amount in USDC").inputValue(), "20");
  await page.keyboard.press("Escape");
  await patch({ balance: "20776100", queued: "0" }); await expectTotal("$20.78");
  assert.equal(await page.locator(".wallet-queue-label").count(), 0);
  console.log("PASS: queued funds cannot be withdrawn early; paying the queue preserves the total without double-counting or losing a cent.");
  await patch({ balance: "20000000", queued: "776100", reserved: "5000000" }); await expectTotal("$20.78");
  await page.locator(".wallet-main").click();
  assert.equal(await row("Available to withdraw").innerText(), "$15.00");
  assert.equal(await row("Pending orders").innerText(), "$5.00"); await page.keyboard.press("Escape");
  await patch({ balance: "0", marginInUse: "20000000", reserved: "0" }); await expectTotal("$20.78");
  await page.locator(".wallet-main").click();
  assert.equal(await row("In open positions").innerText(), "$20.00"); await page.keyboard.press("Escape");
  await patch({ balance: "20000000", marginInUse: "776100", queued: "0" }); await expectTotal("$20.78");
  await patch({ balance: "0", marginInUse: "0", queued: "776100" }); await expectTotal("$0.78");
  await page.locator(".wallet-withdraw").click();
  assert.equal(await dialog.getByRole("button", { name: "Max", exact: true }).isDisabled(), true);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__set({ account: null })); await expectTotal("—");
  assert.equal(await page.locator(".wallet-queue-label").count(), 0);
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log("PASS: pending orders, posted cash/debt margin, all-queued accounts and loading state preserve truthful totals; no writes or browser errors.");
} finally { await browser.close(); }
