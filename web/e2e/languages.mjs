// Full built app, local API snapshots, read-only wallet stub. No live API, signing or transactions.
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../", import.meta.url));
const deployment = JSON.parse(readFileSync(new URL("../../deployments/1.json", import.meta.url), "utf8"));
const catalogs = Object.fromEntries(["en", "zh-CN", "ru", "ko", "ja"].map(locale => [locale, JSON.parse(readFileSync(resolve(root, `src/locales/${locale}.json`), "utf8"))]));
const owner = "0x1000000000000000000000000000000000000001";
const market = { id: 0, symbol: "BTC", coin: "BTC", feedId: "0x" + "11".repeat(32), maxLeverage: 1000, maxKeepBps: 9000, maxConfBps: 20, rateMultiplier: 15000, positionMultiplier: 814598, tick: 10000000, bustBuffer: "476041580087574", retired: false, frozenPrice: "0", maxNotional: "10000000000000", oiLong: "0", oiShort: "0", capLong: "25000000000000", capShort: "25000000000000", depth: 1000000, price: "8100000000000", ref24h: 80000 };
const markets = [market, { ...market, id: 1, symbol: "ETH", coin: "ETH", price: "240000000000", feedId: "0x" + "22".repeat(32) }];
const config = { name: "Tape", chainId: 1, priceSource: "hyperliquid", addresses: { ...deployment, coin: null, staking: null, lossMining: null, sweeper: null, jackpot: null }, usdcPermit: { name: "USD Coin", version: "2" }, timing: { execDelay: 0, pinWindow: 2, intentTtl: 60, directDelay: 30, withdrawDelay: 86400, grace: 60, requestExpiry: 604800 }, markets, minMargin: "10000000", minNotional: "10000000000", opensPaused: false, coin: null, tape: [], previousExchanges: [] };
const house = { house: { lpCash: "29023900", totalQueued: "776100", debtMarginOpen: "0", equity: "28247800", excess: "0", stakerCap: "5000000000000", stakerFees: "100000", devFees: "100000", queueLength: "1", treasury: "50000000", totalBalances: "20000000", totalCashMargin: "0", minMargin: config.minMargin, minNotional: config.minNotional, opensPaused: false }, queue: [], queueStats: { entries: 0, largest: "0", front: "0" }, markets, totals: { volume: "60000000000", volumeByMarket: ["60000000000", "0"], volume24h: "60000000000", volume24hByMarket: ["60000000000", "0"], trades24h: 3, bustVolume: "30000000000", pnl: "-29223900", trades: 3, busts: 2, deposits: "50000000", withdrawals: "0", traders: 2, openPositions: 0, openMargin: "0" }, feed: [], positions: [] };
const account = { address: owner, name: "Long", balance: "20000000", queued: "776100", marginInUse: "0", reserved: "0", positions: [], intents: [], wallet: { usdc: "100000000", eth: "0" } };
const history = { trades: [], transfers: [], staking: [], queue: [], emissions: [] };
const errors = [], writes = [], layoutIssues = [], signed = [];
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(owner => {
    window.ethereum = { on() {}, removeListener() {}, request: async ({ method }) => {
      if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [owner];
      if (method === "eth_chainId") return "0x1";
      throw Error("Language test blocks wallet RPC " + method);
    } };
  }, owner);
  await context.route("http://tape.test/**", route => {
    const path = new URL(route.request().url()).pathname;
    const base = resolve(root, path.startsWith("/img/") ? "public" : "dist");
    const file = resolve(base, /^\/(assets|img)\//.test(path) ? path.slice(1) : "index.html");
    assert.ok(file.startsWith(base + sep));
    return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
  });
  await context.route("https://api.tapemarket.io/**", route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace(/^\/v3/, "");
    if (request.method() !== "GET") { writes.push(path); return route.abort(); }
    const now = Math.floor(Date.now() / 1000);
    if (path === "/stream") return route.fulfill({ contentType: "text/event-stream", body: `event: tick\ndata: {"m":0,"t":${now},"p":"8100000000000"}\n\n` });
    if (path === "/support/status") return route.fulfill({ json: { online: false } });
    if (path.startsWith("/support/conversations/")) return route.fulfill({ status: 404, json: { error: "Not found" } });
    const data = path === "/config" ? { ...config, time: Date.now() } : path === "/house" ? house : path === "/coin" ? { attached: false } : path.startsWith("/account/") ? account : path.startsWith("/history/") ? history : path.startsWith("/referrals/") ? { code: "Long", shareOfFeeBps: 2500, earned: "0", paid: "0", referred: [], names: {} } : path === "/leaderboard" ? { window: url.searchParams.get("window") ?? "24h", positions: [], accounts: [], names: {} } : path === "/season" ? null : path === "/series" ? { points: [] } : path === "/prices" ? { market: 0, points: Array.from({ length: 600 }, (_, i) => ({ t: now - 599 + i, p: "8100000000000" })) } : path === "/status" ? { ok: true, time: Date.now(), chainId: 1, source: "hyperliquid", opensPaused: false, feeds: markets.map(m => ({ market: m.id, symbol: m.symbol, time: now })), block: "100", blocks: [{ number: "100", time: now, gasUsed: "100000", gasLimit: "30000000" }], openPositions: 0, streams: 1, operatorEth: "10000000000000000" } : {};
    return route.fulfill({ json: data });
  });
  await context.route("https://api.hyperliquid.xyz/**", route => route.fulfill({ json: [] }));
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  const choose = async locale => {
    await page.locator(".language-button").click();
    await page.locator(`.language-menu button[lang="${locale}"]`).click();
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
  };
  await page.goto("http://tape.test/trade");
  await page.locator(".mcard").first().waitFor();
  await page.locator(".wallet-connect").click();
  await page.getByRole("dialog", { name: "Connect a wallet" }).locator(".wallet-option").first().click();
  await page.locator(".wallet-text b").filter({ hasText: "$20.78" }).waitFor();
  await page.locator("#margin").fill("12.345678");
  await page.locator("#leverage").fill("250");
  mkdirSync(resolve(root, "e2e/shots"), { recursive: true });
  for (const locale of ["en", "zh-CN", "ru", "ko", "ja"]) {
    await choose(locale);
    assert.equal(await page.locator("#margin").inputValue(), "12.345678");
    assert.equal(await page.locator("#leverage").inputValue(), "250");
    assert.equal(await page.locator(".wallet-text b").innerText(), "$20.78");
    assert.equal(await page.locator(".slip-label label[for=leverage]").innerText(), catalogs[locale].Leverage);
    assert.equal(await page.evaluate(() => localStorage.getItem("tape:language")), locale);
    for (const [width, height] of [[1366, 900], [390, 844], [320, 740]]) {
      await page.setViewportSize({ width, height });
      const inspect = async (selector, what) => {
        const box = await page.locator(selector).boundingBox();
        if (!box || box.x < -1 || box.x + box.width > width + 1 || box.y + box.height > height + 1) layoutIssues.push(`${locale} ${width}: ${what} outside viewport ${JSON.stringify(box)}`);
      };
      if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))) layoutIssues.push(`${locale} ${width}: horizontal page overflow`);
      await page.locator(".language-button").click(); await inspect(".language-menu", "language menu");
      await page.keyboard.press("Escape");
      await page.locator(".wallet-main").click(); await inspect(".wallet .menu", "wallet menu");
      assert.equal(await page.locator(".wallet-summary-owner").innerText(), "Long", "username must not be translated");
      if (width === 390 || (locale === "ru" && width === 1366)) await page.screenshot({ path: resolve(root, `e2e/shots/language-${locale}-${width}.png`) });
      await page.keyboard.press("Escape");
    }
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.locator(".support-launcher").click();
  const message = "Long Привет 你好 123.456789";
  await page.locator("#support-message").fill(message);
  await choose("ru");
  assert.equal(await page.locator("#support-message").inputValue(), message);
  assert.equal(await page.locator("#margin").inputValue(), "12.345678");
  assert.equal(await page.locator(".support-head h2").innerText(), catalogs.ru["Tape support"]);
  await page.locator(".support-close").click();
  await page.locator(".language-button").focus(); await page.keyboard.press("Enter"); await page.keyboard.press("End");
  assert.equal(await page.locator(".language-menu button:focus").getAttribute("lang"), "ja");
  await page.keyboard.press("Escape"); assert.equal(await page.locator(".language-button:focus").count(), 1);
  console.log("PASS: five languages preserve order fields, exact totals, usernames and support drafts; language menu keyboard controls.");
  for (const locale of ["zh-CN", "ru", "ko", "ja", "en"]) {
    await choose(locale);
    for (const route of ["/", "/trade", "/portfolio", "/vault", "/staking", "/leaderboard", "/dashboard", "/stats", "/status", "/docs", "/referrals"]) {
      await page.goto("http://tape.test" + route);
      await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
      await page.locator(route === "/trade" ? ".slip-go" : route === "/" ? ".lp-hero h1" : ".hero h1").waitFor();
      if (route === "/docs" && locale !== "en") {
        await page.locator(".docs-search input").fill(catalogs[locale].Fees);
        assert.equal(await page.locator('.docs-toc a[href="#fees"]').count(), 1);
      }
      assert.ok(await page.locator(".language-button").isVisible());
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))) layoutIssues.push(`${locale} ${width} ${route}: page overflow`);
      }
      await page.setViewportSize({ width: 1366, height: 900 });
    }
  }
  console.log("PASS: saved language survives reloads across landing, trading, balances, vault, staking, leaderboards, dashboard, stats, status, docs and referrals; localized docs search.");
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(signed, []);
  assert.deepEqual(layoutIssues, [], "responsive layout defects");
  console.log("PASS: desktop/390/320 menus fit; no browser errors, signatures, real API calls or writes.");
} finally { await browser.close(); }
