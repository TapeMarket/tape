// Real funding UI with isolated wallet/ledger actions. No live wallet, API writes or real funds.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import jsQR from "jsqr";
const root = fileURLToPath(new URL("../", import.meta.url));
const site = "http://tape.test";
const shots = process.argv.includes("--shots");
const css = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8").match(/href="(\/assets\/index-[^"]+\.css)"/)[1];
const owner = "0x1000000000000000000000000000000000000001", address = "0x2000000000000000000000000000000000000002";
const config = { chainId: 1, addresses: { deposits: address }, markets: [], minMargin:"1000000" };
const built = await build({
  stdin: { resolveDir: root, loader: "js", contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import Deposit from './src/components/Deposit';import {Dialogs} from './src/components/Shell';import {setState,getState} from './src/lib/store';
    window.__history=[];window.__box={address:'${address}',pending:'0',minimum:'10000000'};window.__addressFails=false;window.__copyFails=false;window.__calls=0;window.__reject=false;
    window.__set=setState;window.__get=getState;window.__set({owner:'${owner}',dialog:'deposit',config:${JSON.stringify(config)},account:{address:'${owner}',wallet:{usdc:'500000000',eth:'1'},balance:'100000000',reserved:'0',positions:[],intents:[]}});
    const app=createRoot(document.getElementById('root'));window.__open=()=>{setState({dialog:'deposit'});app.render(React.createElement(Dialogs));};window.__open();
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{if(window.__copyFails)throw Error('Denied');window.__copied=value;}}});
  ` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", alias: { "@shared": fileURLToPath(new URL("../../shared", import.meta.url)) },
  define: { "import.meta.env": '{"VITE_PREVIEW":"0","VITE_API_URL":"https://api.tapemarket.io"}', __MAINNET_DEPOSITS__: "null" }, logLevel: "silent",
  plugins: [{ name:"funding-surface",setup(builder) {
    builder.onResolve({filter:/(?:lib\/route-preload|\.\/route-preload)$/},()=>({path:"preload",namespace:"fixture"}));
    builder.onResolve({filter:/(?:lib\/actions|\.\/actions)$/},()=>({path:"actions",namespace:"fixture"}));
    builder.onResolve({filter:/(?:lib\/api|\.\/api)$/},()=>({path:"api",namespace:"fixture"}));
    builder.onLoad({filter:/.*/,namespace:"fixture"},args=>({loader:"js",resolveDir:root,contents:args.path==="preload"?'export function preloadRoute(){}':args.path==="api"?`
      import {setState,getState} from './src/lib/store';
      export async function get(path){if(path.startsWith('/history/'))return {transfers:structuredClone(window.__history)};throw Error('Unexpected fixture read '+path);}
      export async function loadAccount(){}export async function loadHistory(){}export async function post() {throw Error('Unexpected write');}
      export class ApiError extends Error{}export function refreshAccountSoon(){}export async function loadCoin(){}
    `:`
      import {setState,getState} from './src/lib/store';
      export async function depositAddress(){if(window.__addressFails)throw Error('Deposit address unavailable. Try again.');return {...window.__box};}
      export async function deposit(amount,bySignature){window.__calls++;const owner=getState().owner,slot=owner.toLowerCase();
        const flow={id:window.__calls,owner,amount:amount.toString(),bySignature,baseline:[],stage:window.__reject?'error':'wallet',error:window.__reject?'You declined the request in your wallet.':undefined};
        setState(s=>({depositFlows:{...s.depositFlows,[slot]:flow}}));
        if(window.__reject)return false;
        window.__phase=(stage,extra={})=>setState(s=>({depositFlows:{...s.depositFlows,[slot]:{...s.depositFlows[slot],stage,...extra}}}));
        await new Promise(resolve=>{window.__finish=()=>{window.__phase('complete',{confirmed:true});resolve();};});return true;
      }
      export async function withdraw(){}export async function claimUsername(){}
    `}));
  }}],
});
const browser = await chromium.launch();
const errors=[];let passed=0;
const check=async(name,run)=>{await run();console.log('PASS: '+name);passed++;};
try {
  const context=await browser.newContext({viewport:{width:1366,height:900}});
  for(const prefix of ['assets','img']) await context.route(`${site}/${prefix}/**`,route=>{
    const base=resolve(root,prefix==='img'?'public':'dist'), file=resolve(base,new URL(route.request().url()).pathname.slice(1));
    assert.ok(file.startsWith(base+sep));return existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404});
  });
  await context.route(`${site}/__deposit`,route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"><button id="opener">Deposit</button><div id="root"></div>`}));
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${site}/__deposit`);await page.locator('#opener').focus();await page.addScriptTag({content:built.outputFiles[0].text});
  let dialog=page.getByRole('dialog',{name:'Deposit USDC'});
  const picture=async name=>{if(shots){mkdirSync(new URL('./shots/',import.meta.url),{recursive:true});await page.evaluate(()=>document.fonts.ready);await dialog.screenshot({path:fileURLToPath(new URL(`./shots/deposit-${name}.png`,import.meta.url))});}};
  await check('amount presets, maximum, all six decimals and validation preserve the exact USDC amount',async()=>{
    await dialog.getByLabel('Amount in USDC').waitFor();await dialog.getByRole('button',{name:'$50',exact:true}).click();assert.equal(await dialog.getByLabel('Amount in USDC').inputValue(),'50');
    await dialog.getByRole('button',{name:'Max',exact:true}).click();assert.equal(await dialog.getByLabel('Amount in USDC').inputValue(),'500');
    await dialog.getByLabel('Amount in USDC').fill('500.000001');assert.ok(await dialog.getByRole('button',{name:'Deposit',exact:true}).isDisabled());
    await dialog.getByLabel('Amount in USDC').fill('1');await dialog.getByText(/Add at least/).waitFor();assert.ok(await dialog.getByRole('button',{name:'Deposit',exact:true}).isDisabled());
    await dialog.getByLabel('Amount in USDC').fill('50.123456');assert.ok(await dialog.getByRole('button',{name:'Deposit',exact:true}).isEnabled());await picture('wallet-desktop');
  });
  await check('keyboard method switching, verified address, local QR and denied clipboard fallback work',async()=>{
    await dialog.getByRole('tab',{name:'Connected wallet'}).focus();await page.keyboard.press('ArrowRight');
    await dialog.getByRole('img',{name:'Deposit address QR code'}).waitFor();assert.equal(await dialog.getByRole('tab',{name:'Transfer USDC'}).getAttribute('aria-selected'),'true');
    const pixels=await dialog.locator('.deposit-qr').evaluate(async el=>{
      const image=new Image(),markup=new XMLSerializer().serializeToString(el);
      image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(markup);await image.decode();
      const canvas=document.createElement('canvas');canvas.width=el.clientWidth;canvas.height=el.clientHeight;
      const context=canvas.getContext('2d');context.drawImage(image,0,0,canvas.width,canvas.height);
      return {width:canvas.width,height:canvas.height,data:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data)};
    });
    assert.equal(jsQR(new Uint8ClampedArray(pixels.data),pixels.width,pixels.height)?.data,address,'independent decoder recovers the exact address from the rendered QR');
    assert.equal(await dialog.getByLabel('Your deposit address').inputValue(),address);await dialog.getByText('Only USDC on Ethereum.',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Copy address',exact:true}).click();assert.equal(await page.evaluate(()=>window.__copied),address);
    await page.evaluate(()=>{window.__copyFails=true;});await dialog.getByRole('button',{name:'Address copied',exact:true}).click();await dialog.getByText(/Couldn’t copy automatically/).waitFor();
    assert.equal(await dialog.getByLabel('Your deposit address').evaluate(el=>el.selectionEnd-el.selectionStart),42);
    await page.evaluate(()=>{window.__copyFails=false;});await dialog.getByRole('button',{name:'Copy address',exact:true}).click();await dialog.getByRole('tab',{name:'Transfer USDC'}).click();await picture('transfer-desktop');
  });
  await check('wallet rejection keeps the amount; retry broadcasts once and progress survives close/reopen',async()=>{
    await dialog.getByRole('tab',{name:'Connected wallet'}).click();await page.evaluate(()=>{window.__reject=true;});
    await dialog.getByRole('button',{name:'Deposit',exact:true}).click();await dialog.getByRole('alert').getByText(/declined/).waitFor();assert.equal(await dialog.getByLabel('Amount in USDC').inputValue(),'50.123456');
    await page.evaluate(()=>{window.__reject=false;});await dialog.getByRole('button',{name:'Deposit',exact:true}).click();await dialog.getByText('Confirm in your wallet.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__calls),2);await page.evaluate(()=>window.__phase('confirming',{tx:'0x'+'ab'.repeat(32),confirmed:false}));await dialog.getByText('Confirming on Ethereum.',{exact:true}).waitFor();await picture('progress-desktop');
    await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await page.locator('#opener').evaluate(el=>el===document.activeElement),true);
    await page.evaluate(()=>window.__open());await dialog.getByText('Confirming on Ethereum.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__calls),2);
    await page.evaluate(()=>window.__phase('pending',{confirmed:false,error:'The transaction was sent, but status is unavailable.'}));await dialog.getByText('Checking your deposit.',{exact:true}).waitFor();
    assert.equal(await dialog.locator('.deposit-steps li').nth(1).getAttribute('aria-current'),'step');assert.equal(await dialog.getByRole('button',{name:'Deposit',exact:true}).count(),0);
    await page.evaluate(()=>window.__finish());await dialog.getByText('Deposit received.',{exact:true}).waitFor();await picture('success-desktop');
  });
  await check('success and transfer views fit desktop, phones, short screens and reduced motion',async()=>{
    for(const width of [390,320]){
      await page.setViewportSize({width,height:width===320?568:844});await picture(`success-${width}`);
      assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    }
    await dialog.getByRole('button',{name:'Add more funds',exact:true}).click();await dialog.getByLabel('Amount in USDC').fill('50');
    await page.setViewportSize({width:390,height:844});await picture('wallet-390');
    await dialog.getByRole('tab',{name:'Transfer USDC'}).click();await picture('transfer-390');
    for(const width of [390,320]){
      await page.setViewportSize({width,height:width===320?568:844});assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await dialog.getByRole('button',{name:'Copy address',exact:true}).scrollIntoViewIfNeeded();
      assert.ok((await dialog.boundingBox()).y>=0);
    }
    await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>{const o=window.__get().owner;window.__set({depositFlows:{[o.toLowerCase()]:{id:99,owner:o,amount:'50000000',stage:'complete',baseline:[],bySignature:false}}});});
    await dialog.getByText('Deposit received.',{exact:true}).waitFor();assert.equal(await dialog.locator('.deposit-stamp').evaluate(el=>getComputedStyle(el).animationName),'none');
  });
  await check('external collection completes from indexed deposits and stale address responses cannot cross wallets',async()=>{
    await dialog.getByRole('button',{name:'Add more funds',exact:true}).click();await dialog.getByRole('tab',{name:'Transfer USDC'}).click();await dialog.getByRole('img',{name:'Deposit address QR code'}).waitFor();
    await page.evaluate(()=>{window.__history=[{type:'deposit',amount:'25000000',time:100,tx:'0x'+'cd'.repeat(32)}];});await dialog.getByText('Deposit received.',{exact:true}).waitFor({timeout:10000});
    assert.equal(await dialog.locator('.deposit-received').innerText(),'25.00USDC');
    await dialog.getByRole('button',{name:'Add more funds',exact:true}).click();await page.evaluate(()=>{window.__addressFails=true;window.__set({owner:'0x3000000000000000000000000000000000000003'});});
    await dialog.getByRole('tab',{name:'Transfer USDC'}).click();await dialog.getByRole('alert').waitFor();assert.equal(await dialog.getByLabel('Your deposit address').count(),0);
    await page.evaluate(()=>{window.__addressFails=false;window.__box.address='0x4000000000000000000000000000000000000004';});await dialog.getByRole('button',{name:'Try again',exact:true}).click();
    assert.equal(await dialog.getByLabel('Your deposit address').inputValue(),'0x4000000000000000000000000000000000000004');
  });
  await check('offline submission is disabled and a wallet with no ETH gets the sponsored permit explanation',async()=>{
    await dialog.getByRole('tab',{name:'Connected wallet'}).click();await page.evaluate(()=>{const account=window.__get().account;window.__set({account:{...account,wallet:{...account.wallet,eth:'0'}},offline:'Offline'});});
    await dialog.getByLabel('Amount in USDC').fill('1.123456');assert.ok(await dialog.getByRole('button',{name:'Reconnecting…',exact:true}).isDisabled());
    await page.evaluate(()=>window.__set({offline:null}));await dialog.getByText('Paid by the relayer',{exact:true}).waitFor();assert.ok(await dialog.getByRole('button',{name:'Deposit',exact:true}).isEnabled());
    await dialog.getByRole('button',{name:'Deposit',exact:true}).click();assert.equal(await page.evaluate(()=>Object.values(window.__get().depositFlows).find(Boolean).bySignature),true);
  });
  assert.deepEqual(errors,[]);console.log(`${passed} deposit browser groups passed.`);await context.close();
} finally {await browser.close();}
