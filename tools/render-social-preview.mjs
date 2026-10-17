// Render Tape's share image from native HTML, the bundled font and the existing SVG wordmark.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const { chromium } = require("playwright");
const font = readFileSync(new URL("../web/src/assets/fonts/archivo-latin-wdth-wght-normal.woff2", import.meta.url)).toString("base64");
const mark = /export const WORDMARK_PATH = "([^"]+)";/.exec(readFileSync(new URL("../web/src/components/Wordmark.tsx", import.meta.url), "utf8"))?.[1];
if (!mark) throw Error("Tape wordmark path not found");
const symbols = ["BTC", "ETH", "SOL", "XRP", "DOGE", "GOLD", "SPX", "TSLA", "NVDA", "AAPL"];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><style>
    @font-face{font-family:Archivo;src:url(data:font/woff2;base64,${font});font-weight:100 900;font-stretch:62% 125%}
    body{margin:0;width:1200px;height:630px;background:#fff;font-family:Archivo;overflow:hidden;position:relative;color:#0a1638}
    .wordmark{position:absolute;left:84px;top:64px;width:220px}
    h1{position:absolute;left:80px;top:168px;margin:0;font:700 96px/1 Archivo;font-stretch:108%;letter-spacing:-.04em}
    em{font-style:normal;color:#1640ff}
    p{position:absolute;left:84px;top:390px;margin:0;font:400 27px/1.45 Archivo;color:#4b5675}
    .band{position:absolute;left:-60px;right:-60px;top:520px;height:64px;display:flex;align-items:center;gap:30px;padding-left:130px;background:#1640ff;color:#fff;transform:rotate(-4deg);font:600 24px/1 Archivo;white-space:nowrap}
  </style><body><svg class="wordmark" viewBox="0 0 600 160" role="img" aria-label="Tape"><path fill="#1640ff" fill-rule="evenodd" d="${mark}"/></svg>
    <h1>Trade 10 markets.<br>Up to <em>1000x</em>.</h1>
    <p>Crypto, stocks, gold and the S&amp;P 500.<br>No opening fee. No funding. Settled in USDC on Ethereum.</p>
    <div class="band">${symbols.map(symbol => `<span>${symbol}</span>`).join("")}</div>
  </body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const fits = await page.locator("h1, p, .band span").evaluateAll(elements => elements.every(element => {
    const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= 1200 && r.top >= 0 && r.bottom <= 630;
  }));
  if (!fits) throw Error("Share-image text falls outside the canvas");
  await page.screenshot({ path: fileURLToPath(new URL("../web/public/og.jpg", import.meta.url)), type: "jpeg", quality: 92 });
  console.log("Rendered web/public/og.jpg: ten markets, correct leverage qualifier, no static price quotes.");
} finally { await browser.close(); }
