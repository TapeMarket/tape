/**
 * The price signer, the print log and the Hyperliquid source, without a network.
 *
 * The source is driven by hand: quotes are handed to it as Hyperliquid's API would deliver them,
 * the clock is the test's own, and every print it signs is checked back against the key.
 * relayer/test/hyperliquid-live.mjs runs the same source against the real API.
 *
 *   node --test relayer/test/hyperliquid.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAbiParameters, recoverTypedDataAddress, serializeSignature } from "viem";
import { createBook } from "../src/prices/book.mjs";
import { createPrintLog } from "../src/prices/printlog.mjs";
import { createPrintSigner, PRINT_TYPES, printDomain } from "../src/prices/signer.mjs";
import { createHyperliquidSource, toE8, quoteOf, coinOfFeed } from "../src/prices/hyperliquid.mjs";

// anvil's account 9: worthless anywhere but a local chain.
const KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
const ORACLE = "0x00000000000000000000000000000000000051c4";
const feed = (text) => `0x${Buffer.from(text, "latin1").toString("hex").padEnd(64, "0")}`;
const BTC = feed("hyperliquid:BTC");
const ETH = feed("hyperliquid:ETH");
// What a market is called is not what it is priced from: the feed id is. So the names here are wrong on purpose.
const MARKETS = [
  { id: 0, symbol: "SOL", feedId: BTC },
  { id: 1, symbol: "DOGE", feedId: ETH },
];
const BLOB = [{ type: "bytes32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }];

const signer = createPrintSigner({ privateKey: KEY, chainId: 1, oracle: ORACLE });

/** Who signed a blob, and what it says. */
async function open(blob) {
  const [feedId, price, conf, publishTime, prevPublishTime, v, r, s] = decodeAbiParameters(BLOB, blob);
  const address = await recoverTypedDataAddress({
    domain: printDomain(1, ORACLE),
    types: PRINT_TYPES,
    primaryType: "Print",
    message: { feedId, price, conf, publishTime, prevPublishTime },
    signature: serializeSignature({ r, s, yParity: v - 27 }),
  });
  return { address, feedId, price, conf, time: Number(publishTime), prev: Number(prevPublishTime) };
}

/** A source with its own clock, a book that records what reaches it, and a log that keeps what was said. */
function rig({ markets = MARKETS, reference = null, sanityBps = 150, maxSpreadBps = 100, fetchImpl, start = 1_800_000_000_000, clock = { ms: start }, printLog = null, retired } = {}) {
  const said = [];
  const log = { info: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) };
  const book = createBook(markets.map((m) => m.id));
  const prints = [];
  book.onTick((market, print) => prints.push({ market, ...print }));
  const polls = [];
  const source = createHyperliquidSource({
    markets,
    book,
    signer,
    log,
    reference,
    sanityBps,
    maxSpreadBps,
    printLog,
    retired,
    now: () => clock.ms,
    fetchImpl:
      fetchImpl ??
      (async (url, init) => {
        polls.push(JSON.parse(init.body));
        return { ok: false, status: 503 };
      }),
    WebSocketImpl: class {},
  });
  /** Quotes the stream keeps sending, as it does while the book moves: coin => [bid, ask, lag]. */
  const standing = new Map();
  let lastSent = 0;
  return {
    clock,
    said,
    book,
    prints,
    polls,
    source,
    /** A quote arriving now, stamped by Hyperliquid `lag` ms ago. */
    quote(coin, bid, ask, lag = 80) {
      source.ingest(coin, bid, ask, clock.ms - lag);
    },
    /** From now on the stream repeats this quote five times a second. */
    hold(coin, bid, ask, lag = 80) {
      standing.set(coin, [bid, ask, lag]);
      source.ingest(coin, bid, ask, clock.ms - lag);
    },
    drop(coin) {
      standing.delete(coin);
    },
    /** Moves the clock on and has the source look, as its timer would. */
    async advance(ms, step = 50) {
      for (let passed = 0; passed < ms; passed += step) {
        clock.ms += step;
        if (clock.ms - lastSent >= 200) {
          lastSent = clock.ms;
          for (const [coin, [bid, ask, lag]] of standing) source.ingest(coin, bid, ask, clock.ms - lag);
        }
        source.tick(clock.ms);
        // Let a REST answer, or a signature, land before the next look, as real time would.
        await new Promise((resolve) => setImmediate(resolve));
      }
      await source.settled();
    },
    of: (market) => prints.filter((p) => p.market === market),
  };
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "printlog-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ------------------------------------------------------------------------------------------ numbers

test("prices are read exactly, to eight decimals", () => {
  assert.equal(toE8("82547.5"), 8_254_750_000_000n);
  assert.equal(toE8("2516.95"), 251_695_000_000n);
  assert.equal(toE8("0.00001234"), 1_234n);
  assert.equal(toE8("1"), 100_000_000n);
  assert.equal(toE8("0.123456789"), 12_345_678n); // past eight decimals is cut, not rounded up
  for (const bad of ["", "abc", "-1", "1e5", "1.", ".5", " 1", "0", "0.0", null, undefined, 5, "NaN", "1,000"]) {
    assert.equal(toE8(bad), null, String(bad));
  }
});

test("a quote is the middle of the book and half its width; a crossed or empty book is no quote", () => {
  assert.deepEqual(quoteOf("82547.0", "82548.0"), { mid: 8_254_750_000_000n, conf: 50_000_000n });
  assert.deepEqual(quoteOf("2516.9", "2517.0"), { mid: 251_695_000_000n, conf: 5_000_000n });
  assert.equal(quoteOf("100", "100"), null);
  assert.equal(quoteOf("101", "100"), null);
  assert.equal(quoteOf(undefined, "100"), null);
  assert.equal(quoteOf("100", null), null);
});

test("a market's coin is read out of its feed id and nothing else", () => {
  assert.equal(coinOfFeed(BTC), "BTC");
  assert.equal(coinOfFeed(ETH), "ETH");
  assert.equal(coinOfFeed(BTC.toUpperCase().replace("0X", "0x")), "BTC");
  assert.equal(coinOfFeed(feed("hyperliquid:kPEPE")), "kPEPE");
  assert.equal(coinOfFeed(feed("hyperliquid:xyz:TSLA")), "xyz:TSLA");
  assert.equal(coinOfFeed(feed("hyperliquid:xyz:SP500")), "xyz:SP500");
  assert.equal(coinOfFeed(feed("hyperliquid:XYZ:TSLA")), null);
  assert.equal(coinOfFeed(feed("hyperliquid:xyz:")), null);
  assert.equal(coinOfFeed(feed("hyperliquid::BTC")), null);
  // Pyth's BTC/USD id, another venue, an empty coin, something after the coin, a zero in the middle.
  assert.equal(coinOfFeed("0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"), null);
  assert.equal(coinOfFeed(feed("binance:BTC")), null);
  assert.equal(coinOfFeed(feed("hyperliquid:")), null);
  assert.equal(coinOfFeed(feed("hyperliquid:BTC/USD")), null);
  assert.equal(coinOfFeed(`0x${Buffer.from("hyperliquid:BT\0C", "latin1").toString("hex").padEnd(64, "0")}`), null);
  assert.equal(coinOfFeed("0x1234"), null);
  assert.equal(coinOfFeed(undefined), null);
});

// ------------------------------------------------------------------------------------------- signer

test("the signer's print says what it was given, under the signer's own key", async () => {
  const blob = await signer.sign(BTC, { price: 8_254_750_000_000n, conf: 50_000_000n, time: 1_800_000_002, prev: 1_800_000_001 });
  assert.equal((blob.length - 2) / 2, 256, "eight words, as the contract decodes them");
  const got = await open(blob);
  assert.equal(got.address, signer.address);
  assert.equal(got.feedId, BTC);
  assert.equal(got.price, 8_254_750_000_000n);
  assert.equal(got.conf, 50_000_000n);
  assert.equal(got.time, 1_800_000_002);
  assert.equal(got.prev, 1_800_000_001);
});

test("a print is for one oracle on one chain", async () => {
  const print = { price: 100n, conf: 0n, time: 10, prev: 9 };
  const here = await signer.sign(BTC, print);
  const otherChain = await createPrintSigner({ privateKey: KEY, chainId: 8453, oracle: ORACLE }).sign(BTC, print);
  const otherOracle = await createPrintSigner({ privateKey: KEY, chainId: 1, oracle: "0x00000000000000000000000000000000000051c5" }).sign(BTC, print);
  assert.notEqual(here, otherChain);
  assert.notEqual(here, otherOracle);
  // Read against this oracle's domain, the other two are somebody else's signature.
  assert.equal((await open(here)).address, signer.address);
  assert.notEqual((await open(otherChain)).address, signer.address);
  assert.notEqual((await open(otherOracle)).address, signer.address);
});

test("the signer will not sign what the contract would refuse", async () => {
  await assert.rejects(signer.sign(BTC, { price: 0n, conf: 0n, time: 10, prev: 9 }), /price/);
  await assert.rejects(signer.sign(BTC, { price: -1n, conf: 0n, time: 10, prev: 9 }), /price/);
  await assert.rejects(signer.sign(BTC, { price: 2n ** 64n, conf: 0n, time: 10, prev: 9 }), /price/);
  await assert.rejects(signer.sign(BTC, { price: 100, conf: 0n, time: 10, prev: 9 }), /price/);
  await assert.rejects(signer.sign(BTC, { price: 100n, conf: -1n, time: 10, prev: 9 }), /conf/);
  await assert.rejects(signer.sign(BTC, { price: 100n, conf: 0n, time: 9, prev: 10 }), /times/);
  await assert.rejects(signer.sign(BTC, { price: 100n, conf: 0n, time: 10.5, prev: 9 }), /times/);
});

// ------------------------------------------------------------------------------------------- source

test("one first print a second, each naming the second of the print before it", async () => {
  const r = rig();
  const startSecond = Math.floor(r.clock.ms / 1000);
  r.hold("BTC", "82547.0", "82548.0");
  r.hold("ETH", "2516.9", "2517.0");
  await r.advance(400);
  assert.equal(r.prints.length, 0, "nothing is signed for the second the source started in");

  await r.advance(2700);
  const btc = r.of(0);
  assert.deepEqual(btc.map((p) => p.time), [startSecond + 1, startSecond + 2, startSecond + 3]);
  assert.deepEqual(btc.map((p) => p.prev), [startSecond, startSecond + 1, startSecond + 2]);
  assert.equal(btc[0].price, 8_254_750_000_000n);
  assert.equal(btc[0].conf, 50_000_000n);
  assert.equal(r.of(1)[0].price, 251_695_000_000n);
  for (const p of r.prints) {
    const got = await open(p.blob);
    assert.equal(got.address, signer.address);
    assert.equal(got.feedId, MARKETS[p.market].feedId, "each market's prints are signed for its own feed");
    assert.deepEqual([got.price, got.conf, got.time, got.prev], [p.price, p.conf, p.time, p.prev]);
  }
  // And the book finds them as the contract will: the first print at or after a second.
  assert.equal((await r.book.pinned(0, startSecond + 2, 10)).time, startSecond + 2);
});

test("the coin priced is the one in the feed id, whatever the market is called", async () => {
  // Market 0 is called SOL and its feed is hyperliquid:BTC. A SOL quote must never be signed under it.
  const r = rig();
  r.hold("SOL", "150.0", "150.2");
  await r.advance(1200);
  assert.equal(r.prints.length, 0, "a quote for the market's name is not a quote for its feed");
  r.hold("BTC", "82547.0", "82548.0");
  await r.advance(1000);
  assert.equal(r.of(0)[0].price, 8_254_750_000_000n);
  assert.equal((await open(r.of(0)[0].blob)).feedId, BTC);

  // A feed id that names no Hyperliquid coin cannot be priced from Hyperliquid at all.
  assert.throws(() => rig({ markets: [{ id: 0, symbol: "BTC", feedId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" }] }), /does not name a Hyperliquid coin/);
  // Two different feed ids must not both mean one coin: the same text with more zeros is the same id,
  // so this takes a second, differently spelt id, which the pattern does not let through as BTC.
  assert.throws(() => rig({ markets: [{ id: 0, symbol: "BTC", feedId: BTC }, { id: 1, symbol: "BTC", feedId: feed("hyperliquid:BTC ") }] }), /does not name a Hyperliquid coin/);
});

test("markets that share a feed share one chain of prints, and a retired market gets none", async () => {
  // BTC was retired as market 0 and listed again as market 2: the same feed id twice.
  const markets = [
    { id: 0, symbol: "BTC", feedId: BTC },
    { id: 1, symbol: "ETH", feedId: ETH },
    { id: 2, symbol: "BTC", feedId: BTC },
  ];
  const r = rig({ markets, retired: (id) => id === 0 });
  r.hold("BTC", "82547.0", "82548.0");
  r.hold("ETH", "2516.9", "2517.0");
  await r.advance(2200);
  assert.equal(r.of(0).length, 0, "the retired market is not priced");
  const again = r.of(2);
  assert.equal(again.length, 2);
  // One chain for the feed: exactly one first print a second exists under that feed id.
  const blobs = new Set(r.prints.filter((p) => p.market !== 1).map((p) => p.blob));
  assert.equal(blobs.size, 2);

  const both = rig({ markets });
  both.hold("BTC", "82547.0", "82548.0");
  await both.advance(1200);
  assert.equal(both.of(0).length, 1);
  assert.equal(both.of(0)[0].blob, both.of(2)[0].blob, "both markets are handed the very same print");
});

test("inside a second, a changed price is signed again, as a later print of that second", async () => {
  const r = rig();
  const second = Math.floor(r.clock.ms / 1000) + 1;
  r.hold("BTC", "100.0", "100.2");
  await r.advance(1000); // the first print of `second`
  await r.advance(250);
  assert.equal(r.of(0).length, 1, "the same price is not signed twice in a second");

  r.hold("BTC", "100.4", "100.6");
  await r.advance(50);
  r.hold("BTC", "100.8", "101.0");
  await r.advance(50);
  let btc = r.of(0);
  assert.equal(btc.length, 2, "a change is signed, but not five times in a quarter of a second");
  assert.deepEqual([btc[1].time, btc[1].prev], [second, second], "it names its own second: it is not the first of it");
  assert.equal(btc[1].price, 10_050_000_000n);

  await r.advance(200);
  btc = r.of(0);
  assert.equal(btc.length, 3);
  assert.equal(btc[2].price, 10_090_000_000n);
  // An order pinned at this second fills at the first print, whatever came after.
  assert.equal((await r.book.pinned(0, second, 10)).price, 10_010_000_000n);
});

test("a price older than a trader could already have seen is never signed", async () => {
  let answer = null;
  const asked = [];
  const r = rig({
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      asked.push(body);
      if (!answer) return { ok: false, status: 503 };
      return { ok: true, json: async () => answer(body.coin) };
    },
  });
  const start = Math.floor(r.clock.ms / 1000);
  // The stream says one thing and goes quiet. 950 ms later the second turns over.
  r.clock.ms += 50;
  r.quote("BTC", "100.0", "100.2");
  await r.advance(950);
  assert.equal(r.of(0).length, 0, "a quote 950 ms old is not signed as the price of this second");
  assert.ok(asked.some((b) => b.type === "l2Book" && b.coin === "BTC"), "the book was asked for over REST as soon as the quote was a third of a second old");
  await r.advance(4000);
  assert.equal(r.of(0).length, 0);
  assert.ok(r.said.some((m) => /no BTC price is being signed: Hyperliquid has not confirmed/.test(m)), "and after a few seconds it says so");

  // REST answers promptly: the first print after the gap names the second the source started in.
  answer = (coin) => ({ coin, time: r.clock.ms - 80, levels: [[{ px: coin === "BTC" ? "101.0" : "50.0" }], [{ px: coin === "BTC" ? "101.2" : "50.2" }]] });
  await r.advance(1500);
  const btc = r.of(0);
  assert.ok(btc.length >= 1);
  assert.equal(btc[0].prev, start);
  assert.equal(btc[0].price, 10_110_000_000n);
  // An order pinned inside the gap fills at that print: the first at or after its second.
  assert.equal((await r.book.pinned(0, start + 2, 10)).time, btc[0].time);

  // REST goes on answering, but each answer is now a second old when it arrives: nothing more is signed.
  const lastPrice = r.of(0).at(-1).price;
  answer = (coin) => ({ coin, time: r.clock.ms - 1_000, levels: [[{ px: "250.0" }], [{ px: "250.2" }]] });
  await r.advance(4000);
  assert.ok(
    r.of(0).every((p) => p.price === lastPrice),
    "a book that arrives a second late is never the price",
  );
  assert.ok(r.of(0).at(-1).time <= Math.floor(r.clock.ms / 1000) - 2, "and with nothing fresher, signing stops");
});

test("a clock that disagrees with Hyperliquid's signs nothing", async () => {
  const slow = rig();
  slow.hold("BTC", "100.0", "100.2", 2_500); // every stamp is 2.5 s before this machine's clock
  await slow.advance(1500);
  assert.equal(slow.of(0).length, 0);
  assert.ok(slow.said.some((m) => /clock/.test(m)));

  const fast = rig();
  fast.hold("BTC", "100.0", "100.2", -2_500); // every stamp is 2.5 s after it
  await fast.advance(1500);
  assert.equal(fast.of(0).length, 0);
  assert.ok(fast.said.some((m) => /clock/.test(m)));

  const fine = rig();
  fine.hold("BTC", "100.0", "100.2", 900);
  await fine.advance(1100);
  assert.equal(fine.of(0).length, 1, "a second apart is network and clock drift, and is fine");
});

test("one quote stamped in the future does not stop a market", async () => {
  const r = rig();
  r.hold("BTC", "100.0", "100.2");
  await r.advance(1100);
  assert.equal(r.of(0).length, 1);
  // A broken stamp, an hour ahead. Everything after it is "older".
  r.source.ingest("BTC", "5.0", "5.2", r.clock.ms + 3_600_000);
  await r.advance(3000);
  const btc = r.of(0);
  assert.ok(btc.length >= 3, "prices went on being signed");
  assert.ok(btc.every((p) => p.price === 10_010_000_000n), "and never the broken quote's");
});

test("a price too far from the second opinion, or a book too wide, is not signed", async () => {
  const ref = { price: 100, at: 0 };
  const reference = { name: "test venue", get: (coin) => (coin === "BTC" ? ref : null) };
  const r = rig({ reference, sanityBps: 150 });
  ref.at = r.clock.ms;

  r.hold("BTC", "101.7", "101.9"); // 1.8% above
  r.hold("ETH", "9999.0", "9999.2"); // no reference for ETH: signing must wait
  await r.advance(1100);
  assert.equal(r.of(0).length, 0);
  assert.equal(r.of(1).length, 0);
  assert.ok(r.said.some((m) => /bps apart/.test(m)));

  r.hold("BTC", "101.3", "101.5"); // 1.4% above
  ref.at = r.clock.ms;
  await r.advance(1000);
  assert.ok(r.of(0).length >= 1, "inside the limit it is signed again");
  assert.equal(r.of(0)[0].price, 10_140_000_000n);

  // Losing the reference must not silently disable the cross-check.
  const before = r.of(0).length;
  r.hold("BTC", "150.0", "150.2");
  r.clock.ms += 61_000;
  await r.advance(1200);
  assert.equal(r.of(0).length, before);
  assert.ok(r.said.some((m) => /no fresh, valid/.test(m)));

  const unchecked = rig({ reference, sanityBps: 0 });
  unchecked.hold("BTC", "500.0", "500.2");
  await unchecked.advance(1100);
  assert.equal(unchecked.of(0).length, 1, "with the check switched off nothing is compared");

  // The middle of a book 1.2% wide is nobody's price.
  const wide = rig();
  wide.hold("BTC", "100.0", "101.2");
  await wide.advance(1100);
  assert.equal(wide.of(0).length, 0);
  assert.ok(wide.said.some((m) => /bps wide/.test(m)));
  wide.hold("BTC", "100.0", "100.9");
  await wide.advance(1000);
  assert.ok(wide.of(0).length >= 1);
});

test("missing, invalid and future reference prices stop signing until a valid reference returns", async () => {
  for (const invalid of [null, { price: NaN }, { price: Infinity }, { price: 0 }, { price: -1 }, { at: NaN }, { at: Infinity }, { at: 1_800_000_010_000 }]) {
    const ref = invalid === null ? null : { price: 100.1, at: 1_800_000_000_000, ...invalid };
    let current = ref;
    const r = rig({ reference: { name: "test venue", get: () => current } });
    r.hold("BTC", "100.0", "100.2");
    await r.advance(1100);
    assert.equal(r.of(0).length, 0, JSON.stringify(invalid));
    current = { price: 100.1, at: r.clock.ms };
    await r.advance(1100);
    assert.ok(r.of(0).length > 0, "signing resumes on a fresh reference");
  }
});

test("an older quote does not replace a newer one, and a broken one changes nothing", async () => {
  const r = rig();
  r.clock.ms += 600;
  r.quote("BTC", "100.0", "100.2", 50);
  r.quote("BTC", "90.0", "90.2", 500); // older, arriving late
  r.source.ingest("BTC", "101.0", "100.0", r.clock.ms); // crossed
  r.source.ingest("BTC", "abc", "100.0", r.clock.ms);
  r.source.ingest("BTC", "100.0", "100.2", Number.NaN);
  r.source.ingest("DOGE", "1.0", "1.2", r.clock.ms); // not a feed here
  await r.advance(450);
  assert.equal(r.of(0).length, 1);
  assert.equal(r.of(0)[0].price, 10_010_000_000n);
});

test("whatever the stream sends, reading it does not throw", () => {
  const r = rig();
  const send = (data) => r.source.onMessage({ data });
  for (const bad of [
    "not json",
    "null",
    "[]",
    "42",
    JSON.stringify({ channel: "bbo" }),
    JSON.stringify({ channel: "bbo", data: null }),
    JSON.stringify({ channel: "bbo", data: { coin: "BTC", time: r.clock.ms, bbo: "nope" } }),
    JSON.stringify({ channel: "bbo", data: { coin: "BTC", time: r.clock.ms, bbo: { 0: { px: "1" } } } }),
    JSON.stringify({ channel: "bbo", data: { coin: "BTC", time: r.clock.ms, bbo: [null, null] } }),
    JSON.stringify({ channel: "bbo", data: { coin: "BTC", time: "soon", bbo: [{ px: "1" }, { px: "2" }] } }),
    JSON.stringify({ channel: "bbo", data: { coin: { toString: 1 }, time: r.clock.ms, bbo: [{ px: 1 }, { px: 2 }] } }),
  ]) {
    assert.doesNotThrow(() => send(bad), bad);
  }
  assert.doesNotThrow(() => r.source.onMessage({ data: undefined }));
  assert.doesNotThrow(() => r.source.onMessage({}));
});

test("time never runs backwards in what is signed", async () => {
  const r = rig();
  r.hold("BTC", "100.0", "100.2");
  await r.advance(2000);
  const before = r.of(0).length;
  const last = r.of(0).at(-1).time;

  r.clock.ms -= 5_000; // the machine's clock is set back
  r.hold("BTC", "101.0", "101.2");
  await r.advance(3000);
  assert.equal(r.of(0).length, before, "nothing is signed for a second that is already past");

  await r.advance(4000);
  const after = r.of(0).slice(before);
  assert.ok(after.length >= 1);
  assert.ok(after.every((p) => p.time >= last && p.prev >= last), "never a second earlier than the last one signed");
  assert.equal(after[0].prev, last);
  assert.ok(after.at(-1).time > last);
});

// ---------------------------------------------------------------------------------------- print log

test("every print is on disk before it is used, and a restart carries the chain on from there", async () => {
  const { dir, done } = scratch();
  try {
    const clock = { ms: 1_800_000_000_000 };
    const log = () => createPrintLog({ dir, chainId: 1, oracle: ORACLE, signer: signer.address, now: () => clock.ms, pid: process.pid });

    const first = rig({ clock, printLog: log() });
    first.source.resume();
    first.hold("BTC", "100.0", "100.2");
    await first.advance(3200);
    const signed = first.of(0);
    assert.equal(signed.length, 3);
    const lines = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n"))
      .map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.blob), signed.map((p) => p.blob), "what the book was given is what was written down");
    const lastSecond = signed.at(-1).time;

    // The process dies, the machine's clock is set back two seconds, a new process starts.
    clock.ms -= 2_000;
    const second = rig({ clock, printLog: log() });
    assert.equal(second.source.resume(), 3, "the new process has the old one's prints");
    assert.equal(second.prints.length, 0, "as history: nobody is told of them as if they were news");
    assert.equal((await second.book.pinned(0, signed[1].time, 10)).blob, signed[1].blob, "a close pinned before the restart still finds its print");

    second.hold("BTC", "107.0", "107.2");
    await second.advance(1900);
    assert.equal(second.of(0).length, 0, "no second that the old process signed is signed again, whatever the clock says");
    await second.advance(1500);
    const resumed = second.of(0);
    assert.ok(resumed.length >= 1);
    assert.ok(resumed[0].time > lastSecond);
    assert.equal(resumed[0].prev, lastSecond, "and the chain carries on from the last print on record");
  } finally {
    done();
  }
});

test("two processes cannot sign for one oracle at once, and another key's prints are not taken over", async () => {
  const { dir, done } = scratch();
  try {
    const mine = createPrintLog({ dir, chainId: 1, oracle: ORACLE, signer: signer.address, pid: process.pid });
    mine.acquire();
    // The process that started this test is alive and is not us: it stands in for a second relayer.
    const other = createPrintLog({ dir, chainId: 1, oracle: ORACLE, signer: signer.address, pid: process.ppid });
    assert.throws(() => other.acquire(), /already signing/);
    mine.release();
    assert.ok(!existsSync(join(dir, `prints-1-${ORACLE}.lock`)));

    // A lock left by a process that no longer exists does not block the next one.
    writeFileSync(join(dir, `prints-1-${ORACLE}.lock`), "999999999\n");
    assert.doesNotThrow(() => mine.acquire());
    mine.release();

    const now = Math.floor(Date.now() / 1000);
    mine.append(BTC, { time: now - 5, prev: now - 6, price: 100n, conf: 1n, blob: "0xaa" });
    mine.append(BTC, { time: now - 4000, prev: now - 4001, price: 100n, conf: 1n, blob: "0xbb" });
    const rotated = createPrintLog({ dir, chainId: 1, oracle: ORACLE, signer: "0x00000000000000000000000000000000000000Aa" });
    rotated.append(BTC, { time: now - 3, prev: now - 5, price: 200n, conf: 1n, blob: "0xcc" });
    assert.deepEqual(mine.load().map((p) => p.blob), ["0xaa"], "its own prints of the last half hour, and nobody else's");
    assert.deepEqual(rotated.load().map((p) => p.blob), ["0xcc"]);
    // Another oracle's log is another file altogether.
    assert.deepEqual(createPrintLog({ dir, chainId: 1, oracle: "0x00000000000000000000000000000000000051c5", signer: signer.address }).load(), []);
  } finally {
    done();
  }
});

// ------------------------------------------------------------------------------------------- stream

class FakeSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = {};
    this.readyState = 1;
    FakeSocket.all.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
  }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

test("the stream subscribes to each feed's best bid and ask, and its messages become prices", async () => {
  FakeSocket.all.length = 0;
  const sockets = FakeSocket.all;
  const book = createBook([0, 1]);
  const prints = [];
  book.onTick((market, print) => prints.push({ market, ...print }));
  const quiet = { info() {}, warn() {}, error() {} };
  const source = createHyperliquidSource({ markets: MARKETS, book, signer, log: quiet, WebSocketImpl: FakeSocket, fetchImpl: async () => ({ ok: false, status: 503 }), sanityBps: 0 });
  source.start();
  try {
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, "wss://api.hyperliquid.xyz/ws");
    sockets[0].fire("open");
    assert.deepEqual(sockets[0].sent, [
      { method: "subscribe", subscription: { type: "bbo", coin: "BTC" } },
      { method: "subscribe", subscription: { type: "bbo", coin: "ETH" } },
    ]);
    const send = (coin, bid, ask) =>
      sockets[0].fire("message", { data: JSON.stringify({ channel: "bbo", data: { coin, time: Date.now(), bbo: [{ px: bid, sz: "1", n: 1 }, { px: ask, sz: "1", n: 1 }] } }) });
    sockets[0].fire("message", { data: "not json" });
    sockets[0].fire("message", { data: JSON.stringify({ channel: "pong" }) });
    // Real time now: the stream keeps talking, and the source's own timer signs the first print of the next second.
    for (let i = 0; i < 8; i++) {
      send("BTC", "82547.0", "82548.0");
      send("ETH", "2516.9", "2517.0");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await source.settled();
    assert.ok(prints.some((p) => p.market === 0 && p.price === 8_254_750_000_000n));
    assert.ok(prints.some((p) => p.market === 1 && p.price === 251_695_000_000n));
    const health = source.health();
    assert.equal(health.length, 2);
    assert.deepEqual(health.map((h) => [h.coin, h.stopped]), [["BTC", null], ["ETH", null]]);
    assert.ok(!("quoteAgeMs" in health[0]), "how old the quote is, is not for the public to watch");
  } finally {
    source.stop();
  }
});

test("a stream that is alive and silent about one coin is opened again", () => {
  FakeSocket.all.length = 0;
  const clock = { ms: 1_800_000_000_000 };
  const said = [];
  const log = { info: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) };
  const source = createHyperliquidSource({ markets: MARKETS, book: createBook([0, 1]), signer, log, WebSocketImpl: FakeSocket, fetchImpl: async () => ({ ok: false, status: 503 }), now: () => clock.ms });
  source.start();
  try {
    const ws = FakeSocket.all[0];
    ws.fire("open");
    const btc = () => ws.fire("message", { data: JSON.stringify({ channel: "bbo", data: { coin: "BTC", time: clock.ms - 80, bbo: [{ px: "1.0" }, { px: "1.2" }] } }) });
    for (let i = 0; i < 16; i++) {
      clock.ms += 1_000;
      btc(); // BTC every second, ETH never
    }
    source.heartbeat();
    assert.equal(ws.readyState, 3, "the socket was closed to be opened again");
    assert.ok(said.some((m) => /nothing about ETH/.test(m)));
  } finally {
    source.stop();
  }
});

test("without a WebSocket, or without a signer, the source says what it needs", () => {
  const book = createBook([0, 1]);
  const source = createHyperliquidSource({ markets: MARKETS, book, signer, log: { info() {}, warn() {}, error() {} }, WebSocketImpl: null });
  assert.throws(() => source.start(), /Node 22/);
  assert.throws(() => createHyperliquidSource({ markets: MARKETS, book, log: {}, signer: null }), /price signer/);
});
