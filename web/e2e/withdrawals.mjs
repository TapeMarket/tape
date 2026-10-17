// Real withdrawal component and action, isolated wallet and ledger. No network writes or funds.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
const root=fileURLToPath(new URL('../',import.meta.url)),site='http://tape.test';
const shots=process.argv.find(a=>a.startsWith('--shots='))?.slice(8);
const css=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8').match(/href="(\/assets\/index-[^"]+\.css)"/)[1];
const owner='0x1000000000000000000000000000000000000001', hash='0x'+'ab'.repeat(32);
const built=await build({stdin:{resolveDir:root,loader:'js',contents:`
  import React from 'react';import{createRoot}from'react-dom/client';import{Dialogs,TopBar}from'./src/components/Shell';import{setState,getState}from'./src/lib/store';import{withdraw}from'./src/lib/actions';
  window.__set=setState;window.__get=getState;window.__withdraw=withdraw;window.__signs=[];window.__posts=[];window.__transfers=[];
  window.__account={address:'${owner}',name:null,balance:'100123456',reserved:'10000000',queued:'5000000',marginInUse:'20000000',withdrawNonce:'7',positions:[],intents:[],wallet:{usdc:'0',eth:'0',usdcNonce:'0'}};
  setState({owner:'${owner}',account:window.__account,dialog:'withdraw',config:{name:'Tape',chainId:1,markets:[],addresses:{exchange:'${owner}'}},path:'/trade'});
  createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(TopBar),React.createElement(Dialogs)));
`},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@shared':fileURLToPath(new URL('../../shared',import.meta.url))},define:{'import.meta.env':'{"VITE_PREVIEW":"0","VITE_API_URL":"https://test.invalid"}',__MAINNET_DEPOSITS__:'null'},logLevel:'silent',plugins:[{name:'withdrawal-fixture',setup(b){
  b.onResolve({filter:/(?:lib\/route-preload|\.\/route-preload)$/},()=>({path:'preload',namespace:'fixture'}));
  b.onResolve({filter:/(?:lib\/api|\.\/api)$/},()=>({path:'api',namespace:'fixture'}));
  b.onResolve({filter:/(?:lib\/wallet|\.\/wallet)$/},()=>({path:'wallet',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',resolveDir:root,contents:args.path==='preload'?'export function preloadRoute(){}':args.path==='wallet'?`
    export function getSigner(){return {address:'${owner}',async signTypedData(data){window.__signs.push(data);if(window.__reject)throw Error('You declined the request in your wallet.');await new Promise(resolve=>{window.__approve=resolve;});return '0x11';}};}
    export function explainWalletError(e){return e.message;}export function walletOptions(){return [];}export function disconnect(){}export async function connectWith(){}
  `:`
    import{getState,setState}from'./src/lib/store';
    export class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}
    export async function get(path){if(path.startsWith('/account/'))return structuredClone(window.__account);if(path.startsWith('/history/'))return {transfers:structuredClone(window.__transfers)};throw Error('Unexpected read '+path);}
    export async function loadAccount(){setState({account:structuredClone(window.__account)});}export async function loadHistory(){}export async function loadCoin(){}export function refreshAccountSoon(){}
    export async function post(path,body){if(path!='/withdraw')throw Error('Unexpected write '+path);window.__posts.push(body);if(window.__lost)throw Error('Response interrupted');await new Promise(resolve=>{window.__confirm=resolve;});window.__account.balance=(BigInt(window.__account.balance)-body.amount).toString();window.__transfers.push({type:'withdraw',amount:String(body.amount),to:body.to,time:100,tx:'${hash}'});return {ok:true,tx:'${hash}'};}
  `}));
}}]});
const browser=await chromium.launch(),errors=[];
let count=0;const check=async(name,run)=>{await run();console.log('PASS: '+name);count++;};
try{
  const context=await browser.newContext({viewport:{width:1366,height:900}});
  await context.route(`${site}/**`,route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/__withdraw')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"><div id="root"></div>`});
    const base=resolve(root,path.startsWith('/img/')?'public':'dist'),file=resolve(base,path.slice(1));assert.ok(file.startsWith(base+sep));
    return existsSync(file)?route.fulfill({path:file}):route.fulfill({status:404});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${site}/__withdraw`);await page.addScriptTag({content:built.outputFiles[0].text});
  const dialog=page.getByRole('dialog',{name:'Withdraw USDC'}),amount=dialog.getByLabel('Amount in USDC');
  const picture=async name=>{if(shots){mkdirSync(shots,{recursive:true});await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:resolve(shots,`withdraw-${name}.png`)});}};
  await check('exact maximum excludes reserved money, receipt names the destination and overspending is blocked',async()=>{
    await amount.waitFor();await dialog.getByRole('button',{name:'Max',exact:true}).click();assert.equal(await amount.inputValue(),'90.123456');
    assert.equal(await dialog.locator('.withdraw-destination strong').innerText(),owner);
    await amount.fill('90.123457');assert.ok(await dialog.getByRole('button',{name:'Withdraw',exact:true}).isDisabled());
    await amount.fill('25.123456');await dialog.getByRole('button',{name:'Withdraw',exact:true}).waitFor();assert.ok(await dialog.getByRole('button',{name:'Withdraw',exact:true}).isEnabled());await picture('desktop');
  });
  await check('visible header withdrawal, mobile amount form and long quantities fit 390px and 320px screens',async()=>{
    const widths=[];
    for(const [width,height]of[[390,844],[320,568]]){
      await page.setViewportSize({width,height});
      widths.push(await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflows:[...document.querySelectorAll('.top *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>el.className)})));
      assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      await picture(String(width));
    }
    assert.ok(widths.every(w=>w.scrollWidth<=w.width+1),JSON.stringify(widths));
    await dialog.getByRole('button',{name:'Close',exact:true}).click();await page.locator('.wallet-withdraw').click();await amount.waitFor();
    await page.setViewportSize({width:1366,height:900});
  });
  await check('a declined signature preserves the amount, a double click signs once and progress survives reopening',async()=>{
    await amount.fill('25.123456');await page.evaluate(()=>{window.__reject=true;});await dialog.getByRole('button',{name:'Withdraw',exact:true}).click();
    await dialog.getByRole('alert').waitFor();assert.equal(await amount.inputValue(),'25.123456');assert.equal(await page.evaluate(()=>window.__posts.length),0);
    await page.evaluate(()=>{window.__reject=false;const b=document.querySelector('.withdraw-dialog button.primary');b.click();b.click();});
    await dialog.getByText('Confirm in your wallet.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__signs.length),2);
    await dialog.getByRole('button',{name:'Close',exact:true}).last().click();await page.locator('.wallet-withdraw').click();await dialog.getByText('Confirm in your wallet.',{exact:true}).waitFor();
    await page.evaluate(()=>window.__approve());await dialog.getByText('Confirming on Ethereum.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__posts.length),1);await page.evaluate(()=>window.__confirm());
    await dialog.getByText('Back in your wallet.',{exact:true}).waitFor();assert.equal(await dialog.locator('.deposit-received').innerText(),'25.123456USDC');
    assert.equal(await dialog.getByRole('link',{name:'View transaction'}).getAttribute('href'),`https://etherscan.io/tx/${hash}`);await picture('complete');
    await dialog.getByRole('button',{name:'Done',exact:true}).click();
  });
  await check('an interrupted submission stays pending and resolves only from its indexed withdrawal receipt',async()=>{
    await page.locator('.wallet-withdraw').click();await amount.fill('10.000001');await page.evaluate(()=>{window.__lost=true;});
    await dialog.getByRole('button',{name:'Withdraw',exact:true}).click();await dialog.getByText('Confirm in your wallet.',{exact:true}).waitFor();await page.evaluate(()=>window.__approve());
    await dialog.getByText('Checking your withdrawal.',{exact:true}).waitFor();assert.equal(await amount.count(),0);
    await dialog.getByRole('button',{name:'Close',exact:true}).last().click();await page.locator('.wallet-withdraw').click();await dialog.getByText('Checking your withdrawal.',{exact:true}).waitFor();
    const signs=await page.evaluate(()=>window.__signs.length);assert.equal(await page.evaluate(()=>window.__withdraw(10000001n)),false);assert.equal(await page.evaluate(()=>window.__signs.length),signs);
    await page.evaluate(({owner,hash})=>{window.__transfers.push({type:'withdraw',amount:'10000001',to:owner,time:101,tx:hash});},{owner,hash:'0x'+'cd'.repeat(32)});
    await dialog.getByText('Back in your wallet.',{exact:true}).waitFor({timeout:6000});
    await dialog.getByRole('button',{name:'Done',exact:true}).click();
  });
  await check('offline withdrawal is disabled and a wallet switch replaces its destination',async()=>{
    await page.locator('.wallet-withdraw').click();await amount.fill('1');await page.evaluate(()=>window.__set({offline:'Disconnected'}));assert.ok(await dialog.getByRole('button',{name:'Reconnecting…',exact:true}).isDisabled());
    await page.evaluate(()=>{const owner='0x2000000000000000000000000000000000000002';window.__set({owner,offline:null,account:{...window.__account,address:owner}});});
    assert.equal(await dialog.locator('.withdraw-destination strong').innerText(),'0x2000000000000000000000000000000000000002');
  });
  assert.deepEqual(errors,[]);console.log(`${count} withdrawal browser groups passed; no real wallet or API writes.`);await context.close();
}finally{await browser.close();}
