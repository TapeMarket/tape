/**
 * Looks at the price chart the way a visitor meets it: how much history is drawn a few seconds
 * after the page opens, on a first visit and again after a reload, and what the price requests did.
 *
 *   node web/e2e/peek-chart.mjs [site-url]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const SITE = process.argv[2] ?? "http://127.0.0.1:4173";
const SHOTS = new URL("./shots/", import.meta.url);
mkdirSync(SHOTS, { recursive: true });
const file = (name) => new URL(name, SHOTS).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const requests = [];
page.on("response", (res) => {
  const url = res.url();
  if (/coinbase/.test(url)) requests.push(`${res.status()} ${url.replace(/^https?:\/\//, "").slice(0, 110)}`);
});
page.on("requestfailed", (req) => {
  if (/coinbase/.test(req.url())) requests.push(`FAILED (${req.failure()?.errorText}) ${req.url().replace(/^https?:\/\//, "").slice(0, 110)}`);
});

/** The span of time on the chart's axis, read off its labels. */
const axis = () =>
  page.evaluate(() => {
    const canvases = [...document.querySelectorAll(".chart canvas")];
    return { canvases: canvases.length, width: canvases[0]?.clientWidth ?? 0 };
  });

for (const [label, wait] of [
  ["first visit, 6 s in", 6_000],
  ["first visit, 40 s in", 34_000],
]) {
  if (label.startsWith("first visit, 6")) await page.goto(`${SITE}/trade`);
  await page.waitForTimeout(wait);
  await page.locator(".trade-chart").screenshot({ path: file(`chart-${label.replace(/[^a-z0-9]+/gi, "-")}.png`) });
  console.log(label, JSON.stringify(await axis()));
}
await page.goto(`${SITE}/trade`);
await page.waitForTimeout(6_000);
await page.locator(".trade-chart").screenshot({ path: file("chart-after-a-reload.png") });
console.log("after a reload, 6 s in");
console.log(requests.join("\n"));
await browser.close();
