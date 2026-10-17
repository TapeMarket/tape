/**
 * The engine: takes signed intents from traders, prices them, and gets them on-chain.
 *
 * The contract trusts operators with exactly one thing: to submit an intent only if it was signed
 * for the present second. That is what the freshness check here is for, and it is the reason opens
 * and closes are operator-only on-chain. Everything else in this file is a courtesy: the same
 * checks the contract makes, made early so a trader hears "no" in milliseconds instead of a block
 * later, and so no gas is spent on a transaction that would revert.
 *
 * One rule here is more than a courtesy. An order's price is fixed when it is signed, so an order
 * must never sit in the queue in a state its owner can still flip with a call of their own. The
 * contract closes the doors it can; this file closes the rest by never accepting an order that
 * would fail as things stand, and by setting aside the balance every accepted order and every
 * accepted withdrawal will need, so that two of them can never be played against each other.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashTypedData, recoverTypedDataAddress, isHex, getAddress, parseAbi } from "viem";
import { domain as buildDomain, sessionDomain, types, EXEC_DELAY, PIN_WINDOW, INTENT_TTL, GRACE, DIRECT_DELAY, REQUEST_EXPIRY } from "../../shared/eip712.mjs";
import { bustPrice, crossed, hasRoom, quoteClose, impactNotionalFor, BPS } from "../../shared/math.mjs";
import { Rejected, acct, lower, nowSeconds, isAddr } from "./util.mjs";

// An order may be stamped with the current second or one of the next two, never an earlier one.
// A stamp in the past would shorten the delay between signing and pricing, which is the whole
// protection against trading on prices already seen elsewhere.
const STAMP_AHEAD = 2;
// How long a session key's window is remembered. It must stay well under one slot (GRACE, 12 s):
// a revocation bites one slot after its block, so an answer older than that can be wrong. At 30 s
// a revoked key went on being accepted here, to fail on-chain, for up to 18 s past its cut-off.
const SESSION_CACHE_MS = 5_000;
const MAX_OPEN_POSITIONS = 200;
// With no print for this long the feed is treated as down and no order is taken: an order accepted
// blind could only be priced whenever prices came back.
const STALE_AFTER = 6;
const FORGET_AFTER_MS = 10 * 60_000;
const U64 = 2n ** 64n;
const CASH_FULL = "This side of the market is full for now: what can be open grows with the vault's cash.";
const IMPACT_PAST_LIMIT = "This side filled up while your order was on its way, and its size impact went past your limit. Nothing was opened. Check the ticket and try again.";
const PERMIT_ABI = parseAbi(["function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)"]);

/** Intake must never advertise more room than Pricing's immutable on-chain ceiling. */
export function cashExposureLimit(cash, floorUsd, multiple, committed = 0n) {
  // Public queue payments can consume encumbered cash before an accepted open lands. Counting
  // that cash would make the open's eligibility depend on a later caller's choice to harvest.
  const backing = cash > committed ? cash - committed : 0n;
  const hard = 2_000_000n * 1_000_000n + backing * 50n;
  if (!multiple) return hard;
  const extra = BigInt(floorUsd) * 1_000_000n + backing * BigInt(multiple);
  return extra < hard ? extra : hard;
}

export function createEngine({ config, chain, book, source, store, queue, hub, log, executions = null, onPricedOpen = () => {}, onCloseReleased = () => {} }) {
  const { addresses, read, publicClient } = chain;
  const domain = buildDomain(config.deployment.name, config.chainId, addresses.exchange);
  const sessionsDomain = sessionDomain(config.deployment.name, config.chainId, addresses.sessions);
  const orderBound = config.executionMode === "order-bound";
  const execDelay = orderBound ? 0 : EXEC_DELAY;
  if (orderBound && !executions) throw new Error("Order-bound execution needs its durable quote journal.");

  /** Accepted intents, by id, until a while after they settle. */
  const intents = new Map();
  /** Balance spoken for by opens that have not landed yet. owner -> bigint */
  const reserved = new Map();
  /** Positions with a close on its way. id -> the close's pin time */
  const closing = new Map();
  const sessions = new Map();
  const hits = new Map();
  const CLOSES_PER_MINUTE = 260;
  /** Withdrawals accepted and not yet settled, per owner. Each will use up one replay counter. */
  const withdrawing = new Map();

  // ---------------------------------------------------------------------------------------
  // Shared checks
  // ---------------------------------------------------------------------------------------

  /**
   * Counts one request against `owner`'s allowance for the minute. Call it only once the request
   * is known to be the owner's own (its signature checked). Counted any earlier, anybody could use
   * up somebody else's allowance by sending junk in their name, and so stop them closing.
   * Orders and account actions (session, deposit, withdraw) are counted apart.
   */
  function limit(owner, bucket = "orders", max = config.rateLimit) {
    const key = `${bucket}:${lower(owner)}`;
    const cutoff = Date.now() - 60_000;
    const list = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= max) throw new Rejected("Too many orders. Slow down.", 429);
    list.push(Date.now());
    hits.set(key, list);
  }

  function requireFresh(timestamp) {
    const now = nowSeconds();
    if (!Number.isInteger(timestamp) || timestamp < now - (orderBound ? 1 : 0) || timestamp > now + STAMP_AHEAD) {
      throw new Rejected("Order timestamp is not current. Check your clock and retry.");
    }
  }

  /**
   * When `key` may sign for `owner`. A key that is valid stays valid for the timestamps it covers
   * (the contract never shortens that retroactively), so a positive answer is safe to remember for
   * a while, as long as that is shorter than the one slot a revocation takes to bite. A negative
   * one is never remembered: the key may be registered a moment later.
   */
  async function sessionWindow(owner, key) {
    const cacheKey = `${lower(owner)}:${lower(key)}`;
    const cached = sessions.get(cacheKey);
    if (cached && Date.now() - cached.at < SESSION_CACHE_MS) return cached;
    const [validFrom, validUntil] = await read("sessions", "sessionKeys", [owner, key]);
    const window = { validFrom: Number(validFrom), validUntil: Number(validUntil), at: Date.now() };
    if (window.validUntil > nowSeconds()) sessions.set(cacheKey, window);
    return window;
  }

  /** The intent must be signed by the owner or by a session key valid at the intent's timestamp. */
  async function requireTradeAuth(owner, primaryType, message, signature, timestamp) {
    let signer;
    try {
      signer = await recoverTypedDataAddress({ domain, types, primaryType, message, signature });
    } catch {
      throw new Rejected("Malformed signature.");
    }
    if (lower(signer) === lower(owner)) return;
    const window = await sessionWindow(owner, signer);
    if (timestamp >= window.validFrom && timestamp < window.validUntil) return;
    if (window.validFrom > timestamp && window.validUntil > timestamp) {
      throw new Rejected("One-click trading is still switching on. Try again in a few seconds.", 425);
    }
    throw new Rejected("Not signed by this account or one of its session keys.", 401);
  }

  /**
   * The most one side of any market may hold: CASH_FLOOR_USD plus CASH_MULTIPLE times the vault's
   * cash. The immutable Pricing contract independently enforces $2M plus 50 times house cash.
   * These settings can make intake stricter; they cannot relax the contract's ceiling.
   */
  function cashRoom() {
    const cash = store.house?.lpCash ?? 0n;
    const committed = (store.house?.totalQueued ?? 0n) + (store.house?.debtMarginOpen ?? 0n);
    return cashExposureLimit(cash, config.cashFloorUsd, config.cashMultiple, committed);
  }

  function marketOf(id) {
    const market = store.markets[id];
    if (!market?.feedId) throw new Rejected("Unknown market.");
    return market;
  }

  function requireLivePrices(market) {
    const last = book.latest(market.id);
    if (!last || nowSeconds() - last.time > STALE_AFTER) {
      throw new Rejected("Prices are not updating right now. Try again in a moment.", 503);
    }
  }

  function reserve(owner, amount) {
    reserved.set(lower(owner), (reserved.get(lower(owner)) ?? 0n) + amount);
  }

  function release(owner, amount) {
    const left = (reserved.get(lower(owner)) ?? 0n) - amount;
    if (left > 0n) reserved.set(lower(owner), left);
    else reserved.delete(lower(owner));
  }

  function view(record) {
    return {
      id: record.id,
      kind: record.kind,
      owner: record.owner,
      status: record.status,
      pinTime: record.pinTime,
      positionId: record.positionId,
      fill: record.fill ?? null,
      error: record.error ?? null,
      tx: record.tx ?? null,
    };
  }

  function update(record, patch) {
    Object.assign(record, patch);
    hub.publish(acct(record.owner), "intent", view(record));
  }

  function forgetLater(record) {
    setTimeout(() => intents.delete(record.id), FORGET_AFTER_MS).unref?.();
  }

  // ---------------------------------------------------------------------------------------
  // Open
  // ---------------------------------------------------------------------------------------

  async function open(body) {
    if (config.readOnlyOpens) throw new Rejected("This exchange has moved. Withdraw your remaining balance here, then open current Tape to trade.", 409);
    const it = body?.intent;
    const signature = body?.signature;
    if (!it || typeof it !== "object" || !isHex(signature) || !isAddr(it.owner)) throw new Rejected("Malformed order.");

    let message;
    try {
      message = {
        owner: getAddress(it.owner),
        market: Number(it.market),
        isLong: Boolean(it.isLong),
        useQueued: Boolean(it.useQueued),
        leverage: Number(it.leverage),
        margin: BigInt(it.margin),
        priceLimit: BigInt(it.priceLimit ?? 0),
        impactLimit: Number(it.impactLimit ?? 0),
        timestamp: BigInt(it.timestamp),
        salt: BigInt(it.salt),
      };
    } catch {
      throw new Rejected("Malformed order.");
    }
    // These are uint64 in what the trader signs. Outside that range, hashing the order throws.
    for (const value of [message.priceLimit, message.salt]) {
      if (value < 0n || value >= U64) throw new Rejected("Malformed order.");
    }
    // A uint32 in what the trader signs: whole dollars, zero for no limit.
    if (!Number.isInteger(message.impactLimit) || message.impactLimit < 0 || message.impactLimit >= 2 ** 32) throw new Rejected("Malformed order.");
    const timestamp = Number(message.timestamp);
    const owner = message.owner;

    requireFresh(timestamp);
    const market = marketOf(message.market);
    if (market.retired) throw new Rejected("This market is retired.");
    requireLivePrices(market);
    if (store.house?.opensPaused) throw new Rejected("New positions are paused.");
    if (!Number.isInteger(message.leverage) || message.leverage < 1 || message.leverage > market.maxLeverage) {
      throw new Rejected(`Leverage must be between 1 and ${market.maxLeverage}.`);
    }
    const minMargin = store.house?.minMargin ?? 0n;
    if (message.margin < minMargin || message.margin <= 0n) throw new Rejected("Margin is below the minimum.");
    const notional = message.margin * BigInt(message.leverage);
    if (notional > market.maxNotional) throw new Rejected("Position is larger than this market allows.");
    const minNotional = store.house?.minNotional ?? 0n;
    if (notional < minNotional) {
      throw new Rejected(`Position is below the $${(minNotional / 1_000_000n).toLocaleString("en-US")} minimum. Add margin or leverage.`);
    }
    const sideOi = message.isLong ? market.oiLong : market.oiShort;
    const sideCap = message.isLong ? market.capLong : market.capShort;
    if (sideOi + notional > sideCap) throw new Rejected("This side of the market is full right now.");
    if (sideOi + notional > cashRoom()) throw new Rejected(CASH_FULL);

    const id = hashTypedData({ domain, types, primaryType: "Open", message });
    if (intents.has(id) || (orderBound && executions.has(id))) throw new Rejected("Duplicate order. An earlier quote cannot be submitted as a new order.");
    await requireTradeAuth(owner, "Open", message, signature, timestamp);
    limit(owner);

    const [balance, queued, request] = await Promise.all([
      read("exchange", "balances", [owner]),
      message.useQueued ? read("exchange", "queuedOf", [owner]) : 0n,
      read("exchange", "withdrawRequests", [owner]),
    ]);
    // The contract freezes opens for an account that has asked to leave, from one slot after the
    // request until one slot after it is executed or cancelled.
    const [, requestedAt, closedAt] = request;
    if (requestedAt !== 0n && (closedAt === 0n || BigInt(timestamp) < closedAt + BigInt(GRACE))) {
      throw new Rejected(
        closedAt === 0n
          ? "A direct withdrawal is pending on this account. Complete or cancel it to trade."
          : "Trading resumes a few seconds after a direct withdrawal ends. Try again shortly.",
      );
    }
    // Everything already promised to other orders and withdrawals is off the table. Whatever the
    // queued winnings do not cover has to come from free cash.
    const free = balance - (reserved.get(lower(owner)) ?? 0n);
    const need = message.margin;
    const cashNeed = message.margin > queued ? message.margin - queued : 0n;
    if (free < cashNeed || free + queued < need) throw new Rejected("Not enough balance.");

    // From here to the record below nothing waits, so two requests that arrive together cannot
    // both pass: not the same order twice, and not two orders for an account's last free slot.
    if (intents.has(id)) throw new Rejected("Duplicate order.");
    // Positions already open, plus opens accepted and not yet on-chain.
    let held = 0;
    for (const p of store.positions.values()) if (lower(p.owner) === lower(owner)) held += 1;
    for (const r of intents.values()) if (r.kind === "open" && r.status === "accepted" && lower(r.owner) === lower(owner)) held += 1;
    if (held >= MAX_OPEN_POSITIONS) throw new Rejected(`You have ${MAX_OPEN_POSITIONS} positions open, which is the most an account can hold.`);

    const record = {
      id,
      kind: "open",
      owner,
      positionId: id,
      status: "accepted",
      pinTime: timestamp + execDelay,
      receivedAt: Date.now(),
      message,
      signature,
      need,
    };
    intents.set(id, record);
    reserve(owner, need);
    hub.publish(acct(owner), "intent", view(record));
    settleOpen(record, market).catch((error) => log.error("open", error));
    return view(record);
  }

  async function settleOpen(record, market) {
    const { message, signature, id, owner } = record;
    const notional = message.margin * BigInt(message.leverage);
    try {
      const print = orderBound
        ? await executions.price({ id: record.id, market, timestamp: Number(message.timestamp), receivedAt: record.receivedAt })
        : await book.pinned(market.id, record.pinTime, PIN_WINDOW, source.at);

      if (print.conf * BPS > print.price * BigInt(market.maxConfBps)) throw new Rejected("Price too uncertain to open right now.");
      if (message.priceLimit !== 0n && (message.isLong ? print.price > message.priceLimit : print.price < message.priceLimit)) {
        throw new Rejected("Price moved past your limit.");
      }

      // The contract refuses a leverage whose bust trigger would not sit strictly past the entry.
      if (!hasRoom(print.price, message.leverage, market)) throw new Rejected("That leverage leaves no room for a liquidation price at this price.");

      // What the position will be charged on for its size depends on what is open on its side
      // when it lands. The trader signed the most they will take; the contract holds them to it,
      // and an order already past it is not worth a transaction.
      // The market as the indexer has it now, not as it was when the order came in two seconds ago.
      const live = store.markets[market.id] ?? market;
      if ((message.isLong ? live.oiLong : live.oiShort) + notional > cashRoom()) throw new Rejected(CASH_FULL);
      const impactNotional = Number(impactNotionalFor(message.isLong ? live.oiLong : live.oiShort, notional, live.depth));
      if (message.impactLimit !== 0 && impactNotional > message.impactLimit) throw new Rejected(IMPACT_PAST_LIMIT);

      // The fill is now fixed. Show it, and have the keeper watch it, before the transaction lands.
      const position = {
        id,
        owner,
        market: market.id,
        isLong: message.isLong,
        leverage: message.leverage,
        margin: message.margin,
        debtMargin: 0n,
        entryPrice: print.price,
        entryTime: print.time,
        ...(orderBound ? { entryAtMs: print.observedAt } : {}),
        bust: bustPrice(print.price, message.leverage, message.isLong, market),
        // What the side holds now. The contract decides when the order lands, and orders ahead of
        // this one in the queue can make it more; the opening's own event then replaces this.
        impactNotional,
        status: "pending",
        closeRequestedAt: 0,
        liquidating: false,
      };
      store.positions.set(id, position);
      update(record, { status: "filled", fill: { price: print.price, time: print.time } });
      hub.publish(acct(owner), "position", position);

      const submitted = queue.push({ label: `open ${id.slice(0, 10)}`, functionName: "open", args: [message, signature, [print.blob]] });
      if (orderBound) onPricedOpen(id);
      const result = await submitted;
      if (!result.ok) throw new Rejected(result.reason === "ImpactLimitExceeded" ? IMPACT_PAST_LIMIT : (result.reason ?? "The order was not accepted on-chain."));
      // It is on-chain now. The indexer will overwrite this with the event's own data.
      if (position.status === "pending") {
        position.status = "open";
        position.openTx = result.hash;
        hub.publish(acct(owner), "position", position);
      }
      update(record, { status: "confirmed", tx: result.hash });
    } catch (error) {
      if (store.positions.get(id)?.status === "pending") {
        store.positions.delete(id);
        hub.publish(acct(owner), "position-removed", { id });
      }
      update(record, { status: "failed", error: error instanceof Rejected ? error.message : (error.message ?? "failed") });
      if (!(error instanceof Rejected)) log.warn(`open ${id.slice(0, 10)} failed: ${error.message}`);
    } finally {
      release(owner, record.need);
      forgetLater(record);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Close
  // ---------------------------------------------------------------------------------------

  async function close(body) {
    const it = body?.intent;
    const signature = body?.signature;
    if (!it || typeof it !== "object" || !isHex(signature) || !isAddr(it.owner) || !isHex(it.positionId) || it.positionId.length !== 66) {
      throw new Rejected("Malformed order.");
    }
    let message;
    try {
      message = { owner: getAddress(it.owner), positionId: it.positionId, timestamp: BigInt(it.timestamp) };
    } catch {
      throw new Rejected("Malformed order.");
    }
    const timestamp = Number(message.timestamp);
    const owner = message.owner;

    requireFresh(timestamp);
    const position = store.positions.get(message.positionId);
    if (!position || lower(position.owner) !== lower(owner)) throw new Rejected("No such open position.", 404);
    // A retired market closes at its frozen price and needs no feed.
    if (!store.markets[position.market].retired) requireLivePrices(store.markets[position.market]);
    // A binding direct close stands until it lapses; the contract refuses a signed close that
    // would be priced at or after it.
    if (position.closeRequestedAt && nowSeconds() < position.closeRequestedAt + REQUEST_EXPIRY && timestamp + execDelay >= position.closeRequestedAt + DIRECT_DELAY) {
      throw new Rejected("A direct close is already pending for this position.");
    }
    if (closing.has(position.id)) throw new Rejected("This position is already closing.");
    if (position.liquidating) throw new Rejected("This position hit its liquidation price.");
    if (!orderBound && timestamp + execDelay <= position.entryTime) throw new Rejected("Too soon after opening.");
    await requireTradeAuth(owner, "Close", message, signature, timestamp);
    // Closes are counted apart from opens, with room for a Close All on a full account (200).
    limit(owner, "closes", Math.max(config.rateLimit, CLOSES_PER_MINUTE));
    // Checked again now that nothing waits between here and the mark below: two closes for one
    // position that arrive together must not both be taken.
    if (closing.has(position.id)) throw new Rejected("This position is already closing.");

    const id = hashTypedData({ domain, types, primaryType: "Close", message });
    if (orderBound && (intents.has(id) || executions.has(id))) throw new Rejected("Duplicate close. Wait for the original order or sign a new one.");
    const record = { id, kind: "close", owner, positionId: position.id, status: "accepted", pinTime: timestamp + execDelay, receivedAt: Date.now(), message, signature };
    intents.set(id, record);
    closing.set(position.id, orderBound ? record.receivedAt : record.pinTime);
    hub.publish(acct(owner), "intent", view(record));
    settleClose(record, position).catch((error) => log.error("close", error));
    return view(record);
  }

  async function settleClose(record, position) {
    const market = store.markets[position.market];
    let succeeded = false;
    try {
      let price;
      let blob = [];
      if (market.retired) {
        price = market.frozenPrice;
      } else {
        const print = orderBound
          ? await executions.price({ id: record.id, market, timestamp: Number(record.message.timestamp), receivedAt: record.receivedAt, afterMs: position.entryAtMs ?? (position.entryTime * 1000 + 999) })
          : await book.pinned(market.id, record.pinTime, PIN_WINDOW, source.at);
        if (orderBound && position.liquidating) throw new Rejected("This position hit its liquidation price before the close.");
        if (!orderBound && print.time <= position.entryTime) throw new Rejected("Too soon after opening.");
        if (orderBound) closing.set(position.id, print.observedAt);
        price = print.price;
        blob = [print.blob];
      }
      const quote = quoteClose(position, market, price);
      update(record, { status: "filled", fill: { price, pnl: quote.pnl, busted: quote.busted } });

      const result = await queue.push({ label: `close ${position.id.slice(0, 10)}`, functionName: "close", args: [record.message, record.signature, blob] });
      if (!result.ok) {
        throw new Rejected(result.reason === "NoPosition" ? "The position was already closed or hit its liquidation price." : (result.reason ?? "The close was not accepted on-chain."));
      }
      update(record, { status: "confirmed", tx: result.hash });
      succeeded = true;
    } catch (error) {
      update(record, { status: "failed", error: error instanceof Rejected ? error.message : (error.message ?? "failed") });
      if (!(error instanceof Rejected)) log.warn(`close ${position.id.slice(0, 10)} failed: ${error.message}`);
    } finally {
      closing.delete(position.id);
      if (orderBound && !succeeded) onCloseReleased(position.id);
      forgetLater(record);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Take-profit and stop-loss
  // ---------------------------------------------------------------------------------------
  //
  // The trader signs a trigger once; it is held here, and on disk so a restart keeps it. When a
  // print at or past its price arrives (after it was signed and after the position opened), the
  // position is closed exactly as if the trader had clicked at that print: at the first price two
  // seconds later. The contract checks all of that again (Exchange.closeOnTrigger).

  const triggersDir = config.dataDir ?? join(config.root, "relayer", "data");
  const triggersFile = join(triggersDir, `triggers-${config.chainId}-${lower(addresses.exchange)}.json`);
  /** positionId -> { takeProfit, stopLoss }, each { message, signature } or absent. */
  const triggers = new Map();
  try {
    if (existsSync(triggersFile)) {
      for (const [id, pair] of Object.entries(JSON.parse(readFileSync(triggersFile, "utf8")))) {
        const revive = (t) => t && { signature: t.signature, message: { ...t.message, price: BigInt(t.message.price), timestamp: BigInt(t.message.timestamp) } };
        triggers.set(id, { takeProfit: revive(pair.takeProfit), stopLoss: revive(pair.stopLoss) });
      }
      log.info(`triggers: ${triggers.size} positions with a take-profit or stop-loss reloaded`);
    }
  } catch (error) {
    log.error(`triggers: could not read ${triggersFile}; starting with none`, error);
  }
  function saveTriggers() {
    const plain = {};
    for (const [id, pair] of triggers) {
      const flat = (t) => t && { signature: t.signature, message: { ...t.message, price: String(t.message.price), timestamp: String(t.message.timestamp) } };
      plain[id] = { takeProfit: flat(pair.takeProfit), stopLoss: flat(pair.stopLoss) };
    }
    try {
      mkdirSync(triggersDir, { recursive: true });
      writeFileSync(`${triggersFile}.tmp`, JSON.stringify(plain));
      renameSync(`${triggersFile}.tmp`, triggersFile);
    } catch (error) {
      log.error("triggers: could not save", error);
    }
  }

  /** What the site shows: the two prices, or null. */
  function triggersOf(positionId) {
    const pair = triggers.get(positionId);
    return { takeProfit: pair?.takeProfit ? String(pair.takeProfit.message.price) : null, stopLoss: pair?.stopLoss ? String(pair.stopLoss.message.price) : null };
  }
  function publishTriggers(owner, positionId) {
    hub.publish(acct(owner), "trigger", { positionId, ...triggersOf(positionId) });
  }

  /** A take-profit is on the winning side of the entry: above it for a long, below for a short. */
  const kindOf = (position, above) => (above === position.isLong ? "takeProfit" : "stopLoss");

  async function setTrigger(body) {
    const it = body?.intent;
    const signature = body?.signature;
    if (!it || typeof it !== "object" || !isHex(signature) || !isAddr(it.owner) || !isHex(it.positionId) || it.positionId.length !== 66) {
      throw new Rejected("Malformed order.");
    }
    let message;
    try {
      message = { owner: getAddress(it.owner), positionId: it.positionId, price: BigInt(it.price), above: Boolean(it.above), timestamp: BigInt(it.timestamp) };
    } catch {
      throw new Rejected("Malformed order.");
    }
    if (message.price <= 0n || message.price >= U64) throw new Rejected("Malformed order.");
    const timestamp = Number(message.timestamp);
    requireFresh(timestamp);
    const position = store.positions.get(message.positionId);
    if (!position || lower(position.owner) !== lower(message.owner)) throw new Rejected("No such open position.", 404);
    if (position.liquidating || closing.has(position.id)) throw new Rejected("This position is already closing.");
    const market = store.markets[position.market];
    if (market.retired) throw new Rejected("This market is retired.");
    const kind = kindOf(position, message.above);
    // Past the liquidation price the liquidation comes first, and a stop there would never act.
    if (kind === "stopLoss" && !crossed(message.price, position.bust, !position.isLong)) {
      throw new Rejected("That stop is past your liquidation price, which would close the position first.");
    }
    const last = book.latest(market.id);
    if (last && (message.above ? last.price >= message.price : last.price <= message.price)) {
      throw new Rejected(kind === "takeProfit" ? "The price is already past that take-profit. Close the position instead." : "The price is already past that stop. Close the position instead.");
    }
    await requireTradeAuth(message.owner, "Trigger", message, signature, timestamp);
    limit(message.owner, "triggers", Math.max(config.rateLimit, 120));
    const pair = triggers.get(position.id) ?? {};
    pair[kind] = { message, signature };
    triggers.set(position.id, pair);
    saveTriggers();
    publishTriggers(message.owner, position.id);
    return { positionId: position.id, ...triggersOf(position.id) };
  }

  async function cancelTrigger(body) {
    const it = body?.intent;
    const signature = body?.signature;
    if (!it || typeof it !== "object" || !isHex(signature) || !isAddr(it.owner) || !isHex(it.positionId) || it.positionId.length !== 66) {
      throw new Rejected("Malformed order.");
    }
    let message;
    try {
      message = { owner: getAddress(it.owner), positionId: it.positionId, above: Boolean(it.above), timestamp: BigInt(it.timestamp) };
    } catch {
      throw new Rejected("Malformed order.");
    }
    const timestamp = Number(message.timestamp);
    requireFresh(timestamp);
    const position = store.positions.get(message.positionId);
    if (!position || lower(position.owner) !== lower(message.owner)) throw new Rejected("No such open position.", 404);
    // Once touched, the close is on its way and is not taken back, like any other order.
    if (closing.has(position.id)) throw new Rejected("It has already been triggered.");
    await requireTradeAuth(message.owner, "CancelTrigger", message, signature, timestamp);
    limit(message.owner, "triggers", Math.max(config.rateLimit, 120));
    const pair = triggers.get(position.id);
    if (pair) {
      delete pair[kindOf(position, message.above)];
      if (!pair.takeProfit && !pair.stopLoss) triggers.delete(position.id);
      saveTriggers();
    }
    publishTriggers(message.owner, position.id);
    return { positionId: position.id, ...triggersOf(position.id) };
  }

  /** Every print: does it touch a trigger? The keeper calls this before it looks for busts. */
  function watchTriggers(marketId, print) {
    let pruned = false;
    for (const [id, pair] of triggers) {
      const position = store.positions.get(id);
      if (!position) {
        // Closed some other way. The indexer has had its say; the trigger means nothing now.
        if (!intents.has(id)) {
          triggers.delete(id);
          pruned = true;
        }
        continue;
      }
      if (position.market !== marketId || position.liquidating || closing.has(id)) continue;
      for (const trigger of [pair.takeProfit, pair.stopLoss]) {
        if (!trigger) continue;
        const { message } = trigger;
        const from = Math.max(Number(message.timestamp), position.entryTime);
        if (orderBound ? print.observedAt <= Math.max((Number(message.timestamp) + 1) * 1000 - 1, position.entryAtMs ?? position.entryTime * 1000 + 999) : print.time <= from) continue;
        if (message.above ? print.price < message.price : print.price > message.price) continue;
        fireTrigger(position, trigger, print);
        break;
      }
    }
    if (pruned) saveTriggers();
  }

  function fireTrigger(position, trigger, touch) {
    const id = hashTypedData({ domain, types, primaryType: "Trigger", message: trigger.message });
    const record = { id, kind: "close", owner: position.owner, positionId: position.id, status: "accepted", pinTime: touch.time + execDelay, trigger, touch };
    intents.set(id, record);
    closing.set(position.id, orderBound ? touch.observedAt : record.pinTime);
    hub.publish(acct(position.owner), "intent", view(record));
    settleTrigger(record, position).catch((error) => log.error("trigger", error));
  }

  async function settleTrigger(record, position) {
    const market = store.markets[position.market];
    const pair = triggers.get(position.id);
    let succeeded = false;
    try {
      const print = orderBound ? record.touch : await book.pinned(market.id, record.pinTime, PIN_WINDOW, source.at);
      const quote = quoteClose(position, market, print.price);
      update(record, { status: "filled", fill: { price: print.price, pnl: quote.pnl, busted: quote.busted } });
      const result = await queue.push({
        label: `trigger ${position.id.slice(0, 10)}`,
        functionName: "closeOnTrigger",
        args: [record.trigger.message, record.trigger.signature, [record.touch.blob], [print.blob]],
      });
      if (!result.ok) {
        throw new Rejected(result.reason === "NoPosition" ? "The position was already closed or hit its liquidation price." : (result.reason ?? "The close was not accepted on-chain."));
      }
      triggers.delete(position.id);
      saveTriggers();
      update(record, { status: "confirmed", tx: result.hash });
      succeeded = true;
    } catch (error) {
      // Still open: the trigger stays, and the next touch tries again.
      if (pair && store.positions.has(position.id)) triggers.set(position.id, pair);
      update(record, { status: "failed", error: error instanceof Rejected ? error.message : (error.message ?? "failed") });
      if (!(error instanceof Rejected)) log.warn(`trigger ${position.id.slice(0, 10)} failed: ${error.message}`);
    } finally {
      closing.delete(position.id);
      if (orderBound && !succeeded) onCloseReleased(position.id);
      forgetLater(record);
      publishTriggers(position.owner, position.id);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Account actions signed by the wallet itself
  // ---------------------------------------------------------------------------------------

  async function session(body) {
    const { owner, key, validUntil, signature } = body ?? {};
    if (!isAddr(owner) || !isAddr(key) || !isHex(signature) || !Number.isSafeInteger(validUntil) || validUntil < 0) {
      throw new Rejected("Malformed request.");
    }
    // The contract checks this signature too. Checking it here first means a registration nobody
    // signed costs the named account nothing: no place in the queue and none of its allowance.
    const nonce = await read("sessions", "nonces", [owner]);
    const message = { owner: getAddress(owner), key: getAddress(key), validUntil: BigInt(validUntil), nonce };
    const signed = await publicClient.verifyTypedData({ address: message.owner, domain: sessionsDomain, types, primaryType: "SessionKey", message, signature }).catch(() => false);
    if (!signed) throw new Rejected("That signature does not match. Try again.");
    limit(owner, "account");
    const result = await queue.push({
      contract: "sessions",
      label: `session ${owner.slice(0, 8)}`,
      functionName: "setSessionKeyBySig",
      args: [getAddress(owner), getAddress(key), BigInt(validUntil), signature],
    });
    if (!result.ok) throw new Rejected(result.reason === "BadSignature" ? "That signature does not match. Try again." : (result.reason ?? "Could not register the session."));
    sessions.delete(`${lower(owner)}:${lower(key)}`);
    // The key starts signing one slot after the block it was registered in. Tell the site when.
    const window = await sessionWindow(owner, key);
    return { ok: true, tx: result.hash, validFrom: window.validFrom, validUntil: window.validUntil };
  }

  async function deposit(body) {
    const { owner, amount, deadline, v, r, s } = body ?? {};
    if (!isAddr(owner) || !isHex(r) || !isHex(s) || r.length !== 66 || s.length !== 66) throw new Rejected("Malformed request.");
    let args;
    try {
      args = [getAddress(owner), BigInt(amount), BigInt(deadline), Number(v), r, s];
    } catch {
      throw new Rejected("Malformed request.");
    }
    if (args[1] <= 0n) throw new Rejected("Enter an amount.");
    if (args[2] < 0n || !Number.isInteger(args[3]) || args[3] < 0 || args[3] > 255) throw new Rejected("Malformed request.");
    // The Gateway lets an operator carry on when the permit itself fails (that is how a permit
    // somebody front-ran still becomes a deposit). The relayer is an operator, so it must only
    // submit a permit it has seen to be good. Otherwise anybody could move a wallet's USDC onto
    // the exchange, without its signature, whenever that wallet has an allowance standing.
    const permitted = await publicClient
      .simulateContract({ address: addresses.usdc, abi: PERMIT_ABI, functionName: "permit", args: [args[0], addresses.gateway, ...args.slice(1)] })
      .then(() => true, () => false);
    if (!permitted) throw new Rejected("That signature does not match. Try again.");
    limit(owner, "account");
    const result = await queue.push({
      contract: "gateway",
      label: `deposit ${owner.slice(0, 8)}`,
      functionName: "depositWithPermit",
      args,
    });
    if (!result.ok) throw new Rejected(result.reason ?? "The deposit did not go through.");
    return { ok: true, tx: result.hash };
  }

  async function withdraw(body) {
    const { owner, to, amount, deadline, signature } = body ?? {};
    if (!isAddr(owner) || !isAddr(to) || !isHex(signature)) throw new Rejected("Malformed request.");
    let value;
    let until;
    try {
      value = BigInt(amount);
      until = BigInt(deadline);
    } catch {
      throw new Rejected("Malformed request.");
    }
    // The deadline is a uint64 on-chain. One that does not fit cannot be encoded at all.
    if (until < 0n || until >= U64) throw new Rejected("Malformed request.");
    if (value <= 0n) throw new Rejected("Enter an amount.");

    // The wallet's signature is checked before anything is counted or set aside. It used to be
    // checked on-chain only, after the amount had been reserved: a withdrawal nobody signed, for
    // somebody's whole balance, was enough to have that account's orders refused meanwhile.
    const key = lower(owner);
    const nonce = (await read("exchange", "withdrawNonces", [owner])) + BigInt(withdrawing.get(key) ?? 0);
    const message = { owner: getAddress(owner), to: getAddress(to), amount: value, nonce, deadline: until };
    const signed = await publicClient.verifyTypedData({ address: message.owner, domain, types, primaryType: "Withdraw", message, signature }).catch(() => false);
    if (!signed) throw new Rejected("That signature does not match. Try again.");
    limit(owner, "account");

    const balance = await read("exchange", "balances", [owner]);
    // A withdrawal never pulls the margin out from under an open that is already accepted, and
    // from this moment its own amount is set aside too, so no later open can depend on whether
    // this withdrawal lands.
    if (balance - (reserved.get(key) ?? 0n) < value) throw new Rejected("Not enough free balance.");
    reserve(owner, value);
    withdrawing.set(key, (withdrawing.get(key) ?? 0) + 1);
    try {
      const result = await queue.push({
        label: `withdraw ${owner.slice(0, 8)}`,
        functionName: "withdrawBySig",
        args: [message.owner, message.to, value, until, signature],
      });
      if (!result.ok) throw new Rejected(result.reason === "BadSignature" ? "That signature does not match. Try again." : (result.reason ?? "The withdrawal did not go through."));
      return { ok: true, tx: result.hash };
    } finally {
      release(owner, value);
      const left = (withdrawing.get(key) ?? 1) - 1;
      if (left > 0) withdrawing.set(key, left);
      else withdrawing.delete(key);
    }
  }

  return {
    open,
    close,
    setTrigger,
    cancelTrigger,
    watchTriggers,
    triggersOf,
    /** The cash limit on one side of a market, for the site. */
    cashRoom,
    session,
    deposit,
    withdraw,
    /** The pin time of an accepted close for `positionId`, if there is one. */
    closingAt: (positionId) => closing.get(positionId) ?? null,
    intent: (id) => (intents.has(id) ? view(intents.get(id)) : null),
    intentsOf: (owner) => [...intents.values()].filter((r) => lower(r.owner) === lower(owner)).map(view),
    reservedOf: (owner) => reserved.get(lower(owner)) ?? 0n,
    /** Is `key` a session key signing for `owner` at this moment? */
    isSessionKey: async (owner, key) => {
      const window = await sessionWindow(owner, key);
      const now = nowSeconds();
      return now >= window.validFrom && now < window.validUntil;
    },
    INTENT_TTL,
  };
}
