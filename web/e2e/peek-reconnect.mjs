/**
 * Does a page that lost its relayer get it back by itself?
 *
 * A relayer that is restarting answers the page's live stream with an error for a few seconds. A
 * browser does not retry a stream that was answered with an error, so the page has to. This plays
 * that: the stream is answered 502 for a while, then let through again, and the page must go from
 * "Offline" back to live prices without a reload. Nothing is sent to the exchange.
 *
 *   node e2e/peek-reconnect.mjs [site]        default https://tapemarket.io
 */
import { chromium } from "playwright";

const SITE = (process.argv[2] ?? "https://tapemarket.io").replace(/\/$/, "");
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let refused = 0;
  const down = (route) => {
    refused += 1;
    return route.fulfill({ status: 502, contentType: "text/html", body: "<h1>502 Bad gateway</h1>" });
  };
  await page.route("**/stream*", down);
  await page.goto(`${SITE}/trade`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  const text = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const offline = /Connection to the relayer dropped/.test(await text());
  console.log(`relayer answering 502: the page says it is offline: ${offline ? "yes" : "NO"} (${refused} tries refused)`);

  await page.unroute("**/stream*", down);
  let back = false;
  const started = Date.now();
  while (Date.now() - started < 25_000 && !back) {
    await page.waitForTimeout(1000);
    back = !/Connection to the relayer dropped|Offline/.test(await text());
  }
  console.log(`relayer back: ${back ? `the page is live again after ${Math.round((Date.now() - started) / 1000)}s, without a reload` : "THE PAGE STAYED OFFLINE for 25s"}`);
  if (!offline || !back) failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
