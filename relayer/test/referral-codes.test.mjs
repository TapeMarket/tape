import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createReferralCodes } from "../src/referral-codes.mjs";
import { referralCodeMessage } from "../../shared/referral-code.mjs";
import { createApi, usernameMessage } from "../src/server.mjs";
import { createReferrals, referralMessage } from "../src/referrals.mjs";

const exchange = "0x1111111111111111111111111111111111111111";
const wallet = () => privateKeyToAccount(generatePrivateKey());
const log = { info() {}, warn() {}, error() {} };
const configOf = dir => ({ root: dir, dataDir: dir, chainId: 1, host: "127.0.0.1", port: 0, corsOrigin: "https://tapemarket.io", deployment: {} });
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "tape-referral-codes-"));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + "tape-referral-codes-")); rmSync(dir, { recursive: true }); });
  return dir;
}
function rig(t, options = {}) {
  const config = configOf(temp(t));
  const names = options.names ?? new Map();
  const chain = { addresses: { exchange }, publicClient: { verifyMessage: options.verify ?? verifyMessage } };
  const deps = { config, chain, log, addressOfName: name => names.get(name), file: options.file };
  return { registry: createReferralCodes(deps), deps, names };
}
async function body(who, code, domain = {}) {
  return { owner: who.address, code, signature: await who.signMessage({ message: referralCodeMessage({ code: code.trim().toLowerCase(), owner: who.address, chainId: 1, exchange, ...domain }) }) };
}
const refused = (promise, status) => assert.rejects(promise, error => error.status === status);

test("custom codes normalize, persist, reload and remain assigned to one wallet", async t => {
  const alice = wallet(), bob = wallet();
  const { registry, deps } = rig(t);
  assert.deepEqual(await registry.claim(await body(alice, " My_Code ")), { ok: true, code: "my_code" });
  assert.equal(registry.addressOf("MY_CODE"), alice.address.toLowerCase());
  assert.equal(registry.codeOf(alice.address), "my_code");
  const reloaded = createReferralCodes(deps);
  assert.equal(reloaded.addressOf("my_code"), alice.address.toLowerCase());
  await refused(reloaded.claim(await body(bob, "my_code")), 409);
  await refused(reloaded.claim(await body(alice, "another")), 409);
  assert.equal((await reloaded.claim(await body(alice, "my_code"))).ok, true);
});

test("claims reject wrong wallet, code, chain, exchange and malformed input", async t => {
  const alice = wallet(), bob = wallet();
  const { registry } = rig(t);
  const signed = await body(alice, "valid_code");
  await refused(registry.claim({ ...signed, owner: bob.address }), 401);
  await refused(registry.claim({ ...signed, code: "changed_code" }), 401);
  await refused(registry.claim(await body(alice, "valid_code", { chainId: 31337 })), 401);
  await refused(registry.claim(await body(alice, "valid_code", { exchange: bob.address })), 401);
  for (const code of [null, {}, [], "ab", "x".repeat(17), "has space", "dashed-code", "Ｋelvin", "a/b", "a\u0000bc"]) await refused(registry.claim({ ...signed, code }), 400);
  for (const owner of [null, {}, [alice.address], "wrong"]) await refused(registry.claim({ ...signed, owner }), 400);
  assert.equal(registry.codeOf(alice.address), null);
});

test("only one concurrent claimant can reserve a code; names appearing during verification also win", async t => {
  const alice = wallet(), bob = wallet();
  const pending = [];
  const { registry, names } = rig(t, { verify: () => new Promise(resolve => pending.push(resolve)) });
  const a = registry.claim(await body(alice, "same_code"));
  const b = registry.claim(await body(bob, "same_code"));
  pending.splice(0).forEach(resolve => resolve(true));
  const results = await Promise.allSettled([a, b]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
  const nameRace = registry.claim(await body(bob, "new_name"));
  names.set("new_name", alice.address.toLowerCase());
  pending.shift()(true);
  await refused(nameRace, 409);
});

test("failed persistence cannot reserve a code or return success; corrupt registries fail closed", async t => {
  const dir = temp(t), blocked = join(dir, "not-a-directory");
  writeFileSync(blocked, "blocked");
  const alice = wallet();
  const { registry, deps } = rig(t, { file: join(blocked, "codes.json") });
  await refused(registry.claim(await body(alice, "save_code")), 503);
  assert.equal(registry.codeOf(alice.address), null);
  assert.equal(registry.addressOf("save_code"), undefined);
  const corrupt = join(dir, "corrupt.json");
  writeFileSync(corrupt, JSON.stringify({ [alice.address]: "bad code" }));
  assert.throws(() => createReferralCodes({ ...deps, file: corrupt }), /Invalid referral-code registry/);
});

test("HTTP claims keep usernames independent and resolve custom links to the original reward wallet", async t => {
  const dir = temp(t), config = configOf(dir);
  const alice = wallet(), bob = wallet();
  let api;
  const chain = { addresses: { exchange }, abis: {}, publicClient: { verifyMessage }, read: async () => 0n };
  const referrals = createReferrals({ config, chain, log, tradesOf: () => 0, isSessionKey: async () => false, addressOfName: name => api.addressOfName(name), file: null });
  api = createApi({ config, chain, log, referrals, book: { onTick() {} }, store: {}, engine: {}, indexer: {}, hub: {}, source: { name: "test" } });
  const address = await api.listen();
  t.after(() => api.close());
  const origin = `http://127.0.0.1:${address.port}`;
  const post = async (path, body) => { const response = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, json: await response.json() }; };
  const username = async (who, name) => ({ owner: who.address, name, signature: await who.signMessage({ message: usernameMessage(name, who.address) }) });
  assert.equal((await post("/username", await username(alice, "alice_name"))).status, 200);
  assert.equal((await post("/referral-code", await body(bob, "alice_name"))).status, 409);
  assert.equal((await post("/referral-code", await body(alice, "alice_link"))).status, 200);
  assert.equal(api.nameOf(alice.address), "alice_name");
  assert.equal((await post("/username", await username(bob, "alice_link"))).status, 409);
  assert.equal((await post("/username", await username(alice, "new_display"))).status, 200);
  assert.equal(api.addressOfName("alice_link"), alice.address.toLowerCase());
  const page = await (await fetch(`${origin}/referrals/${alice.address}`)).json();
  assert.equal(page.code, "alice_link"); assert.equal(page.customCode, "alice_link");
  const binding = await post("/referral", { owner: bob.address, referrer: "ALICE_LINK", signature: await bob.signMessage({ message: referralMessage(bob.address, "ALICE_LINK") }) });
  assert.equal(binding.status, 200); assert.equal(binding.json.referrer, alice.address);
  referrals.onTrade({ owner: bob.address, time: Math.floor(Date.now() / 1000) + 1, fee: 4_000000n, margin: 100_000000n, leverage: 10 });
  assert.equal(referrals.payload(alice.address).earned, 1_000000n);
  assert.equal(JSON.parse(readFileSync(join(dir, "referral-codes-1.json"), "utf8"))[alice.address.toLowerCase()], "alice_link");
});
