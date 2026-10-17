import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSupport } from "../src/support.mjs";

const agent = privateKeyToAccount(`0x${"11".repeat(32)}`);
const a = { id: "a".repeat(32), token: "1".repeat(64) };
const b = { id: "b".repeat(32), token: "2".repeat(64) };
const auth = value => `${value.id}.${value.token}`;
const initial = (value = a, messageId = "initial_message_001") => ({ ...value, topic: "Deposits", text: "My deposit needs checking", messageId });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "tape-support-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let time = 1_800_000_000_000;
  const options = { dir, admins: [agent.address], verifyMessage, now: () => time, log: { warn() {} } };
  let api = await createSupport(options);
  const call = async (path, { body, token, client = "test" } = {}) => {
    const req = { method: body === undefined ? "GET" : "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) } };
    const res = new EventEmitter();
    res.setHeader = () => {};
    let result;
    await api.handle({ req, res, path: path.split("?")[0], url: new URL(path, "http://local"), body, client,
      send: (_, status, data) => { result = { status, data }; } });
    return result;
  };
  const login = async () => {
    const { data: challenge } = await call("/support/auth/challenge", { body: { owner: agent.address } });
    const signature = await agent.signMessage({ message: challenge.message });
    return (await call("/support/auth", { body: { nonce: challenge.nonce, signature } })).data.token;
  };
  return { dir, call, login, advance: ms => { time += ms; }, restart: async () => { api = await createSupport(options); } };
}

test("customer conversations persist without exposing bearer secrets on disk", async t => {
  const f = await fixture(t);
  const { data } = await f.call("/support/conversations", { body: initial() });
  assert.equal(data.messages[0].role, "customer");
  assert.equal(data.online, false);
  assert.equal(data.secretHash, undefined);
  const disk = await readFile(join(f.dir, `${a.id}.json`), "utf8");
  assert.equal(disk.includes(a.token), false);
  await f.restart();
  assert.equal((await f.call(`/support/conversations/${a.id}`, { token: auth(a) })).data.messages.length, 1);
});

test("guessing an id, using another conversation token, and forging staff roles cannot read or impersonate staff", async t => {
  const f = await fixture(t);
  await f.call("/support/conversations", { body: initial() });
  await f.call("/support/conversations", { body: initial(b), client: "second" });
  await assert.rejects(f.call(`/support/conversations/${a.id}`, { token: auth(b) }), e => e.status === 401);
  await assert.rejects(f.call(`/support/tickets/${a.id}`, { token: auth(a) }), e => e.status === 401);
  await assert.rejects(f.call("/support/inbox"), e => e.status === 401);
  const { data } = await f.call(`/support/conversations/${a.id}/messages`, { token: auth(a), body: { role: "staff", text: "<script>bad()</script>", messageId: "second_message_0001" } });
  assert.equal(data.messages.at(-1).role, "customer");
  assert.equal(data.messages.at(-1).text, "<script>bad()</script>");
});

test("staff sign-in uses an authorized wallet, a single-use challenge and an expiring session", async t => {
  const f = await fixture(t);
  await assert.rejects(f.call("/support/auth/challenge", { body: { owner: `0x${"22".repeat(20)}` } }), e => e.status === 403);
  const { data: challenge } = await f.call("/support/auth/challenge", { body: { owner: agent.address } });
  const signature = await agent.signMessage({ message: challenge.message });
  const { data: session } = await f.call("/support/auth", { body: { nonce: challenge.nonce, signature } });
  await assert.rejects(f.call("/support/auth", { body: { nonce: challenge.nonce, signature } }), e => e.status === 401);
  assert.equal((await f.call("/support/inbox", { token: session.token })).status, 200);
  f.advance(8 * 60 * 60_000 + 1);
  await assert.rejects(f.call("/support/inbox", { token: session.token }), e => e.status === 401);
});

test("customer send retries are idempotent, and concurrent writes retain every message", async t => {
  const f = await fixture(t);
  await f.call("/support/conversations", { body: initial() });
  await f.call("/support/conversations", { body: initial() });
  const send = n => f.call(`/support/conversations/${a.id}/messages`, { token: auth(a), body: { text: `Message ${n}`, messageId: `message_reference_${n}` } });
  await Promise.all([send(1), send(2), send(3), send(1)]);
  const { data } = await f.call(`/support/conversations/${a.id}`, { token: auth(a) });
  assert.equal(data.messages.length, 4);
  assert.deepEqual(new Set(data.messages.map(m => m.text)), new Set([initial().text, "Message 1", "Message 2", "Message 3"]));
  await assert.rejects(f.call(`/support/conversations/${a.id}/messages`, { token: auth(a), body: { text: "Changed retry", messageId: "message_reference_1" } }), e => e.status === 409);
});

test("only actual staff replies reach the conversation, resolved tickets reopen on a new customer message", async t => {
  const f = await fixture(t);
  const token = await f.login();
  await f.call("/support/conversations", { body: initial() });
  assert.equal((await f.call("/support/inbox", { token })).data.conversations[0].unread, 1);
  await f.call(`/support/tickets/${a.id}/seen`, { token, body: {} });
  assert.equal((await f.call("/support/inbox", { token })).data.conversations[0].unread, 0);
  await f.call(`/support/tickets/${a.id}/messages`, { token, body: { text: "Checking the transfer now.", messageId: "staff_message_00001" } });
  assert.equal((await f.call(`/support/conversations/${a.id}`, { token: auth(a) })).data.messages.at(-1).role, "staff");
  await f.call(`/support/tickets/${a.id}/resolve`, { token, body: {} });
  assert.equal((await f.call(`/support/conversations/${a.id}`, { token: auth(a) })).data.status, "closed");
  await f.call(`/support/conversations/${a.id}/messages`, { token: auth(a), body: { text: "One more question", messageId: "customer_followup_1" } });
  assert.equal((await f.call(`/support/conversations/${a.id}`, { token: auth(a) })).data.status, "open");
});

test("presence is opt-in and expires after the staff heartbeat stops", async t => {
  const f = await fixture(t);
  const token = await f.login();
  assert.equal((await f.call("/support/status")).data.online, false);
  await f.call("/support/presence", { token, body: { available: true } });
  assert.equal((await f.call("/support/status")).data.online, true);
  f.advance(45_001);
  assert.equal((await f.call("/support/status")).data.online, false);
  await f.call("/support/logout", { token, body: {} });
  await assert.rejects(f.call("/support/inbox", { token }), e => e.status === 401);
});

test("expired conversations are deleted and malformed input, oversized messages and spam are rejected", async t => {
  const f = await fixture(t);
  await assert.rejects(f.call("/support/conversations", { body: { ...initial(), id: "../secret" } }), e => e.status === 400);
  await assert.rejects(f.call("/support/conversations", { body: { ...initial(), text: "x".repeat(3001) } }), e => e.status === 400);
  await assert.rejects(f.call("/support/conversations", { body: { ...initial(), website: "bot" } }), e => e.status === 400);
  await f.call("/support/conversations", { body: initial() });
  for (let n = 0; n < 15; n++) await f.call(`/support/conversations/${a.id}/messages`, { token: auth(a), body: { text: "Test", messageId: `rate_test_message_${n}` } });
  await assert.rejects(f.call(`/support/conversations/${a.id}/messages`, { token: auth(a), body: { text: "One more", messageId: "rate_test_message_16" } }), e => e.status === 429);
  f.advance(91 * 86_400_000);
  await f.restart();
  assert.deepEqual(await readdir(f.dir), []);
  await assert.rejects(f.call(`/support/conversations/${a.id}`, { token: auth(a) }), e => e.status === 401);
});
