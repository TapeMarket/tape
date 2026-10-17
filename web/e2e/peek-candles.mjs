/**
 * Looks at the chart's Line / Candles switch on a desktop and on a phone.
 *
 *   node web/e2e/peek-candles.mjs [site-url]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const SITE = process.argv[2] ?? "http://127.0.0.1:4173";
const SHOTS = new URL("./shots/", import.meta.url);
mkdirSync(SHOTS, { recursive: true });
const file = (name) => new URL(name, SHOTS).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const problems = [];
const browser = await chromium.launch();

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
]) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (error) => problems.push(`${name}: ${error.message}`));
  await page.goto(`${SITE}/trade`);
  const pill = page.locator(".chart-pill");
  await pill.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(5_000);
  const pressed = async () => (await pill.locator('button[aria-pressed="true"]').innerText()).trim();
  if ((await pressed()) !== "Line") problems.push(`${name}: the chart does not open on Line`);
  await page.locator(".trade-chart").screenshot({ path: file(`candles-${name}-line.png`) });

  await pill.getByRole("button", { name: "Candles" }).click();
  await page.waitForTimeout(4_000);
  if ((await pressed()) !== "Candles") problems.push(`${name}: Candles is not lit after the click`);
  if ((await page.getByLabel("Chart step").inputValue()) !== "60") problems.push(`${name}: Candles did not open on one minute`);
  await page.locator(".trade-chart").screenshot({ path: file(`candles-${name}-candles.png`) });

  // Another step, away to Line and back: each kind comes back at the step it was left on.
  await page.getByLabel("Chart step").selectOption({ label: "15m" });
  await pill.getByRole("button", { name: "Line" }).click();
  if ((await page.getByLabel("Chart step").inputValue()) !== "0") problems.push(`${name}: Line did not come back on Tick`);
  await pill.getByRole("button", { name: "Candles" }).click();
  if ((await page.getByLabel("Chart step").inputValue()) !== "900") problems.push(`${name}: Candles did not come back on 15m`);
  await page.waitForTimeout(2_500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) problems.push(`${name}: the page overflows sideways by ${overflow}px`);
  await page.close();
}
await browser.close();
console.log(problems.length ? `problems:\n  ${problems.join("\n  ")}` : "ok: Line and Candles switch on a desktop and on a phone");
process.exit(problems.length ? 1 : 0);
