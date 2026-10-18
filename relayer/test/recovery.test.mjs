import test from "node:test";
import assert from "node:assert/strict";
import { refreshRecovery } from "../src/recovery.mjs";
const controller = "0x1111111111111111111111111111111111111111";
const exchange = "0x2222222222222222222222222222222222222222";
function fixture(read) {
  return { config: { deployment: { upgradeController: controller } }, chain: { addresses: { exchange }, publicClient: { readContract: read } } };
}
test("hybrid recovery status follows the controller and source-bound vault", async () => {
  const f = fixture(async request => request.functionName === "emergencyPaused" ? true : exchange);
  const state = await refreshRecovery(f);
  assert.equal(state.paused, true); assert.equal(state.available, true); assert.equal(state.custodyVault, exchange);
});
test("unavailable controller blocks writes until a successful status read", async () => {
  const f = fixture(async () => { throw Error("RPC unavailable"); });
  assert.equal((await refreshRecovery(f)).paused, true);
  assert.equal(f.config.recoveryState.available, false);
  f.chain.publicClient.readContract = async () => false;
  assert.equal((await refreshRecovery(f)).paused, false);
  assert.equal(f.config.recoveryState.available, true);
});
test("immutable historical deployments have no recovery monitor", async () => {
  const f = fixture(async () => { throw Error("Should not read"); });
  delete f.config.deployment.upgradeController;
  assert.equal(await refreshRecovery(f), null);
});
