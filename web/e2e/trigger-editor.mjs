// Exercise rejected saves in the real editor, with account actions stubbed: no chain or funds.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../", import.meta.url));
const built = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {TriggerEditor} from './src/components/Triggers';
    const position={id:'0x01',entryPrice:'10000000000',margin:'100000000',leverage:10,isLong:true,impactNotional:100000,bust:'9000000000'};
    const market={rateMultiplier:1000,positionMultiplier:100000000,maxKeepBps:9000,tick:1000000,bustBuffer:'0'};
    window.__saveWorks=false; window.__calls=[];
    const root=createRoot(document.getElementById('root'));
    window.__render=(p)=>root.render(React.createElement(TriggerEditor,{position:p,market,mark:10000000000n})); window.__render(position);`, resolveDir: root, loader: "js" },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", alias: { "@shared": fileURLToPath(new URL("../../shared", import.meta.url)) }, logLevel: "silent",
  plugins: [{ name: "fake-account-actions", setup(builder) {
    builder.onResolve({ filter: /lib\/actions$/ }, () => ({ path: "actions", namespace: "fake" }));
    builder.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export async function setTrigger(...args){window.__calls.push(args);return window.__saveWorks;} export async function cancelTrigger(...args){window.__calls.push(args);return window.__saveWorks;}", loader: "js" }));
  } }],
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage(); const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>'); await page.addScriptTag({ content: built.outputFiles[0].text });
  await page.getByRole("button", { name: "TP / SL", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Take profit and stop loss" });
  await editor.getByLabel("Take-profit price").fill("110");
  await editor.getByRole("button", { name: "Save", exact: true }).click({ timeout: 5000 });
  await editor.getByRole("alert").waitFor(); assert.equal(await editor.getByLabel("Take-profit price").inputValue(), "110");
  assert.equal(await editor.getByRole("button", { name: "Save", exact: true }).isEnabled(), true);
  await page.evaluate(() => { window.__saveWorks = true; });
  await editor.getByRole("button", { name: "Save", exact: true }).click({ timeout: 5000 }); await editor.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__calls.length), 2); assert.deepEqual(errors, []);
  console.log("PASS: rejected TP/SL save stays open with entered values; retry succeeds.");
  await page.evaluate(() => window.__render({id:'0x01',entryPrice:'10000000000',margin:'100000000',leverage:10,isLong:true,impactNotional:100000,bust:'9000000000',takeProfit:'11012345678'}));
  await page.locator('.trigger-pop').click(); await editor.waitFor();
  assert.equal(await editor.getByLabel("Take-profit price").inputValue(), "110.12345678");
  assert.equal(await editor.getByRole("button", {name:"Save",exact:true}).isDisabled(), true);
  assert.deepEqual(errors, []); console.log("PASS: reopening a saved trigger preserves all eight decimals and does not create an unintended edit.");
} finally { await browser.close(); }
