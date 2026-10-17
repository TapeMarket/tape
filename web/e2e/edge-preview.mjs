/**
 * The site against clumsy and hostile use, in preview mode (no relayer needed).
 *
 *   node e2e/edge-preview.mjs [site]        default http://127.0.0.1:4174
 *
 * Each check is something that once went wrong: an order nobody meant to place, a figure that
 * misled, a control that could not be reached.
 */
import { chromium } from "playwright";

const SITE = (process.argv[2] ?? "http://127.0.0.1:4174").replace(/\/$/, "");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

let passed = 0;
const failed = [];
const assert = (ok, why) => {
  if (!ok) throw new Error(why);
};
async function check(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`  FAIL ${name}\n       ${error.message.split("\n")[0]}`);
  }
}

const money = (text) => Number(text.replace(/[^0-9.-]/g, ""));
const order = page.locator(".ticket .btn.big");
const rows = page.locator(".trade-bottom .tbl tbody tr", { hasText: /\dx/ });
const leverage = page.locator("#leverage");
const margin = page.locator("#margin");
const closeAll = page.getByRole("button", { name: "Close All", exact: true });
const balance = async () => money(await page.locator(".bar-btn.acct b").innerText());
/** Sets an input's value the way a paste does, without typing it key by key. */
const paste = (selector, value) =>
  page.evaluate(
    ([sel, text]) => {
      const input = document.querySelector(sel);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    [selector, value],
  );
const inView = async (target, view) => {
  const box = await target.boundingBox();
  return Boolean(box) && box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width + 0.5 && box.y + box.height <= view.height + 0.5;
};

console.log(`\n${SITE} (edge cases)\n`);
await page.goto(`${SITE}/trade`);
await order.click();
await page.getByRole("button", { name: /Play account/ }).click();
await page.locator(".bar-btn.acct b").waitFor({ timeout: 10_000 });
await page.waitForFunction(() => /^(Long|Short) /.test(document.querySelector(".ticket .btn.big")?.textContent ?? ""), null, { timeout: 15_000 });

// ---------------------------------------------------------------------------------------------
// The order ticket
// ---------------------------------------------------------------------------------------------

await check("a double click places one order, not two", async () => {
  // At 100x the bust price is a percent away: at 1000x a position can be gone again, on a real
  // price, before it is counted four seconds later.
  await leverage.fill("100");
  await margin.fill("100");
  for (const gap of [60, 150]) {
    const before = await rows.count();
    let opened = 0;
    // The simulated crowd can fill the side in the two seconds an order takes to land, and an
    // order past its own size limit is refused, as it should be. That is not what is tested here.
    for (let attempt = 0; attempt < 2; attempt++) {
      await order.click();
      await page.waitForTimeout(gap);
      await order.click({ force: true }).catch(() => {});
      await page.waitForTimeout(4500);
      opened = (await rows.count()) - before;
      const refused = await page.locator(".toast", { hasText: "past your limit" }).count();
      if (opened !== 0 || refused === 0) break;
    }
    // If it is not one, say what the site said: a refusal and a bust inside four seconds look the same from here.
    const said = opened === 1 ? "" : (await page.locator(".toast").allInnerTexts()).map((t) => t.replace(/\s+/g, " ")).join(" | ");
    assert(opened === 1, `two clicks ${gap} ms apart opened ${opened} positions${said ? ` (the site said: ${said})` : ""}`);
  }
});

await check("Close All pressed twice closes each position once, with no error", async () => {
  await closeAll.click();
  await closeAll.click({ force: true }).catch(() => {});
  await page.getByText("No open positions").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  const errors = await page.locator(".toast.bad").allInnerTexts();
  assert(errors.length === 0, `an error was shown: ${errors[0]}`);
});

await check("an empty or zero leverage cannot be sent", async () => {
  for (const text of ["", "0"]) {
    await leverage.fill(text);
    assert(await order.isDisabled(), `leverage "${text}" left the order button live`);
    assert(/Leverage is a whole number/.test(await order.innerText()), `the button does not say why: "${await order.innerText()}"`);
  }
});

await check("leverage is a whole number in range, and what is shown is what is sent", async () => {
  // More than the market allows is held to the most it allows, in the box too.
  await leverage.fill("1001");
  assert((await leverage.inputValue()) === "1000", `1001 typed, the box reads ${await leverage.inputValue()}`);
  // Anything that is not a whole number stays as written and cannot be sent as some other number.
  for (const text of ["1e2", "2.5", "-5"]) {
    await leverage.fill("100");
    await paste("#leverage", text);
    assert((await leverage.inputValue()) === text, `"${text}" turned the box into ${await leverage.inputValue()}`);
    assert(await order.isDisabled(), `leverage "${text}" left the order button live`);
  }
  await leverage.fill("100");
});

await check("margin takes a plain amount and nothing else", async () => {
  // Something that is no amount is refused whole: digits are never picked out of it.
  for (const junk of ["1e9", "-250", "ten"]) {
    await margin.fill("100");
    await paste("#margin", junk);
    assert((await margin.inputValue()) === "", `"${junk}" turned the margin into "${await margin.inputValue()}"`);
    assert(await order.isDisabled(), `"${junk}" left the order button live`);
  }
  // An amount pasted with its dollar sign and commas is that amount.
  await paste("#margin", "$1,250.50");
  assert((await margin.inputValue()) === "1250.50", `"$1,250.50" became "${await margin.inputValue()}"`);
  // Two points make it no number at all.
  await margin.fill("1.2.3");
  assert((await order.isDisabled()) && /Enter a margin/.test(await order.innerText()), `"1.2.3": "${await order.innerText()}"`);
  // Forty digits are over any limit, and still read as numbers.
  await leverage.fill("1000");
  await margin.fill("9".repeat(40));
  assert((await order.isDisabled()) && /Size limit/.test(await order.innerText()), `forty digits: "${await order.innerText()}"`);
  assert(!/e\+|NaN|Infinity/.test(await page.locator(".ticket").innerText()), "an amount is shown in exponent notation");
});

await check("halving never raises the margin", async () => {
  await margin.fill("0.5");
  await page.locator(".ticket .chip", { hasText: "½×" }).click();
  assert(money(await margin.inputValue()) <= 0.5, `½× turned 0.5 into ${await margin.inputValue()}`);
  await margin.fill("40");
  await page.locator(".ticket .chip", { hasText: "½×" }).click();
  assert(money(await margin.inputValue()) === 20, `½× turned 40 into ${await margin.inputValue()}`);
});

await check("a position below the minimum size cannot be sent", async () => {
  await leverage.fill("10");
  await margin.fill("100");
  assert(await order.isDisabled(), "a $1,000 position left the order button live");
  assert(/Minimum size/.test(await order.innerText()), `the button says "${await order.innerText()}"`);
});

await check("a toast is never in the way of a click", async () => {
  await leverage.fill("1000");
  await margin.fill("10");
  await order.click();
  await rows.first().waitFor({ timeout: 12_000 });
  await page.waitForTimeout(2500);
  await rows.first().getByRole("button", { name: "Close", exact: true }).click();
  const toast = page.locator(".toast").first();
  await toast.waitFor({ timeout: 15_000 });
  // Whatever is under the middle of the toast is what a click there reaches: never the toast.
  const blocks = await toast.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return Boolean(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".toasts"));
  });
  assert(!blocks, "a click on a toast lands on the toast, not on what is under it");
  await page.getByText("No open positions").waitFor({ timeout: 20_000 });
});

await check("the chart has candles with history, and more of it as it is scrolled back", async () => {
  const asked = [];
  const note = (request) => request.url().includes("/candles") && asked.push(new URL(request.url()).search);
  page.on("request", note);
  await page.getByLabel("Chart step").selectOption({ label: "1h" });
  await page.waitForTimeout(2500);
  assert(asked.some((query) => /granularity=3600/.test(query)), "no hourly candles were asked for");
  const box = await page.locator(".chart-canvas").boundingBox();
  for (let i = 0; i < 6 && !asked.some((query) => /start=/.test(query)); i++) {
    await page.mouse.move(box.x + 150, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 850, box.y + 200, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);
  }
  page.off("request", note);
  assert(asked.some((query) => /start=/.test(query)), "scrolling back did not fetch older candles");
  await page.getByLabel("Chart step").selectOption({ label: "Tick" });
  await page.waitForTimeout(500);
});

await check("Line and Candles are one click apart, and each comes back at the step it was left on", async () => {
  const pill = page.locator(".chart-pill");
  const lit = async () => (await pill.locator('button[aria-pressed="true"]').innerText()).trim();
  const stepNow = () => page.getByLabel("Chart step").inputValue();
  assert((await lit()) === "Line", "the chart is not on Line to begin with");
  await pill.getByRole("button", { name: "Candles" }).click();
  await page.waitForTimeout(1500);
  assert((await lit()) === "Candles", "Candles is not lit after the click");
  // The check before this one left the candles on an hour, so that is where they come back.
  assert((await stepNow()) === "3600", `candles came back on a step of ${await stepNow()}s, not the hour they were left on`);
  await page.getByLabel("Chart step").selectOption({ label: "5m" });
  await pill.getByRole("button", { name: "Line" }).click();
  assert((await stepNow()) === "0" && (await lit()) === "Line", "Line did not come back on Tick");
  await pill.getByRole("button", { name: "Candles" }).click();
  assert((await stepNow()) === "300", "Candles did not come back on 5m");
  await pill.getByRole("button", { name: "Line" }).click();
  await page.waitForTimeout(500);
});

await check("the tape never shows a fraction of a cent as a long decimal", async () => {
  const chips = await page.locator(".tchip").allInnerTexts();
  assert(chips.length > 0, "the tape is empty");
  const odd = chips.filter((text) => /\$0\.0{2,}\d|e-\d/.test(text));
  assert(odd.length === 0, `chips read ${odd.slice(0, 3).join(", ")}`);
});

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

await check("the money dialog: what counts as an amount, Tab stays inside, Enter sends, Escape gives the focus back", async () => {
  const opener = page.locator(".bar-end .bar-btn", { hasText: "Deposit" }).first();
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  const amount = dialog.getByLabel("Amount in USDC");
  await amount.waitFor();
  // Less than the smallest unit of USDC is nothing; the smallest unit itself is an amount.
  await amount.fill("0.0000001");
  const main = dialog.locator("button.primary");
  assert((await main.isDisabled()) && /enter an amount/i.test(await main.innerText()), `a ten-millionth of a dollar: "${await main.innerText()}"`);
  await amount.fill("0.000001");
  assert(!(await main.isDisabled()), `a millionth of a dollar: "${await main.innerText()}"`);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    assert(await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))), "Tab left the dialog");
  }
  await amount.fill("100");
  const before = await balance();
  await amount.press("Enter");
  await dialog.waitFor({ state: "detached", timeout: 8_000 });
  await page.waitForFunction((was) => Number((document.querySelector(".bar-btn.acct b")?.textContent ?? "").replace(/[^0-9.]/g, "")) > was, before, { timeout: 8_000 });

  await opener.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert(await opener.evaluate((el) => el === document.activeElement), "Escape did not give the focus back to the button that opened the dialog");
});

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

await check("every address is a real page or becomes one", async () => {
  const cases = [
    ["/nope", "/trade"],
    ["/Vault/", "/vault"],
    ["/Trade", "/trade"],
    ["/portfolio/extra", "/trade"],
  ];
  for (const [typed, becomes] of cases) {
    await page.goto(`${SITE}${typed}`);
    await page.waitForFunction((want) => location.pathname === want, becomes, { timeout: 5_000 }).catch(() => {});
    assert(new URL(page.url()).pathname === becomes, `${typed} stayed at ${new URL(page.url()).pathname}`);
  }
});

await check("the portfolio's tab follows the address, Back included", async () => {
  await page.goto(`${SITE}/portfolio?tab=nonsense`);
  const selected = () => page.locator(".tab[aria-selected=true]").first().innerText();
  await page.locator(".tab").first().waitFor();
  assert(/Positions/i.test(await selected()), `an unknown tab selected "${await selected()}"`);
  await page.getByRole("tab", { name: /History/ }).first().click();
  assert(/History/i.test(await selected()), "clicking History did not select it");
  await page.goBack();
  await page.waitForTimeout(300);
  assert(/Positions/i.test(await selected()), `Back left "${await selected()}" selected`);
});

// ---------------------------------------------------------------------------------------------
// Small screens
// ---------------------------------------------------------------------------------------------

await check("a short laptop screen keeps the order button and Close All in view", async () => {
  const view = { width: 1280, height: 680 };
  await page.setViewportSize(view);
  await page.goto(`${SITE}/trade`);
  await order.waitFor();
  await page.waitForTimeout(800);
  assert(await inView(order, view), "the order button is off screen at 1280 by 680");
  assert(await inView(closeAll, view), "Close All is off screen at 1280 by 680");
});

await check("on a phone the More menu opens and the dialogs fit", async () => {
  const view = { width: 390, height: 780 };
  await page.setViewportSize(view);
  await page.goto(`${SITE}/house`);
  await page.locator(".nav").waitFor();
  await page.locator(".nav button", { hasText: "More" }).click();
  const dashboard = page.locator(".nav .menu a", { hasText: "Dashboard" });
  await dashboard.waitFor({ timeout: 3_000 });
  assert(await inView(dashboard, view), "the More menu is not on screen");
  await dashboard.click();
  await page.waitForFunction(() => location.pathname === "/dashboard", null, { timeout: 5_000 });
  await page.locator(".bar-btn.acct").click();
  await page.locator(".menu button", { hasText: "Deposit" }).click();
  assert(await inView(page.getByRole("dialog"), view), "the dialog runs off a 390 px screen");
  await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------------------------------------
// Tabs left open across a release
// ---------------------------------------------------------------------------------------------

await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${SITE}/trade`);
await order.waitFor();
await page.waitForTimeout(1500);

await check("every page has an address the host answers, and a missing file is a 404, not the page", async () => {
  // Only the published site tells these apart; a local preview server answers everything.
  if (/127\.0\.0\.1|localhost/.test(SITE)) return;
  for (const path of ["/", "/trade", "/portfolio", "/vault", "/staking", "/leaderboard", "/dashboard", "/stats", "/status", "/docs"]) {
    const res = await context.request.get(`${SITE}${path}`);
    assert(res.status() === 200, `${path} answered ${res.status()}`);
  }
  const gone = await context.request.get(`${SITE}/assets/index-0ld0ld0ld.js`);
  assert(gone.status() === 404, `a script that does not exist answered ${gone.status()}`);
});

await check("a tab left open from before the tabs were versioned is told to reload", async () => {
  // Stand in for it: hold the lock such a tab holds and listen where it listens.
  const old = await context.newPage();
  await old.goto(`${SITE}/favicon.svg`);
  await old.evaluate(() => {
    window.heard = [];
    navigator.locks.request("tape:preview:engine", () => new Promise(() => {}));
    window.legacy = new BroadcastChannel("tape:preview");
    window.legacy.onmessage = (event) => window.heard.push(event.data);
  });
  const fresh = await context.newPage();
  await fresh.goto(`${SITE}/trade`);
  await old.waitForFunction(() => window.heard.some((m) => m?.kind === "post" && m?.path === "/reset"), null, { timeout: 8_000 });
  await fresh.close();
  await old.close();
});

// The channel name carries PROTOCOL from web/src/lib/preview/tabs.ts: keep the two in step.
await check("a tab that hears of a newer build reloads itself", async () => {
  const newer = await context.newPage();
  await newer.goto(`${SITE}/favicon.svg`);
  const reloaded = page.waitForEvent("load", { timeout: 8_000 });
  await newer.evaluate(() => new BroadcastChannel("tape:preview:v4").postMessage({ kind: "build", build: Date.now() + 1e9, leader: false }));
  await reloaded;
  await newer.close();
  // And it comes back working, once: it does not reload for ever.
  await order.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  assert(await order.isVisible(), "the tab did not come back after reloading");
});

await browser.close();
console.log(`\n${passed}/${passed + failed.length} passed`);
if (failed.length) process.exit(1);
