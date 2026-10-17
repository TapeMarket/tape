/**
 * Prints what a few screens say, for a quick read after changing copy or figures.
 *
 *   node e2e/peek.mjs [site]        default http://127.0.0.1:4174
 */
import { chromium } from "playwright";

const SITE = (process.argv[2] ?? "http://127.0.0.1:4174").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => message.type() === "error" && errors.push(message.text()));

const text = async (selector) => (await page.locator(selector).first().innerText().catch(() => "(missing)")).replace(/\n+/g, " | ");

await page.goto(`${SITE}/staking`);
await page.waitForTimeout(4000);
console.log("staking / distribution:", await text('.panel:has(h2:text-is("Distribution"))'));
console.log("staking / rewards:     ", await text('.panel:has(h2:text-is("Rewards"))'));

await page.goto(`${SITE}/docs`);
await page.waitForTimeout(1500);
for (const id of ["bust", "win", "staking", "fees"]) {
  const body = await page.evaluate((heading) => {
    const out = [];
    let node = document.getElementById(heading)?.nextElementSibling;
    while (node && node.tagName !== "H2") {
      out.push(node.innerText.replace(/\s+/g, " ").trim());
      node = node.nextElementSibling;
    }
    return out.join("\n");
  }, id);
  console.log(`\n--- docs / ${id} ---\n${body}`);
}

await page.goto(`${SITE}/trade`);
await page.waitForTimeout(2500);
console.log("\nticket:", await text(".ticket"));
console.log(errors.length ? `\nerrors:\n${errors.join("\n")}` : "\nno errors logged");
await browser.close();
