// Preview mode: the whole exchange, running in this browser tab.
//
// It keeps the same books the Exchange contract keeps (src/Exchange.sol) with the same pricing
// (shared/math.mjs), fills orders at the first price two seconds after they are placed, and
// answers the same requests the relayer answers. What it is not: on a chain. Prices are real
// (Hyperliquid's public feed), the money is play money, and simulated traders are disabled.
// Nothing here can be deposited or withdrawn on-chain.
//
// The world is saved in this browser and picked up again on the next visit.

import { MIN_TRADES, PRIZE_SPLIT_BPS, WEEK, season, seasonNumber, weekOf } from "@shared/seasons.mjs";
import { EXEC_DELAY, PIN_WINDOW, INTENT_TTL, DIRECT_DELAY, WITHDRAW_DELAY, GRACE, REQUEST_EXPIRY } from "@shared/eip712.mjs";
import { ApiError, type Backend, type StreamHandler } from "../api";
import { BRAND, COIN as COIN_SYMBOL } from "../mode";
import type { Address, Hex, SeriesPoint } from "../types";
import { feedIdOf } from "../hl";
import { createFeed, loadCandles, loadDayOpen, loadRecentPrints, type Candle } from "./feed";
import { BOTS, createBots } from "./bots";
import { BookError, createBooks } from "./books";

const STORE_KEY = "tape:preview:world:v7";
/** Worlds saved by earlier versions kept different books. They are dropped, not converted. */
const OLD_STORE_KEYS = ["tape:preview:world:v1", "tape:preview:world:v2", "tape:preview:world:v3", "tape:preview:world:v4", "tape:preview:world:v5", "tape:preview:world:v6"];
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const USD = 1_000_000n;
const COIN = 10n ** 18n;

const STAKER_CAP = 5_000_000n * USD;
// The limits the reference exchange trades under.
const MIN_MARGIN = 10n * USD;
const MIN_NOTIONAL = 10_000n * USD;
const AUTO_HARVEST = 4;
const MAX_KEEP_BPS = 9_000;
const COIN_SUPPLY = 1_000_000_000n * COIN;
const COIN_RESERVE = 200_000_000n * COIN;
const MINING_SCALE = 5_000_000n * USD;
const SAMPLE_EVERY = 30;
const MAX_TRADES = 1_000;
/** The share of a week's fees its prizes take, as the relayer has it by default. */
const SEASON_PRIZE_BPS = 1_000;
/** The jackpot's round, and the share of every fee that fills its pot (30% of the team's half). */
/** Pricing.sol's immutable cash limit, also checked by the relayer before intake. */
const CASH_FLOOR = 2_000_000n * 1_000_000n;
const CASH_MULTIPLE = 50n;
const JACKPOT_ROUND = 3_600;
const JACKPOT_FEE_BPS = 1_500n;
const MAX_LEDGER = 200;
const DAY = 86_400;

// The pricing parameters of BTC and ETH are the reference exchange's own, as its contract holds
// them (see shared/math.mjs). The others are set the same way for their own volatility: the
// impact curve scaled by how far each moves in a minute against ETH, a little stricter for markets
// that trade on a stock exchange's hours. `cap` is the most that may be open on each side: what a
// trader who moved the real market could be paid on is the cap times the move, so it is sized at
// about half of what rests on Hyperliquid's book within 0.15% of the price. `depth` is how much
// may be open on a side at the curve's own price, in dollars: a position opened past it keeps less
// of a small win. script/Deploy.s.sol lists the same markets with the same figures.
const M = 1_000_000n;
export const MARKETS = [
  { id: 0, symbol: "BTC", coin: "BTC", maxLeverage: 1000, rateMultiplier: 15_000, positionMultiplier: 814_598, tick: 10_000_000, bustBuffer: "476041580087574", cap: 25_000_000n * M, depth: 1_000_000, maxNotional: 10_000_000n * M },
  { id: 1, symbol: "ETH", coin: "ETH", maxLeverage: 1000, rateMultiplier: 15_000, positionMultiplier: 483_979, tick: 1_000_000, bustBuffer: "481304050180130", cap: 10_000_000n * M, depth: 1_000_000, maxNotional: 10_000_000n * M },
  { id: 2, symbol: "SOL", coin: "SOL", maxLeverage: 500, rateMultiplier: 15_000, positionMultiplier: 403_000, tick: 100_000, bustBuffer: "480000000000000", cap: 1_500_000n * M, depth: 150_000, maxNotional: 1_000_000n * M },
  { id: 3, symbol: "XRP", coin: "XRP", maxLeverage: 500, rateMultiplier: 15_000, positionMultiplier: 435_000, tick: 1_000, bustBuffer: "480000000000000", cap: 500_000n * M, depth: 50_000, maxNotional: 250_000n * M },
  { id: 4, symbol: "DOGE", coin: "DOGE", maxLeverage: 500, rateMultiplier: 15_000, positionMultiplier: 388_000, tick: 100, bustBuffer: "480000000000000", cap: 300_000n * M, depth: 30_000, maxNotional: 150_000n * M },
  { id: 5, symbol: "GOLD", coin: "xyz:GOLD", maxLeverage: 500, rateMultiplier: 25_000, positionMultiplier: 1_186_000, tick: 1_000_000, bustBuffer: "480000000000000", cap: 1_500_000n * M, depth: 150_000, maxNotional: 1_000_000n * M },
  { id: 6, symbol: "SPX", coin: "xyz:SP500", maxLeverage: 500, rateMultiplier: 40_000, positionMultiplier: 1_896_000, tick: 1_000_000, bustBuffer: "480000000000000", cap: 6_000_000n * M, depth: 600_000, maxNotional: 2_000_000n * M },
  { id: 7, symbol: "TSLA", coin: "xyz:TSLA", maxLeverage: 200, rateMultiplier: 15_000, positionMultiplier: 498_000, tick: 100_000, bustBuffer: "480000000000000", cap: 500_000n * M, depth: 50_000, maxNotional: 250_000n * M },
  { id: 8, symbol: "NVDA", coin: "xyz:NVDA", maxLeverage: 200, rateMultiplier: 15_000, positionMultiplier: 611_000, tick: 100_000, bustBuffer: "480000000000000", cap: 1_000_000n * M, depth: 100_000, maxNotional: 500_000n * M },
  { id: 9, symbol: "AAPL", coin: "xyz:AAPL", maxLeverage: 200, rateMultiplier: 18_000, positionMultiplier: 853_000, tick: 100_000, bustBuffer: "480000000000000", cap: 500_000n * M, depth: 50_000, maxNotional: 250_000n * M },
] as const;

interface Pos {
  id: Hex;
  owner: Address;
  market: number;
  isLong: boolean;
  leverage: number;
  margin: bigint;
  debtMargin: bigint;
  entryPrice: bigint;
  entryTime: number;
  bust: bigint;
  /** What a win's impact is charged on, in whole dollars. Fixed at open. */
  impactNotional: bigint;
  /** Simulated traders decide when to close as they open. */
  closeAt?: number;
  /** A take-profit and a stop-loss, each with the second it was set from. */
  takeProfit?: { price: bigint; from: number };
  stopLoss?: { price: bigint; from: number };
}

interface TradeRow {
  id: Hex;
  owner: Address;
  market: number;
  isLong: boolean;
  leverage: number;
  margin: bigint;
  entryPrice: bigint;
  entryTime: number;
  exitPrice: bigint;
  pnl: bigint;
  busted: boolean;
  credited: bigint;
  queued: bigint;
  fee: bigint;
  time: number;
  tx: Hex;
}

interface UserStats {
  address: Address;
  volume: bigint;
  pnl: bigint;
  trades: number;
  wins: number;
  busts: number;
  mined: bigint;
  rewards: bigint;
}

interface Ledger {
  transfers: Record<string, unknown>[];
  staking: Record<string, unknown>[];
  queue: Record<string, unknown>[];
  emissions: Record<string, unknown>[];
}

interface JackpotDraw {
  round: number;
  winner: Address;
  prize: bigint;
  tickets: bigint;
  time: number;
}

interface JackpotState {
  round: number;
  pot: bigint;
  /** This round's tickets: 6-decimal dollars lost, by trader. */
  tickets: Record<string, bigint>;
  owners: Record<string, Address>;
  winners: JackpotDraw[];
}

interface World {
  jackpot?: JackpotState;
  balances: Record<string, bigint>;
  wallets: Record<string, bigint>;
  queuedOf: Record<string, bigint>;
  queueSpent: Record<string, bigint>;
  claims: { id: number; user: Address; amount: bigint; time: number }[];
  nextClaim: number;
  totalQueued: bigint;
  debtMarginOpen: bigint;
  totalCashMargin: bigint;
  lpCash: bigint;
  stakerFees: bigint;
  devFees: bigint;
  positions: Pos[];
  oi: [bigint, bigint][];
  size: [bigint, bigint][];
  trades: TradeRow[];
  users: Record<string, UserStats>;
  ledgers: Record<string, Ledger>;
  names: Record<string, string>;
  tape: Record<string, unknown>[];
  series: SeriesPoint[];
  totals: { volume: bigint; volumeByMarket: bigint[]; bustVolume: bigint; pnl: bigint; trades: number; busts: number; deposits: bigint; withdrawals: bigint };
  coin: {
    reserve: bigint;
    cumulativeLossUsd: bigint;
    mined: bigint;
    wallet: Record<string, bigint>;
    staked: Record<string, bigint>;
    totalStaked: bigint;
    rewardRate: bigint;
    periodFinish: bigint;
    lastUpdate: bigint;
    rewardPerShare: bigint;
    paidPerShare: Record<string, bigint>;
    accrued: Record<string, bigint>;
    waiting: bigint;
    received: bigint;
    claimed: bigint;
    lastDistributionAt: number;
    lastDistributionAmount: bigint;
    events: Record<string, unknown>[];
    daily: Record<string, bigint>;
  };
}

function freshWorld(): World {
  return {
    balances: {},
    wallets: {},
    queuedOf: {},
    queueSpent: {},
    claims: [],
    nextClaim: 0,
    totalQueued: 0n,
    debtMarginOpen: 0n,
    totalCashMargin: 0n,
    lpCash: 0n,
    stakerFees: 0n,
    devFees: 0n,
    positions: [],
    oi: MARKETS.map(() => [0n, 0n]),
    size: MARKETS.map(() => [0n, 0n]),
    trades: [],
    users: {},
    ledgers: {},
    names: {},
    tape: [],
    series: [],
    totals: { volume: 0n, volumeByMarket: MARKETS.map(() => 0n), bustVolume: 0n, pnl: 0n, trades: 0, busts: 0, deposits: 0n, withdrawals: 0n },
    coin: {
      reserve: COIN_RESERVE,
      cumulativeLossUsd: 0n,
      mined: 0n,
      wallet: {},
      staked: {},
      totalStaked: 0n,
      rewardRate: 0n,
      periodFinish: 0n,
      lastUpdate: 0n,
      rewardPerShare: 0n,
      paidPerShare: {},
      accrued: {},
      waiting: 0n,
      received: 0n,
      claimed: 0n,
      lastDistributionAt: 0,
      lastDistributionAmount: 0n,
      events: [],
      daily: {},
    },
  };
}

// Bigints are saved as "123n" strings and sent to the interface as plain decimal strings.
const freeze = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
const thaw = (text: string) => JSON.parse(text, (_, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const key = (address: string) => address.toLowerCase();
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const usdNumber = (v: bigint) => Number(v) / 1e6;
const coinNumber = (v: bigint) => Number(v / 10n ** 12n) / 1e6;

function randomHex(bytes: number): Hex {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return `0x${[...data].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function note(list: Record<string, unknown>[], entry: Record<string, unknown>, max = MAX_LEDGER): void {
  list.unshift(entry);
  if (list.length > max) list.length = max;
}

export interface Engine {
  now: () => number;
  price: (market: number) => bigint | null;
  positionsOf: (owner: Address) => Pos[];
  balanceOf: (owner: Address) => bigint;
  fund: (owner: Address, amount: bigint) => void;
  open: (owner: Address, market: number, isLong: boolean, leverage: number, margin: bigint, useQueued: boolean, closeAt?: number) => Pos | null;
  close: (position: Pos) => void;
  coinWallet: (owner: Address) => bigint;
  staked: (owner: Address) => bigint;
  pending: (owner: Address) => bigint;
  stake: (owner: Address, amount: bigint) => void;
  claim: (owner: Address) => void;
}

/**
 * Starts the exchange in this tab. `tap` hears everything the interface is told (with the account
 * it concerns, if it concerns one), so other tabs of the same browser can be kept in step.
 */
export async function createEngine(tap?: (type: string, data: unknown, owner: string | null) => void): Promise<Backend> {
  let w: World = freshWorld();
  let restored = false;
  try {
    for (const old of OLD_STORE_KEYS) localStorage.removeItem(old);
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) {
      w = { ...freshWorld(), ...thaw(saved) };
      restored = true;
    }
  } catch {
    // A world that cannot be read is simply started over.
  }

  /** The engine's clock, in unix seconds. Real time, except while history is being replayed. */
  let clock = Math.floor(Date.now() / 1000);
  const last: ({ p: bigint; t: number } | null)[] = MARKETS.map(() => null);
  const history: { t: number; p: bigint }[][] = MARKETS.map(() => []);
  const dayOpen: (number | null)[] = MARKETS.map(() => null);
  const startedAt = Date.now();

  /** Orders waiting for their price. */
  const pending: {
    id: Hex;
    kind: "open" | "close";
    owner: Address;
    pinTime: number;
    market: number;
    positionId: Hex;
    open?: { isLong: boolean; leverage: number; margin: bigint; useQueued: boolean; impactLimit: bigint };
    need: bigint;
  }[] = [];
  const intents = new Map<string, Record<string, unknown>>();
  const reserved: Record<string, bigint> = {};

  const subscribers = new Set<{ owner: string | null; on: StreamHandler }>();
  /** While history is replayed nothing is announced: there is nobody to tell yet. */
  let quiet = false;

  function emit(type: string, data: unknown, owner?: string): void {
    if (quiet) return;
    const payload = wire(data);
    for (const sub of subscribers) if (!owner || sub.owner === key(owner)) sub.on(type, payload);
    tap?.(type, payload, owner ? key(owner) : null);
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function saveSoon(): void {
    if (quiet || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, 4_000);
  }
  /** Set once the visitor asks to start over: nothing more is written, so the wipe sticks. */
  let discarded = false;
  function save(): void {
    if (discarded) return;
    try {
      localStorage.setItem(STORE_KEY, freeze(w));
    } catch {
      // Storage is full or blocked. The preview still works; it just will not be remembered.
    }
  }

  // -------------------------------------------------------------------------------------------
  // The books. This section mirrors Exchange.sol line for line where it matters.
  // -------------------------------------------------------------------------------------------

  const userOf = (address: Address): UserStats =>
    (w.users[key(address)] ??= { address, volume: 0n, pnl: 0n, trades: 0, wins: 0, busts: 0, mined: 0n, rewards: 0n });
  const botKeys = new Set(BOTS.map((b) => key(b.address)));
  const scrap: Ledger = { transfers: [], staking: [], queue: [], emissions: [] };
  /** Only real accounts keep a history. The simulated ones are never shown one, so theirs is discarded. */
  const ledgerOf = (address: Address): Ledger => {
    if (botKeys.has(key(address))) {
      scrap.transfers.length = scrap.staking.length = scrap.queue.length = scrap.emissions.length = 0;
      return scrap;
    }
    return (w.ledgers[key(address)] ??= { transfers: [], staking: [], queue: [], emissions: [] });
  };

  // Every rule that moves money lives in books.ts, which is tested against the contracts. What
  // is here only keeps the histories and tells the interface what happened.
  const books = createBooks(
    w,
    { stakerCap: STAKER_CAP, miningScale: MINING_SCALE, autoHarvest: AUTO_HARVEST, markets: MARKETS.map((m) => ({ rateMultiplier: m.rateMultiplier, positionMultiplier: m.positionMultiplier, maxKeepBps: MAX_KEEP_BPS, tick: m.tick, bustBuffer: m.bustBuffer, depth: m.depth })) },
    () => clock,
    {
      queued: (user, claimId, amount) => note(ledgerOf(user as Address).queue, { type: "queued", claimId, amount, time: clock, tx: randomHex(32) }),
      queueSpent: (user, amount) => note(ledgerOf(user as Address).queue, { type: "spent", claimId: null, amount, time: clock, tx: randomHex(32) }),
      queuePaid(user, claimId, amount) {
        note(ledgerOf(user as Address).queue, { type: "paid", claimId, amount, time: clock, tx: randomHex(32) });
        emit("balance", { reason: "queue-paid", amount }, user);
      },
      mined(user, usd, amount) {
        userOf(user as Address).mined += amount;
        const tx = randomHex(32);
        note(ledgerOf(user as Address).emissions, { usd, amount, time: clock, tx });
        note(w.coin.events, { type: "mined", user, usd, amount, time: clock, tx }, 50);
        emit("balance", { reason: "mined", amount }, user);
      },
    },
  );
  const { balanceOf, queuedOf, credit, totalBalances, treasury, lpExcess, harvest, mineQuote, pendingReward } = books;

  /** Turns a refusal from the books into one the interface shows to the person. */
  function guard<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof BookError) throw new ApiError(error.message, 400);
      throw error;
    }
  }

  function stake(user: Address, amount: bigint): void {
    guard(() => books.stake(user, amount));
    const tx = randomHex(32);
    note(ledgerOf(user).staking, { type: "stake", amount, time: clock, tx });
    note(w.coin.events, { type: "stake", user, amount, time: clock, tx }, 50);
  }

  function unstake(user: Address, amount: bigint): void {
    guard(() => books.unstake(user, amount));
    const tx = randomHex(32);
    note(ledgerOf(user).staking, { type: "unstake", amount, time: clock, tx });
    note(w.coin.events, { type: "unstake", user, amount, time: clock, tx }, 50);
  }

  /** Rewards are credited to the trading balance, as on the chain. */
  function claim(user: Address): bigint {
    const amount = guard(() => books.claim(user));
    userOf(user).rewards += amount;
    const tx = randomHex(32);
    note(ledgerOf(user).staking, { type: "claim", amount, time: clock, tx });
    note(ledgerOf(user).transfers, { type: "reward", amount, time: clock, tx });
    note(w.coin.events, { type: "claim", user, amount, time: clock, tx }, 50);
    return amount;
  }

  /**
   * What the keeper does for stakers: sends them the fees the exchange has accrued, and has the
   * sweeper send whatever house cash above the cap the open positions leave spare. Either starts
   * (or tops up) the stream that pays stakers over the following day.
   */
  function payStakers(): void {
    let amount = 0n;
    if (w.stakerFees >= USD) amount += books.pushStakerFees();
    if (lpExcess() >= USD && last.every((tick) => tick !== null)) amount += books.sweep(last.map((tick) => tick!.p));
    if (amount === 0n) return;
    w.coin.lastDistributionAt = clock;
    w.coin.lastDistributionAmount = amount;
    const day = String(Math.floor(clock / DAY) * DAY);
    w.coin.daily[day] = (w.coin.daily[day] ?? 0n) + amount;
    note(w.coin.events, { type: "distribution", user: null, amount, time: clock, tx: randomHex(32) }, 50);
    emit("distribution", { amount, time: clock });
  }

  function openPosition(owner: Address, market: number, isLong: boolean, leverage: number, margin: bigint, useQueued: boolean, price: bigint, closeAt?: number, impactLimit = 0n): Pos {
    const position = guard(() => books.open({ id: randomHex(32), owner, market, isLong, leverage, margin, entryPrice: price, entryTime: clock, closeAt }, useQueued, impactLimit));
    const notional = margin * BigInt(leverage);
    userOf(owner).volume += notional;
    w.totals.volume += notional;
    w.totals.volumeByMarket[market] += notional;
    const chip = { type: "open", id: position.id, owner, market, isLong, notional, time: clock };
    note(w.tape, chip, 60);
    emit("tape", chip);
    return position;
  }

  function settlePosition(p: Pos, exitPrice: bigint, forced: boolean): TradeRow {
    const notional = p.margin * BigInt(p.leverage);
    const result = books.settlePosition(p, exitPrice, forced);
    const trade: TradeRow = {
      id: p.id,
      owner: p.owner,
      market: p.market,
      isLong: p.isLong,
      leverage: p.leverage,
      margin: p.margin,
      entryPrice: p.entryPrice,
      entryTime: p.entryTime,
      exitPrice,
      pnl: result.pnl,
      busted: result.busted,
      credited: result.credited,
      queued: result.queued,
      fee: result.fee,
      time: clock,
      tx: randomHex(32),
    };
    w.trades.push(trade);
    if (w.trades.length > MAX_TRADES) w.trades.shift();
    // The jackpot: its share of the fee fills the pot, and a loss is tickets (a liquidation its
    // whole margin, a losing close the loss less the fee), as loss mining enters them on-chain.
    {
      const jp = jackpotState();
      jp.pot += (result.fee * JACKPOT_FEE_BPS) / 10_000n;
      const lost = result.busted ? p.margin : result.pnl < 0n ? -result.pnl - result.fee : 0n;
      if (lost > 0n) {
        jp.tickets[key(p.owner)] = (jp.tickets[key(p.owner)] ?? 0n) + lost;
        jp.owners[key(p.owner)] = p.owner;
      }
    }
    const user = userOf(p.owner);
    user.pnl += result.pnl;
    user.trades += 1;
    if (result.pnl > 0n) user.wins += 1;
    w.totals.trades += 1;
    w.totals.pnl += result.pnl;
    if (result.busted) {
      user.busts += 1;
      w.totals.busts += 1;
      w.totals.bustVolume += notional;
    }
    const chip = { type: "close", id: p.id, owner: p.owner, market: p.market, isLong: p.isLong, pnl: result.pnl, busted: result.busted, time: clock };
    note(w.tape, chip, 60);
    emit("closed", trade, p.owner);
    emit("trade", trade);
    emit("tape", chip);
    houseSoon();
    saveSoon();
    return trade;
  }

  function jackpotState(): JackpotState {
    w.jackpot ??= { round: Math.floor(clock / JACKPOT_ROUND), pot: 0n, tickets: {}, owners: {}, winners: [] };
    return w.jackpot;
  }

  /** When the hour turns: one ticket of the hour just ended wins the pot, paid to the wallet. */
  function drawJackpot(): void {
    const jp = jackpotState();
    const round = Math.floor(clock / JACKPOT_ROUND);
    if (round === jp.round) return;
    const entries = Object.entries(jp.tickets);
    const total = entries.reduce((sum, [, t]) => sum + t, 0n);
    if (total > 0n && jp.pot > 0n) {
      let point = BigInt(Math.floor(Math.random() * Number(total)));
      let winner = jp.owners[entries[entries.length - 1][0]];
      for (const [who, t] of entries) {
        if (point < t) {
          winner = jp.owners[who];
          break;
        }
        point -= t;
      }
      const draw: JackpotDraw = { round: jp.round, winner, prize: jp.pot, tickets: total, time: (jp.round + 1) * JACKPOT_ROUND };
      w.wallets[key(winner)] = (w.wallets[key(winner)] ?? 0n) + jp.pot;
      jp.pot = 0n;
      jp.winners.unshift(draw);
      jp.winners.splice(12);
      emit("jackpot", draw);
    }
    jp.round = round;
    jp.tickets = {};
    jp.owners = {};
    saveSoon();
  }

  let houseTimer: ReturnType<typeof setTimeout> | null = null;
  function houseSoon(): void {
    if (quiet || houseTimer) return;
    houseTimer = setTimeout(() => {
      houseTimer = null;
      emit("house", houseState());
    }, 800);
  }

  // -------------------------------------------------------------------------------------------
  // Prices, fills, busts
  // -------------------------------------------------------------------------------------------

  function setIntent(id: string, patch: Record<string, unknown>): void {
    const record = { ...(intents.get(id) ?? {}), ...patch };
    intents.set(id, record);
    emit("intent", record, record.owner as string);
  }

  function release(owner: Address, amount: bigint): void {
    const left = (reserved[key(owner)] ?? 0n) - amount;
    reserved[key(owner)] = left > 0n ? left : 0n;
  }

  function fill(order: (typeof pending)[number], price: bigint): void {
    try {
      if (order.kind === "open") {
        const o = order.open!;
        release(order.owner, order.need);
        const position = openPosition(order.owner, order.market, o.isLong, o.leverage, o.margin, o.useQueued, price, undefined, o.impactLimit);
        // The position takes the order's id, as on the chain.
        position.id = order.id;
        const chip = w.tape[0];
        if (chip) chip.id = order.id;
        setIntent(order.id, { status: "filled", fill: { price, time: clock } });
        emit("position", positionView(position), order.owner);
        setIntent(order.id, { status: "confirmed", tx: randomHex(32) });
      } else {
        const position = w.positions.find((p) => p.id === order.positionId);
        if (!position) throw new ApiError("The position was already closed or hit its liquidation price.", 404);
        const trade = settlePosition(position, price, false);
        setIntent(order.id, { status: "filled", fill: { price, pnl: trade.pnl, busted: trade.busted } });
        setIntent(order.id, { status: "confirmed", tx: trade.tx });
      }
    } catch (error) {
      setIntent(order.id, { status: "failed", error: error instanceof Error ? error.message : "failed" });
    }
    setTimeout(() => intents.delete(order.id), 10 * 60_000);
  }

  function onPrice(market: number, price: bigint, time: number): void {
    const previous = last[market];
    if (previous && time < previous.t) return;
    clock = Math.max(clock, time);
    last[market] = { p: price, t: time };
    const points = history[market];
    if (points.length && points[points.length - 1].t === time) points[points.length - 1].p = price;
    else points.push({ t: time, p: price });
    if (points.length > 2_400) points.splice(0, points.length - 2_400);
    emit("tick", { m: market, t: time, p: price });

    // Orders whose two seconds are up fill at this, the first price after them.
    for (let i = pending.length - 1; i >= 0; i--) {
      const order = pending[i];
      if (order.market !== market || order.pinTime > time) continue;
      pending.splice(i, 1);
      // An order is only good for a minute, as on the chain. If its price never came (the tab was
      // asleep, the feed dropped) it lapses instead of filling at whatever the price is by now.
      if (time > order.pinTime + INTENT_TTL) {
        release(order.owner, order.need);
        setIntent(order.id, { status: "failed", error: "The order expired before a price arrived. Nothing was opened." });
        continue;
      }
      fill(order, price);
    }

    // A take-profit or stop-loss this price touches closes the position at the first price two
    // seconds later, as a click at this moment would.
    for (const position of w.positions) {
      if (position.market !== market || (!position.takeProfit && !position.stopLoss)) continue;
      if (pending.some((o) => o.kind === "close" && o.positionId === position.id)) continue;
      const touched = [position.takeProfit, position.stopLoss].find((t) => {
        if (!t || time <= Math.max(t.from, position.entryTime)) return false;
        const above = t === position.takeProfit ? position.isLong : !position.isLong;
        return above ? price >= t.price : price <= t.price;
      });
      if (!touched) continue;
      const id = randomHex(32);
      const pinTime = time + EXEC_DELAY;
      pending.push({ id, kind: "close", owner: position.owner, pinTime, market, positionId: position.id, need: 0n });
      intents.set(id, { id, kind: "close", owner: position.owner, status: "accepted", pinTime, positionId: position.id, fill: null, error: null, tx: null });
      emit("intent", intents.get(id), position.owner);
      position.takeProfit = undefined;
      position.stopLoss = undefined;
      emit("trigger", { positionId: position.id, takeProfit: null, stopLoss: null }, position.owner);
    }

    // Anything this price has pushed past its bust is gone.
    for (const position of [...w.positions]) {
      if (position.market !== market || position.entryTime >= time) continue;
      if (books.isBusted(position, price)) settlePosition(position, price, true);
    }
  }

  function sample(): void {
    const point: SeriesPoint = {
      t: clock,
      lp: usdNumber(w.lpCash),
      eq: usdNumber(w.lpCash - w.totalQueued - w.debtMarginOpen),
      q: usdNumber(w.totalQueued),
      tvl: usdNumber(treasury()),
      oi: w.oi.map(([long, short]) => [usdNumber(long), usdNumber(short)] as [number, number]),
      px: last.map((tick) => (tick ? Number(tick.p) / 1e8 : 0)),
      mined: coinNumber(w.coin.mined),
      staked: coinNumber(w.coin.totalStaked),
      paid: usdNumber(w.coin.received),
      vol: usdNumber(w.totals.volume),
      volm: w.totals.volumeByMarket.map(usdNumber),
      pnl: usdNumber(w.totals.pnl),
      n: w.totals.trades,
      users: Object.keys(w.users).length,
    };
    w.series.push(point);
    const cutoff = clock - DAY;
    while (w.series.length && (w.series[0].t < cutoff || w.series.length > 2_900)) w.series.shift();
  }

  // -------------------------------------------------------------------------------------------
  // The simulated traders
  // -------------------------------------------------------------------------------------------

  const engine: Engine = {
    now: () => clock,
    price: (market) => last[market]?.p ?? null,
    positionsOf: (owner) => w.positions.filter((p) => key(p.owner) === key(owner)),
    balanceOf,
    fund(owner, amount) {
      credit(owner, amount);
      w.totals.deposits += amount;
    },
    open(owner, market, isLong, leverage, margin, useQueued, closeAt) {
      const price = last[market]?.p;
      if (!price) return null;
      // The simulated crowd trades under the same cap as anyone.
      if (w.oi[market][isLong ? 0 : 1] + margin * BigInt(leverage) > MARKETS[market].cap) return null;
      return openPosition(owner, market, isLong, leverage, margin, useQueued, price, closeAt);
    },
    close(position) {
      const price = last[position.market]?.p;
      if (price && w.positions.includes(position)) settlePosition(position, price, false);
    },
    coinWallet: (owner) => w.coin.wallet[key(owner)] ?? 0n,
    staked: (owner) => w.coin.staked[key(owner)] ?? 0n,
    pending: pendingReward,
    stake,
    claim: (owner) => void claim(owner),
  };
  // The simulated crowd is off: every trade, figure and winner here is a real visitor's.
  const SIMULATED_TRADERS = false;
  const bots = SIMULATED_TRADERS ? createBots(engine) : { step() {} };

  // -------------------------------------------------------------------------------------------
  // Start: replay a few hours of real prices so the exchange is not empty, then go live
  // -------------------------------------------------------------------------------------------

  function replay(candles: Candle[][]): void {
    const ticks: { market: number; t: number; p: number }[] = [];
    candles.forEach((list, market) => {
      for (const c of list) {
        // Four prints a minute: open, the far side first, then the near side, then close.
        const up = c.close >= c.open;
        ticks.push({ market, t: c.time, p: c.open }, { market, t: c.time + 15, p: up ? c.low : c.high }, { market, t: c.time + 30, p: up ? c.high : c.low }, { market, t: c.time + 45, p: c.close });
      }
    });
    ticks.sort((a, b) => a.t - b.t);
    if (ticks.length === 0) return;
    quiet = true;
    clock = ticks[0].t;
    let lastStep = clock;
    let lastSample = 0;
    for (const tick of ticks) {
      if (tick.t >= Math.floor(Date.now() / 1000)) break;
      onPrice(tick.market, BigInt(Math.round(tick.p * 1e8)), tick.t);
      if (clock > lastStep) {
        bots.step(clock - lastStep);
        payStakers();
        drawJackpot();
        lastStep = clock;
      }
      if (clock - lastSample >= 60) {
        sample();
        lastSample = clock;
      }
    }
    quiet = false;
  }

  const feed = createFeed(
    MARKETS.map((m) => m.coin),
    (index, mid) => onPrice(index, BigInt(Math.round(mid * 1e8)), Math.floor(Date.now() / 1000)),
  );

  async function refreshDayOpen(): Promise<void> {
    await Promise.all(MARKETS.map(async (market) => {
      try {
        const open = await loadDayOpen(market.coin);
        if (open !== null && open !== dayOpen[market.id]) {
          dayOpen[market.id] = open;
          emit("reference", { m: market.id, p: open });
        }
      } catch {
        // Keep the last valid reference; the next refresh retries a failed request.
      }
    }));
  }

  // Recent candles and the price a day ago, fetched together. Neither is allowed to hold the page up.
  const giveUp = <T,>(fallback: T) => new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 3_500));
  const noPrints = (): { t: number; p: number }[] => [];
  const [candles, , prints] = await Promise.all([
    Promise.race([Promise.all(MARKETS.map((m) => loadCandles(m.coin).catch(() => [] as Candle[]))), giveUp(MARKETS.map(() => [] as Candle[]))]),
    // Each market publishes as soon as it arrives, including after the startup deadline.
    Promise.race([refreshDayOpen(), giveUp(undefined)]),
    Promise.race([Promise.all(MARKETS.map((m) => loadRecentPrints(m.coin).catch(noPrints))), giveUp(MARKETS.map(noPrints))]),
  ]);
  setInterval(() => void refreshDayOpen(), 15_000);

  if (!restored) {
    replay(candles.map((list) => list.slice(-150)));
    save();
  }
  // What the tick chart opens with, so it is a chart from the first moment and not a sliver:
  // the last minutes trade by trade (one price a second, as far back as the public tape goes in
  // one page), and before that the path each minute took (open, the far side, the near side,
  // close) for the rest of the last hour.
  candles.forEach((list, market) => {
    const now = Math.floor(Date.now() / 1000);
    const e8 = (price: number) => BigInt(Math.round(price * 1e8));
    const recent = prints[market].filter((print) => print.t <= now);
    const from = recent.length ? recent[0].t : now;
    const points: { t: number; p: bigint }[] = [];
    for (const c of list.slice(-61)) {
      const up = c.close >= c.open;
      const path: [number, number][] = [
        [c.time, c.open],
        [c.time + 15, up ? c.low : c.high],
        [c.time + 30, up ? c.high : c.low],
        [c.time + 45, c.close],
      ];
      for (const [t, price] of path) if (t < from && t < now) points.push({ t, p: e8(price) });
    }
    for (const print of recent) points.push({ t: print.t, p: e8(print.p) });
    history[market] = points;
    const newest = points[points.length - 1];
    const tail = list[list.length - 1];
    if (newest) last[market] = { p: newest.p, t: newest.t };
    else if (tail) last[market] = { p: e8(tail.close), t: Math.min(tail.time + 59, now) };
  });
  clock = Math.floor(Date.now() / 1000);
  feed.start();

  // A quiet market still prints the moment a new second starts, so an order whose two seconds are
  // up fills then, as the real price signer does (within 50 ms), and never a second late.
  setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    MARKETS.forEach((_, i) => {
      const tick = last[i];
      if (tick && now > tick.t && feed.healthy(i)) onPrice(i, tick.p, now);
    });
  }, 50);

  // The heartbeat: the simulated traders act, stakers are paid, the charts get a sample.
  let lastBeat = clock;
  let lastSample = clock;
  let auditFailed = false;
  setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    MARKETS.forEach((_, i) => {
      const tick = last[i];
      if (tick && now > tick.t && feed.healthy(i)) onPrice(i, tick.p, now);
    });
    clock = Math.max(clock, now);
    if (!feed.healthy()) return;
    bots.step(Math.min(clock - lastBeat, 5));
    lastBeat = clock;
    drawJackpot();
    if (clock % 5 === 0) payStakers();
    if (w.totalQueued !== 0n && w.lpCash > 0n) harvest(32);
    if (clock - lastSample >= SAMPLE_EVERY) {
      sample();
      lastSample = clock;
      saveSoon();
      // The books check themselves twice a minute. If they ever stop adding up, say so loudly
      // rather than carry on quietly wrong.
      const wrong = books.audit(0n);
      if (wrong.length && !auditFailed) {
        auditFailed = true;
        console.error(`preview books failed their own audit: ${wrong.slice(0, 3).join("; ")}`);
      }
    }
  }, 1_000);
  // Whatever this tab knows is written down the moment it stops being looked at, so another tab
  // (or the next visit) picks up exactly where it left off.
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });

  // -------------------------------------------------------------------------------------------
  // What the interface asks for
  // -------------------------------------------------------------------------------------------

  function liveClaims() {
    const left: Record<string, bigint> = { ...w.queueSpent };
    const out: { id: number; user: Address; amount: bigint; ahead: bigint; time: number }[] = [];
    let ahead = 0n;
    for (const claim of w.claims) {
      let owed = claim.amount;
      const spent = left[key(claim.user)] ?? 0n;
      if (spent > 0n) {
        const netted = min(spent, owed);
        left[key(claim.user)] = spent - netted;
        owed -= netted;
      }
      if (owed <= 0n) continue;
      out.push({ id: claim.id, user: claim.user, amount: owed, ahead, time: claim.time });
      ahead += owed;
    }
    return out;
  }

  const positionView = (p: Pos) => ({
    id: p.id,
    owner: p.owner,
    market: p.market,
    isLong: p.isLong,
    leverage: p.leverage,
    margin: p.margin,
    debtMargin: p.debtMargin,
    entryPrice: p.entryPrice,
    entryTime: p.entryTime,
    bust: p.bust,
    impactNotional: Number(p.impactNotional),
    status: "open",
    closeRequestedAt: 0,
    liquidating: false,
    takeProfit: p.takeProfit ? p.takeProfit.price : null,
    stopLoss: p.stopLoss ? p.stopLoss.price : null,
  });

  const marketView = (m: (typeof MARKETS)[number]) => ({
    id: m.id,
    symbol: m.symbol,
    feedId: feedIdOf(m.coin),
    maxLeverage: m.maxLeverage,
    maxKeepBps: 9000,
    maxConfBps: 1000,
    rateMultiplier: m.rateMultiplier,
    positionMultiplier: m.positionMultiplier,
    tick: m.tick,
    bustBuffer: m.bustBuffer,
    retired: false,
    frozenPrice: 0n,
    maxNotional: m.maxNotional,
    oiLong: w.oi[m.id][0],
    oiShort: w.oi[m.id][1],
    capLong: m.cap,
    capShort: m.cap,
    depth: m.depth,
    price: last[m.id]?.p ?? null,
    ref24h: dayOpen[m.id],
  });

  const houseState = () => ({
    lpCash: w.lpCash,
    totalQueued: w.totalQueued,
    debtMarginOpen: w.debtMarginOpen,
    equity: w.lpCash - w.totalQueued - w.debtMarginOpen,
    excess: lpExcess(),
    stakerCap: STAKER_CAP,
    stakerFees: w.stakerFees,
    devFees: w.devFees,
    queueLength: BigInt(w.claims.length),
    treasury: treasury(),
    totalBalances: totalBalances(),
    totalCashMargin: w.totalCashMargin,
    minMargin: MIN_MARGIN,
    minNotional: MIN_NOTIONAL,
    opensPaused: false,
  });

  const WINDOWS: Record<string, number> = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY, all: Infinity };
  const byPnl = (x: { pnl: bigint }, y: { pnl: bigint }) => (y.pnl > x.pnl ? 1 : y.pnl < x.pnl ? -1 : 0);

  function accountsBoard(since: number) {
    const rows = new Map<string, { address: Address; pnl: bigint; volume: bigint; trades: number; wins: number; busts: number }>();
    for (const t of w.trades) {
      if (t.time < since) continue;
      const row = rows.get(key(t.owner)) ?? { address: t.owner, pnl: 0n, volume: 0n, trades: 0, wins: 0, busts: 0 };
      row.pnl += t.pnl;
      row.volume += t.margin * BigInt(t.leverage);
      row.trades += 1;
      if (t.pnl > 0n) row.wins += 1;
      if (t.busted) row.busts += 1;
      rows.set(key(t.owner), row);
    }
    return [...rows.values()].sort(byPnl);
  }

  function namesOf(list: Address[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const address of list) {
      const name = w.names[key(address)] ?? BOTS.find((b) => key(b.address) === key(address))?.name;
      if (name) out[key(address)] = name;
    }
    return out;
  }

  function accountPayload(owner: Address) {
    const claims = liveClaims();
    const mine = claims.filter((c) => key(c.user) === key(owner));
    const stats = userOf(owner);
    const badges: { window: string; rank: number }[] = [];
    for (const [window, span] of Object.entries(WINDOWS)) {
      const rank = accountsBoard(span === Infinity ? 0 : clock - span).findIndex((row) => key(row.address) === key(owner) && row.pnl > 0n);
      if (rank >= 0 && rank < 10) badges.push({ window, rank: rank + 1 });
    }
    return {
      address: owner,
      name: w.names[key(owner)] ?? null,
      balance: balanceOf(owner),
      queued: queuedOf(owner),
      queueAhead: mine.length ? mine[0].ahead : null,
      claims: mine,
      reserved: reserved[key(owner)] ?? 0n,
      marginInUse: w.positions.filter((p) => key(p.owner) === key(owner)).reduce((sum, p) => sum + p.margin, 0n),
      sessionNonce: 0n,
      withdrawNonce: 0n,
      withdrawRequest: null,
      positions: w.positions.filter((p) => key(p.owner) === key(owner)).map(positionView),
      intents: [...intents.values()].filter((r) => key(r.owner as string) === key(owner)),
      wallet: { usdc: w.wallets[key(owner)] ?? 0n, usdcNonce: 0n, eth: 0n },
      coin: {
        wallet: w.coin.wallet[key(owner)] ?? 0n,
        staked: w.coin.staked[key(owner)] ?? 0n,
        pending: pendingReward(owner),
        stakingAllowance: 0n,
        claimed: stats.rewards,
      },
      stats,
      badges,
    };
  }

  function housePayload() {
    const day = clock - DAY;
    let volume24h = 0n;
    let trades24h = 0;
    const volume24hByMarket = MARKETS.map(() => 0n);
    for (let i = w.trades.length - 1; i >= 0 && w.trades[i].time >= day; i--) {
      const notional = w.trades[i].margin * BigInt(w.trades[i].leverage);
      volume24h += notional;
      volume24hByMarket[w.trades[i].market] += notional;
      trades24h += 1;
    }
    const claims = liveClaims();
    const largest = claims.reduce((best, c) => (c.amount > best ? c.amount : best), 0n);
    return {
      house: houseState(),
      queue: claims.slice(0, 25).map(({ id, user, amount }) => ({ id, user, amount })),
      queueStats: { entries: claims.length, largest, front: claims[0]?.amount ?? 0n },
      markets: MARKETS.map(marketView),
      totals: {
        ...w.totals,
        traders: Object.keys(w.users).length,
        openPositions: w.positions.length,
        openMargin: w.positions.reduce((sum, p) => sum + p.margin, 0n),
        volume24h,
        volume24hByMarket,
        trades24h,
      },
      feed: w.trades.slice(-30).reverse(),
      positions: w.positions.map((p) => ({ m: p.market, l: p.isLong, g: p.margin, x: p.leverage, e: p.entryPrice, b: p.bust, i: Number(p.impactNotional) })),
    };
  }

  const coinPayload = () => ({
    attached: true,
    address: ZERO,
    staking: ZERO,
    lossMining: ZERO,
    name: BRAND,
    symbol: COIN_SYMBOL,
    supply: COIN_SUPPLY,
    mining: { reserve: w.coin.reserve, cumulativeLossUsd: w.coin.cumulativeLossUsd, scaleUsd: MINING_SCALE, perDollar: mineQuote(USD), mined: w.coin.mined },
    stakingState: {
      totalStaked: w.coin.totalStaked,
      // The stream: USDC per second scaled by 1e18, when it ends, and what it has left to pay.
      streamRate: clock < Number(w.coin.periodFinish) ? w.coin.rewardRate : 0n,
      streamEnds: Number(w.coin.periodFinish),
      unstreamed: books.unstreamed(),
      waiting: w.coin.waiting,
      totalReceived: w.coin.received,
      totalClaimed: w.coin.claimed,
      lastDistributionAt: w.coin.lastDistributionAt,
      lastDistributionAmount: w.coin.lastDistributionAmount,
    },
    // On the exchange and not yet sent: accrued fees, and house cash above the cap that the open
    // positions leave spare at current prices.
    pendingFees: w.stakerFees + (last.every((tick) => tick !== null) ? books.sweepable(last.map((tick) => tick!.p)) : 0n),
    rewardRate: w.totalQueued > 0n ? 0 : lpExcess() > 0n ? 99 : 1,
    events: w.coin.events.slice(0, 25),
    daily: Object.entries(w.coin.daily)
      .slice(-30)
      .map(([t, amount]) => ({ t: Number(t), amount })),
  });

  function seriesPayload(seconds: number) {
    const since = clock - seconds;
    const window = w.series.filter((p) => p.t >= since);
    const step = Math.ceil(window.length / 360) || 1;
    const points = window.filter((_, i) => i % step === 0);
    if (window.length && points[points.length - 1] !== window[window.length - 1]) points.push(window[window.length - 1]);
    return { points };
  }

  const configPayload = () => ({
    name: BRAND,
    chainId: 0,
    time: Date.now(),
    priceSource: "preview",
    addresses: { exchange: ZERO, sessions: ZERO, lens: ZERO, gateway: ZERO, oracle: ZERO, usdc: ZERO, coin: ZERO, staking: ZERO, lossMining: ZERO },
    usdcPermit: { name: "USD Coin", version: "2" },
    timing: { execDelay: EXEC_DELAY, pinWindow: PIN_WINDOW, intentTtl: INTENT_TTL, directDelay: DIRECT_DELAY, withdrawDelay: WITHDRAW_DELAY, grace: GRACE, requestExpiry: REQUEST_EXPIRY },
    markets: MARKETS.map(marketView),
    minMargin: MIN_MARGIN,
    minNotional: MIN_NOTIONAL,
    opensPaused: false,
    coin: { address: ZERO, staking: ZERO, lossMining: ZERO, symbol: COIN_SYMBOL },
    tape: w.tape.slice(0, 40),
  });

  const statusPayload = () => ({
    ok: feed.healthy(),
    time: Date.now(),
    startedAt,
    chainId: 0,
    block: 0n,
    source: "preview",
    opensPaused: false,
    feeds: MARKETS.map((m) => ({ market: m.id, symbol: m.symbol, retired: false, time: last[m.id]?.t ?? null, price: last[m.id]?.p ?? null })),
    operator: ZERO,
    operatorEth: 0n,
    oracleFloat: 0n,
    streams: subscribers.size,
    openPositions: w.positions.length,
    queue: liveClaims()
      .slice(0, 10)
      .map(({ id, user, amount, time }) => ({ id, user, amount, time })),
    blocks: [],
  });

  // -------------------------------------------------------------------------------------------
  // What the interface can do
  // -------------------------------------------------------------------------------------------

  /** A play account starts with money on the exchange and more in its "wallet". */
  function welcome(owner: Address): void {
    if (w.wallets[key(owner)] !== undefined) return;
    w.wallets[key(owner)] = 40_000n * USD;
    credit(owner, 10_000n * USD);
    w.totals.deposits += 10_000n * USD;
    note(ledgerOf(owner).transfers, { type: "deposit", amount: 10_000n * USD, time: clock, tx: randomHex(32) });
    saveSoon();
  }

  type Body = Record<string, unknown>;

  function requireLive(market: number): void {
    const tick = last[market];
    if (!feed.healthy(market) || !tick || Math.floor(Date.now() / 1000) - tick.t > 6) {
      throw new ApiError("Prices are not updating right now. Try again in a moment.", 503);
    }
  }

  function postOpen(body: Body) {
    const it = body.intent as Body;
    const owner = it.owner as Address;
    const market = Number(it.market);
    const leverage = Number(it.leverage);
    const margin = BigInt(it.margin as string);
    const useQueued = Boolean(it.useQueued);
    const impactLimit = BigInt(Number(it.impactLimit ?? 0));
    if (!MARKETS[market]) throw new ApiError("Unknown market.", 400);
    requireLive(market);
    const spec = MARKETS[market];
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > spec.maxLeverage) throw new ApiError(`Leverage on ${spec.symbol} goes from 1 to ${spec.maxLeverage}.`, 400);
    if (margin < MIN_MARGIN) throw new ApiError("Margin is below the $10 minimum.", 400);
    if (margin * BigInt(leverage) < MIN_NOTIONAL) throw new ApiError("Position is below the $10,000 minimum. Add margin or leverage.", 400);
    if (margin * BigInt(leverage) > spec.maxNotional) throw new ApiError("Position is larger than this market allows.", 400);
    if (w.oi[market][it.isLong ? 0 : 1] + margin * BigInt(leverage) > MARKETS[market].cap) throw new ApiError("This side of the market is full right now.", 400);
    // Refuse at intake too; the books recheck the immutable ceiling when the order fills.
    if (w.oi[market][it.isLong ? 0 : 1] + margin * BigInt(leverage) > CASH_FLOOR + (w.lpCash > 0n ? w.lpCash : 0n) * CASH_MULTIPLE) {
      throw new ApiError("This side of the market is full for now: what can be open grows with the vault's cash.", 400);
    }
    if (w.positions.filter((p) => key(p.owner) === key(owner)).length >= 200) throw new ApiError("You have 200 positions open, which is the most an account can hold.", 400);
    const queued = useQueued ? queuedOf(owner) : 0n;
    const free = balanceOf(owner) - (reserved[key(owner)] ?? 0n);
    const cashNeed = margin > queued ? margin - queued : 0n;
    if (free < cashNeed) throw new ApiError("Not enough balance.", 400);

    const id = randomHex(32);
    const pinTime = Number(it.timestamp) + EXEC_DELAY;
    reserved[key(owner)] = (reserved[key(owner)] ?? 0n) + cashNeed;
    pending.push({ id, kind: "open", owner, pinTime, market, positionId: id, open: { isLong: Boolean(it.isLong), leverage, margin, useQueued, impactLimit }, need: cashNeed });
    const record = { id, kind: "open", owner, status: "accepted", pinTime, positionId: id, fill: null, error: null, tx: null };
    intents.set(id, record);
    return record;
  }

  function postClose(body: Body) {
    const it = body.intent as Body;
    const owner = it.owner as Address;
    const position = w.positions.find((p) => p.id === it.positionId && key(p.owner) === key(owner));
    if (!position) throw new ApiError("No such open position.", 404);
    requireLive(position.market);
    if (pending.some((o) => o.kind === "close" && o.positionId === position.id)) throw new ApiError("This position is already closing.", 400);
    const id = randomHex(32);
    const pinTime = Number(it.timestamp) + EXEC_DELAY;
    pending.push({ id, kind: "close", owner, pinTime, market: position.market, positionId: position.id, need: 0n });
    const record = { id, kind: "close", owner, status: "accepted", pinTime, positionId: position.id, fill: null, error: null, tx: null };
    intents.set(id, record);
    return record;
  }

  /** A take-profit sits on the winning side of the entry: above it for a long, below for a short. */
  const kindOf = (position: Pos, above: boolean) => (above === position.isLong ? "takeProfit" : "stopLoss");

  function triggerTarget(body: Body) {
    const it = body.intent as Body;
    const owner = it.owner as Address;
    const position = w.positions.find((p) => p.id === it.positionId && key(p.owner) === key(owner));
    if (!position) throw new ApiError("No such open position.", 404);
    if (pending.some((o) => o.kind === "close" && o.positionId === position.id)) throw new ApiError("This position is already closing.", 400);
    return { it, owner, position, above: Boolean(it.above) };
  }

  function triggersView(position: Pos) {
    return { positionId: position.id, takeProfit: position.takeProfit?.price ?? null, stopLoss: position.stopLoss?.price ?? null };
  }

  function postTrigger(body: Body) {
    const { it, owner, position, above } = triggerTarget(body);
    const price = BigInt(it.price as string);
    if (price <= 0n) throw new ApiError("Enter a price.", 400);
    const kind = kindOf(position, above);
    if (kind === "stopLoss" && (position.isLong ? price < position.bust : price > position.bust)) {
      throw new ApiError("That stop is past your liquidation price, which would close the position first.", 400);
    }
    const now = last[position.market]?.p;
    if (now !== undefined && (above ? now >= price : now <= price)) {
      throw new ApiError(kind === "takeProfit" ? "The price is already past that take-profit. Close the position instead." : "The price is already past that stop. Close the position instead.", 400);
    }
    position[kind] = { price, from: Number(it.timestamp) };
    saveSoon();
    emit("trigger", triggersView(position), owner);
    return triggersView(position);
  }

  function postTriggerCancel(body: Body) {
    const { owner, position, above } = triggerTarget(body);
    position[kindOf(position, above)] = undefined;
    saveSoon();
    emit("trigger", triggersView(position), owner);
    return triggersView(position);
  }

  function postDeposit(body: Body) {
    const owner = body.owner as Address;
    const amount = BigInt(body.amount as string);
    const held = w.wallets[key(owner)] ?? 0n;
    if (amount <= 0n) throw new ApiError("Enter an amount.", 400);
    if (amount > held) throw new ApiError("More than your wallet holds.", 400);
    w.wallets[key(owner)] = held - amount;
    credit(owner, amount);
    w.totals.deposits += amount;
    note(ledgerOf(owner).transfers, { type: "deposit", amount, time: clock, tx: randomHex(32) });
    saveSoon();
    return { ok: true };
  }

  function postWithdraw(body: Body) {
    const owner = body.owner as Address;
    const amount = BigInt(body.amount as string);
    if (amount <= 0n) throw new ApiError("Enter an amount.", 400);
    if (balanceOf(owner) - (reserved[key(owner)] ?? 0n) < amount) throw new ApiError("Not enough free balance.", 400);
    w.balances[key(owner)] = balanceOf(owner) - amount;
    w.wallets[key(owner)] = (w.wallets[key(owner)] ?? 0n) + amount;
    w.totals.withdrawals += amount;
    note(ledgerOf(owner).transfers, { type: "withdraw", amount, to: owner, time: clock, tx: randomHex(32) });
    saveSoon();
    return { ok: true };
  }

  function postUsername(body: Body) {
    const owner = body.owner as Address;
    const name = String(body.name ?? "").toLowerCase();
    if (!/^[a-z0-9_]{3,16}$/.test(name)) throw new ApiError("Use 3 to 16 letters, numbers or underscores.", 400);
    const taken = Object.entries(w.names).some(([address, held]) => held === name && address !== key(owner)) || BOTS.some((b) => b.name === name);
    if (taken) throw new ApiError("That username is taken.", 409);
    w.names[key(owner)] = name;
    saveSoon();
    return { ok: true, name };
  }

  const coinPost = (run: (owner: Address, amount: bigint) => void) => (body: Body) => {
    run(body.owner as Address, BigInt((body.amount as string | undefined) ?? 0));
    saveSoon();
    return { ok: true };
  };

  /** Throws the whole world away. Every open tab reloads into a fresh one. */
  function postReset() {
    discarded = true;
    if (saveTimer) clearTimeout(saveTimer);
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      // Nothing was stored, then.
    }
    emit("reload", {});
    return { ok: true };
  }

  const posts: Record<string, (body: Body) => unknown> = {
    "/reset": postReset,
    "/open": postOpen,
    "/close": postClose,
    "/trigger": postTrigger,
    "/trigger/cancel": postTriggerCancel,
    "/deposit": postDeposit,
    "/withdraw": postWithdraw,
    "/username": postUsername,
    "/stake": coinPost(stake),
    "/unstake": coinPost(unstake),
    "/claim": coinPost((owner) => void claim(owner)),
  };

  function get(path: string): unknown {
    const url = new URL(path, "http://preview");
    const [, section, arg] = url.pathname.split("/");
    switch (section) {
      case "config":
        return configPayload();
      case "account":
        welcome(arg as Address);
        return accountPayload(arg as Address);
      case "history": {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const ledger = ledgerOf(arg as Address);
        return {
          trades: w.trades.filter((t) => key(t.owner) === key(arg)).slice(-limit).reverse(),
          transfers: ledger.transfers.slice(0, limit),
          staking: ledger.staking.slice(0, limit),
          queue: ledger.queue.slice(0, limit),
          emissions: ledger.emissions.slice(0, limit),
        };
      }
      case "jackpot": {
        const jp = jackpotState();
        const owner = url.searchParams.get("owner");
        const round = Math.floor(clock / JACKPOT_ROUND);
        return {
          address: "preview",
          round,
          start: round * JACKPOT_ROUND,
          end: (round + 1) * JACKPOT_ROUND,
          now: clock,
          pot: jp.pot,
          prize: jp.pot,
          tickets: Object.values(jp.tickets).reduce((sum, t) => sum + t, 0n),
          mine: owner ? (jp.tickets[key(owner)] ?? 0n) : 0n,
          winners: jp.winners,
          names: namesOf(jp.winners.map((d) => d.winner)),
        };
      }
      case "season": {
        // The preview's own trades, with the default prize share; season 1 is this week.
        const first = w.trades.length ? w.trades[0].time : clock;
        const current = weekOf(clock);
        const n = url.searchParams.has("n") ? Number(url.searchParams.get("n")) : null;
        const start = n !== null && Number.isInteger(n) && n >= 1 ? Math.min(current, weekOf(first) + (n - 1) * WEEK) : current;
        const shown = season(w.trades, start, SEASON_PRIZE_BPS);
        const rows = shown.rows.slice(0, 100);
        return {
          number: seasonNumber(start, first),
          start,
          end: shown.end,
          now: clock,
          live: start === current,
          fees: shown.fees,
          pool: shown.pool,
          prizeBps: SEASON_PRIZE_BPS,
          minTrades: MIN_TRADES,
          split: PRIZE_SPLIT_BPS,
          rows,
          past: [],
          names: namesOf(rows.map((r) => r.address as Address)),
        };
      }
      case "leaderboard": {
        const window = url.searchParams.get("window") ?? "24h";
        const span = WINDOWS[window] ?? DAY;
        const since = span === Infinity ? 0 : clock - span;
        const positions = w.trades.filter((t) => t.time >= since && t.pnl > 0n).sort(byPnl).slice(0, 100);
        const accounts = accountsBoard(since).slice(0, 100);
        return { window: WINDOWS[window] ? window : "24h", positions, accounts, names: namesOf([...positions.map((t) => t.owner), ...accounts.map((a) => a.address)]) };
      }
      case "house":
        return housePayload();
      case "coin":
        return coinPayload();
      case "series":
        return seriesPayload(Number(url.searchParams.get("seconds") ?? DAY));
      case "status":
        return statusPayload();
      case "prices": {
        const market = Number(url.searchParams.get("market") ?? 0);
        const since = clock - Number(url.searchParams.get("seconds") ?? 900);
        return { market, points: (history[market] ?? []).filter((p) => p.t >= since) };
      }
      case "intent":
        if (intents.has(arg)) return intents.get(arg);
        throw new ApiError("Unknown intent.", 404);
      default:
        throw new ApiError("Not found.", 404);
    }
  }

  return {
    get: async (path) => wire(get(path)),
    post: async (path, body) => {
      const handler = posts[path];
      if (!handler) throw new ApiError("Not found.", 404);
      // The interface sends bigints; give the handlers what the relayer would have parsed.
      return wire(handler(wire(body) as Body));
    },
    stream(owner, on, online) {
      const sub = { owner: owner ? key(owner) : null, on };
      subscribers.add(sub);
      online(true);
      on("hello", { time: Date.now() });
      MARKETS.forEach((m) => {
        const tick = last[m.id];
        if (tick) on("tick", { m: m.id, t: tick.t, p: tick.p.toString() });
        if (dayOpen[m.id] !== null) on("reference", { m: m.id, p: dayOpen[m.id] });
      });
      return () => subscribers.delete(sub);
    },
  };
}
