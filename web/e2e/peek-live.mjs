/**
 * A look at the published site in real mode, without a wallet: does it load, does it reach its
 * relayer, are prices on the screen, and did the browser log an error (a security policy that does
 * not name the relayer shows up here as a refused connection).
 *
 *   node e2e/peek-live.mjs [site]        default https://tapemarket.io
 */
import { chromium } from "playwright";

const SITE = (process.argv[2] ?? "https://tapemarket.io").replace(/\/$/, "");
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const refused = [];
  const asked = new Set();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("requestfailed", (request) => refused.push(`${request.url().slice(0, 90)} (${request.failure()?.errorText})`));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== SITE) asked.add(url.origin);
  });

  for (const path of ["/", "/trade", "/status", "/docs"]) {
    const response = await page.goto(`${SITE}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(path === "/trade" ? 7000 : 3500);
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const seen =
      path === "/"
        ? `landing page: ${/leverage/.test(body) && /onchain on Ethereum/.test(body) ? "yes" : "NO"}; live prices in its strip: ${/\b\d{2,3},\d{3}\.\d/.test(body) ? "yes" : "NO"}`
        : path === "/trade"
        ? `prices on screen: ${/\b\d{2,3},\d{3}\.\d/.test(body) ? "yes" : "NO"}; preview label: ${/preview/i.test(body) ? "YES" : "no"}`
        : path === "/status"
          ? `prices from: ${(/Prices from\s*([A-Za-z ,()]+?)(?= [A-Z][a-z]+ |$)/.exec(body) ?? [])[1] ?? "?"}; says Hyperliquid: ${/Hyperliquid/.test(body) ? "yes" : "NO"}`
          : `docs name the price signer: ${/price signer/i.test(body) ? "yes" : "NO"}`;
    console.log(`${path.padEnd(8)} HTTP ${response.status()}  ${seen}`);
    if (response.status() !== 200) failed = true;
  }
  console.log(`other hosts the page talked to: ${[...asked].join(", ") || "none"}`);
  // The event stream is cut when the page moves on: that one is not a failure.
  const real = refused.filter((r) => !/ERR_ABORTED/.test(r));
  console.log(real.length ? `refused requests:\n  ${real.join("\n  ")}` : "no request was refused");
  console.log(errors.length ? `errors logged:\n  ${errors.join("\n  ")}` : "no errors logged");
  if (real.length || errors.length) failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
