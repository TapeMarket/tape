/**
 * Hyperliquid: the production price source of a SignedOracle deployment.
 *
 * The price of a market is the middle of Hyperliquid's best bid and best ask for that coin's
 * perpetual, read from its public API (no key). This process turns it into prints and signs them
 * with the price signer's key; the SignedOracle contract accepts nothing else.
 *
 * So, unlike a Pyth update, a print proves nothing about the market: it proves that this process
 * signed it. Everything that keeps a wrong price from being signed is therefore in this file:
 *
 *   the coin    which coin a market is priced from is read out of its feed id, the very bytes the
 *               print is signed under ("hyperliquid:BTC"), and from nowhere else. A market whose
 *               feed id is not of that form is refused. Markets that share a feed share one chain
 *               of prints.
 *   fresh       an order stamped second S is taken until S.999 and fills at the first print of
 *               S+2. A price more than a second old at that moment is one the trader has already
 *               seen. So a print is signed only from a quote no older than SIGN_MAX_AGE_MS,
 *               counting both the time since it arrived and how late it arrived (its delay beyond
 *               the fastest message seen). The websocket sends the best bid and ask whenever they
 *               change; when a quote passes CONFIRM_AFTER_MS the book is asked for over REST.
 *               With neither answering in time nothing is signed: orders stop being taken (the
 *               engine sees the feed go stale) and positions are busted or closed when prices
 *               return.
 *   clock       Hyperliquid stamps every quote. If its clock and this machine's are more than
 *               MAX_SKEW_MS apart, nothing is signed: a print's time is this machine's, and a
 *               machine whose clock runs fast would label old prices as new ones.
 *   sane        the middle price is compared with a second, unrelated venue (Coinbase's spot
 *               ticker by default). Further apart than `sanityBps`, nothing is signed. Nor is
 *               anything signed while the book is wider than `maxSpreadBps`: the middle of a wide
 *               book is nobody's price.
 *   one chain   prints of a feed are signed in order, each naming the time of the one before it,
 *               never for a second at or before the last one on record. The first print of second
 *               T names an earlier second, which is what makes it the one print an order pinned
 *               at T can fill at; later prints of the same second can only bust. Every print is
 *               written to the print log before it is used, and a new process starts from the
 *               log, not from its clock (see printlog.mjs).
 *
 * Needs a global WebSocket: Node 22 or newer.
 */

export const DEFAULT_WS_URL = "wss://api.hyperliquid.xyz/ws";
export const DEFAULT_API_URL = "https://api.hyperliquid.xyz";

const TICK_MS = 50;
/** The oldest a quote may be, late arrival included, and still be signed. */
const SIGN_MAX_AGE_MS = 700;
/** A quote older than this is asked about over REST, so a confirmation lands before it is too old. */
const CONFIRM_AFTER_MS = 300;
/** How long without any word on a coin before that is worth a line in the log. */
const QUIET_MS = 3_000;
/** At most five prints a second for a feed: the first of the second, then changes. */
const MIN_GAP_MS = 200;
/** The most Hyperliquid's clock and this machine's may differ. */
const MAX_SKEW_MS = 2_000;
/** A stamp this far from this machine's clock is a broken stamp, not a clock. */
const ABSURD_SKEW_MS = 20_000;
const PING_MS = 5_000;
/** A socket that has said nothing at all for this long, pings included, is dead. */
const STALL_MS = 12_000;
/** A socket that is alive and has said nothing about one coin for this long is opened again. */
const COIN_STALL_MS = 15_000;
const RECONNECT_MS = [500, 1_000, 2_000, 5_000];
/** Stop signing when the configured reference has not refreshed within this interval. */
const REFERENCE_MAX_AGE_MS = 60_000;
const COMPLAIN_EVERY_MS = 15_000;
/** The clock estimate forgets what it saw after two of these. */
const OFFSET_WINDOW_MS = 60_000;

/** "82547.5" -> 8254750000000n. Null for anything that is not a plain positive decimal. */
export function toE8(text) {
  if (typeof text !== "string" || !/^\d{1,12}(\.\d{1,18})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const value = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0").slice(0, 8));
  return value > 0n ? value : null;
}

/** The middle of a bid and an ask, and half the gap between them, both 1e8. Null if not a market. */
export function quoteOf(bidText, askText) {
  const bid = toE8(bidText);
  const ask = toE8(askText);
  if (bid === null || ask === null || bid >= ask) return null;
  return { mid: (bid + ask) / 2n, conf: (ask - bid + 1n) / 2n };
}

/**
 * The Hyperliquid coin a feed id names: "hyperliquid:BTC", as text in a bytes32, gives "BTC", and
 * "hyperliquid:xyz:TSLA" gives "xyz:TSLA" (a coin of a builder-deployed dex, named "dex:COIN" on
 * Hyperliquid itself). Null for any other feed id. The feed id is what a print is signed under, so this is the one
 * place a market's coin comes from.
 */
export function coinOfFeed(feedId) {
  if (typeof feedId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(feedId)) return null;
  const bytes = Buffer.from(feedId.slice(2), "hex");
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  // Text, then nothing but zeros. Anything else in there (a zero in the middle included) fails the pattern.
  const m = /^hyperliquid:((?:[a-z]{1,8}:)?[A-Za-z0-9]{1,16})$/.exec(bytes.subarray(0, end).toString("latin1"));
  return m ? m[1] : null;
}

/**
 * A second opinion on the price: Hyperliquid's own oracle price, polled every few seconds. For its
 * own perpetuals that is a weighted median of the big exchanges' spot prices, worked out by its
 * validators; for a builder-deployed dex such as trade.xyz it is the deployer's feed of the
 * underlying market. Either way it does not come from the order book the price is read off, so a
 * push on that book moves one and not the other. It covers every coin, where Coinbase covers some.
 * @returns {{ name: string, start(): void, stop(): void, get(coin: string): { price: number, at: number } | null }}
 */
export function createOracleReference({ coins, log, fetchImpl = fetch, apiUrl = "https://api.hyperliquid.xyz/info", everyMs = 3_000 }) {
  const latest = new Map();
  const endpoint = `${apiUrl.replace(/\/+$/, "").replace(/\/info$/, "")}/info`;
  const dexes = [...new Set(coins.map((coin) => (coin.includes(":") ? coin.split(":")[0] : "")))];
  let timer = null;
  let complained = 0;

  async function refresh(dex) {
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "tape-relayer" },
        body: JSON.stringify(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" }),
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) throw new Error(`oracle ${res.status}`);
      const [meta, contexts] = await res.json();
      const at = Date.now();
      meta.universe.forEach((asset, i) => {
        if (!coins.includes(asset.name)) return;
        const price = Number(contexts[i]?.oraclePx);
        if (Number.isFinite(price) && price > 0) latest.set(asset.name, { price, at });
      });
    } catch (error) {
      if (Date.now() - complained > 60_000) {
        complained = Date.now();
        log.warn(`price cross-check: Hyperliquid's oracle${dex ? ` (${dex})` : ""} unreachable (${error.message}); signing stops when its last reference expires`);
      }
    }
  }

  return {
    name: "Hyperliquid's oracle",
    start() {
      const all = () => dexes.forEach(refresh);
      all();
      timer = setInterval(all, everyMs);
    },
    stop() {
      clearInterval(timer);
    },
    get: (coin) => latest.get(coin) ?? null,
  };
}

/**
 * A second opinion on the price: Coinbase's spot ticker, polled every few seconds.
 * @returns {{ start(): void, stop(): void, get(symbol: string): { price: number, at: number } | null }}
 */
export function createCoinbaseReference({ symbols, log, fetchImpl = fetch, everyMs = 4_000 }) {
  const latest = new Map();
  let timer = null;
  let complained = 0;

  async function refresh(symbol) {
    try {
      const res = await fetchImpl(`https://api.exchange.coinbase.com/products/${symbol}-USD/ticker`, {
        headers: { accept: "application/json", "user-agent": "tape-relayer" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) throw new Error(`ticker ${res.status}`);
      const json = await res.json();
      const price = (Number(json.bid) + Number(json.ask)) / 2;
      if (!Number.isFinite(price) || price <= 0) throw new Error("ticker returned no price");
      latest.set(symbol, { price, at: Date.now() });
    } catch (error) {
      if (Date.now() - complained > 60_000) {
        complained = Date.now();
        log.warn(`price cross-check: Coinbase ${symbol} unreachable (${error.message}); signing stops when its last reference expires`);
      }
    }
  }

  return {
    name: "coinbase",
    start() {
      const all = () => symbols.forEach(refresh);
      all();
      timer = setInterval(all, everyMs);
    },
    stop() {
      clearInterval(timer);
    },
    get: (symbol) => latest.get(symbol) ?? null,
  };
}

/**
 * @param {object} options
 * @param {{ id: number, feedId: string }[]} options.markets every market to price; its coin is read
 *        from its feed id
 * @param {{ sign(feedId: string, print: object): Promise<string> }} options.signer
 * @param {{ acquire(): void, release(): void, load(): object[], append(feedId: string, print: object): void } | null} [options.printLog]
 * @param {(marketId: number) => boolean} [options.retired] a retired market needs no prints
 * @param {{ get(symbol: string): { price: number, at: number } | null } | null} [options.reference]
 * @param {number} [options.sanityBps] how far from the reference a price may be; 0 for no check
 * @param {number} [options.maxSpreadBps] the widest book whose middle is signed; 0 for no limit
 */
export function createHyperliquidSource({
  markets,
  book,
  signer,
  log,
  printLog = null,
  retired = () => false,
  wsUrl = DEFAULT_WS_URL,
  apiUrl = DEFAULT_API_URL,
  reference = null,
  sanityBps = 150,
  maxSpreadBps = 100,
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
  now = Date.now,
  orderBound = false,
}) {
  if (!signer) throw new Error("The Hyperliquid price source signs its prints: it needs the price signer.");

  /** feed id (lower case) => its one chain of prints */
  const feeds = new Map();
  const byCoin = new Map();
  const executionWaiters = new Set();
  let persistenceFailed = false;
  const snapshots = new Map();
  const snapshotTimes = [];
  let snapshotId = 0;
  function snapshotBudget() {
    const at = now();
    while (snapshotTimes.length && snapshotTimes[0] < at - 60_000) snapshotTimes.shift();
    if (snapshotTimes.length >= 200) return false; // 400 info weight/minute; reserve room for reference checks.
    snapshotTimes.push(at);
    return true;
  }
  for (const market of markets) {
    const coin = coinOfFeed(market.feedId);
    if (!coin) throw new Error(`Market ${market.id}'s feed id ${market.feedId} does not name a Hyperliquid coin ("hyperliquid:<COIN>"). It cannot be priced from Hyperliquid.`);
    const key = market.feedId.toLowerCase();
    let state = feeds.get(key);
    if (!state) {
      if (byCoin.has(coin)) throw new Error(`Two feed ids name the coin ${coin}. One coin has one chain of prints.`);
      state = {
        feedId: market.feedId,
        coin,
        marketIds: [],
        /** @type {{ mid: bigint, conf: bigint, hlTime: number, at: number } | null} */
        quote: null,
        // Nothing is signed for the second this process started in: an earlier process may have.
        lastTime: Math.floor(now() / 1000),
        /** Whether the first print of second `lastTime` is this process's own. */
        first: false,
        lastMid: null,
        lastPrintAt: 0,
        lastObservedAt: 0,
        lastWsAt: 0,
        polling: false,
        lastPollAt: 0,
        chain: Promise.resolve(),
        complainedAt: 0,
        why: "starting",
      };
      feeds.set(key, state);
      byCoin.set(coin, state);
    }
    state.marketIds.push(market.id);
  }
  const states = [...feeds.values()];
  // Each confirmation costs Hyperliquid's REST limit; with more feeds each waits a little longer.
  const pollEveryMs = Math.max(300, states.length * 150);

  let stopped = false;
  let socket = null;
  let openedAt = 0;
  let lastHeard = 0;
  let attempt = 0;
  let timers = [];
  let reconnectTimer = null;

  // The least delayed message of the last minute or two says how far apart the two clocks are
  // (network delay included). What a message is later than that by is how late it arrived.
  const offset = { window: Infinity, previous: Infinity, startedAt: 0 };
  function observe(at, hlTime) {
    const apart = at - hlTime;
    if (Math.abs(apart) > ABSURD_SKEW_MS) return;
    if (at - offset.startedAt > OFFSET_WINDOW_MS) {
      offset.previous = offset.window;
      offset.window = Infinity;
      offset.startedAt = at;
    }
    if (apart < offset.window) offset.window = apart;
  }
  const clockOffset = () => Math.min(offset.window, offset.previous);
  const lateness = (quote) => Math.max(0, quote.at - quote.hlTime - clockOffset());

  function complain(state, why, level = "warn") {
    state.why = why;
    if (now() - state.complainedAt < COMPLAIN_EVERY_MS) return;
    state.complainedAt = now();
    log[level](`hyperliquid: no ${state.coin} price is being signed: ${why}`);
  }

  /** A quote from either transport. */
  function ingest(coin, bidText, askText, hlTime, viaStream = true) {
    if (stopped) return;
    const state = byCoin.get(coin);
    if (!state || !Number.isFinite(hlTime)) return;
    const at = now();
    observe(at, hlTime);
    if (viaStream) state.lastWsAt = at;
    // Stamped in the future: a broken stamp, or a clock the tick will complain about. Not a price to keep.
    if (hlTime - at > MAX_SKEW_MS) return;
    const quote = quoteOf(bidText, askText);
    if (!quote) return;
    if (orderBound && state.quote && hlTime <= state.quote.hlTime) return;
    // An older quote than the one held changes nothing, unless the one held is past signing anyway.
    if (state.quote && hlTime < state.quote.hlTime && at - state.quote.at <= SIGN_MAX_AGE_MS) return;
    state.quote = { ...quote, hlTime, at };
    if (orderBound) {
      if (usableExecution(state, at)) {
        const second = Math.floor(hlTime / 1000);
        if ((second > state.lastTime || state.lastObservedAt > 0) && hlTime > state.lastObservedAt) {
          emit(state, state.quote, second, Math.floor(state.lastObservedAt / 1000), at);
        }
        for (const waiter of executionWaiters) if (waiter.state === state) waiter.check();
      }
    }
  }

  async function poll(state) {
    if (orderBound && !snapshotBudget()) { state.lastPollAt = now(); return; }
    state.polling = true;
    state.lastPollAt = now();
    try {
      const res = await fetchImpl(`${apiUrl}/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "l2Book", coin: state.coin }),
        signal: AbortSignal.timeout(2_500),
      });
      if (!res.ok) throw new Error(`book ${res.status}`);
      const json = await res.json();
      ingest(state.coin, json?.levels?.[0]?.[0]?.px, json?.levels?.[1]?.[0]?.px, Number(json?.time), false);
    } catch {
      // Nothing confirmed: the quote stays too old to sign and the tick says so.
    } finally {
      state.polling = false;
    }
  }

  function requestSnapshot(state) {
    if (!socket || socket.readyState !== 1 || [...snapshots.values()].some(value => value.state === state) || !snapshotBudget()) return;
    const id = ++snapshotId;
    const timer = setTimeout(() => snapshots.delete(id), 2000);
    snapshots.set(id, { state, timer });
    try { socket.send(JSON.stringify({ method: "post", id, request: { type: "info", payload: { type: "l2Book", coin: state.coin } } })); }
    catch { clearTimeout(timer); snapshots.delete(id); }
  }

  function sane(state, quote, at) {
    if (maxSpreadBps && quote.conf * 2n * 10_000n > quote.mid * BigInt(maxSpreadBps)) {
      complain(state, `Hyperliquid's book is ${((Number(quote.conf) * 2 * 10_000) / Number(quote.mid)).toFixed(0)} bps wide, the limit is ${maxSpreadBps}`);
      return false;
    }
    if (!reference || !sanityBps) return true;
    const ref = reference.get(state.coin);
    if (!ref || !Number.isFinite(ref.price) || ref.price <= 0 || !Number.isFinite(ref.at)
      || ref.at > at || at - ref.at > REFERENCE_MAX_AGE_MS) {
      complain(state, `${reference.name ?? "the reference"} has no fresh, valid ${state.coin} price`);
      return false;
    }
    const price = Number(quote.mid) / 1e8;
    const apartBps = (Math.abs(price - ref.price) / ref.price) * 10_000;
    if (apartBps <= sanityBps) return true;
    complain(state, `Hyperliquid says ${price} and ${reference.name ?? "the reference"} says ${ref.price}: ${apartBps.toFixed(0)} bps apart, the limit is ${sanityBps}`, "error");
    return false;
  }

  function emit(state, quote, time, prev, at) {
    if (persistenceFailed) return;
    if (time > state.lastTime) state.first = true;
    state.lastTime = time;
    state.lastMid = quote.mid;
    state.lastPrintAt = at;
    state.why = null;
    const print = { time, prev, price: quote.mid, conf: quote.conf,
      ...(orderBound ? { observedAt: quote.hlTime, prevObservedAt: state.lastObservedAt } : {}) };
    if (orderBound) state.lastObservedAt = quote.hlTime;
    // One at a time and in order: the book, like the contract, reads prints as a chain.
    state.chain = state.chain
      .then(async () => {
        const blob = await signer.sign(state.feedId, print);
        // On disk before anything is built on it (see printlog.mjs).
        if (orderBound && printLog) await printLog.appendDurable(state.feedId, { ...print, blob });
        else printLog?.append(state.feedId, { ...print, blob });
        for (const id of state.marketIds) if (!retired(id)) book.add(id, { ...print, blob, at: now() });
      })
      .catch((error) => {
        if (orderBound) { persistenceFailed = true; state.why = "Price storage unavailable"; }
        log.error(`hyperliquid: signing a ${state.coin} print failed`, error);
      });
  }

  function usableExecution(state, at = now()) {
    const quote = state.quote;
    const apart = clockOffset();
    return !persistenceFailed && quote && Number.isFinite(apart) && Math.abs(apart) <= 500
      && at >= quote.at && at - quote.at + lateness(quote) <= SIGN_MAX_AGE_MS && sane(state, quote, at);
  }

  /** First fresh exchange observation after intake, with no scheduled pricing sleep. */
  function execution(marketId, receivedAt, minTime, afterMs = 0) {
    if (stopped) return Promise.reject(new Error("The price feed stopped"));
    if (!orderBound) return Promise.reject(new Error("This deployment uses delayed public pricing"));
    const state = states.find(value => value.marketIds.includes(marketId));
    if (!state || retired(marketId) || persistenceFailed) return Promise.reject(new Error("Execution prices are unavailable"));
    if (executionWaiters.size >= 2000) return Promise.reject(new Error("The execution feed is busy. Try again shortly."));
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (fn, value) => { clearTimeout(timer); executionWaiters.delete(waiter); fn(value); };
      const waiter = { state, check() {
        const quote = state.quote;
        if (!usableExecution(state) || quote.at <= receivedAt || quote.hlTime <= Math.max(receivedAt, afterMs) || Math.floor(quote.hlTime / 1000) < minTime) return;
        if (Math.floor(quote.hlTime / 1000) > minTime + 10) return finish(reject, new Error("No fresh execution price inside the order window"));
        const price = { price: quote.mid, conf: quote.conf, time: Math.floor(quote.hlTime / 1000), observedAt: quote.hlTime };
        // Publish every earlier liquidation observation before releasing this manual fill. A
        // recovered price must not let a close jump ahead of an already-observed bust.
        clearTimeout(timer); executionWaiters.delete(waiter);
        state.chain.then(() => persistenceFailed ? reject(new Error("Price storage unavailable")) : resolve(price), reject);
      }, cancel: () => finish(reject, new Error("The price feed stopped")) };
      timer = setTimeout(() => finish(reject, new Error("A fresh price did not arrive. Nothing was executed.")), Math.max(1, Math.min(12_000, (minTime + 10) * 1000 - now())));
      executionWaiters.add(waiter);
      waiter.check();
      if (executionWaiters.has(waiter)) requestSnapshot(state);
      if (executionWaiters.has(waiter) && !state.polling && (!socket || now() - state.lastWsAt > 1000)) void poll(state);
    });
  }

  /** Looks at every feed once and signs what is due. `at` is the time, in ms. */
  function tick(at = now()) {
    const second = Math.floor(at / 1000);
    const apart = clockOffset();
    for (const state of states) {
      const quote = state.quote;
      const age = quote ? at - quote.at + lateness(quote) : Infinity;
      if (age > (orderBound ? 1500 : CONFIRM_AFTER_MS) && !state.polling && at - state.lastPollAt >= pollEveryMs) poll(state);
      if (orderBound) continue; // Every eligible source observation is signed in ingest(), including intrasecond moves.
      if (Number.isFinite(apart) && Math.abs(apart) > MAX_SKEW_MS) {
        complain(state, `this machine's clock and Hyperliquid's are ${(apart / 1000).toFixed(1)}s apart. Fix the clock (NTP).`, "error");
        continue;
      }
      if (!quote) {
        complain(state, "no quote from Hyperliquid yet");
        continue;
      }
      if (age > SIGN_MAX_AGE_MS) {
        // Between two confirmations this is the ordinary state for a moment. Lasting, it is an outage.
        if (at - quote.at > QUIET_MS) complain(state, `Hyperliquid has not confirmed its price for ${((at - quote.at) / 1000).toFixed(1)}s`);
        else if (lateness(quote) > SIGN_MAX_AGE_MS) complain(state, `quotes are arriving ${(lateness(quote) / 1000).toFixed(1)}s late`);
        continue;
      }
      if (!sane(state, quote, at)) continue;

      if (second > state.lastTime) emit(state, quote, second, state.lastTime, at);
      // A later print of a second only follows a first print of it that this process signed.
      else if (state.first && second === state.lastTime && quote.mid !== state.lastMid && at - state.lastPrintAt >= MIN_GAP_MS) emit(state, quote, second, second, at);
    }
  }

  function onMessage(event) {
    lastHeard = now();
    // Whatever arrives, this must not throw: an error here would end the process.
    try {
      const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      if (orderBound && message?.channel === "post") {
        const pending = snapshots.get(message.data?.id);
        if (!pending) return;
        clearTimeout(pending.timer); snapshots.delete(message.data.id);
        const response = message.data.response;
        const data = response?.type === "info" && response.payload?.type === "l2Book" ? response.payload.data : null;
        if (data?.coin === pending.state.coin && Array.isArray(data.levels?.[0]) && Array.isArray(data.levels?.[1])) ingest(data.coin, data.levels[0][0]?.px, data.levels[1][0]?.px, Number(data.time), true);
        return;
      }
      if (orderBound && message?.channel === "l2Book" && Array.isArray(message.data?.levels?.[0]) && Array.isArray(message.data?.levels?.[1])) {
        ingest(message.data.coin, message.data.levels[0][0]?.px, message.data.levels[1][0]?.px, Number(message.data.time), true);
        return;
      }
      if (message?.channel !== "bbo" || !message.data || !Array.isArray(message.data.bbo)) return;
      const [bid, ask] = message.data.bbo;
      ingest(message.data.coin, bid?.px, ask?.px, Number(message.data.time), true);
    } catch {
      // Not a message we can read.
    }
  }

  function connect() {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocketImpl(wsUrl);
    } catch (error) {
      log.warn(`hyperliquid: could not open the stream (${error.message})`);
      return retry();
    }
    socket = ws;
    lastHeard = now();
    ws.addEventListener("open", () => {
      attempt = 0;
      openedAt = now();
      for (const state of states) {
        state.lastWsAt = openedAt;
        ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "bbo", coin: state.coin } }));
        if (orderBound) ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: state.coin } }));
      }
      log.info(`hyperliquid: streaming ${states.map((s) => s.coin).join(", ")}`);
    });
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", () => {});
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = null;
      if (!stopped) log.warn("hyperliquid: stream dropped; reconnecting (REST keeps confirming prices meanwhile, if it is quick enough)");
      retry();
    });
  }

  function retry() {
    if (stopped) return;
    const wait = RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)];
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, wait);
  }

  function reopen(why) {
    const ws = socket;
    log.warn(`hyperliquid: ${why}; reconnecting`);
    socket = null;
    try {
      ws.close();
    } catch {
      // Already gone.
    }
    retry();
  }

  function heartbeat() {
    const ws = socket;
    if (!ws) return;
    const at = now();
    if (at - lastHeard > STALL_MS) return reopen(`stream went quiet for ${STALL_MS / 1000}s`);
    // Alive, and silent about one coin: its subscription may have died on its own.
    const silent = openedAt && at - openedAt > COIN_STALL_MS ? states.find((s) => at - s.lastWsAt > COIN_STALL_MS) : null;
    if (silent) return reopen(`the stream has said nothing about ${silent.coin} for ${COIN_STALL_MS / 1000}s`);
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ method: "ping" }));
    } catch {
      // The close handler deals with it.
    }
  }

  /** Takes up the chain where the last process left it: its prints, and the last second it signed. */
  function resume() {
    if (!printLog) return 0;
    printLog.acquire();
    let restored = 0;
    for (const record of printLog.load()) {
      const state = feeds.get(String(record.feedId).toLowerCase());
      if (!state) continue;
      for (const id of state.marketIds) book.restore(id, { ...record, at: now() });
      if (record.time > state.lastTime) state.lastTime = record.time;
      if (orderBound && record.observedAt > state.lastObservedAt) state.lastObservedAt = record.observedAt;
      restored++;
    }
    return restored;
  }

  return {
    name: "hyperliquid",
    start() {
      if (typeof WebSocketImpl !== "function") throw new Error("The Hyperliquid price source needs a global WebSocket: run the relayer on Node 22 or newer.");
      const restored = resume();
      if (restored) log.info(`hyperliquid: ${restored} prints of the last half hour reloaded from the print log`);
      reference?.start?.();
      connect();
      timers = [setInterval(tick, TICK_MS), setInterval(heartbeat, PING_MS)];
    },
    stop() {
      stopped = true;
      for (const waiter of executionWaiters) waiter.cancel();
      for (const timer of timers) clearInterval(timer);
      clearTimeout(reconnectTimer);
      for (const value of snapshots.values()) clearTimeout(value.timer);
      snapshots.clear();
      reference?.stop?.();
      try {
        socket?.close();
      } catch {
        // Already gone.
      }
      printLog?.release();
    },
    /** Nothing to fall back to: this process makes every print, and the book and the log hold them. */
    at: async () => null,
    execution,
    /** For the status page: is each feed being priced, and if not, why. */
    health() {
      const apart = clockOffset();
      return states.map((s) => ({ markets: s.marketIds, coin: s.coin, clockOffsetMs: Number.isFinite(apart) ? apart : null, stopped: s.why }));
    },
    // For tests: drive the source by hand.
    tick,
    ingest,
    resume,
    onMessage,
    heartbeat,
    settled: () => Promise.all(states.map((s) => s.chain)),
  };
}
