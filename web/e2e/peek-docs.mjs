/**
 * Screenshots the part of the docs that explains what a win pays, for a look at it.
 *
 *   node web/e2e/peek-docs.mjs [site-url]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const SITE = process.argv[2] ?? "http://127.0.0.1:4173";
const SHOTS = new URL("./shots/", import.meta.url);
mkdirSync(SHOTS, { recursive: true });
const file = (name) => new URL(name, SHOTS).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } });
const problems = [];
page.on("pageerror", (error) => problems.push(error.message));
await page.goto(`${SITE}/docs`);
await page.locator("#win").waitFor({ timeout: 15_000 });
await page.locator("#win").scrollIntoViewIfNeeded();
await page.evaluate(() => document.getElementById("win").scrollIntoView({ block: "start" }));
await page.waitForTimeout(400);
await page.screenshot({ path: file("docs-win.png") });
await page.evaluate(() => document.getElementById("risks").scrollIntoView({ block: "start" }));
await page.waitForTimeout(300);
await page.screenshot({ path: file("docs-risks.png") });
const text = await page.locator(".docs").innerText();
for (const phrase of ["Size Impact", "A crowded side pays less", "Four things limit"]) {
  if (!text.includes(phrase)) problems.push(`the docs do not say "${phrase}"`);
}
await browser.close();
console.log(problems.length ? `problems:\n  ${problems.join("\n  ")}` : "ok: docs render, with the size sections in them");
process.exit(problems.length ? 1 : 0);
