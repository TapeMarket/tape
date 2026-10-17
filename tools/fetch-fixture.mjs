/**
 * Captures a few minutes of real, guardian-signed Pyth updates for the fork test.
 *
 * Writes test/fixtures/pyth-live.json with, for BTC/USD:
 *   open   the first print of a second a few minutes ago
 *   late   a print from the following second (must be refused as an entry price)
 *   touch  the first later print that crosses a 1000x bust trigger, and which side it busts
 *   close  the first print of a second after the touch
 *
 * Needs PYTH_API_KEY in .env (the key must be entitled to the feed).
 *
 *   node tools/fetch-fixture.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const HERMES = env.HERMES_URL || "https://hermes.pyth.network";
const BTC = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const LOOKBACK = 600; // seconds
const BUST_BPS = 5; // 1000x: 10 bps of margin, trigger 5 bps earlier

async function at(timestamp) {
  const res = await fetch(`${HERMES}/v2/updates/price/${timestamp}?ids%5B%5D=0x${BTC}&encoding=hex`, {
    headers: { accept: "application/json", ...(env.PYTH_API_KEY ? { authorization: `Bearer ${env.PYTH_API_KEY}` } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Hermes ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  const parsed = json.parsed[0];
  return {
    time: Number(parsed.price.publish_time),
    prev: Number(parsed.metadata.prev_publish_time),
    price: BigInt(parsed.price.price),
    conf: BigInt(parsed.price.conf),
    expo: Number(parsed.price.expo),
    update: `0x${json.binary.data[0]}`,
  };
}

const now = Math.floor(Date.now() / 1000);
const start = now - LOOKBACK;

const open = await at(start);
console.log(`open   t=${open.time} prev=${open.prev} price=${open.price} conf=${open.conf} expo=${open.expo}`);
if (open.prev >= open.time) throw new Error("open print is not the first of its second");

const late = await at(open.time + 1);
console.log(`late   t=${late.time} prev=${late.prev}`);

const band = (open.price * BigInt(BUST_BPS)) / 10_000n;
let touch = null;
for (let t = open.time + 2; t < now - 10 && !touch; t += 8) {
  const batch = await Promise.all(Array.from({ length: 8 }, (_, i) => at(t + i).catch(() => null)));
  for (const p of batch) {
    if (!p || p.time <= open.time) continue;
    if (p.price <= open.price - band) touch = { ...p, busts: "long" };
    else if (p.price >= open.price + band) touch = { ...p, busts: "short" };
    if (touch) break;
  }
}
if (!touch) throw new Error(`BTC did not move ${BUST_BPS} bps in ${LOOKBACK}s; run again`);
console.log(`touch  t=${touch.time} price=${touch.price} busts the ${touch.busts}`);

const close = await at(touch.time + 5);
console.log(`close  t=${close.time} prev=${close.prev} price=${close.price}`);

const strip = ({ time, prev, price, conf, expo, update, busts }) => ({
  time,
  prev,
  price: price.toString(),
  conf: conf.toString(),
  expo,
  update,
  ...(busts ? { bustsLong: busts === "long" } : {}),
});

mkdirSync(new URL("../test/fixtures/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../test/fixtures/pyth-live.json", import.meta.url),
  JSON.stringify({ feed: `0x${BTC}`, open: strip(open), late: strip(late), touch: strip(touch), close: strip(close) }, null, 2),
);
console.log("wrote test/fixtures/pyth-live.json");
