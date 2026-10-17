/**
 * Tape's X (Twitter) profile picture and header, drawn from the same wordmark, mark, typeface and
 * market logos as the site, and written as PNGs at twice the size X shows them.
 *
 *   node tools/build-x-assets.mjs [out-dir]      default ~/Desktop/tape-x
 *
 *   tape-avatar.png   800 x 800    X shows 400 x 400, cropped to a circle
 *   tape-banner.png   3000 x 1000  X shows 1500 x 500; the profile picture covers its lower left
 */
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Playwright is installed with the site.
import { chromium } from "../web/node_modules/playwright/index.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = process.argv[2] ?? join(homedir(), "Desktop", "tape-x");
mkdirSync(OUT, { recursive: true });

const brand = readFileSync(join(ROOT, "web/src/components/Wordmark.tsx"), "utf8");
const WORD = /export const WORDMARK_PATH = "([^"]+)"/.exec(brand)[1];
const MARK = /className="mark"[\s\S]*?d="([^"]+)"/.exec(brand)[1];
const font = readFileSync(join(ROOT, "web/src/assets/fonts/archivo-latin-wdth-wght-normal.woff2")).toString("base64");
const icon = (name) => `data:image/png;base64,${readFileSync(join(ROOT, "web/public/img", `${name}.png`)).toString("base64")}`;

const BLUE = "#1640ff";
const NAVY = "#0a1638";
const head = `<style>
@font-face { font-family: Archivo; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }
* { margin: 0; box-sizing: border-box; }
body { font-family: Archivo, sans-serif; -webkit-font-smoothing: antialiased; }
</style>`;

const avatar = `<!doctype html><html><head>${head}<style>
body { width: 800px; height: 800px; background: ${BLUE}; display: grid; place-items: center; }
svg { width: 494px; height: 494px; }
</style></head><body>
<svg viewBox="0 0 160 160"><path fill="#fff" fill-rule="evenodd" d="${MARK}"/></svg>
</body></html>`;

const markets = ["btc", "eth", "sol", "xrp", "doge", "gold", "spx", "tsla", "nvda", "aapl"];
const tickers = ["BTC", "ETH", "SOL", "XRP", "DOGE", "GOLD", "S&amp;P 500", "TSLA", "NVDA", "AAPL"];
const banner = `<!doctype html><html><head>${head}<style>
body { width: 3000px; height: 1000px; background: ${BLUE}; position: relative; overflow: hidden; color: #fff; }
.copy { position: absolute; left: 0; right: 0; top: 150px; display: grid; justify-items: center; gap: 46px; }
.copy svg { height: 210px; }
.copy p { font-size: 74px; font-weight: 600; font-stretch: 106%; letter-spacing: -0.02em; }
.copy p span { opacity: 0.72; font-weight: 500; }
.tape { position: absolute; left: -100px; right: -100px; top: 690px; height: 150px; background: #fff; transform: rotate(-2.2deg);
  display: flex; align-items: center; justify-content: center; gap: 54px; box-shadow: 0 30px 60px -30px rgba(10, 22, 56, 0.55); }
.tape div { display: flex; align-items: center; gap: 18px; color: ${NAVY}; font-size: 50px; font-weight: 650; font-stretch: 104%; white-space: nowrap; }
.tape img { width: 62px; height: 62px; border-radius: 50%; }
</style></head><body>
<div class="copy">
  <svg viewBox="0 0 600 160"><path fill="#fff" fill-rule="evenodd" d="${WORD}"/></svg>
  <p>Perps at up to 1000x, on Ethereum <span>· tapemarket.io</span></p>
</div>
<div class="tape">${markets.map((m, i) => `<div><img src="${icon(m)}">${tickers[i]}</div>`).join("")}</div>
</body></html>`;

const browser = await chromium.launch();
try {
  for (const [name, html, width, height] of [
    ["tape-avatar.png", avatar, 800, 800],
    ["tape-banner.png", banner, 3000, 1000],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(OUT, name) });
    await page.close();
    console.log("wrote", join(OUT, name));
  }
} finally {
  await browser.close();
}
