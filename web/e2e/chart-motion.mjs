// Real chart library and component, deterministic quotes. Never connects a wallet or writes to an API.
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
const bundled=await build({stdin:{resolveDir:root,loader:'jsx',contents:`
import React from 'react';import{createRoot}from'react-dom/client';
import{Chart}from'./src/components/Chart';import{setState}from'./src/lib/store';
const now=1792339000;
setState({config:{markets:[{id:0,coin:'BTC',symbol:'BTC'}]},ticket:{leverage:0,isLong:true},ticks:{0:{t:now,p:8100000000000n}}});
const root=createRoot(document.getElementById('root'));
window.renderChart=(interval=0)=>root.render(<Chart key={interval} marketId={0} interval={interval}/>);
window.renderChart();
`},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@shared':fileURLToPath(new URL('../../shared',import.meta.url))},logLevel:'silent',plugins:[{name:'chart-fixture',setup(b){
 b.onLoad({filter:/[\\/]components[\\/]Chart\.tsx$/},async({path})=>({loader:'tsx',contents:readFileSync(path,'utf8').replace('chartRef.current = chart;','window.__chart = chart; window.__series = series; chartRef.current = chart;')}));
 b.onLoad({filter:/[\\/]lib[\\/]api\.ts$/},()=>({contents:`export function loadPrices(){return Promise.resolve({points:Array.from({length:600},(_,i)=>({t:1792338401+i,p:String(8100000000000n+BigInt(i%7)*100000000n)}))})}export function onTick(fn){window.emit=(t,p)=>fn(0,{t,p:BigInt(p)});return()=>{window.emit=null}}`}));
 b.onLoad({filter:/[\\/]lib[\\/]candles\.ts$/},()=>({contents:`export function heldCandles(){return []}export function loadCandles(){return Promise.reject(Error("No fixture history"))}`}));
}}]});
const browser=await chromium.launch();const errors=[];
try{
 for(const reducedMotion of ['no-preference','reduce']){
  const context=await browser.newContext({viewport:{width:1366,height:900},reducedMotion});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://chart.test/**',r=>r.fulfill({contentType:'text/html',body:'<style>body{margin:0}.chart{position:relative;height:560px}.chart-canvas{height:100%;width:100%}.chart-reset{position:absolute;right:80px;bottom:28px;z-index:5}</style><div id="root"></div>'}));
  await page.goto('http://chart.test');await page.addScriptTag({content:bundled.outputFiles[0].text});
  await page.waitForFunction(()=>window.__series?.data().length>=600);
  const before=await page.evaluate(()=>({range:__chart.timeScale().getVisibleLogicalRange(),type:__series.options().lineType}));
  assert.equal(before.type,0,'connected line must replace right-angle steps');
  assert.ok(before.range.to-before.range.from<=105,'tick opens on close-up window');
  await page.evaluate(()=>{window.fullRedraws=0;const original=__series.setData.bind(__series);__series.setData=(...args)=>{fullRedraws++;return original(...args)};emit(1792339001,'8101234567890')});
  const immediate=await page.evaluate(()=>__series.data().at(-1));assert.equal(immediate.value,81012.3456789,'latest plotted price must be exact immediately');
  await page.waitForTimeout(250);
  const after=await page.evaluate(()=>__chart.timeScale().getVisibleLogicalRange());
  assert.ok(after.to>before.range.to+.9,'live window follows the new point');
  await page.evaluate(()=>{emit(1792339001,'8102234567890');emit(1792339000,'1')});
  assert.deepEqual(await page.evaluate(()=>({last:__series.data().at(-1).value,count:__series.data().length,redraws:fullRedraws})),{last:81022.3456789,count:601,redraws:0});
  await page.locator('.chart-canvas').dispatchEvent('wheel',{deltaX:-100,deltaY:0});
  await page.evaluate(()=>__chart.timeScale().setVisibleLogicalRange({from:300,to:400}));
  await page.evaluate(()=>emit(1792339002,'8103234567890'));await page.waitForTimeout(220);
  assert.ok((await page.evaluate(()=>__chart.timeScale().getVisibleLogicalRange())).to<500,'live update must not drag a reader back from history');
  await page.getByRole('button',{name:'Reset',exact:true}).click();
  await page.waitForFunction(()=>__chart.timeScale().getVisibleLogicalRange().to>600);
  for(const width of [1366,390]){
   await page.setViewportSize({width,height:900});await page.waitForTimeout(100);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   if(reducedMotion==='no-preference'){mkdirSync(new URL('./shots/',import.meta.url),{recursive:true});await page.screenshot({path:fileURLToPath(new URL(`./shots/chart-smooth-${width}.png`,import.meta.url))})}
  }
  await page.evaluate(()=>renderChart(60));await page.waitForTimeout(120);
  await page.evaluate(()=>{emit(1792339200,'8100000000000');emit(1792339201,'8105000000000');emit(1792339202,'8095000000000');emit(1792339203,'8101000000000')});
  const candle=await page.evaluate(()=>__series.data().at(-1));assert.equal(candle.high,81050);assert.equal(candle.low,80950);assert.equal(candle.close,81010);
  console.log(`PASS ${reducedMotion}: exact ticks, no per-tick history redraw, close-up view, smooth follow/reset, free history navigation, candle OHLC; desktop and mobile.`);
  await context.close();
 }
 assert.deepEqual(errors,[]);
}finally{await browser.close()}
