import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { getContractAddress, zeroAddress } from "viem";
import { depositPinFrom } from "../deployment-pin.mjs";

const owner = "0x1000000000000000000000000000000000000001";
const depositContract = "0x2000000000000000000000000000000000000002";
const otherContract = "0x3000000000000000000000000000000000000003";
const pin = depositPinFrom({ chainId: 1, name: "Tape", deposits: depositContract });
const require = createRequire(import.meta.url);
async function load(pin) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/lib/deposits.ts", import.meta.url))],
    bundle: true, format: "cjs", platform: "node", write: false,
    external: ["viem"], define: { __MAINNET_DEPOSITS__: JSON.stringify(pin) }, logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}
const [pinned, unconfigured] = await Promise.all([load(pin), load(null)]);
const said = { deposits: pin.deposits, box: pin.box, address: pinned.depositAddressOf(pin.deposits, pin.box, owner) };

test("a fresh Tape deployment pins its own deposit contract and first CREATE box", () => {
  assert.deepEqual(pin, { deposits: depositContract, box: getContractAddress({ from: depositContract, nonce: 1n }) });
  assert.equal(depositPinFrom(null), null);
  assert.equal(depositPinFrom({ chainId: 1, name: "Tape" }), null);
});
test("another project's deployment, another chain and a zero contract cannot be pinned", () => {
  assert.throws(() => depositPinFrom({ chainId: 1, name: "Other", deposits: depositContract }));
  assert.throws(() => depositPinFrom({ chainId: 31337, name: "Tape", deposits: depositContract }));
  assert.throws(() => depositPinFrom({ chainId: 1, name: "Tape", deposits: zeroAddress }));
});
test("mainnet accepts a fresh deposit address derived from its build-time pin", () => {
  assert.equal(pinned.checkedDepositAddress(1, owner, said, pin.deposits), said.address);
});
test("a server cannot substitute the deposit contract, implementation or beneficiary", () => {
  const other = depositPinFrom({ chainId: 1, name: "Tape", deposits: otherContract });
  const lie = { ...other, address: pinned.depositAddressOf(other.deposits, other.box, owner) };
  assert.throws(() => pinned.checkedDepositAddress(1, owner, lie, other.deposits), pinned.DepositAddressMismatch);
  assert.throws(() => pinned.checkedDepositAddress(1, owner, { ...said, box: other.box }, pin.deposits), pinned.DepositAddressMismatch);
  assert.throws(() => pinned.checkedDepositAddress(1, otherContract, said, pin.deposits), pinned.DepositAddressMismatch);
});
test("an unconfigured mainnet build refuses deposits while local chains retain CREATE2 verification", () => {
  assert.throws(() => unconfigured.checkedDepositAddress(1, owner, said, pin.deposits), unconfigured.DepositAddressMismatch);
  assert.equal(unconfigured.checkedDepositAddress(31337, owner, said, pin.deposits), said.address);
  assert.throws(() => unconfigured.checkedDepositAddress(31337, owner, { ...said, address: otherContract }, pin.deposits), unconfigured.DepositAddressMismatch);
});
