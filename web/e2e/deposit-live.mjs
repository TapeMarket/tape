// Published app and real deployment pin; fixture-wallet reads only, never a signed transaction.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { depositPinFrom } from "../deployment-pin.mjs";
const site=process.argv.find(a=>a.startsWith('http'))??'https://tapemarket.io';
const api='https://api.tapemarket.io', owner='0x1000000000000000000000000000000000000001';
const deployment=JSON.parse(readFileSync(new URL('../../deployments/1.json',import.meta.url),'utf8'));
const pin=depositPinFrom(deployment);
const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/lib/deposits.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',define:{__MAINNET_DEPOSITS__:JSON.stringify(pin)},logLevel:'silent'});
const {depositAddressOf}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const expected=depositAddressOf(pin.deposits,pin.box,owner);
const browser=await chromium.launch();const errors=[],writes=[];
try {
  const context=await browser.newContext({viewport:{width:1366,height:900}});
  await context.addInitScript(({owner})=>{
    const NativeEventSource=window.EventSource;
    window.EventSource=class {
      static CONNECTING=0;static OPEN=1;static CLOSED=2;readyState=1;listeners=new Map();
      constructor(url){
        if(new URL(url).searchParams.get('owner')?.toLowerCase()!==owner.toLowerCase())return new NativeEventSource(url);
        setTimeout(()=>{this.onopen?.({});this.listeners.get('hello')?.({data:JSON.stringify({time:Date.now()})});},0);
      }
      addEventListener(type,callback){this.listeners.set(type,callback);}
      close(){this.readyState=2;}
    };
    window.__walletWrites=[];
    window.ethereum={on(){},removeListener(){},async request({method}){
      if(method==='eth_accounts'||method==='eth_requestAccounts')return [owner];
      if(method==='eth_chainId')return '0x1';
      window.__walletWrites.push(method);throw Error('No signing or transaction methods are allowed in this check');
    }};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__copied=value;}}});
  },{owner});
  let wrong=false;const transfers=[];
  const history=()=>({transfers,trades:[],staking:[],queue:[],emissions:[]});
  await context.route(`${api}/**`,route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(request.method()!=='GET'){writes.push(path);return route.abort();}
    if(path===`/account/${owner}`)return route.fulfill({json:{address:owner,name:null,balance:transfers.length?'125000000':'100000000',queued:'0',reserved:'0',marginInUse:'0',positions:[],intents:[],claims:[],coin:null,withdrawRequest:null,wallet:{usdc:'500456789',eth:'100000000000000',usdcNonce:'0'},stats:{},badges:[]}});
    if(path===`/history/${owner}`)return route.fulfill({json:history()});
    if(path===`/deposit-address/${owner}`)return route.fulfill({json:{...pin,address:wrong?owner:expected,pending:'0',minimum:'10000000'}});
    if(path==='/stream'&&url.searchParams.get('owner')?.toLowerCase()===owner.toLowerCase())return route.fulfill({contentType:'text/event-stream',body:`event: hello\ndata: {"time":${Date.now()}}\n\n`});
    return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${site}/trade`);await page.locator('.wallet-connect').click();
  await page.getByRole('dialog',{name:'Connect a wallet'}).getByRole('button',{name:'Browser wallet',exact:true}).click();
  await page.locator('.wallet-main').waitFor();await page.locator('.wallet-add').click();
  const dialog=page.getByRole('dialog',{name:'Deposit USDC'});
  await dialog.getByRole('button',{name:'Max',exact:true}).click();assert.equal(await dialog.getByLabel('Amount in USDC').inputValue(),'500.456789');
  await dialog.getByRole('tab',{name:'Transfer USDC'}).click();await dialog.getByRole('img',{name:'Deposit address QR code'}).waitFor();
  assert.equal(await dialog.getByLabel('Your deposit address').inputValue(),expected);
  await dialog.getByRole('button',{name:'Copy address',exact:true}).click();assert.equal(await page.evaluate(()=>window.__copied),expected);
  await page.setViewportSize({width:390,height:844});assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  transfers.push({type:'deposit',amount:'25000000',time:Math.floor(Date.now()/1000),tx:'0x'+'ab'.repeat(32)});
  await dialog.getByText('Deposit received.',{exact:true}).waitFor({timeout:12000});assert.equal(await dialog.locator('.deposit-received').innerText(),'25.00USDC');
  await dialog.getByRole('button',{name:'Back to trading',exact:true}).click();await dialog.waitFor({state:'detached'});
  console.log('PASS: published deposit UI preserves exact Max, verifies the pinned address, copies it, fits mobile and confirms an isolated indexed credit.');
  wrong=true;await page.locator('.wallet-add').click();await dialog.getByRole('tab',{name:'Transfer USDC'}).click();
  await dialog.getByRole('alert').waitFor();assert.equal(await dialog.getByLabel('Your deposit address').count(),0);assert.equal(await dialog.getByRole('img',{name:'Deposit address QR code'}).count(),0);
  await dialog.getByRole('tab',{name:'Connected wallet'}).click();await dialog.getByLabel('Amount in USDC').fill('25');assert.ok(await dialog.getByRole('button',{name:'Deposit',exact:true}).isDisabled());
  assert.deepEqual(await page.evaluate(()=>window.__walletWrites),[]);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  console.log('PASS: published code refuses a substituted address; zero signing requests, transaction requests, API writes or browser exceptions.');
  await context.close();
}finally{await browser.close();}
