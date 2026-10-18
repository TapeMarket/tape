import test from "node:test";
import assert from "node:assert/strict";
import { requireCompatible } from "./hybrid-layout.mjs";

const original = [{ label: "balances", slot: "8", offset: 0, type: { label: "mapping(address => uint256)", bytes: "32" } }];
test("storage guard allows append-only additions", () => {
  requireCompatible(original, [...original, { label: "newField", slot: "30", offset: 0 }], "candidate");
});
test("storage guard rejects moves, renames, retypes, removed fields and packed offsets", () => {
  for (const patch of [{ slot: "9" }, { label: "other" }, { type: { label: "uint128", bytes: "16" } }, { offset: 1 }]) {
    assert.throws(() => requireCompatible(original, [{ ...original[0], ...patch }], "candidate"), /incompatible storage/);
  }
  assert.throws(() => requireCompatible(original, [], "candidate"), /removed/);
});
