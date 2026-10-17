/**
 * The indexer: follows the contracts' events and keeps what the site needs in memory.
 *
 * Nothing here is authoritative. It is rebuilt from the chain's logs on every start, and anything
 * a trader's money depends on is read from the contracts themselves.
 */
import { parseEventLogs } from "viem";
import { bustPrice } from "../../shared/math.mjs";
import { DIRECT_DELAY } from "../../shared/eip712.mjs";
import { acct, lower } from "./util.mjs";
import { readAccountSnapshot, balanceSnapshot } from "./account-balance.mjs";

const CHUNK = 5_000n;
const MAX_TRADES = 5_000;
const MAX_FEED = 60;
const MAX_TAPE = 80;
const MAX_LEDGER = 400;
const MAX_COIN_EVENTS = 50;
const DAY = 86_400;

export function createStore() {
  return {
    /** Static market configuration plus live open interest, by id. */
    markets: [],
    /** Open positions, and fills on their way to the chain. id -> position */
    positions: new Map(),
    pricingTimes: new Map(),
    /** Closed trades, oldest first. */
    trades: [],
    /** Lifetime numbers per trader. address -> stats */
    users: new Map(),
    /** Latest snapshot of the house, from the Lens. */
    house: null,
    /** Recent settlements for the public feed, newest first. */
    feed: [],
    /** Opens and closes for the ticker tape, newest first. */
    tape: [],
    /** Per-account histories, newest first. address -> { transfers, staking, queue, emissions } */
    ledgers: new Map(),
    /** Queued payouts still in line, in queue order. claimId -> claim */
    claims: new Map(),
    /** Queued payout spent as margin and not yet netted off a claim. address -> bigint */
    spent: new Map(),
    /** Coin-side totals. `received` and `daily` (per UTC day) are USDC sent to the staking contract. */
    coin: { mined: 0n, minedUsd: 0n, received: 0n, claimed: 0n, lastPaymentAt: 0, lastPaymentAmount: 0n, events: [], daily: new Map() },
    /** `pnl` is every trader's result added up; `bustVolume` the notional of busted positions. */
    totals: { volume: 0n, volumeByMarket: [], bustVolume: 0n, pnl: 0n, trades: 0, busts: 0, deposits: 0n, withdrawals: 0n },
    block: 0n,
  };
}

function userOf(store, address) {
  const key = lower(address);
  let user = store.users.get(key);
  if (!user) {
    user = { address, volume: 0n, pnl: 0n, trades: 0, wins: 0, busts: 0, mined: 0n, rewards: 0n };
    store.users.set(key, user);
  }
  return user;
}

function ledgerOf(store, address) {
  const key = lower(address);
  let ledger = store.ledgers.get(key);
  if (!ledger) {
    ledger = { transfers: [], staking: [], queue: [], emissions: [] };
    store.ledgers.set(key, ledger);
  }
  return ledger;
}

function note(list, entry, max = MAX_LEDGER) {
  list.unshift(entry);
  if (list.length > max) list.length = max;
}

/**
 * What each queued payout is still owed, in queue order.
 *
 * The contract nets queued payout that was spent as margin off the spender's claims lazily, oldest
 * first, when the queue reaches them. This applies the same rule up front, so the numbers shown are
 * the ones the queue will actually pay.
 */
export function liveClaims(store) {
  const left = new Map(store.spent);
  const out = [];
  let ahead = 0n;
  for (const claim of store.claims.values()) {
    let owed = claim.amount - claim.paid;
    const key = lower(claim.user);
    const spent = left.get(key) ?? 0n;
    if (spent > 0n) {
      const netted = spent < owed ? spent : owed;
      left.set(key, spent - netted);
      owed -= netted;
    }
    if (owed <= 0n) continue;
    out.push({ id: claim.id, user: claim.user, amount: owed, ahead, time: claim.time });
    ahead += owed;
  }
  return out;
}

export function createIndexer({ config, chain, store, hub, log, onEvent = () => {}, onTrade = () => {}, reservedOf = () => 0n }) {
  const { publicClient, abis, addresses, read } = chain;
  const watched = [addresses.exchange, addresses.lossMining, addresses.staking].filter(Boolean);
  const eventAbi = [...abis.exchange, ...abis.lossMining, ...abis.staking].filter((item) => item.type === "event");
  const stakingAddress = addresses.staking ? lower(addresses.staking) : null;
  const blockTimes = new Map();
  let timer = null;
  let running = false;
  let live = false;

  async function timeOf(blockNumber) {
    if (!blockTimes.has(blockNumber)) {
      const block = await publicClient.getBlock({ blockNumber });
      blockTimes.set(blockNumber, Number(block.timestamp));
      if (blockTimes.size > 2_000) blockTimes.delete(blockTimes.keys().next().value);
    }
    return blockTimes.get(blockNumber);
  }

  async function refreshMarkets() {
    const list = await read("lens", "markets");
    store.markets = list.map((m, id) => ({
      id,
      // A market's name comes from its own listing event, never from its place in the list: a
      // relisted market takes a new id, and a guess here would name it after another coin.
      symbol: store.markets[id]?.symbol ?? config.deployment.symbols?.[id] ?? `M${id}`,
      feedId: m.feedId,
      maxLeverage: m.maxLeverage,
      maxKeepBps: m.maxKeepBps,
      maxConfBps: m.maxConfBps,
      // The pricing parameters, as shared/math.mjs takes them.
      rateMultiplier: Number(m.rateMultiplier),
      positionMultiplier: Number(m.positionMultiplier),
      tick: Number(m.tick),
      bustBuffer: m.bustBuffer,
      retired: m.retired,
      frozenPrice: m.frozenPrice,
      maxNotional: m.maxNotional,
      oiLong: m.oiLong,
      oiShort: m.oiShort,
      capLong: m.capLong,
      capShort: m.capShort,
      // How much may be open on one side before size is charged for, in whole dollars.
      depth: Number(m.depth),
      // Open size in units of the asset (1e18), which the sweep marks the book with.
      sizeLong: m.sizeLong,
      sizeShort: m.sizeShort,
    }));
  }

  async function refreshHouse() {
    const [h, head] = await Promise.all([read("lens", "house"), read("exchange", "queueHead")]);
    store.house = {
      lpCash: h.lpCash,
      totalQueued: h.totalQueued,
      debtMarginOpen: h.debtMarginOpen,
      equity: h.equity,
      excess: h.excess,
      stakerCap: h.stakerCap,
      stakerFees: h.stakerFees,
      devFees: h.devFees,
      queueLength: h.queueLength,
      treasury: h.treasury,
      totalBalances: h.totalBalances,
      totalCashMargin: h.totalCashMargin,
      minMargin: h.minMargin,
      minNotional: h.minNotional,
      opensPaused: h.opensPaused,
    };
    store.houseAt = Date.now();
    pruneClaims(Number(head));
    hub.publish("house", "house", store.house);
  }

  /** Drops claims the queue has moved past, and with them the spending that was netted off them. */
  function pruneClaims(head) {
    for (const claim of store.claims.values()) {
      if (claim.id >= head) break;
      const netted = claim.amount - claim.paid;
      if (netted > 0n) {
        const key = lower(claim.user);
        const left = (store.spent.get(key) ?? 0n) - netted;
        if (left > 0n) store.spent.set(key, left);
        else store.spent.delete(key);
      }
      store.claims.delete(claim.id);
    }
  }

  /** Re-reads the house unless it was read within the last `maxAgeMs`. */
  async function freshHouse(maxAgeMs = 400) {
    if (Date.now() - (store.houseAt ?? 0) > maxAgeMs) await refreshHouse();
    return store.house;
  }

  function coinEvent(entry) {
    note(store.coin.events, entry, MAX_COIN_EVENTS);
  }

  async function apply(logEntry, balances) {
    const { eventName, args } = logEntry;
    const time = await timeOf(logEntry.blockNumber);
    const tx = logEntry.transactionHash;

    switch (eventName) {
      case "PositionPricingTime": {
        store.pricingTimes.set(args.id, Number(args.observedAt));
        break;
      }
      case "MarketListed": {
        // Symbols only exist in this event; remember them before the first refresh.
        store.markets[Number(args.id)] = { ...(store.markets[Number(args.id)] ?? {}), id: Number(args.id), symbol: args.symbol, feedId: args.feedId };
        // A position's bust price needs its market's pricing parameters, which only the contract has.
        if (store.markets[Number(args.id)].tick === undefined) await refreshMarkets();
        break;
      }
      case "PositionOpened": {
        const position = {
          id: args.id,
          owner: args.owner,
          market: Number(args.market),
          isLong: args.isLong,
          leverage: Number(args.leverage),
          margin: args.margin,
          debtMargin: args.debtMargin,
          entryPrice: args.entryPrice,
          entryTime: Number(args.entryTime),
          ...(store.pricingTimes.has(args.id) ? { entryAtMs: store.pricingTimes.get(args.id) } : {}),
          bust: bustPrice(args.entryPrice, Number(args.leverage), args.isLong, store.markets[Number(args.market)]),
          // What a win's impact is charged on, in whole dollars: fixed by the contract at open.
          impactNotional: Number(args.impactNotional),
          status: "open",
          openTx: tx,
          closeRequestedAt: 0,
          liquidating: store.positions.get(args.id)?.liquidating ?? false,
        };
        store.positions.set(args.id, position);
        store.pricingTimes.delete(args.id);
        const notional = args.margin * BigInt(args.leverage);
        const user = userOf(store, args.owner);
        user.volume += notional;
        store.totals.volume += notional;
        store.totals.volumeByMarket[position.market] = (store.totals.volumeByMarket[position.market] ?? 0n) + notional;
        const chip = { type: "open", id: args.id, owner: args.owner, market: position.market, isLong: args.isLong, notional, time };
        note(store.tape, chip, MAX_TAPE);
        hub.publish(acct(args.owner), "position", position);
        hub.publish("public", "tape", chip);
        break;
      }
      case "PositionClosed": {
        const position = store.positions.get(args.id);
        store.positions.delete(args.id);
        const busted = Number(args.kind) === 1;
        const trade = {
          id: args.id,
          owner: args.owner,
          market: Number(args.market),
          isLong: position?.isLong ?? null,
          leverage: position?.leverage ?? null,
          margin: position?.margin ?? null,
          entryPrice: position?.entryPrice ?? null,
          entryTime: position?.entryTime ?? null,
          exitPrice: args.exitPrice,
          pnl: args.pnl,
          busted,
          credited: args.credited,
          queued: args.queued,
          fee: args.fee,
          time,
          tx,
        };
        store.trades.push(trade);
        if (store.trades.length > MAX_TRADES) store.trades.shift();
        // Every closed trade, in order, the replay of history at start included: referrals are
        // added up from this and nothing else.
        onTrade(trade);
        note(store.feed, trade, MAX_FEED);

        const user = userOf(store, args.owner);
        user.pnl += args.pnl;
        user.trades += 1;
        if (args.pnl > 0n) user.wins += 1;
        if (busted) user.busts += 1;
        store.totals.trades += 1;
        store.totals.pnl += args.pnl;
        if (busted) {
          store.totals.busts += 1;
          if (position) store.totals.bustVolume += position.margin * BigInt(position.leverage);
        }

        const chip = { type: "close", id: args.id, owner: args.owner, market: trade.market, isLong: trade.isLong, pnl: args.pnl, busted, time };
        note(store.tape, chip, MAX_TAPE);
        // The close and its actual spendable balance reach the trader in the same event.
        // Never infer this from quoted PnL: some wins can be queued instead of credited.
        const snapshot = balances?.get(lower(args.owner));
        hub.publish(acct(args.owner), "closed", { ...trade, accountBalance: snapshot ? { ...snapshot, reserved: reservedOf(args.owner) } : undefined });
        hub.publish("public", "trade", trade);
        hub.publish("public", "tape", chip);
        break;
      }
      case "CloseRequested": {
        const position = store.positions.get(args.id);
        if (position) position.closeRequestedAt = Number(args.pinTime) - DIRECT_DELAY;
        break;
      }
      case "Deposited": {
        // A staking claim arrives as a deposit made by the staking contract.
        const reward = stakingAddress !== null && lower(args.from) === stakingAddress;
        if (!reward) store.totals.deposits += args.amount;
        note(ledgerOf(store, args.user).transfers, { type: reward ? "reward" : "deposit", amount: args.amount, time, tx });
        hub.publish(acct(args.user), "balance", { reason: reward ? "reward" : "deposit", amount: args.amount });
        break;
      }
      case "Withdrawn":
        store.totals.withdrawals += args.amount;
        note(ledgerOf(store, args.user).transfers, { type: "withdraw", amount: args.amount, to: args.to, time, tx });
        hub.publish(acct(args.user), "balance", { reason: "withdraw", amount: args.amount });
        break;
      case "WithdrawRequested":
        note(ledgerOf(store, args.user).transfers, { type: "withdraw-request", amount: args.amount, time, tx });
        break;
      case "Queued": {
        const id = Number(args.claimId);
        const claim = store.claims.get(id);
        // The back of the queue is extended when it already belongs to this trader.
        if (claim) claim.amount += args.amount;
        else store.claims.set(id, { id, user: args.user, amount: args.amount, paid: 0n, time });
        note(ledgerOf(store, args.user).queue, { type: "queued", claimId: id, amount: args.amount, time, tx });
        hub.publish(acct(args.user), "balance", { reason: "queued", amount: args.amount });
        break;
      }
      case "QueuePaid": {
        const claim = store.claims.get(Number(args.claimId));
        if (claim) claim.paid += args.amount;
        note(ledgerOf(store, args.user).queue, { type: "paid", claimId: Number(args.claimId), amount: args.amount, time, tx });
        hub.publish(acct(args.user), "balance", { reason: "queue-paid", amount: args.amount });
        break;
      }
      case "QueueSpent": {
        const key = lower(args.user);
        store.spent.set(key, (store.spent.get(key) ?? 0n) + args.amount);
        note(ledgerOf(store, args.user).queue, { type: "spent", claimId: null, amount: args.amount, time, tx });
        break;
      }
      case "Mined": {
        userOf(store, args.user).mined += args.amount;
        store.coin.mined += args.amount;
        store.coin.minedUsd += args.usd;
        note(ledgerOf(store, args.user).emissions, { usd: args.usd, amount: args.amount, time, tx });
        coinEvent({ type: "mined", user: args.user, usd: args.usd, amount: args.amount, time, tx });
        hub.publish(acct(args.user), "balance", { reason: "mined", amount: args.amount });
        break;
      }
      case "Staked":
      case "Unstaked": {
        const type = eventName === "Staked" ? "stake" : "unstake";
        note(ledgerOf(store, args.user).staking, { type, amount: args.amount, time, tx });
        coinEvent({ type, user: args.user, amount: args.amount, time, tx });
        break;
      }
      case "Claimed":
        userOf(store, args.user).rewards += args.amount;
        store.coin.claimed += args.amount;
        note(ledgerOf(store, args.user).staking, { type: "claim", amount: args.amount, time, tx });
        coinEvent({ type: "claim", user: args.user, amount: args.amount, time, tx });
        break;
      case "Received": {
        // A payment from the exchange into the staking stream: fees, or cash above the cap.
        store.coin.received += args.amount;
        store.coin.lastPaymentAt = time;
        store.coin.lastPaymentAmount = args.amount;
        const day = Math.floor(time / DAY) * DAY;
        store.coin.daily.set(day, (store.coin.daily.get(day) ?? 0n) + args.amount);
        coinEvent({ type: "distribution", user: null, amount: args.amount, time, tx });
        hub.publish("public", "distribution", { amount: args.amount, time });
        break;
      }
      default:
        break;
    }
    onEvent(eventName, args, logEntry);
  }

  async function pull(fromBlock, toBlock) {
    const logs = await publicClient.getLogs({ address: watched, fromBlock, toBlock });
    const parsed = parseEventLogs({ abi: eventAbi, logs, strict: false }).filter((l) => l.eventName);
    const balances = new Map();
    if (live) {
      const owners = new Map(parsed.filter(l => l.eventName === "PositionClosed").map(l => [lower(l.args.owner), l.args.owner]));
      // One read per affected wallet, even when several positions close in the same batch.
      await Promise.all([...owners].map(async ([key, owner]) => {
        let timeout;
        try {
          const snapshot = await Promise.race([
            readAccountSnapshot(chain, owner, toBlock),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("balance read timed out; refreshing separately")), 1500); }),
          ]);
          balances.set(key, balanceSnapshot(owner, snapshot));
        }
        catch (error) { log.warn(`settlement balance: ${error.shortMessage ?? error.message}`); }
        finally { clearTimeout(timeout); }
      }));
    }
    for (const entry of parsed) await apply(entry, balances);
    return parsed.length;
  }

  /** Follows the chain from the last block seen to the head. Throws if it cannot. */
  async function catchUp() {
    // viem remembers the block number for four seconds unless told not to. With that, a close
    // that had landed stayed on the books here (and on the trader's screen) for up to 4 s more.
    const head = await publicClient.getBlockNumber({ cacheTime: 0 });
    if (head <= store.block) return;
    let from = store.block + 1n;
    let seen = 0;
    while (from <= head) {
      const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
      seen += await pull(from, to);
      // What has been applied stays applied: a failure further on resumes from here.
      store.block = to;
      from = to + 1n;
    }
    if (seen > 0) await Promise.all([refreshMarkets(), refreshHouse()]);
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      await catchUp();
    } catch (error) {
      log.warn(`indexer: ${error.shortMessage ?? error.message}`);
    } finally {
      running = false;
    }
  }

  return {
    async start() {
      store.block = BigInt(config.deployment.block ?? 0) - 1n;
      if (store.block < 0n) store.block = 0n;
      // Markets first: replaying a position's opening needs its market's pricing parameters.
      await refreshMarkets();
      // The whole history, or no start at all. A relayer that began on half of it would not know
      // its own markets or positions; later ticks only warn, this one has to succeed.
      let lastError = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await catchUp();
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          log.warn(`indexer: replaying the chain's history failed (${error.shortMessage ?? error.message}); trying again`);
          await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
        }
      }
      if (lastError) throw new Error(`The indexer could not replay the chain's history: ${lastError.shortMessage ?? lastError.message}`);
      await Promise.all([refreshMarkets(), refreshHouse()]);
      live = true;
      log.info(`indexer: caught up to block ${store.block}, ${store.positions.size} open positions, ${store.trades.length} trades`);
      timer = setInterval(tick, config.pollMs);
    },
    stop() {
      clearInterval(timer);
    },
    tick,
    refreshHouse,
    freshHouse,
    refreshMarkets,
  };
}
