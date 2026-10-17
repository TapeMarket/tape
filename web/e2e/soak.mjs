/**
 * Leaves the preview site running and trading for a while, and watches for anything going wrong
 * slowly: errors in the console (including the books failing their own audit), memory that only
 * grows, a page that stops responding.
 *
 *   node e2e/soak.mjs [site-url] [--minutes=4]
 */
import { chromium } from "playwright";

const args = process.argv.slice(2);
const SITE = args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4173";
const MINUTES = Number(args.find((a) => a.startsWith("--minutes="))?.split("=")[1] ?? 4);

const browser = await chromium.launch({ headless: true, args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console: ${message.text().slice(0, 200)}`);
});

const measure = () =>
  page.evaluate(() => {
    globalThis.gc?.();
    return { heap: performance.memory.usedJSHeapSize, nodes: document.querySelectorAll("*").length, stored: (localStorage.getItem("tape:preview:world:v4") ?? "").length };
  });
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

await page.goto(`${SITE}/trade`);
await page.locator(".ticket .btn.big").click();
await page.getByRole("button", { name: /Play account/ }).click();
await page.locator(".bar-btn.acct b").waitFor({ timeout: 15_000 });
await page.waitForTimeout(3000);
const start = await measure();
console.log(`\n${SITE}: trading at random for ${MINUTES} minutes\n  start   heap ${mb(start.heap)}, ${start.nodes} elements, world ${(start.stored / 1024).toFixed(0)} KB`);

const PAGES = ["/trade", "/vault", "/staking", "/portfolio", "/leaderboard", "/stats", "/dashboard", "/status", "/trade"];
const levers = [100, 250, 500, 750, 1000];
let orders = 0;
let closes = 0;
let slowest = 0;
const until = Date.now() + MINUTES * 60_000;
for (let round = 0; Date.now() < until; round++) {
  // Wander through the pages, and come back to trade.
  if (round % 6 === 5) {
    for (const path of PAGES) {
      await page.evaluate((to) => {
        history.pushState(null, "", to);
        dispatchEvent(new PopStateEvent("popstate"));
      }, path);
      await page.waitForTimeout(1200);
    }
  }
  const went = Date.now();
  await page.locator("#leverage").fill(String(levers[round % levers.length]));
  await page.locator("#margin").fill(String(100 + ((round * 37) % 120)));
  await page.getByRole("group", { name: "Direction" }).getByRole("button", { name: round % 2 ? /Short/ : /Long/ }).click();
  const order = page.locator(".ticket .btn.big");
  if (/^(Long|Short) /.test(await order.innerText())) {
    await order.click();
    orders += 1;
  }
  slowest = Math.max(slowest, Date.now() - went);
  await page.waitForTimeout(3500);
  if (round % 3 === 2) {
    const closeAll = page.locator(".ticket-foot").getByRole("button", { name: "Close All" });
    if (await closeAll.isEnabled()) {
      await closeAll.click();
      closes += 1;
    }
    await page.waitForTimeout(3000);
  }
}

await page.waitForTimeout(4000);
const end = await measure();
const balance = await page.locator(".bar-btn.acct b").innerText();
console.log(`  end     heap ${mb(end.heap)}, ${end.nodes} elements, world ${(end.stored / 1024).toFixed(0)} KB`);
console.log(`  ${orders} orders placed, ${closes} close-alls, slowest interaction ${slowest} ms, balance now ${balance}`);
console.log(`  heap grew ${mb(end.heap - start.heap)} (${(((end.heap - start.heap) / start.heap) * 100).toFixed(0)}%), elements ${end.nodes - start.nodes >= 0 ? "+" : ""}${end.nodes - start.nodes}`);
console.log(problems.length ? `  PROBLEMS:\n   ${[...new Set(problems)].slice(0, 8).join("\n   ")}` : "  no errors in the console, and the books passed their own audit throughout");
await browser.close();
process.exit(problems.length ? 1 : 0);
