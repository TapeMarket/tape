/**
 * The picture of the trading screen that the landing page shows (public/img/terminal.png): the
 * real page, as a visitor without a wallet sees it. Run it again when the trading screen changes.
 *
 *   node e2e/shot-terminal.mjs [site] [out]      default https://tapemarket.io, public/img/terminal.png
 */
import { chromium } from "playwright";

const SITE = (process.argv[2] ?? "https://tapemarket.io").replace(/\/$/, "");
const OUT = process.argv[3] ?? new URL("../public/img/terminal.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 850 } });
  await page.goto(`${SITE}/trade`, { waitUntil: "domcontentloaded" });
  // The chart draws its day of history a moment after the first prices arrive.
  await page.waitForTimeout(6000);
  // Candles show the whole day at a glance; the line of the last minutes says less in a small picture.
  await page.getByRole("button", { name: "Candles", exact: true }).click().catch(() => {});
  await page.waitForTimeout(4000);
  // The chart, the ticket and the first line of the tables: below that a visitor's page is empty.
  await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 1360, height: 644 } });
  console.log(`saved ${OUT}`);
} finally {
  await browser.close();
}
