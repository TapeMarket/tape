// Isolated real components: referral recovery, ranking races, keyboard layout and docs navigation.
// These fixtures never enter the deployed API or the practice exchange.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const site = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4173";
const shots = process.argv.includes("--shots");
const root = fileURLToPath(new URL("../", import.meta.url));
const css = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8").match(/href="(\/assets\/index-[^"]+\.css)"/)[1];
const api = "https://api.tapemarket.io";
const [config, house, series] = await Promise.all(["config", "house", "series"].map(async (path) => (await fetch(`${api}/${path}`)).json()));
const owner = "0x1111111111111111111111111111111111111111", trader = "0x2222222222222222222222222222222222222222";
const fixture = { config, house, series: Array.isArray(series) ? series : series.points ?? [],
  refs: { code: "Alice", shareOfFeeBps: 2500, earned: "25000000", paid: "10000000", names: { [trader]: "Bob" }, referred: [{ address: trader, trades: 12, volume: "100000000000", fees: "100000000", reward: "25000000" }] },
  board: { positions: [], accounts: [{ address: owner, pnl: "25000000", volume: "100000000000", trades: 10, wins: 7, busts: 1 }, { address: trader, pnl: "10000000", volume: "50000000000", trades: 5, wins: 3, busts: 1 }], names: { [owner]: "Alice", [trader]: "Bob" } },
};
const bundle = await build({ stdin: { resolveDir: root, loader: "js", contents: `
  import React from 'react';import {createRoot} from 'react-dom/client';
  import {Referrals} from './src/pages/Referrals';import {Leaderboard} from './src/pages/Leaderboard';import {Dashboard} from './src/pages/Dashboard';import {Docs} from './src/pages/Docs';import {Vault} from './src/pages/Vault';import {Jackpot} from './src/pages/Jackpot';import {Staking} from './src/pages/Staking';
  import {setState} from './src/lib/store';
  window.__fixture=${JSON.stringify(fixture)};window.__failRefs=true;window.__failBoard=false;window.__failHistory=false;window.__boardDelays={};window.__boardRequests=[];window.__set=setState;
  setState({config:window.__fixture.config,house:window.__fixture.house,series:window.__fixture.series,owner:'${owner}',account:{name:'Alice'},coin:{attached:false}});
  const app=createRoot(document.getElementById('root'));const pages={Referrals,Leaderboard,Dashboard,Docs,Vault,Jackpot,Staking};
  window.__render=(name)=>app.render(React.createElement('div',{className:'app'},React.createElement('main',{className:'page'},React.createElement(pages[name]))));window.__render('Referrals');
` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", alias: { "@shared": fileURLToPath(new URL("../../shared", import.meta.url)) }, define: { "import.meta.env": '{"VITE_PREVIEW":"0","VITE_API_URL":"https://api.tapemarket.io"}', "__MAINNET_DEPOSITS__": "null" }, logLevel: "silent",
  plugins: [{ name: "page-fixtures", setup(builder) {
    // This harness mounts individual pages; full application navigation is covered by loading.mjs.
    builder.onResolve({ filter: /(?:lib\/route-preload|\.\/route-preload)$/ }, () => ({ path: "page-preload", namespace: "fixture-preload" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-preload" }, () => ({ contents: "export function preloadRoute(){}" }));
    builder.onResolve({ filter: /(?:lib\/api|\.\/api)$/ }, (args) => /(?:(?:pages[\\/](?:Referrals|Leaderboard|Docs|Jackpot|Staking)|components[\\/](?:Panels|Season))\.tsx|lib[\\/]actions\.ts)$/.test(args.importer) ? { path: "page-api", namespace: "fixture" } : undefined);
    builder.onResolve({ filter: /(?:lib\/wallet|\.\/wallet)$/ }, () => ({ path: "page-wallet", namespace: "fixture-wallet" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-wallet" }, () => ({ loader: "js", contents: `
      export const getSigner=()=>({address:'${owner}',async signMessage(message){window.__signed=message;await new Promise(r=>setTimeout(r,window.__signDelay??0));if(window.__denySign)throw {code:4001};return '0x'+'11'.repeat(65);}});
      export const explainWalletError=e=>e.code===4001?'You declined the request in your wallet.':e.message;
      export function connectWith(){}export function disconnect(){}export const walletOptions=()=>[];
    ` }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `
      export async function get(){if(window.__failRefs)throw Error('Offline');return window.__fixture.refs;}
      export class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}
      export async function post(path,body){if(path!=='/referral-code')throw Error('Unexpected test write');window.__claimPosts=(window.__claimPosts??0)+1;window.__claimBody=body;if(window.__claimError)throw new ApiError(window.__claimError,409);window.__fixture.refs.code=body.code;window.__fixture.refs.customCode=body.code;return {ok:true,code:body.code};}
      export async function loadLeaderboard(period){window.__boardRequests.push(period);const result={...structuredClone(window.__fixture.board),window:period};await new Promise(r=>setTimeout(r,window.__boardDelays[period]??0));if(window.__failBoard)throw Error('Offline');return result;}
      export async function loadSeason(){return null;}export async function loadJackpot(){return null;}
      export async function loadHouse(){window.__set({house:window.__fixture.house});}export async function loadCoin(){window.__set({coin:{attached:false}});}
      export async function loadSeries(){if(window.__failHistory)throw Error('Offline');window.__set({series:window.__fixture.series});}export async function loadAccount(){}
      export async function loadHistory(){}export function refreshAccountSoon(){}
      export async function loadPrices(){return {points:[]};}export function onTick(){return ()=>{};}
    ` }));
  } }],
});
const browser = await chromium.launch();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Serve the exact built stylesheet/assets even when no separate preview server is running.
  for (const prefix of ["assets", "img"]) await context.route(`${site}/${prefix}/**`, route => {
    const base = resolve(root, prefix === "img" ? "public" : "dist");
    const file = resolve(base, new URL(route.request().url()).pathname.slice(1));
    assert.ok(file.startsWith(base + sep));
    return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
  });
  await context.route(`${site}/__pages-test`, (route) => route.fulfill({ contentType: "text/html", body: `<link rel="stylesheet" href="${css}"><div id="root"></div>` }));
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${site}/__pages-test`); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator('.hero-figs dd').nth(2).innerText(), "–");
  await page.evaluate(() => { window.__failRefs = false; });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.locator('.hero-figs dd').nth(2).getByText("$25.00", { exact: true }).waitFor();
  assert.match(await page.getByLabel("Your referral link").inputValue(), /\?ref=Alice$/);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(Error('Denied')) } }));
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await page.getByRole("status").getByText(/Couldn’t copy automatically/).waitFor();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } }));
  await page.getByRole("button", { name: "Copy link", exact: true }).click(); await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.match(await page.evaluate(() => window.__copied), /\?ref=Alice$/);
  console.log("PASS: referrals distinguish unavailable totals from zero, retry correctly, copy links and recover from denied clipboard access.");

  const custom = page.getByLabel('Create a custom referral code', {exact:true});
  const create = page.getByRole('button', {name:'Create custom link',exact:true});
  await custom.fill('not valid!'); assert.equal(await create.isDisabled(), true);
  await custom.fill('My_Custom'); assert.equal(await custom.inputValue(), 'my_custom');
  await page.evaluate(() => { window.__denySign=true; });
  await create.click(); await page.getByRole('alert').getByText('You declined the request in your wallet.',{exact:true}).waitFor();
  assert.match(await page.getByLabel('Your referral link').inputValue(), /\?ref=Alice$/);
  await page.evaluate(() => { window.__denySign=false;window.__claimError='That referral code is taken. Try another.'; });
  await create.click(); await page.getByRole('alert').getByText(/That referral code is taken/).waitFor();
  await page.evaluate(() => { window.__claimError=null; });
  await custom.fill('My_Community'); await create.click();
  await page.getByText('my_community',{exact:true}).waitFor();
  assert.match(await page.getByLabel('Your referral link').inputValue(), /\?ref=my_community$/);
  assert.equal(await page.evaluate(() => window.__claimBody.code), 'my_community');
  assert.match(await page.evaluate(() => window.__signed), new RegExp('Chain: 1\\nExchange: '+config.addresses.exchange.toLowerCase()));
  assert.equal(await page.evaluate(() => window.__fixture.refs.customCode), 'my_community');
  await page.evaluate(() => window.__render('Docs')); await page.getByRole('heading',{name:'Docs',exact:true}).waitFor();
  await page.evaluate(() => window.__render('Referrals')); await page.getByText('my_community',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Create a custom referral code',{exact:true}).count(), 0);
  // Disconnecting while the wallet popup is open must never submit a claim for a stale account.
  await page.evaluate(() => { window.__fixture.refs.customCode=null;window.__fixture.refs.code='Alice';window.__render('Docs'); });
  await page.getByRole('heading',{name:'Docs',exact:true}).waitFor();
  await page.evaluate(() => { window.__render('Referrals');window.__signDelay=400; });
  const beforePosts=await page.evaluate(() => window.__claimPosts);
  await page.getByLabel('Create a custom referral code',{exact:true}).fill('another_code'); await create.click();
  await page.evaluate(() => window.__set({owner:null})); await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__claimPosts),beforePosts);
  await page.evaluate(() => {window.__signDelay=0;window.__set({owner:'${owner}'});});
  await page.getByLabel('Create a custom referral code',{exact:true}).waitFor();
  console.log('PASS: custom links validate, recover wallet rejection and taken codes, persist without a username change, and discard stale-wallet claims.');

  await page.evaluate(() => window.__render('Leaderboard'));
  await page.getByRole("button", { name: "Traders", exact: true }).click(); await page.locator('.lb-accounts .lb-row').first().waitFor();
  await page.getByLabel("Search name or address").fill("ALICE"); assert.equal(await page.locator('.lb-accounts .lb-row').count(), 1);
  await page.getByLabel("Search name or address").fill("nobody"); await page.getByRole("button", { name: "Clear search", exact: true }).click();
  assert.equal(await page.locator('.lb-accounts .lb-row').count(), 2);
  await page.evaluate(() => { window.__boardDelays['7d'] = 700; window.__failBoard = true; });
  await page.getByRole("button", { name: "7d", exact: true }).click();
  await page.getByText("Loading the board…", { exact: true }).waitFor(); assert.equal(await page.locator('.podium .step').count(), 0);
  await page.getByRole("alert").waitFor();
  await page.evaluate(() => { window.__failBoard = false; window.__boardDelays['7d'] = 0; });
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await page.locator('.lb-accounts .lb-row').first().waitFor();
  await page.evaluate(() => { window.__boardDelays['7d'] = 700; window.__fixture.board.accounts[0].pnl = '999000000'; });
  await page.getByRole("button", { name: "24h", exact: true }).click(); await page.locator('.lb-accounts .lb-row').first().waitFor();
  await page.getByRole("button", { name: "7d", exact: true }).click();
  await page.evaluate(() => { window.__fixture.board.accounts[0].pnl = '25000000'; });
  await page.getByRole("button", { name: "30d", exact: true }).click(); await page.locator('.lb-accounts .lb-row').first().waitFor();
  await page.waitForTimeout(800); assert.match(await page.locator('.lb-accounts .lb-row').first().innerText(), /\$25\.00/);
  console.log("PASS: leaderboard search is case-insensitive, empty searches recover, failed periods retry and late old-period replies are discarded.");

  await page.evaluate(() => window.__render('Dashboard'));
  await page.locator('.dash .widget').first().waitFor();
  const titles = () => page.locator('.dash .widget').evaluateAll((items) => items.map((item) => item.querySelector('.close-x').getAttribute('aria-label')));
  const initial = await titles();
  const move = page.getByRole("button", { name: "Move Vault value later", exact: true }); await move.focus(); await page.keyboard.press('Enter');
  assert.equal((await titles())[1], initial[0]);
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('tape:dash:v1'))); assert.equal(saved.view, 'custom'); assert.equal(saved.custom[1], 'house-funds');
  await page.evaluate(() => window.__render('Docs')); await page.getByRole('heading', {name:'Docs',exact:true}).waitFor();
  await page.evaluate(() => window.__render('Dashboard')); await page.getByRole('heading', {name:'Dashboard',exact:true}).waitFor();
  assert.equal((await titles())[1], initial[0]);
  await page.getByRole("button", { name: "Clear", exact: true }).click(); await page.getByRole("button", { name: "Restore overview", exact: true }).click();
  assert.equal(await page.locator('.dash .widget').count(), 9);
  console.log("PASS: dashboard keyboard reorder persists the exact order; clear and overview recovery work.");

  await page.evaluate(() => { window.__failHistory = true; window.__render('Vault'); }); await page.getByRole('alert').waitFor();
  await page.evaluate(() => { window.__failHistory = false; }); await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.getByRole('alert').waitFor({ state: 'detached' });
  console.log("PASS: vault retains available figures and recovers failed chart history.");

  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => window.__render('Docs'));
  const contents = page.locator('.docs-toc details'); assert.equal(await contents.getAttribute('open'), null);
  await page.getByText('On this page', { exact: true }).click(); await page.locator('.docs-toc').getByRole('link', { name: 'Risks', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#risks');
  assert.equal(await contents.getAttribute('open'), null);
  await page.waitForFunction(() => { const rect = document.querySelector('#risks').getBoundingClientRect(); return rect.top >= 0 && rect.top < 300; });
  assert.equal(await page.locator('.docs-toc a[href="#risks"]').getAttribute('aria-current'), 'location');
  console.log("PASS: mobile docs collapse their contents, navigate to the requested section and mark it current.");

  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ['Referrals', 'Leaderboard', 'Jackpot', 'Staking', 'Docs']) {
      await page.evaluate((name) => { history.replaceState(null, '', location.pathname); document.querySelector('.page').scrollTop = 0; window.__render(name); }, name);
      await page.waitForFunction((name) => document.querySelector('.hero h1')?.textContent === (name === 'Jackpot' ? 'Rekt Jackpot' : name), name); await page.evaluate(() => document.fonts.ready);
      if (name === 'Leaderboard') { await page.getByRole('button', {name:'Traders',exact:true}).click(); await page.locator('.lb-accounts .lb-row').first().waitFor(); }
      const overflow = await page.evaluate(() => [...document.querySelectorAll(".page *")].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(el => ({ tag: el.tagName, class: el.className, right: Math.round(el.getBoundingClientRect().right) })));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} overflow at ${width}: ${JSON.stringify(overflow)}`);
      if (shots && width !== 320) { await page.waitForTimeout(250); await page.screenshot({ path: fileURLToPath(new URL(`./shots/platform-${name.toLowerCase()}-${width}.png`, import.meta.url)) }); }
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: populated and pending pages fit desktop, tablet and small phones without browser exceptions.");
} finally { await browser.close(); }
