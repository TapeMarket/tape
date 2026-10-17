/**
 * How fast the site is, in numbers. Cold loads in a fresh browser profile each time.
 *
 *   node e2e/speed.mjs <url> [--trade] [--runs=5]
 *
 * Reports, as medians: time to first byte, to DOM ready, to the first price on screen, bytes
 * transferred and request count. With --trade (preview mode only: it clicks through a play
 * account) it also times an order: click to "accepted" on screen, click to filled, close to gone.
 * Works on any site that shows a dollar price, so the same script can time someone else's.
 */
import { chromium } from "playwright";

const args = process.argv.slice(2);
const URL_ = args.find((a) => a.startsWith("http"));
const TRADE = args.includes("--trade");
const RUNS = Number(args.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? 5);
if (!URL_) {
  console.error("usage: node e2e/speed.mjs <url> [--trade] [--runs=5]");
  process.exit(2);
}

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};
const ms = (value) => (Number.isFinite(value) ? `${Math.round(value)} ms` : "n/a");

const browser = await chromium.launch({ headless: true });
const loads = [];
const trades = { accepted: [], filled: [], closed: [] };

for (let run = 0; run < RUNS; run++) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  let bytes = 0;
  let requests = 0;
  client.on("Network.loadingFinished", (event) => {
    bytes += event.encodedDataLength;
    requests += 1;
  });

  const started = Date.now();
  await page.goto(URL_, { waitUntil: "commit" });
  // A price is a dollar figure in the thousands with cents: $83,021.13 or $2,504.70.
  const price = await page
    .waitForFunction(() => /\$\d{1,3},\d{3}\.\d{2}/.test(document.body?.innerText ?? ""), null, { timeout: 30_000, polling: 50 })
    .then(() => Date.now() - started)
    .catch(() => NaN);
  const nav = await page.evaluate(() => {
    const [entry] = performance.getEntriesByType("navigation");
    return { ttfb: entry.responseStart, dom: entry.domContentLoadedEventEnd };
  });
  await page.waitForTimeout(1500);
  loads.push({ ttfb: nav.ttfb, dom: nav.dom, price, bytes, requests });

  if (TRADE) {
    await page.locator(".ticket .btn.big").click();
    await page.getByRole("button", { name: /Play account/ }).click();
    await page.locator(".bar-btn.acct b").waitFor({ timeout: 10_000 });
    await page.locator("#leverage").fill("500");
    await page.locator("#margin").fill("25");
    const rows = page.locator(".trade-bottom .tbl tbody tr");
    for (let i = 0; i < 3; i++) {
      const before = await rows.count();
      const click = Date.now();
      await page.getByRole("button", { name: "Long BTC", exact: true }).click();
      // "Accepted" is the row that says the order is waiting for its price.
      await page.getByText(/Filling at the next price/).first().waitFor({ timeout: 5_000 });
      trades.accepted.push(Date.now() - click);
      await page.waitForFunction((n) => [...document.querySelectorAll(".trade-bottom .tbl tbody tr")].filter((r) => r.textContent.includes("500x")).length > n, before, { timeout: 15_000, polling: 25 });
      trades.filled.push(Date.now() - click);
      await page.waitForTimeout(2200);
    }
    for (let i = 0; i < 3; i++) {
      const before = await rows.count();
      const click = Date.now();
      await rows.first().getByRole("button", { name: "Close", exact: true }).click();
      await page.waitForFunction((n) => document.querySelectorAll(".trade-bottom .tbl tbody tr").length < n, before, { timeout: 15_000, polling: 25 });
      trades.closed.push(Date.now() - click);
      await page.waitForTimeout(300);
    }
  }
  await context.close();
}
await browser.close();

console.log(`\n${URL_}   (${RUNS} cold loads, medians)`);
console.log(`  first byte            ${ms(median(loads.map((l) => l.ttfb)))}`);
console.log(`  page ready (DOM)      ${ms(median(loads.map((l) => l.dom)))}`);
console.log(`  first price on screen ${ms(median(loads.map((l) => l.price)))}   (worst ${ms(Math.max(...loads.map((l) => l.price)))})`);
console.log(`  downloaded            ${(median(loads.map((l) => l.bytes)) / 1024).toFixed(0)} KB in ${median(loads.map((l) => l.requests))} requests`);
if (TRADE) {
  console.log(`  order: click to accepted on screen   ${ms(median(trades.accepted))}   (worst ${ms(Math.max(...trades.accepted))})`);
  console.log(`  order: click to filled               ${ms(median(trades.filled))}   (worst ${ms(Math.max(...trades.filled))})`);
  console.log(`  close: click to position gone        ${ms(median(trades.closed))}   (worst ${ms(Math.max(...trades.closed))})`);
}
