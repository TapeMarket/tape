/**
 * The price book and the Hermes source, without a network.
 *
 * The live Hermes stream cannot be exercised here without an entitled key, so the source is driven
 * with responses in Hermes' own format: an event stream of `data: {...}` lines for the stream, and
 * a JSON body for a price at a timestamp.
 *
 *   node --test relayer/test/prices.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBook } from "../src/prices/book.mjs";
import { createHermesSource, HermesAuthError } from "../src/prices/hermes.mjs";

const print = (time, prev, price = 100n) => ({ time, prev, price: price * 10n ** 8n, conf: 1n, blob: `0x${time.toString(16)}`, at: Date.now() });
const quiet = { info() {}, warn() {}, error() {} };
const now = () => Math.floor(Date.now() / 1000);

test("pinned returns the first print at or after the pin", async () => {
  const book = createBook([0]);
  const t = now();
  book.add(0, print(t - 3, t - 4));
  book.add(0, print(t - 2, t - 3, 101n));
  book.add(0, print(t - 1, t - 2, 102n));
  const got = await book.pinned(0, t - 2, 10);
  assert.equal(got.time, t - 2);
  assert.equal(got.price, 101n * 10n ** 8n);
});

test("pinned waits for a print that has not arrived yet", async () => {
  const book = createBook([0]);
  const t = now();
  book.add(0, print(t - 1, t - 2));
  const pending = book.pinned(0, t + 1, 10);
  setTimeout(() => book.add(0, print(t + 1, t - 1, 105n)), 20);
  const got = await pending;
  assert.equal(got.time, t + 1);
});

test("pinned skips a gap: the first print after a silent second still counts", async () => {
  const book = createBook([0]);
  const t = now();
  book.add(0, print(t - 5, t - 6));
  book.add(0, print(t - 1, t - 5, 107n)); // nothing published for three seconds
  const got = await book.pinned(0, t - 3, 10);
  assert.equal(got.time, t - 1);
});

test("pinned refuses a print outside the window", async () => {
  const book = createBook([0]);
  const t = now();
  book.add(0, print(t - 30, t - 31));
  book.add(0, print(t - 5, t - 30));
  await assert.rejects(book.pinned(0, t - 20, 10), /window/);
});

test("pinned will not use a later print of the same second", async () => {
  const book = createBook([0]);
  const t = now();
  // We joined mid-second: this print's predecessor has the same publish time.
  book.add(0, print(t - 2, t - 2, 99n));
  await assert.rejects(book.pinned(0, t - 2, 10), /first print/);
});

test("pinned asks the fallback for the true first print", async () => {
  const book = createBook([0]);
  const t = now();
  book.add(0, print(t - 2, t - 2, 99n));
  const got = await book.pinned(0, t - 2, 10, async (market, minTime) => print(minTime, minTime - 1, 98n));
  assert.equal(got.price, 98n * 10n ** 8n);
  // A fallback that returns another non-first print is rejected too.
  await assert.rejects(book.pinned(0, t - 2, 10, async (market, minTime) => print(minTime, minTime, 97n)), /no usable price/);
});

test("pinned gives up when nothing arrives", async () => {
  const book = createBook([0]);
  const t = now();
  // Pin time and window already in the past: the deadline has passed.
  await assert.rejects(book.pinned(0, t - 60, 5), /did not arrive/);
});

test("the book keeps ticks in order and one point per second in history", () => {
  const book = createBook([0]);
  const t = now();
  const seen = [];
  book.onTick((market, p) => seen.push(p.time));
  book.add(0, print(t - 3, t - 4));
  book.add(0, print(t - 3, t - 3, 101n)); // a second slot in the same second
  book.add(0, print(t - 2, t - 3));
  book.add(0, print(t - 9, t - 10)); // out of order: dropped
  assert.deepEqual(seen, [t - 3, t - 3, t - 2]);
  assert.equal(book.history(0, 60).length, 2);
  assert.equal(book.latest(0).time, t - 2);
  assert.equal(book.between(0, t - 3, t - 2).length, 1);
});

// ---------------------------------------------------------------------------------------------

const FEED = `0x${"ab".repeat(32)}`;
const markets = [{ id: 0, symbol: "BTC", feedId: FEED }];

function hermesEvent({ price, conf = "3500000000", expo = -8, time, prev }) {
  return `data: ${JSON.stringify({
    binary: { encoding: "hex", data: [`504e4155${time.toString(16)}`] },
    parsed: [{ id: FEED.slice(2), price: { price, conf, expo, publish_time: time }, ema_price: {}, metadata: { slot: 1, proof_available_time: time, prev_publish_time: prev } }],
  })}\n\n`;
}

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      for (const chunk of chunks) yield encoder.encode(chunk);
      // Hold the stream open like a real one would.
      await new Promise(() => {});
    })(),
  };
}

test("the Hermes stream feeds the book, across chunk boundaries and bad events", async () => {
  const book = createBook([0]);
  const t = now();
  const a = hermesEvent({ price: "8294645000000", time: t - 2, prev: t - 3 });
  const b = hermesEvent({ price: "8295000000000", time: t - 1, prev: t - 2 });
  // The first event is split mid-JSON; a malformed event sits between the two good ones.
  const chunks = [a.slice(0, 40), a.slice(40) + "data: {not json}\n\n", ": keep-alive\n\n", b];
  let requested = null;
  const source = createHermesSource({
    markets,
    book,
    log: quiet,
    baseUrl: "https://hermes.test",
    apiKey: "secret",
    fetchImpl: async (url, init) => {
      requested = { url, auth: init.headers.authorization };
      return streamResponse(chunks);
    },
  });
  source.start();
  await new Promise((r) => setTimeout(r, 60));
  source.stop();

  assert.match(requested.url, /\/v2\/updates\/price\/stream\?ids%5B%5D=0xabab/);
  assert.equal(requested.auth, "Bearer secret");
  assert.equal(book.latest(0).time, t - 1);
  assert.equal(book.latest(0).price, 8295000000000n);
  const pinned = await book.pinned(0, t - 2, 10);
  assert.equal(pinned.price, 8294645000000n);
  assert.equal(pinned.prev, t - 3);
  assert.ok(pinned.blob.startsWith("0x504e4155"));
});

test("Hermes prices are rescaled to eight decimals whatever the exponent", async () => {
  const book = createBook([0]);
  const t = now();
  const source = createHermesSource({
    markets,
    book,
    log: quiet,
    baseUrl: "https://hermes.test",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        binary: { data: ["504e4155"] },
        parsed: [{ id: FEED.slice(2), price: { price: "8294645", conf: "350", expo: -2, publish_time: t }, metadata: { prev_publish_time: t - 1 } }],
      }),
    }),
  });
  const got = await source.at(0, t);
  assert.equal(got.price, 8294645000000n);
  assert.equal(got.conf, 350000000n);
  assert.equal(got.time, t);
  assert.equal(got.blob, "0x504e4155");
});

test("a key that is not entitled is reported as such", async () => {
  const source = createHermesSource({
    markets,
    book: createBook([0]),
    log: quiet,
    baseUrl: "https://hermes.test",
    apiKey: "stale",
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => "Not entitled: feed abab (no grant accepts this feed)" }),
  });
  await assert.rejects(source.at(0, now()), (error) => error instanceof HermesAuthError && /Not entitled/.test(error.message));
});

test("a Hermes stream that connects and then says nothing is dropped and opened again", async () => {
  const book = createBook([0]);
  const t = now();
  const event = (time) =>
    `data:${JSON.stringify({ binary: { data: ["504e4155"] }, parsed: [{ id: FEED.slice(2), price: { price: "8294645000000", conf: "1", expo: -8, publish_time: time }, metadata: { prev_publish_time: time - 1 } }] })}

`;
  let connections = 0;
  const warnings = [];
  const source = createHermesSource({
    markets,
    book,
    log: { ...quiet, warn: (m) => warnings.push(m) },
    baseUrl: "https://hermes.test",
    stallMs: 120,
    reconnectMs: 10,
    fetchImpl: async (url, init) => {
      connections += 1;
      const mine = connections;
      const body = new ReadableStream({
        start(controller) {
          // The first connection sends one price and then hangs for ever, as a dead stream does.
          controller.enqueue(new TextEncoder().encode(event(t + mine)));
          init.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return { ok: true, status: 200, body };
    },
  });
  source.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  source.stop();
  assert.ok(connections >= 3, `it reconnected only ${connections - 1} times in half a second`);
  assert.ok(warnings.some((m) => /went quiet/.test(m)), "the log does not say the stream went quiet");
  assert.equal(book.latest(0).time, t + connections, "prices from the new connection reach the book");
});
