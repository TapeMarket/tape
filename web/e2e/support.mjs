// Real chat UI and real local support backend. The signing key below is a public test fixture.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { createSupport } from "../../relayer/src/support.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "tape-chat-e2e-"));
const shots = process.argv.find(value => value.startsWith("--shots="))?.slice(8);
if (shots) await mkdir(shots, { recursive: true });
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const api = await createSupport({ dir, admins: [account.address], verifyMessage, log: console });
const html = await readFile(join(root, "dist/index.html"), "utf8");
const cssFile = html.match(/href="(\/assets\/index-[^"]+\.css)"/)[1];
const css = await readFile(join(root, "dist", cssFile));
let js;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/support/")) {
      let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 32768) throw Error("Too big"); }
      await api.handle({ req, res, path: url.pathname, url, body: raw ? JSON.parse(raw) : undefined, client: req.socket.remoteAddress,
        send: (response, status, value) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); } });
    } else if (url.pathname === "/fixture.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(js); }
    else if (url.pathname === "/fixture.css") { res.writeHead(200, { "content-type": "text/css" }); res.end(css); }
    else if (url.pathname.startsWith("/assets/")) { res.writeHead(200, { "content-type": "font/woff2" }); res.end(await readFile(join(root, "dist", url.pathname))); }
    else { res.writeHead(200, { "content-type": "text/html" }); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>'); }
  } catch (error) { if (!res.headersSent) res.writeHead(error.status ?? 500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const result = await build({ stdin: { resolveDir: root, loader: "js", contents: `
 import React from 'react';import{createRoot}from'react-dom/client';import{Support}from'./src/components/Support';import{SupportInbox}from'./src/pages/SupportInbox';import{setState}from'./src/lib/store';
 const staff=location.pathname==='/inbox';if(staff)setState({owner:'${account.address}'});
 createRoot(document.getElementById('root')).render(staff?React.createElement(SupportInbox):React.createElement(Support));
` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "import.meta.env": JSON.stringify({ VITE_PREVIEW: "0", VITE_API_URL: origin }) }, logLevel: "silent", plugins: [{ name: "staff-fixture", setup(b) {
  b.onResolve({ filter: /(?:lib\/wallet|\.\/wallet)$/ }, () => ({ path: "wallet", namespace: "fixture" }));
  b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `export const getSigner=async()=>({address:'${account.address}',signMessage:message=>window.__signSupport(message)});` }));
} }] });
js = result.outputFiles[0].contents;
const browser = await chromium.launch();
const errors = [];
try {
  const customerContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const customer = await customerContext.newPage(); customer.on("pageerror", error => errors.push(error.message));
  await customer.goto(origin);
  await customer.getByRole("button", { name: "Open support chat" }).click();
  await customer.getByRole("heading", { name: "What can we help with?" }).waitFor();
  await customer.getByRole("button", { name: "Deposits", exact: true }).click();
  await customer.getByLabel("Your message", { exact: true }).fill("My deposit has not appeared. Can you check it?");
  await customer.getByRole("button", { name: "Send message", exact: true }).click();
  await customer.getByText("My deposit has not appeared. Can you check it?", { exact: true }).waitFor();
  assert.equal(await customer.locator(".support-message.staff").count(), 0);
  const identity = await customer.evaluate(() => JSON.parse(localStorage.getItem("tape:support:conversation")));
  assert.equal((await fetch(`${origin}/support/inbox`)).status, 401);
  console.log("PASS: a customer starts a private conversation without a wallet; no fabricated agent reply.");

  const staffContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const staff = await staffContext.newPage(); staff.on("pageerror", error => errors.push(error.message));
  await staff.exposeFunction("__signSupport", message => account.signMessage({ message }));
  await staff.goto(`${origin}/inbox`);
  await staff.getByRole("button", { name: "Sign in to inbox" }).click();
  await staff.locator(".support-inbox-list button").first().waitFor();
  await staff.locator(".support-inbox-list button").first().click();
  await staff.getByText("My deposit has not appeared. Can you check it?", { exact: true }).last().waitFor();
  await staff.getByRole("button", { name: "Go online" }).click();
  await staff.getByLabel("Reply to customer").fill("I’m checking your deposit now. Which transaction hash did you send?");
  const start = performance.now();
  await staff.getByRole("button", { name: "Send reply", exact: true }).click();
  await customer.getByText("I’m checking your deposit now. Which transaction hash did you send?", { exact: true }).waitFor();
  assert.ok(performance.now() - start < 3000);
  assert.equal(await customer.locator(".support-message.staff").count(), 1);
  console.log("PASS: authorized wallet sign-in, inbox, live human reply delivered over the private stream.");
  if (shots) { await staff.screenshot({ path: join(shots, "inbox-desktop.png"), fullPage: true }); await customer.screenshot({ path: join(shots, "chat-desktop.png") }); }

  await staff.getByRole("button", { name: "Mark resolved" }).click();
  await customer.getByText("Need anything else? Send a message to reopen this conversation.").waitFor();
  await customer.getByLabel("Your message", { exact: true }).fill("Here is the transaction hash.");
  await customer.getByRole("button", { name: "Send message", exact: true }).click();
  await staff.locator(".support-inbox-thread").getByText("Here is the transaction hash.", { exact: true }).waitFor();
  await customer.reload();
  await customer.getByRole("button", { name: "Open support chat" }).click();
  await customer.getByText("Here is the transaction hash.", { exact: true }).waitFor();
  assert.equal((await customer.evaluate(() => JSON.parse(localStorage.getItem("tape:support:conversation")))).id, identity.id);
  await customerContext.setOffline(true);
  await customer.getByLabel("Your message", { exact: true }).fill("Do you have an update?");
  await customer.getByRole("button", { name: "Send message", exact: true }).click();
  await customer.getByRole("alert").waitFor();
  assert.equal(await customer.getByLabel("Your message", { exact: true }).inputValue(), "Do you have an update?");
  await customerContext.setOffline(false);
  await customer.getByRole("button", { name: "Send message", exact: true }).click();
  await customer.getByText("Do you have an update?", { exact: true }).waitFor();
  console.log("PASS: resolution/reopening, browser recovery and failed-send retry preserve the conversation.");

  for (const width of [390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin); await page.getByRole("button", { name: "Open support chat" }).click();
    await page.getByRole("heading", { name: "What can we help with?" }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.getByLabel("Your message", { exact: true }).isVisible());
    if (shots) await page.screenshot({ path: join(shots, `chat-mobile-${width}.png`) });
    await page.getByLabel("Your message", { exact: true }).fill("Deposit question "+"x".repeat(500));
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.locator(".support-message.customer").waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".support-chat").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Open support chat" }).evaluate(el => el === document.activeElement), true);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS: 390px/320px layouts, long messages, Escape and focus restoration; no runtime errors.");
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
