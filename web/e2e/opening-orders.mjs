// Real order action/ticket/positions with delayed fixture signing and HTTP. No funded wallet.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
const site='http://tape.test',root=fileURLToPath(new URL('../',import.meta.url));
const config=await (await fetch('https://api.tapemarket.io/config')).json();
const css=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8').match(/href="(\/assets\/index-[^"]+\.css)"/)[1];
const owner='0x1000000000000000000000000000000000000001';
const shots=process.argv.find(a=>a.startsWith('--shots='))?.slice(8);
const built=await build({stdin:{resolveDir:root,loader:'js',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{Trade}from'./src/pages/Trade';import{getState,setState}from'./src/lib/store';import{recordIntent}from'./src/lib/open-orders';
 window.__config=${JSON.stringify(config)};window.__set=setState;window.__get=getState;window.__posts=[];window.__signs=0;window.__intent=null;window.__responses=0;
 window.__recordIntent=intent=>setState(s=>recordIntent(s,intent));
 const now=Math.floor(Date.now()/1000);window.__account={address:'${owner}',balance:'100000000',reserved:'0',queued:'0',marginInUse:'0',positions:[],intents:[],wallet:{usdc:'0',eth:'0'},stats:{pnl:'0',volume:'0'}};
 localStorage.setItem(('tape:session:'+window.__config.chainId+':'+window.__config.addresses.sessions+':${owner}').toLowerCase(),JSON.stringify({privateKey:'0x11',address:'${owner}',validFrom:0,validUntil:now+86400}));
 setState({owner:'${owner}',config:window.__config,account:window.__account,session:{validFrom:0,validUntil:now+86400},ticket:{isLong:true,leverage:1000},ticks:{0:{p:8000000000000n,t:now}},path:'/trade'});
 createRoot(document.getElementById('root')).render(React.createElement('div',{className:'app'},React.createElement('main',{className:'page'},React.createElement(Trade))));
`},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@shared':fileURLToPath(new URL('../../shared',import.meta.url))},define:{'import.meta.env':'{"VITE_PREVIEW":"0","VITE_API_URL":"https://test.invalid"}',__MAINNET_DEPOSITS__:'null'},logLevel:'silent',plugins:[{name:'opening-fixture',setup(b){
 b.onResolve({filter:/(?:lib\/route-preload|\.\/route-preload)$/},()=>({path:'preload',namespace:'fixture'}));
 b.onResolve({filter:/(?:components\/Chart|\.\/Chart)$/},()=>({path:'chart',namespace:'fixture'}));
 b.onResolve({filter:/(?:lib\/wallet|\.\/wallet)$/},()=>({path:'wallet',namespace:'fixture'}));
 b.onResolve({filter:/(?:lib\/api|\.\/api)$/},()=>({path:'api',namespace:'fixture'}));
 b.onResolve({filter:/^viem\/accounts$/},()=>({path:'signer',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',resolveDir:root,contents:args.path==='preload'?'export function preloadRoute(){}':args.path==='chart'?`import React from 'react';export function Chart(){return React.createElement('canvas');}`:args.path==='wallet'?`
  export const getSigner=()=>({address:'${owner}'});export const explainWalletError=e=>e.message;export function walletOptions(){return [];}export function disconnect(){}export async function connectWith(){}
 `:args.path==='signer'?`
  export function generatePrivateKey(){return '0x11';}export function privateKeyToAccount(){return{address:'${owner}',async signTypedData(){window.__signs++;await new Promise(resolve=>{window.__signReady=resolve;});return '0x'+'11'.repeat(65);}};}
 `:`
  import{hashTypedData}from'viem';import{domain,types}from'@shared/eip712.mjs';import{setState}from'./src/lib/store';
  export class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}
  export async function get(path){if(path.startsWith('/intent/')){if(!window.__intent)throw new ApiError('Not found',404);return structuredClone(window.__intent);}if(path.startsWith('/account/'))return structuredClone(window.__account);if(path.startsWith('/history/'))return{trades:[],transfers:[]};throw Error('Unexpected read '+path);}
  export async function post(path,body){if(path!='/open')throw Error('Unexpected fixture write '+path);window.__posts.push(body);const c=window.__config;const id=hashTypedData({domain:domain(c.name,c.chainId,c.addresses.exchange),types,primaryType:'Open',message:body.intent});window.__orderId=id;window.__accepted={id,kind:'open',owner:'${owner}',status:'accepted',pinTime:Number(body.intent.timestamp)+2,positionId:id,fill:null,tx:null,error:null};if(window.__reject)throw new ApiError('Not enough balance.',400);if(window.__lost)throw Error('Response interrupted');return await new Promise(resolve=>{window.__accept=()=>{window.__responses++;resolve(window.__accepted);};});}
  export async function loadAccount(){setState({account:structuredClone(window.__account)});}export async function loadHistory(){}export function refreshAccountSoon(){}export async function loadCoin(){}
  export async function loadHouse(){}export async function loadPrices(){return{points:[]};}export async function loadStatus(){return{source:'signed',feeds:[],blocks:[]};}export async function loadJackpot(){return null;}
 `}));
}}]});
const browser=await chromium.launch(),errors=[];
try{
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 await context.route(`${site}/**`,route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/__open')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"><div id="root"></div>`});
  const base=resolve(root,path.startsWith('/img/')?'public':'dist'),file=resolve(base,path.slice(1));assert.ok(file.startsWith(base+sep));return existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const restart=async()=>{await page.goto(`${site}/__open`);await page.addScriptTag({content:built.outputFiles[0].text});await page.locator('#margin').fill('20');};
 const picture=async name=>{if(shots){mkdirSync(shots,{recursive:true});await page.locator('.opening-order').screenshot({path:resolve(shots,`open-${name}.png`),animations:'disabled'});}};
 await restart();await page.getByRole('tab',{name:'History',exact:true}).click();
 const button=page.locator('.slip-go');assert.ok(await button.isEnabled());
 const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 const result=await page.evaluate(async()=>{
  const start=performance.now();document.querySelector('.slip-go').click();
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  return{frameMs:performance.now()-start,visible:!!document.querySelector('.opening-order'),posts:window.__posts.length,balance:window.__get().account.balance,positions:window.__get().account.positions.length};
 });
 console.log('Click before signing/HTTP completes, 4x CPU:',JSON.stringify(result));
 assert.ok(result.visible,'The order must appear before signing and the HTTP response finish.');assert.ok(result.frameMs<200);assert.equal(result.posts,0);assert.equal(result.positions,0);assert.equal(result.balance,'100000000');
 assert.equal(await page.getByRole('tab',{name:/Positions/}).getAttribute('aria-selected'),'true');
 const row=page.locator('.opening-order');await row.getByText('Sending order',{exact:true}).waitFor();assert.match(await row.innerText(),/BTC[\s\S]*Long[\s\S]*1000x/);assert.match(await row.innerText(),/\$20,000/);assert.equal(await row.getByRole('button',{name:'Close',exact:true}).count(),0);assert.equal(await row.locator('.strip-pnl').count(),0);
 await picture('desktop');
 for(const [width,height]of[[390,844],[320,568]]){
  await page.setViewportSize({width,height});assert.ok(await row.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  assert.ok(await row.locator('.strip-cell').last().isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await picture(String(width));
 }
 await page.setViewportSize({width:1440,height:900});await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
 await page.waitForFunction(()=>typeof window.__signReady==='function');await page.evaluate(()=>window.__signReady());await page.waitForFunction(()=>window.__posts.length===1);
 await page.evaluate(()=>window.__recordIntent(window.__accepted));await row.getByText('Waiting for price',{exact:true}).waitFor();
 assert.ok(await page.locator('.slip-go').isEnabled());assert.equal(await page.evaluate(()=>window.__responses),0);
 await page.evaluate(()=>{window.__recordIntent({...window.__accepted,status:'filled',fill:{price:'8000000000000',time:Math.floor(Date.now()/1000)}});window.__accept();});
 await row.getByText('Price set',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__get().intents[window.__orderId].status),'filled');
 await page.evaluate(owner=>{
  const position={id:window.__orderId,owner,market:0,isLong:true,leverage:1000,margin:'20000000',debtMargin:'0',entryPrice:'8000000000000',entryTime:Math.floor(Date.now()/1000)-3,bust:'7995800000000',impactNotional:100000,status:'pending',closeRequestedAt:0,liquidating:false};
  window.__account={...window.__account,reserved:'20000000',positions:[position]};window.__set({account:window.__account});
 },owner);
 await page.locator('.strip:not(.opening-order)').waitFor();assert.equal(await page.locator('.opening-order').count(),0);await page.getByText('Confirming on Ethereum',{exact:true}).waitFor();
 console.log('PASS: pending details paint immediately, fit phones, select Positions, and stream acceptance beats a delayed HTTP response without regressing the real fill.');

 await restart();await page.evaluate(()=>{window.__reject=true;});await page.locator('.slip-go').click();await page.waitForFunction(()=>typeof window.__signReady==='function');await page.evaluate(()=>window.__signReady());
 await page.waitForFunction(()=>window.__get().toasts.some(t=>t.title==='Order not placed'));assert.equal(await page.locator('.opening-order').count(),0);assert.equal(await page.evaluate(()=>window.__get().account.positions.length),0);
 console.log('PASS: a definite rejection removes the request and never creates a position.');

 await restart();await page.evaluate(()=>{window.__lost=true;});await page.locator('.slip-go').click();await page.waitForFunction(()=>typeof window.__signReady==='function');await page.evaluate(()=>window.__signReady());
 await page.locator('.opening-order').getByText('Checking order',{exact:true}).waitFor();assert.equal(await page.locator('.slip-go').innerText(),'Checking previous order');assert.ok(await page.locator('.slip-go').isDisabled());
 await page.evaluate(()=>{window.__intent=window.__accepted;});await page.locator('.opening-order').getByText('Waiting for price',{exact:true}).waitFor({timeout:6000});assert.equal(await page.evaluate(()=>window.__posts.length),1);assert.ok(await page.locator('.slip-go').isEnabled());
 console.log('PASS: an interrupted response is recovered by reading the same order; no signing or submission is repeated.');

 await restart();await page.locator('.slip-go').click();await page.waitForFunction(()=>typeof window.__signReady==='function');await page.evaluate(()=>{const owner='0x2000000000000000000000000000000000000002';window.__set({owner,account:{...window.__account,address:owner}});window.__signReady();});
 await page.waitForFunction(()=>Object.keys(window.__get().openSubmissions).length===0);assert.equal(await page.evaluate(()=>window.__posts.length),0);assert.equal(await page.locator('.opening-order').count(),0);
 console.log('PASS: changing wallets during signing stops before the order is sent; zero real wallet or API writes.');
 await context.close();assert.deepEqual(errors,[]);
}finally{await browser.close();}
