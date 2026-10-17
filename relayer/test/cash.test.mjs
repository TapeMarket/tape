import test from "node:test";
import assert from "node:assert/strict";
import { cashExposureLimit, createEngine } from "../src/engine.mjs";
test("intake and status keep the immutable cash ceiling even with weaker or disabled extra checks", () => {
  const cash = 10_000n * 1_000_000n;
  const cap = 2_500_000n * 1_000_000n;
  assert.equal(cashExposureLimit(cash, 2_000_000, 50), cap);
  assert.equal(cashExposureLimit(cash, 20_000_000, 500), cap);
  assert.equal(cashExposureLimit(cash, 0, 0), cap);
  assert.equal(cashExposureLimit(cash, 1_000_000, 10), 1_100_000n * 1_000_000n);
  assert.equal(cashExposureLimit(0n, 2_000_000, 50), 2_000_000n * 1_000_000n);
});

test("intake never borrows capacity from queued or queue-funded claims", () => {
  const usd = 1_000_000n;
  assert.equal(cashExposureLimit(10_000n*usd,2_000_000,50,5_000n*usd),2_250_000n*usd);
  assert.equal(cashExposureLimit(100n*usd,2_000_000,50,500n*usd),2_000_000n*usd);
  assert.equal(cashExposureLimit(100n*usd,20_000_000,500,500n*usd),2_000_000n*usd);
  const store={house:{lpCash:10_000n*usd,totalQueued:4_000n*usd,debtMarginOpen:1_000n*usd}};
  const engine=createEngine({config:{root:'.',dataDir:'cache/nonexistent-audit-cash',chainId:1,deployment:{name:'Tape'},cashFloorUsd:2_000_000,cashMultiple:50},chain:{addresses:{exchange:'0x1111111111111111111111111111111111111111',sessions:'0x2222222222222222222222222222222222222222'},publicClient:{}},store,log:{info(){},error(){},warn(){}},book:{},source:{},hub:{},queue:{}});
  const before=engine.cashRoom();
  assert.equal(before,2_250_000n*usd);
  // Paying a queued claim changes both cash and queued liability equally, never capacity.
  store.house.lpCash-=2_000n*usd;store.house.totalQueued-=2_000n*usd;
  assert.equal(engine.cashRoom(),before);
  // Spending a claim as margin also leaves its backing committed.
  store.house.totalQueued-=1_000n*usd;store.house.debtMarginOpen+=1_000n*usd;
  assert.equal(engine.cashRoom(),before);
});
