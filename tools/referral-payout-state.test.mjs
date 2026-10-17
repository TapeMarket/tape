import {test} from 'node:test';
import assert from 'node:assert/strict';
import {payoutScanStart} from './referral-payout-state.mjs';
test('an uninitialized payout cursor cannot skip payments sent before the current head',()=>{
  assert.throws(()=>payoutScanStart(null,100n),/not initialized/);
  assert.throws(()=>payoutScanStart(undefined,100n),/not initialized/);
});
test('payout scans include every block after the last checkpoint, including a first uncounted payment',()=>{
  const firstUncountedPayment=99n;
  const start=payoutScanStart('98',100n);
  assert.ok(start<=firstUncountedPayment);
  assert.equal(start,99n);
  assert.equal(payoutScanStart(100n,100n),101n);
  assert.equal(payoutScanStart(0n,1n),1n);
});
test('an invalid, future or excessively stale checkpoint cannot authorize another payment',()=>{
  assert.throws(()=>payoutScanStart(-1n,100n),/invalid/);
  assert.throws(()=>payoutScanStart(101n,100n),/invalid/);
  assert.throws(()=>payoutScanStart(1n,2002n),/behind/);
});
