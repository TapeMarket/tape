// Read-only browser coverage for the manual, its deep links and pricing example.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const site = (process.argv.find(arg => arg.startsWith("http")) ?? "https://tapemarket.io").replace(/\/$/, "");
const local = process.argv.includes("--local"), shots = process.argv.includes("--shots");
const browser = await chromium.launch();
const errors = [], writes = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (local) await context.route(`${site}/**`, route => {
    const root = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
    const file = resolve(root, route.request().isNavigationRequest() ? "index.html" : new URL(route.request().url()).pathname.slice(1));
    assert.ok(file.startsWith(root + sep));
    return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404 });
  });
  await context.route("https://api.tapemarket.io/**", route => {
    if (!["GET", "OPTIONS", "HEAD"].includes(route.request().method())) {
      writes.push(new URL(route.request().url()).pathname); return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const open = async suffix => {
    const response = await page.goto(`${site}/docs${suffix}`, { waitUntil: "domcontentloaded" });
    // Same-document hash navigation has no HTTP response.
    if (response) assert.equal(response.status(), 200);
    await page.locator("#contracts").waitFor(); await page.evaluate(() => document.fonts.ready);
  };
  const checkWidth = async (width, height) => {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Document overflows at ${width}`);
    assert.ok(await page.locator(".docs-card").evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1), `Article overflows at ${width}`);
    const fields = await page.locator(".docs-example-controls select").evaluateAll(els => els.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
    assert.ok(fields.every(field => field.width > 60 && field.height >= 44), `Example controls do not fit at ${width}×${height}`);
  };
  const snapshot = async (name, target) => {
    if (!shots) return;
    if (target) await page.locator(target).scrollIntoViewIfNeeded();
    const folder = new URL("./shots/", import.meta.url); mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL(`docs-${local ? "local" : "live"}-${name}.png`, folder)) });
  };
  await open("");
  assert.equal(await page.locator(".docs-toc a").count(), 14);
  assert.equal(await page.locator(".docs-toc a").evaluateAll(links => links.every(link => document.getElementById(link.hash.slice(1))?.tagName === "H2")), true);
  await snapshot("desktop-start");
  const search = page.getByLabel("Find a topic", { exact: true });
  await search.fill("liquidation");
  assert.equal(await page.locator(".docs-toc a").count(), 1);
  await page.locator('.docs-toc a[href="#liquidation"]').click();
  await page.waitForFunction(() => location.hash === "#liquidation" && document.activeElement.id === "liquidation");
  await search.fill("not-a-topic"); await page.getByRole("status").getByText("No matching topics.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  assert.equal(await page.locator(".docs-toc a").count(), 14);
  console.log("PASS: grouped topic search, no-results recovery, valid section links and keyboard focus destination.");

  await page.locator('.docs-toc a[href="#win"]').click();
  const example = page.locator(".docs-example");
  const profit = async () => Number((await page.getByLabel("Example net profit", { exact: true }).innerText()).replace(/[^0-9.-]/g, ""));
  const initial = await profit(); assert.ok(initial > 0);
  assert.equal(await example.getByLabel("Price increase", { exact: true }).locator('option[value="25"]').innerText(), "0.25%");
  await example.getByLabel("Price increase", { exact: true }).selectOption("100"); assert.ok(await profit() > initial);
  const beforeImpact = await profit();
  await example.getByLabel("Size Impact", { exact: true }).selectOption("20"); assert.ok(await profit() < beforeImpact);
  await example.getByLabel("Size Impact", { exact: true }).selectOption("1");
  await example.getByLabel("Leverage", { exact: true }).selectOption("1000");
  const beforeMarket = await example.getByLabel("Market", { exact: true }).inputValue();
  const options = await example.getByLabel("Market", { exact: true }).locator("option").evaluateAll(els => els.map(el => ({ value: el.value, label: el.textContent })));
  const next = options.find(option => option.value !== beforeMarket);
  await example.getByLabel("Market", { exact: true }).selectOption(next.value);
  assert.ok(Number(await example.getByLabel("Leverage", { exact: true }).inputValue()) <= 1000);
  assert.ok(await profit() >= 0);
  await example.locator("summary").click(); assert.equal(await example.locator("tbody tr").count(), 7);
  await snapshot("desktop-example", ".docs-example");
  console.log("PASS: integer pricing example responds to moves, size impact and market changes; comparison table expands.");

  await page.locator('.docs-toc a[href="#coin"]').click();
  await page.locator('[aria-labelledby="coin"]').getByText(/Coin launch pending/).waitFor();
  assert.match(await page.locator('[aria-labelledby="coin"]').innerText(), /20% of the fixed supply/);
  await page.getByText("Reward formula and delivery", { exact: true }).click();
  assert.match(await page.locator('[aria-labelledby="coin"]').innerText(), /pendingRewards/);
  assert.match(await page.locator('[aria-labelledby="jackpot"]').innerText(), /winner and prize stay reserved/);
  assert.match(await page.locator('[aria-labelledby="deposits"]').innerText(), /normal USDC transfer needs ETH/);
  const body = await page.locator(".docs-body").textContent();
  assert.doesNotMatch(body, /\b(?:delve|seamless|game.chang(?:er|ing)|cutting.edge|groundbreaking|foster|empower|unlock your|in today.s|it.s worth noting|revolutioniz|elevate your)\b/i);
  const source = page.locator('.hero a[href="https://github.com/TapeMarket/tape"]');
  assert.equal(await source.getAttribute("target"), "_blank");
  console.log("PASS: deposits, 20% reserve, pending reward claims and jackpot retry copy match current behavior; no banned filler phrases.");

  for (const [name, width, height] of [["desktop", 1440, 1000], ["tablet", 768, 1000], ["mobile", 390, 844], ["small", 320, 740]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => { document.querySelector(".page").scrollTop = 0; });
    await checkWidth(width, height);
    if (width <= 900) {
      await page.locator('.docs-toc details:not([open])').waitFor();
      assert.equal(await page.locator('.docs-toc details').getAttribute("open"), null);
      await page.getByText("On this page", { exact: true }).click();
      await page.locator('.docs-toc a[href="#fees"]').click();
      await page.waitForFunction(() => location.hash === "#fees" && document.activeElement.id === "fees");
      assert.equal(await page.locator('.docs-toc details').getAttribute("open"), null);
      await page.waitForFunction(() => { const r = document.getElementById("fees").getBoundingClientRect(), bar = document.querySelector('.docs-toc').getBoundingClientRect(); return r.top >= bar.bottom - 1 && r.top < 250; });
      assert.equal(await page.locator('.docs-toc a[href="#fees"]').getAttribute("aria-current"), "location");
    }
    if (name === "mobile") { await snapshot("mobile-fees"); await open(""); await snapshot("mobile-start"); await page.locator(".docs-example").scrollIntoViewIfNeeded(); await snapshot("mobile-example"); }
    console.log(`PASS: ${name} layout, readable fields, mobile contents and unobscured section navigation.`);
  }
  await open("#exit");
  await page.waitForFunction(() => { const r = document.getElementById("exit").getBoundingClientRect(); return r.top >= 0 && r.top < 250; });
  const exit = page.locator('[aria-labelledby="exit"]');
  await exit.getByText("Withdraw without the relayer", { exact: true }).click();
  await exit.getByText("Close a position directly", { exact: true }).click();
  assert.match(await exit.innerText(), /100000000/);
  assert.match(await exit.innerText(), /executeWithdraw\(to\)/);
  assert.match(await exit.innerText(), /valid signed price update/);
  assert.ok(await page.locator('.docs-contracts a[href^="https://etherscan.io/address/"]').count() >= 8);
  await page.goto(`${site}/docs?preview=1#contracts`); await page.locator('#contracts').waitFor();
  await page.getByText('Practice mode uses simulated balances and rewards.', { exact: false }).waitFor();
  assert.equal(await page.locator('.docs-contracts').count(), 0);
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  console.log("PASS: direct-entry anchors, expanded exit instructions, explorer links, practice truth and no signing or API writes.");
} finally { await browser.close(); }
