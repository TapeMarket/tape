/**
 * A referral, in a real browser: somebody arrives through a link, connects a wallet that has never
 * traded here, turns on one-click trading, and is bound to the link's owner without being asked
 * for anything more. Then the Referrals page.
 *
 * Needs the local stack (anvil + DevDeploy, the relayer, the site built with VITE_TEST_WALLETS=1).
 *
 *   node e2e/referrals.mjs [site] [--api=http://127.0.0.1:8787] [--wallet=3] [--ref=0x...]
 */
import { chromium } from "playwright";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const args = process.argv.slice(2);
const SITE = (args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:5173").replace(/\/$/, "");
const API = args.find((a) => a.startsWith("--api="))?.split("=")[1] ?? "http://127.0.0.1:8787";
const WALLET = Number(args.find((a) => a.startsWith("--wallet="))?.split("=")[1] ?? 3);
// Whoever the link belongs to: anybody's address will do.
const REF = args.find((a) => a.startsWith("--ref="))?.split("=")[1] ?? privateKeyToAccount(generatePrivateKey()).address;
// anvil's accounts 2 to 5 are the site's test wallets 1 to 4.
const ADDRESSES = ["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x90F79bf6EB2c4f870365E785982E1f101E93b906", "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"];
const OWNER = ADDRESSES[WALLET - 1];

const get = async (path) => (await fetch(`${API}${path}`)).json();
let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(error.message).split("\n")[0]}`);
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const before = await get(`/account/${OWNER}`);
if (before.referrer || before.stats.trades > 0) {
  console.log(`test wallet ${WALLET} (${OWNER}) already has a referrer or has traded on this chain: use another (--wallet=) or a fresh chain`);
  process.exit(2);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  console.log(`\n${SITE}, a link of ${REF}, test wallet ${WALLET}\n`);

  await check("the landing page opens through the link and leads to the terminal", async () => {
    await page.goto(`${SITE}/?ref=${REF}`);
    await page.getByRole("link", { name: "Trade", exact: true }).first().click();
    await page.locator(".ticket").waitFor({ timeout: 10_000 });
    assert((await page.evaluate(() => localStorage.getItem("tape:ref"))) === REF.toLowerCase(), "the link's name was not kept");
  });

  await check("a wallet connects, and nothing is bound yet", async () => {
    await page.locator(".bar-end").getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`Test wallet ${WALLET}`) }).click();
    await page.locator(".bar-btn.acct b").waitFor({ timeout: 8_000 });
    await page.waitForTimeout(1500);
    assert((await get(`/account/${OWNER}`)).referrer === null, "bound before one-click trading was on");
  });

  await check("turning on one-click trading binds it to the link's owner, with nothing else to sign", async () => {
    const cta = page.locator(".ticket .btn.big");
    assert((await cta.innerText()).toLowerCase() === "turn on one-click trading", `ticket says "${await cta.innerText()}"`);
    await cta.click();
    await page.waitForFunction(() => !/turn on|trading on in|check your wallet/i.test(document.querySelector(".ticket .btn.big")?.textContent ?? ""), null, { timeout: 40_000 });
    let referrer = null;
    for (const until = Date.now() + 30_000; Date.now() < until && !referrer; ) {
      await page.waitForTimeout(1000);
      referrer = (await get(`/account/${OWNER}`)).referrer;
    }
    assert(referrer && referrer.toLowerCase() === REF.toLowerCase(), `the account's referrer is ${referrer}`);
    assert((await get(`/referrals/${REF}`)).referred.some((r) => r.address === OWNER), "the link's owner does not list the wallet");
  });

  await check("the Referrals page shows this wallet's own link and who referred it", async () => {
    await page.evaluate(() => {
      history.pushState(null, "", "/referrals");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.locator(".refs h1").waitFor({ timeout: 8_000 });
    await page.getByText("You were referred by").waitFor({ timeout: 20_000 });
    const link = await page.locator(".refs-link code").innerText();
    assert(link === `${SITE}/?ref=${OWNER}`, `the link shown is ${link}`);
    const tiles = await page.locator(".refs-tiles .tile").allInnerTexts();
    assert(tiles.length === 4 && /traders referred\s*0/i.test(tiles[0]), `tiles: ${JSON.stringify(tiles)}`);
    await page.screenshot({ path: new URL("./shots/referrals.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
  });

  await check("it is in the More menu, and fits a phone", async () => {
    await page.locator(".nav").getByText("More").click();
    await page.getByRole("link", { name: "Referrals", exact: true }).waitFor({ timeout: 4_000 });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `the page overflows a phone by ${overflow}px`);
    await page.screenshot({ path: new URL("./shots/referrals-phone.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), fullPage: true });
  });

  await check("nothing was logged as an error", async () => {
    assert(errors.length === 0, errors.join(" | "));
  });
} finally {
  await browser.close();
}
console.log(`\n${passed}/${passed + failures.length} passed`);
process.exit(failures.length ? 1 : 0);
