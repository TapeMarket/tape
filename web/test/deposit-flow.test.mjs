import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { depositPinFrom } from "../deployment-pin.mjs";

const require = createRequire(import.meta.url);
const owner = "0x1000000000000000000000000000000000000001";
const pin = depositPinFrom({ name: "Tape", chainId: 1, deposits: "0x2000000000000000000000000000000000000002" });
const hash = `0x${"ab".repeat(32)}`;
const bundled = await build({
  stdin: { resolveDir: fileURLToPath(new URL("../src/lib/", import.meta.url)), contents: 'export {deposit,withdraw} from "./actions"; export * from "./deposit-flow"; export * from "./withdraw-flow"; export {depositAddressOf} from "./deposits"; export {setState,getState} from "./store";', loader: "ts" },
  bundle: true, format: "cjs", platform: "node", write: false, external: ["react", "viem", "viem/accounts"],
  alias: { "@shared": fileURLToPath(new URL("../../shared/", import.meta.url)) }, define: { __MAINNET_DEPOSITS__: JSON.stringify(pin) }, logLevel: "silent",
  plugins: [{ name: "funding-fixtures", setup(builder) {
    builder.onLoad({ filter: /[\\/]lib[\\/]mode\.ts$/ }, () => ({ loader: "js", contents: 'export const PREVIEW=false;' }));
    builder.onResolve({ filter: /^\.\/api$/ }, args => args.importer.endsWith("actions.ts") ? { path: "api", namespace: "fixture" } : undefined);
    builder.onResolve({ filter: /^\.\/wallet$/ }, args => args.importer.endsWith("actions.ts") ? { path: "wallet", namespace: "fixture" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js", contents: args.path === "api" ? `
      export class ApiError extends Error { constructor(message,status){super(message);this.status=status;} }
      export const get=path=>globalThis.__funding.get(path); export const post=(path,body)=>globalThis.__funding.post(path,body);
      export const loadAccount=async()=>{globalThis.__funding.accountLoads++;if(globalThis.__funding.failRefresh)throw Error('Refresh unavailable');}; export const loadHistory=async()=>{};
      export const loadCoin=async()=>{};export function refreshAccountSoon(){}
    ` : 'export const getSigner=()=>globalThis.__funding.signer;export const explainWalletError=error=>error.message;' }));
  } }],
});
const flush = async () => { for(let i=0;i<20;i++) await Promise.resolve(); };
function fixture(t) {
  const saved = { timeout: globalThis.setTimeout, now: Date.now };
  let clock = 100_000;
  Date.now = () => clock;
  globalThis.setTimeout = (callback, ms) => { if(ms === 2500) { clock += ms; queueMicrotask(callback); } return 1; };
  const module = { exports: {} };
  new Function("module", "exports", "require", bundled.outputFiles[0].text)(module, module.exports, require);
  const m = module.exports, transfers = [], writes = [], permits = [], posts = [];
  const receipt = amount => ({ type: "deposit", amount: String(amount), time: 100, tx: hash });
  const f = { ...m, transfers, writes, permits, posts, accountLoads: 0,
    signer: { address: owner, async write(call, submitted) { writes.push(call); submitted(hash); transfers.unshift(receipt(call.args[1])); return hash; }, async signTypedData(data) { permits.push(data); return `0x${"11".repeat(64)}1b`; } },
    async get(path) {
      if(path.startsWith("/history/")) return { transfers: structuredClone(transfers) };
      if(path.startsWith("/account/")) return { balance: "9999999999999", reserved:"0", withdrawNonce:"7", wallet: { usdcNonce: "7" } };
      if(path.startsWith("/deposit-address/")) return { address: m.depositAddressOf(pin.deposits,pin.box,owner), ...pin, pending: "0", minimum: "10000000" };
      throw Error(`Unexpected read ${path}`);
    },
    async post(path, body) { posts.push({path,body}); transfers.unshift(receipt(body.amount)); return { ok:true, tx:hash }; },
  };
  globalThis.__funding = f;
  m.setState({ owner, dialog:"deposit", config: { name:"Tape",chainId:1,addresses:{usdc:owner,deposits:pin.deposits,gateway:pin.box},usdcPermit:{name:"USD Coin",version:"2"} } });
  t.after(() => { globalThis.setTimeout=saved.timeout;Date.now=saved.now;delete globalThis.__funding; });
  return {...f, flow:()=>m.getState().depositFlows[owner.toLowerCase()], withdrawal:()=>m.getState().withdrawFlows[owner.toLowerCase()]};
}

test("deposit stages follow wallet, broadcast and indexed credit; repeated clicks send once", async t => {
  const f=fixture(t);let send;
  f.signer.write=async(call,submitted)=>{f.writes.push(call);await new Promise(resolve=>{send=()=>{submitted(hash);resolve();};});f.transfers.push({type:"deposit",amount:"50000000",time:100,tx:hash});return hash;};
  const pending=f.deposit(50_000000n);await flush();assert.equal(f.flow().stage,"wallet");
  assert.equal(await f.deposit(50_000000n),false);assert.equal(f.writes.length,1);
  f.setState({dialog:null});send();assert.equal(f.flow().stage,"confirming");
  assert.equal(await pending,true);assert.equal(f.flow().stage,"complete");assert.equal(f.flow().tx,hash);
});

test("wallet rejection stays retryable, preserves the exact amount and sends nothing", async t => {
  const f=fixture(t);f.signer.write=async()=>{throw Error("You declined the request in your wallet.");};
  assert.equal(await f.deposit(25_123456n),false);assert.equal(f.flow().stage,"error");
  assert.equal(f.flow().amount,"25123456");assert.match(f.flow().error,/declined/);assert.equal(f.posts.length,0);
});

test("withdrawals sign the exact amount, fresh nonce and connected destination once, surviving dialog close", async t => {
  const f=fixture(t);let approve;
  f.signer.signTypedData=async data=>{f.permits.push(data);await new Promise(resolve=>{approve=resolve;});return '0x11';};
  const pending=f.withdraw(25_123456n);await flush();assert.equal(f.withdrawal().stage,'wallet');
  assert.equal(await f.withdraw(25_123456n),false);f.setState({dialog:null});
  approve();assert.equal(await pending,true);assert.equal(f.withdrawal().stage,'complete');
  assert.equal(f.permits.length,1);assert.deepEqual(f.permits[0].message,{owner,to:owner,amount:25_123456n,nonce:7n,deadline:700n});
  assert.equal(f.posts.length,1);assert.equal(f.posts[0].path,'/withdraw');
});

test("a declined withdrawal preserves its amount and can retry with a new flow", async t => {
  const f=fixture(t);f.signer.signTypedData=async()=>{throw Error('You declined the request in your wallet.');};
  assert.equal(await f.withdraw(10_123456n),false);assert.equal(f.withdrawal().stage,'error');assert.equal(f.withdrawal().amount,'10123456');assert.equal(f.posts.length,0);
  f.signer.signTypedData=async()=> '0x11';assert.equal(await f.withdraw(10_123456n),true);assert.equal(f.withdrawal().stage,'complete');
});

test("emergency withdrawals use a direct wallet transaction and ignore disabled trading reservations", async t => {
  const f=fixture(t), originalGet=globalThis.__funding.get;
  f.setState({config:{...f.getState().config,addresses:{...f.getState().config.addresses,exchange:pin.box},recovery:{paused:true,available:true}}});
  globalThis.__funding.get=async path=>path==='/config'?f.getState().config:path.startsWith('/account/')?{balance:'25000000',reserved:'25000000',withdrawNonce:'1'}:originalGet(path);
  f.signer.write=async(call,submitted)=>{f.writes.push(call);submitted(hash);assert.equal(f.withdrawal().stage,'confirming');return hash;};
  assert.equal(await f.withdraw(25_000000n),true);
  assert.equal(f.writes[0].functionName,'emergencyWithdraw');
  assert.equal(f.writes[0].address,pin.box);
  assert.deepEqual(f.writes[0].args,[25_000000n]);
  assert.equal(f.posts.length,0);assert.equal(f.permits.length,0);assert.equal(f.withdrawal().stage,'complete');
});

test("unavailable recovery status cannot send a withdrawal to an unknown implementation", async t => {
  const f=fixture(t), originalGet=globalThis.__funding.get;
  f.setState({config:{...f.getState().config,recovery:{paused:true,available:false}}});
  globalThis.__funding.get=async path=>path==='/config'?f.getState().config:originalGet(path);
  assert.equal(await f.withdraw(1_000000n),false);
  assert.equal(f.writes.length,0);assert.equal(f.posts.length,0);assert.equal(f.permits.length,0);
});

test("withdrawal fresh balance and wallet changes are checked before any money request is sent", async t => {
  const f=fixture(t), accountGet=globalThis.__funding.get;
  globalThis.__funding.get=async path=>path.startsWith('/account/')?{balance:'25000000',reserved:'20000000',withdrawNonce:'1'}:accountGet(path);
  assert.equal(await f.withdraw(10_000000n),false);assert.equal(f.permits.length,0);assert.equal(f.posts.length,0);
  globalThis.__funding.get=accountGet;
  f.signer.signTypedData=async()=>{f.setState({owner:'0x2000000000000000000000000000000000000002'});return '0x11';};
  assert.equal(await f.withdraw(10_000000n),false);assert.equal(f.posts.length,0);
});

test("an interrupted withdrawal stays pending and cannot be blindly signed again", async t => {
  const f=fixture(t);globalThis.__funding.post=async()=>{throw Error('Response lost');};
  assert.equal(await f.withdraw(25_000000n),false);assert.equal(f.withdrawal().stage,'pending');
  assert.equal(await f.withdraw(25_000000n),false);assert.equal(f.permits.length,1);
});

test("withdrawal completion survives a failed account refresh and only new matching receipts resolve uncertainty", async t => {
  const f=fixture(t);globalThis.__funding.failRefresh=true;
  assert.equal(await f.withdraw(25_000000n),true);assert.equal(f.withdrawal().stage,'complete');
  const receipt={type:'withdraw',to:owner,amount:'25000000',time:100,tx:hash}, flow={...f.withdrawal(),baseline:[receipt]};
  assert.equal(f.withdrawalSince(flow,[receipt,{...receipt,type:'deposit'},{...receipt,amount:'1'},{...receipt,to:pin.box}]),undefined);
  assert.deepEqual(f.withdrawalSince(flow,[receipt,{...receipt,tx:'0x'+'cd'.repeat(32)}]),{...receipt,tx:'0x'+'cd'.repeat(32)});
});

test("profits and other balance changes cannot finish a deposit that has no indexed receipt", async t => {
  const f=fixture(t);f.signer.write=async(call,submitted)=>{f.writes.push(call);submitted(hash);return hash;};
  assert.equal(await f.deposit(50_000000n),true);assert.equal(f.flow().stage,"pending");assert.equal(f.flow().confirmed,true);
  assert.equal(await f.deposit(50_000000n),false,"an uncertain or uncredited deposit cannot be resubmitted as a retry");assert.equal(f.writes.length,1);
});

test("lost receipt response after broadcast is pending, while an explicit revert is a retryable failure", async t => {
  const f=fixture(t);f.signer.write=async(_,submitted)=>{submitted(hash);throw Error("RPC disconnected");};
  assert.equal(await f.deposit(50_000000n),true);assert.equal(f.flow().stage,"pending");assert.equal(f.flow().confirmed,false);
  f.setState({depositFlows:{}});
  f.signer.write=async(_,submitted)=>{submitted(hash);throw Object.assign(Error("Transaction reverted"),{transactionReverted:true});};
  assert.equal(await f.deposit(50_000000n),false);assert.equal(f.flow().stage,"error");assert.match(f.flow().error,/reverted/);
});

test("gas-sponsored permits sign only the requested amount and a fresh nonce", async t => {
  const f=fixture(t);assert.equal(await f.deposit(1_123456n,true),true);
  assert.equal(f.writes.length,0);assert.equal(f.permits.length,1);assert.equal(f.permits[0].message.value,1_123456n);assert.equal(f.permits[0].message.nonce,7n);
  assert.equal(f.posts.length,1);assert.equal(f.flow().stage,"complete");
});

test("an interrupted signed deposit response does not offer a duplicate submission", async t => {
  const f=fixture(t);globalThis.__funding.post=async()=>{throw Error("Connection lost");};
  assert.equal(await f.deposit(25_000000n,true),true);assert.equal(f.flow().stage,"pending");assert.match(f.flow().error,/response was interrupted/);
  assert.equal(await f.deposit(25_000000n,true),false);assert.equal(f.permits.length,1);
});

test("wallet switches and below-minimum transfers stop before wallet approval", async t => {
  const f=fixture(t);const original=globalThis.__funding.get;
  globalThis.__funding.get=async path=>{const answer=await original(path);if(path.startsWith("/deposit-address/"))f.setState({owner:pin.box});return answer;};
  assert.equal(await f.deposit(25_000000n),false);assert.equal(f.writes.length,0);assert.match(f.flow().error,/wallet changed/);
  f.setState({owner});globalThis.__funding.get=original;
  assert.equal(await f.deposit(1_000000n),false);assert.equal(f.writes.length,0);assert.match(f.flow().error,/at least/);
});

test("receipt differences preserve large integer precision and duplicate events, excluding rewards and withdrawals", t => {
  const f=fixture(t),base={type:"deposit",amount:"900719925474099312",time:100,tx:hash};
  assert.equal(f.depositCreditSince([base],[base,{...base},{...base,type:"reward"},{...base,type:"withdraw"}]),900719925474099312n);
  assert.equal(f.depositCreditSince([base],[base]),0n);
});

test("maximums and confirmation amounts retain all six decimals without rounding or repeated units", t => {
  const f=fixture(t);
  assert.equal(f.depositAmount("50123456",true),"50.123456");assert.equal(f.depositAmount("50000000",true),"50.00");
  assert.equal(f.depositAmount("1"),"0.000001");assert.equal(f.depositAmount("900719925474099312"),"900719925474.099312");
});
