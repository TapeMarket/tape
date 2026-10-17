import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const owner="0x1000000000000000000000000000000000000001",other="0x2000000000000000000000000000000000000002";
const bundled=await build({stdin:{resolveDir:fileURLToPath(new URL('../src/lib/',import.meta.url)),loader:'ts',contents:'export {openPosition,checkOpenSubmission} from "./actions"; export * from "./open-orders"; export {getState,setState} from "./store";'},bundle:true,format:'cjs',platform:'node',write:false,external:['react','viem','viem/accounts'],alias:{'@shared':fileURLToPath(new URL('../../shared',import.meta.url))},define:{__MAINNET_DEPOSITS__:'null'},logLevel:'silent',plugins:[{name:'order-fixtures',setup(b){
 b.onLoad({filter:/[\\/]lib[\\/]mode\.ts$/},()=>({loader:'js',contents:'export const PREVIEW=true;'}));
 b.onResolve({filter:/^\.\/api$/},args=>args.importer.endsWith('actions.ts')?{path:'api',namespace:'fixture'}:undefined);
 b.onResolve({filter:/^\.\/wallet$/},args=>args.importer.endsWith('actions.ts')?{path:'wallet',namespace:'fixture'}:undefined);
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='wallet'?'export const getSigner=()=>globalThis.__orders.signer;export const explainWalletError=e=>e.message;':`
  export class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}globalThis.__orderApiError=ApiError;
  export const post=(path,body)=>globalThis.__orders.post(path,body),get=path=>globalThis.__orders.get(path);
  export async function loadAccount(){}export async function loadHistory(){}export async function loadCoin(){}export function refreshAccountSoon(){}
 `}));
}}]});
const request={market:0,isLong:true,margin:20_000000n,leverage:1000,useQueued:false,impactLimit:100000};
const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
function fixture(t){
 const module={exports:{}};new Function('module','exports','require',bundled.outputFiles[0].text)(module,module.exports,createRequire(import.meta.url));
 const f={...module.exports,signer:{address:owner},posts:[],get:async()=>{throw Error('Not found');}};
 const previousTimer=globalThis.setTimeout;globalThis.setTimeout=()=>1;
 t.after(()=>{globalThis.setTimeout=previousTimer;delete globalThis.__orders;delete globalThis.__orderApiError;});
 f.post=async(path,body)=>{f.posts.push({path,body});f.intentId=Object.values(f.getState().openSubmissions)[0].intentId;return new Promise(resolve=>{f.accept=(status='accepted')=>resolve({id:f.intentId,kind:'open',owner,status,pinTime:Number(body.intent.timestamp)+2,positionId:f.intentId,fill:null,error:null,tx:null});});};
 globalThis.__orders=f;
 f.setState({owner,config:{name:'Tape',chainId:1,addresses:{exchange:other}},account:{address:owner,balance:'100000000',reserved:'0',queued:'0',positions:[],intents:[]}});
 return f;
}
test('the actual order is visible synchronously, without inventing a position, entry or balance',async t=>{
 const f=fixture(t),pending=f.openPosition(request);
 const rows=f.pendingOpens(f.getState(),Math.floor(Date.now()/1000));
 assert.equal(rows.length,1);assert.equal(rows[0].stage,'sending');assert.deepEqual(rows[0].order,{market:0,isLong:true,margin:'20000000',leverage:1000,useQueued:false});
 assert.equal(f.getState().account.positions.length,0);assert.equal(f.getState().account.balance,'100000000');
 assert.equal(await f.openPosition(request),null);await flush();assert.equal(f.posts.length,1);
 f.accept();assert.equal(await pending,f.intentId);assert.equal(Object.keys(f.getState().openSubmissions).length,0);
 assert.equal(f.pendingOpens(f.getState(),Math.floor(Date.now()/1000))[0].stage,'pricing');
});
test('an older accepted response preserves the filled stream state and the submitted order details',async t=>{
 const f=fixture(t),pending=f.openPosition(request);await flush();
 const filled={id:f.intentId,positionId:f.intentId,kind:'open',owner,status:'filled',pinTime:Math.floor(Date.now()/1000)+2,fill:{price:'8000000000000'},error:null,tx:null};
 f.setState(f.recordIntent(f.getState(),filled));f.accept();await pending;
 assert.equal(f.getState().intents[f.intentId].status,'filled');assert.equal(f.getState().intents[f.intentId].fill.price,'8000000000000');
 assert.equal(f.getState().intents[f.intentId].order.margin,'20000000');
 assert.equal(f.pendingOpens(f.getState(),Math.floor(Date.now()/1000)).length,1);
});
test('a definitive rejection removes the pending request, and a wallet switch stops before submission',async t=>{
 const f=fixture(t);f.post=async()=>{throw new globalThis.__orderApiError('Not enough balance.',400);};
 assert.equal(await f.openPosition(request),null);assert.equal(Object.keys(f.getState().openSubmissions).length,0);
 const pending=f.openPosition(request);f.setState({owner:other});assert.equal(await pending,null);assert.equal(f.posts.length,0);
});
test('an interrupted response stays visible, blocks duplicate submission and recovers by reading the same intent',async t=>{
 const f=fixture(t);f.post=async()=>{f.posts.push({});throw Error('Response interrupted');};
 assert.equal(await f.openPosition(request),null);
 const submission=Object.values(f.getState().openSubmissions)[0];assert.equal(submission.stage,'checking');assert.ok(submission.intentId);
 assert.equal(await f.openPosition(request),null);assert.equal(f.posts.length,1);
 f.get=async()=>({id:submission.intentId,positionId:submission.intentId,kind:'open',owner,status:'accepted',pinTime:Math.floor(Date.now()/1000)+2,fill:null,error:null,tx:null});
 await f.checkOpenSubmission(submission.id);assert.equal(Object.keys(f.getState().openSubmissions).length,0);assert.equal(f.posts.length,1);
 assert.equal(f.getState().intents[submission.intentId].order.margin,'20000000');
});
test('pending counts exclude other wallets, filled positions, closed history, failures and expired intents',async t=>{
 const f=fixture(t),pending=f.openPosition(request);await flush();f.accept();await pending;
 const now=Math.floor(Date.now()/1000),state=f.getState(),id=f.intentId;
 assert.equal(f.pendingOpens(state,now).length,1);
 assert.equal(f.pendingOpens({...state,owner:other},now).length,0);
 assert.equal(f.pendingOpens({...state,account:{...state.account,positions:[{id}]}},now).length,0);
 assert.equal(f.pendingOpens({...state,history:{...state.history,trades:[{id}]}},now).length,0);
 assert.equal(f.pendingOpens({...state,intents:{[id]:{...state.intents[id],status:'failed'}}},now).length,0);
 assert.equal(f.pendingOpens(state,now+100).length,0);
});

test('another wallet\'s response is never presented as an accepted order for this wallet',async t=>{
 const f=fixture(t);f.post=async()=>({id:'0x01',positionId:'0x01',kind:'open',owner:other,status:'accepted',pinTime:0});
 assert.equal(await f.openPosition(request),null);
 assert.equal(Object.values(f.getState().intents).length,0);
 const pending=Object.values(f.getState().openSubmissions)[0];assert.equal(pending.owner,owner);assert.equal(pending.stage,'checking');
});
