// Real migration UI with isolated balances. No signing, API mutations, or funds.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const deployment = JSON.parse(readFileSync(new URL('../../deployments/1.json', import.meta.url), 'utf8'));
const owner = '0x1000000000000000000000000000000000000001';
const other = '0x2000000000000000000000000000000000000002';
const css = readFileSync(resolve(root, 'dist/index.html'), 'utf8').match(/href="(\/assets\/index-[^"]+\.css)"/)[1];
const result = await build({ stdin: { resolveDir: root, loader: 'js', contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{PreviousExchange,RecoveryBanner}from'./src/components/PreviousExchange';import{TopBar,Dialogs}from'./src/components/Shell';
import{LEGACY,API_URL}from'./src/lib/mode';import{setState,getState}from'./src/lib/store';
window.__set=setState;window.__get=getState;window.__api=API_URL;
setState({owner:'${owner}',account:{address:'${owner}',balance:LEGACY?'5991':'25000000',reserved:'0',positions:[],wallet:{usdc:'0',eth:'0'}},config:{name:'Tape',chainId:1,markets:[],addresses:${JSON.stringify(deployment)},previousExchange:${JSON.stringify(deployment.previousExchange)},previousExchanges:${JSON.stringify(deployment.previousExchanges)}},path:'/trade'});
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(TopBar),React.createElement(RecoveryBanner),React.createElement(PreviousExchange),React.createElement(Dialogs)));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@shared': fileURLToPath(new URL('../../shared', import.meta.url)) }, define: { 'import.meta.env': JSON.stringify({ VITE_PREVIEW: '0', VITE_API_URL: 'https://api.tapemarket.io/v2' }), __MAINNET_DEPOSITS__: 'null' }, logLevel: 'silent', plugins: [{ name: 'no-route-prefetch', setup(b) { b.onResolve({ filter: /(?:lib\/route-preload|\.\/route-preload)$/ }, () => ({ path: 'preload', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function preloadRoute(){}', loader: 'js' })); } }] });
const browser = await chromium.launch();
const errors = [], writes = [], reads = [];
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.route('http://tape.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!/^\/(assets|img)\//.test(path)) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"><div id="root"></div>` });
    const base = resolve(root, path.startsWith('/img/') ? 'public' : 'dist'), file = resolve(base, path.slice(1));
    assert.ok(file.startsWith(base + sep));
    return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
  });
  await context.route('https://api.tapemarket.io/**', route => {
    if (route.request().method() !== 'GET') { writes.push(route.request().url()); return route.abort(); }
    reads.push(route.request().url());
    const path = new URL(route.request().url()).pathname;
    if (path === `/v1/account/${owner}` || path === `/v2/account/${owner}`) return route.fulfill({ json: { balance: '5991', queued: '0', positions: [] } });
    return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const open = async query => { await page.goto('http://tape.test/trade' + query); await page.addScriptTag({ content: result.outputFiles[0].text }); };
  await open('');
  await page.locator('.wallet-main').waitFor();
  assert.equal(await page.locator('.banner').count(), 0);
  assert.equal(reads.length, 0, 'Current trading no longer fetches historical account balances');
  assert.equal(await page.locator('.wallet-text b').innerText(), '$25.00');
  await page.locator('.top-nav').getByRole('button', { name: 'More', exact: true }).click();
  assert.equal(await page.getByRole('menu').getByRole('link', { name: /Previous exchange|TradingView/ }).count(), 0);
  await page.keyboard.press('Escape');
  await page.evaluate(other => window.__set({ owner: other, account: null }), other);
  assert.equal(await page.locator('.banner').count(), 0);
  console.log('PASS: no automatic historical-balance banners or fetches; More omits historical exchanges and TradingView.');
  await open('?legacy=1');
  assert.equal(await page.evaluate(() => window.__api), 'https://api.tapemarket.io/v1');
  await page.getByText('Previous exchange.', { exact: true }).waitFor();
  assert.equal(await page.locator('.wallet-add').count(), 0);
  await page.locator('.wallet-withdraw').click();
  const dialog = page.getByRole('dialog', { name: 'Withdraw USDC' });
  await dialog.getByRole('button', { name: 'Max', exact: true }).click();
  assert.equal(await dialog.getByLabel('Amount in USDC').inputValue(), '0.005991');
  assert.equal(await dialog.locator('.withdraw-destination strong').innerText(), owner);
  await page.keyboard.press('Escape');
  await page.locator('.top-nav').getByRole('link', { name: 'Vault', exact: true }).click();
  assert.match(page.url(), /\/vault\?legacy=1$/);
  await page.evaluate(() => window.__set({ dialog: 'deposit' }));
  await page.getByRole('dialog', { name: 'Previous exchange', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open current Tape' }).getAttribute('href'), '/trade');
  await open('?legacy=2');
  assert.equal(await page.evaluate(() => window.__api), 'https://api.tapemarket.io/v2');
  await page.getByText('Previous exchange (v2).', { exact: true }).waitFor();
  await page.locator('.top-nav').getByRole('link', { name: 'Vault', exact: true }).click();
  assert.match(page.url(), /\/vault\?legacy=2$/);
  await open('');
  await page.evaluate(() => window.__set({ config: { ...window.__get().config, previousExchanges: [
    { address: '0x3000000000000000000000000000000000000003', apiUrl: 'https://api.tapemarket.io/v1', siteUrl: '/trade?legacy=1', version: 1 },
    { address: '0x4000000000000000000000000000000000000004', apiUrl: 'https://api.tapemarket.io/v2', siteUrl: '/trade?legacy=2', version: 2 },
  ], recovery: { controller: '0x5000000000000000000000000000000000000005', paused: true, available: true, checkedAt: Date.now() } } }));
  await page.locator('.top-nav').getByRole('button', { name: 'More', exact: true }).click();
  assert.equal(await page.getByRole('menu').getByRole('link', { name: /Previous exchange|TradingView/ }).count(), 0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Withdraw USDC', exact: true }).click();
  await page.getByText('Paid by your wallet', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__set({ dialog: 'deposit' }));
  await page.getByRole('dialog', { name: 'Deposits paused', exact: true }).waitFor();
  await page.setViewportSize({ width: 320, height: 568 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log('PASS: both previous exchange versions, navigation, exact Max, recovery withdrawal fee and paused deposits; no writes or browser errors.');
} finally { await browser.close(); }
