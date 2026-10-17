// The preview exchange's books: every rule that moves money, and nothing else.
//
// This file mirrors src/Exchange.sol, src/Staking.sol, src/LossMining.sol and
// src/periphery/Sweeper.sol statement for statement where a balance is involved, including the
// direction of every rounding. It knows
// nothing about the browser, the price feed or the simulated traders, so the same code can be run
// in a test against the real contracts: test/PreviewParity.t.sol plays a long random session
// through the contracts and writes down every balance after every step, and
// web/test/books.test.mjs replays that session through this file and requires every figure to
// match exactly.

import { BPS, FEE_BPS, bustPrice, crossed, hasRoom, impactNotionalFor, settle } from "@shared/math.mjs";

const WAD = 10n ** 18n;
const STAKER_SHARE_BPS = 5_000n;
/** Staking.PERIOD: how long a payment from the exchange takes to reach stakers in full, in seconds. */
export const STREAM_PERIOD = 86_400n;
/** Sweeper.MARGIN_BPS: held back from a sweep on top of open profit, in basis points of everything open. */
export const SWEEP_MARGIN_BPS = 20n;

export interface BookPosition {
  id: string;
  owner: string;
  market: number;
  isLong: boolean;
  leverage: number;
  margin: bigint;
  /** The part of the margin that came from queued winnings rather than cash. */
  debtMargin: bigint;
  entryPrice: bigint;
  entryTime: number;
  bust: bigint;
  /** The notional a win's impact is charged on, in whole dollars. Fixed at open from how full the side was. */
  impactNotional: bigint;
}

export interface Claim {
  id: number;
  user: string;
  amount: bigint;
  time: number;
}

export interface CoinBooks {
  reserve: bigint;
  cumulativeLossUsd: bigint;
  mined: bigint;
  wallet: Record<string, bigint>;
  staked: Record<string, bigint>;
  totalStaked: bigint;
  /** USDC streamed to stakers per second, scaled by 1e18. Zero when no stream is running. */
  rewardRate: bigint;
  /** When the current stream ends, and the last moment it was accounted for. Seconds. */
  periodFinish: bigint;
  lastUpdate: bigint;
  /** USDC streamed per staked coin so far, scaled by 1e36. */
  rewardPerShare: bigint;
  paidPerShare: Record<string, bigint>;
  accrued: Record<string, bigint>;
  /** USDC received while nobody was staked, waiting for the next staker. */
  waiting: bigint;
  received: bigint;
  claimed: bigint;
}

export interface BookState<P extends BookPosition = BookPosition> {
  balances: Record<string, bigint>;
  queuedOf: Record<string, bigint>;
  queueSpent: Record<string, bigint>;
  claims: Claim[];
  nextClaim: number;
  totalQueued: bigint;
  debtMarginOpen: bigint;
  totalCashMargin: bigint;
  /** The house's free cash. On the chain this is derived; here it is tracked directly. */
  lpCash: bigint;
  stakerFees: bigint;
  devFees: bigint;
  positions: P[];
  oi: [bigint, bigint][];
  /** Open positions' total size in units of the asset, scaled by 1e18: longs, then shorts. */
  size: [bigint, bigint][];
  coin: CoinBooks;
}

/** A market's pricing parameters, as shared/math.mjs takes them. */
export interface BookMarket {
  rateMultiplier: number;
  positionMultiplier: number;
  maxKeepBps: number;
  tick: number;
  bustBuffer: string;
  /** How much may be open on one side at the curve's own price, in whole dollars. */
  depth: number;
}

export interface BookParams {
  stakerCap: bigint;
  miningScale: bigint;
  autoHarvest: number;
  markets: BookMarket[];
}

/** What a settlement did, in the terms of the contract's PositionClosed event. */
export interface Settlement {
  pnl: bigint;
  busted: boolean;
  credited: bigint;
  queued: bigint;
  fee: bigint;
  /** Coin paid to the trader for the loss, if any. */
  mined: bigint;
}

/** Called as money moves, for whoever keeps histories. None of them may change the books. */
export interface BookHooks {
  queued?(user: string, claimId: number, amount: bigint): void;
  queueSpent?(user: string, amount: bigint): void;
  queuePaid?(user: string, claimId: number, amount: bigint): void;
  mined?(user: string, usd: bigint, amount: bigint): void;
}

export class BookError extends Error {}

const key = (address: string) => address.toLowerCase();
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function emptyBooks(markets: number, coinReserve: bigint): BookState {
  return {
    balances: {},
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
    oi: Array.from({ length: markets }, () => [0n, 0n] as [bigint, bigint]),
    size: Array.from({ length: markets }, () => [0n, 0n] as [bigint, bigint]),
    coin: {
      reserve: coinReserve,
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
    },
  };
}

/**
 * @param now The clock, in unix seconds. Queue entries are stamped with it and the staking stream
 *            runs on it, as the chain's does on block time.
 */
export function createBooks<P extends BookPosition>(w: BookState<P>, params: BookParams, now: () => number, hooks: BookHooks = {}) {
  const seconds = (): bigint => BigInt(Math.floor(now()));
  const balanceOf = (user: string): bigint => w.balances[key(user)] ?? 0n;
  const queuedOf = (user: string): bigint => w.queuedOf[key(user)] ?? 0n;

  function credit(user: string, amount: bigint): void {
    w.balances[key(user)] = balanceOf(user) + amount;
  }

  const totalBalances = (): bigint => Object.values(w.balances).reduce((sum, v) => sum + v, 0n);
  /** Every dollar the exchange holds: balances, margin, the house, and fees not yet paid out. */
  const treasury = (): bigint => totalBalances() + w.totalCashMargin + w.lpCash + w.stakerFees + w.devFees;

  /** House cash above what it must keep: nothing while anyone is queued. Exchange.lpExcess. */
  function lpExcess(): bigint {
    if (w.totalQueued !== 0n) return 0n;
    const floor = w.debtMarginOpen + params.stakerCap;
    return w.lpCash > floor ? w.lpCash - floor : 0n;
  }

  // Exchange._accrueFee
  function accrueFee(fee: bigint): void {
    const toStakers = (fee * STAKER_SHARE_BPS) / BPS;
    w.lpCash -= fee;
    w.stakerFees += toStakers;
    w.devFees += fee - toStakers;
  }

  // Exchange._enqueue
  function enqueue(user: string, amount: bigint): void {
    const tail = w.claims[w.claims.length - 1];
    let claimId: number;
    if (tail && key(tail.user) === key(user)) {
      // The back of the queue is already this trader's: extend it.
      tail.amount += amount;
      claimId = tail.id;
    } else {
      claimId = w.nextClaim++;
      w.claims.push({ id: claimId, user, amount, time: now() });
    }
    w.totalQueued += amount;
    w.queuedOf[key(user)] = queuedOf(user) + amount;
    hooks.queued?.(user, claimId, amount);
  }

  // Exchange._spendQueued
  function spendQueued(user: string, amount: bigint): void {
    w.queuedOf[key(user)] = queuedOf(user) - amount;
    w.totalQueued -= amount;
    w.queueSpent[key(user)] = (w.queueSpent[key(user)] ?? 0n) + amount;
    hooks.queueSpent?.(user, amount);
  }

  // Exchange._harvest
  function harvest(maxEntries: number): void {
    let available = w.lpCash;
    for (let n = 0; n < maxEntries && w.claims.length > 0; n++) {
      const claim = w.claims[0];
      const user = claim.user;
      let amount = claim.amount;

      // Net off what this trader already spent as margin.
      const spent = w.queueSpent[key(user)] ?? 0n;
      if (spent !== 0n) {
        const netted = min(spent, amount);
        w.queueSpent[key(user)] = spent - netted;
        amount -= netted;
      }

      const pay = min(amount, available);
      if (pay !== 0n) {
        available -= pay;
        amount -= pay;
        w.lpCash -= pay;
        w.totalQueued -= pay;
        w.queuedOf[key(user)] = queuedOf(user) - pay;
        credit(user, pay);
        hooks.queuePaid?.(user, claim.id, pay);
      }

      if (amount !== 0n) {
        // Out of cash with this claim still owed. It stays at the front.
        claim.amount = amount;
        break;
      }
      w.claims.shift();
    }
  }

  // Exchange.donate: cash for the house that nobody is owed. The front of the queue is paid at once.
  function donate(amount: bigint): void {
    w.lpCash += amount;
    harvest(params.autoHarvest);
  }

  // Exchange._payOrQueue
  function payOrQueue(user: string, owed: bigint, fee: bigint): { paid: bigint; queued: bigint; feePaid: boolean } {
    let paid = 0n;
    let feePaid = false;
    if (w.totalQueued === 0n) {
      const available = w.lpCash;
      paid = min(owed, available);
      if (fee !== 0n && available >= owed + fee + w.debtMarginOpen) {
        accrueFee(fee);
        feePaid = true;
      }
      if (paid !== 0n) {
        w.lpCash -= paid;
        credit(user, paid);
      }
    }
    const queued = owed - paid;
    if (queued !== 0n) enqueue(user, queued);
    return { paid, queued, feePaid };
  }

  // LossMining.quote and LossMining.onLoss
  const mineQuote = (usd: bigint): bigint => (w.coin.reserve * usd) / (params.miningScale + w.coin.cumulativeLossUsd + usd);

  function mine(user: string, usd: bigint): bigint {
    if (usd === 0n) return 0n;
    const amount = mineQuote(usd);
    w.coin.cumulativeLossUsd += usd;
    if (amount === 0n) return 0n;
    w.coin.reserve -= amount;
    w.coin.mined += amount;
    w.coin.wallet[key(user)] = (w.coin.wallet[key(user)] ?? 0n) + amount;
    hooks.mined?.(user, usd, amount);
    return amount;
  }

  // Exchange.open, from the point where the price is known. `impactLimit` is the order's own: the
  // most it will be charged on for its size, in whole dollars, or zero for no limit.
  function open(position: Omit<P, "debtMargin" | "bust" | "impactNotional">, useQueued: boolean, impactLimit = 0n): P {
    const { owner, margin, leverage, market, isLong, entryPrice } = position;
    const m = params.markets[market];
    if (!hasRoom(entryPrice, leverage, m)) throw new BookError("That leverage leaves no room for a liquidation price at this price.");
    const notional = margin * BigInt(leverage);
    // What is already open on this side: the position is charged for it.
    const ahead = w.oi[market][isLong ? 0 : 1];
    if (ahead + notional > 2_000_000n * 1_000_000n + w.lpCash * 50n) throw new BookError("This side of the market is full for now: what can be open grows with the vault's cash.");
    const impactNotional = impactNotionalFor(ahead, notional, m.depth);
    if (impactLimit !== 0n && impactNotional > impactLimit) throw new BookError("This side filled up while your order was on its way, and its size impact went past your limit. Nothing was opened. Check the ticket and try again.");
    const debt = useQueued ? min(queuedOf(owner), margin) : 0n;
    const cash = margin - debt;
    if (balanceOf(owner) < cash) throw new BookError("Not enough balance.");
    if (debt !== 0n) spendQueued(owner, debt);
    w.balances[key(owner)] = balanceOf(owner) - cash;
    w.totalCashMargin += cash;
    w.debtMarginOpen += debt;
    w.oi[market][isLong ? 0 : 1] = ahead + notional;
    w.size[market][isLong ? 0 : 1] += (notional * WAD) / entryPrice;
    const opened = {
      ...position,
      debtMargin: debt,
      bust: bustPrice(entryPrice, leverage, isLong, m),
      impactNotional,
    } as P;
    w.positions.push(opened);
    return opened;
  }

  // Exchange._settle, _settleWin and _settleLoss.
  function settlePosition(p: P, exitPrice: bigint, forced: boolean): Settlement {
    const index = w.positions.indexOf(p);
    if (index < 0) throw new BookError("No such open position.");
    const m = params.markets[p.market];
    const notional = p.margin * BigInt(p.leverage);
    w.positions.splice(index, 1);
    w.oi[p.market][p.isLong ? 0 : 1] -= notional;
    // The same amount was added at open.
    w.size[p.market][p.isLong ? 0 : 1] -= (notional * WAD) / p.entryPrice;

    const cashMargin = p.margin - p.debtMargin;
    w.totalCashMargin -= cashMargin;
    w.debtMarginOpen -= p.debtMargin;

    let busted = forced;
    let win = false;
    let amount = 0n;
    if (!busted) {
      // A close priced at or beyond the trigger is a bust like any other.
      if (crossed(exitPrice, bustPrice(p.entryPrice, p.leverage, p.isLong, m), p.isLong)) busted = true;
      else ({ win, amount } = settle(p.entryPrice, exitPrice, notional, p.isLong, m, p.impactNotional));
    }

    if (win) {
      const fee = (amount * FEE_BPS) / BPS;
      const profit = amount - fee;
      // Cash margin goes straight back. The profit, and any queue-funded margin, is what the house
      // owes: paid now if it can be, queued if not.
      credit(p.owner, cashMargin);
      const paid = payOrQueue(p.owner, p.debtMargin + profit, fee);
      return { pnl: profit, busted: false, credited: cashMargin + paid.paid, queued: paid.queued, fee: paid.feePaid ? fee : 0n, mined: 0n };
    }

    const loss = busted ? p.margin : min(amount, p.margin);
    // A loss is shared pro rata between the cash and queue-funded parts of the margin. A bust
    // takes all of both.
    const lossDebt = busted ? p.debtMargin : (loss * p.debtMargin) / p.margin;
    const lossCash = loss - lossDebt;
    const surviving = p.debtMargin - lossDebt;

    credit(p.owner, cashMargin - lossCash);
    // Lost cash becomes house cash; lost queue-funded margin is debt the house no longer owes.
    w.lpCash += lossCash;

    // The house-side fee is carved from what the house gained, never added to the loss. It is paid
    // only while nobody is queued and the house can also cover what it still owes here. A bust
    // charges nothing on queue-funded margin.
    let fee = 0n;
    if (w.totalQueued === 0n) {
      fee = ((lossCash + (busted ? 0n : lossDebt)) * FEE_BPS) / BPS;
      // Queue-funded margin in other positions is money the house still owes its owners.
      if (fee !== 0n && w.lpCash >= surviving + fee + w.debtMarginOpen) accrueFee(fee);
      else fee = 0n;
    }

    const paid = payOrQueue(p.owner, surviving, 0n);
    if (w.totalQueued !== 0n) harvest(params.autoHarvest);
    const mined = mine(p.owner, busted ? p.margin : loss - fee);
    return { pnl: -loss, busted, credited: cashMargin - lossCash + paid.paid, queued: paid.queued, fee, mined };
  }

  // ---------------------------------------------------------------------------------- Staking
  // A payment from the exchange is spread evenly over the next STREAM_PERIOD; each second of it
  // goes to whoever is staked during that second.

  const streamTime = (): bigint => min(seconds(), w.coin.periodFinish);

  // Staking._perShareNow
  function perShareNow(): bigint {
    const c = w.coin;
    if (c.totalStaked === 0n) return c.rewardPerShare;
    return c.rewardPerShare + ((streamTime() - c.lastUpdate) * c.rewardRate * WAD) / c.totalStaked;
  }

  // Staking._settle
  function settleStream(): void {
    w.coin.rewardPerShare = perShareNow();
    w.coin.lastUpdate = streamTime();
  }

  // Staking._unstreamed: what is left of the current stream.
  function unstreamed(): bigint {
    const c = w.coin;
    const t = seconds();
    if (t >= c.periodFinish) return 0n;
    return ((c.periodFinish - t) * c.rewardRate) / WAD;
  }

  // Staking._start
  function startStream(amount: bigint): void {
    const t = seconds();
    w.coin.rewardRate = (amount * WAD) / STREAM_PERIOD;
    w.coin.lastUpdate = t;
    w.coin.periodFinish = t + STREAM_PERIOD;
  }

  // Staking.notify
  function notify(amount: bigint): void {
    w.coin.received += amount;
    if (w.coin.totalStaked === 0n) {
      w.coin.waiting += amount;
      return;
    }
    settleStream();
    startStream(amount + unstreamed());
  }

  // Exchange.pushStakerFees: accrued staker fees go to staking. Returns what moved.
  function pushStakerFees(): bigint {
    const amount = w.stakerFees;
    if (amount === 0n) return 0n;
    w.stakerFees = 0n;
    notify(amount);
    return amount;
  }

  /**
   * Sweeper.sweep with Exchange.sweepExcess: house cash above the cap goes to stakers, less what
   * the open positions are up at `prices` (one per market). Returns what moved.
   */
  function sweep(prices: bigint[]): bigint {
    const amount = sweepable(prices);
    if (amount === 0n) return 0n;
    w.lpCash -= amount;
    notify(amount);
    return amount;
  }

  /** What a sweep at `prices` would send: Sweeper._owed against Exchange.lpExcess. */
  function sweepable(prices: bigint[]): bigint {
    let owed = 0n;
    w.size.forEach(([long, short], market) => {
      if (long === 0n && short === 0n) return;
      const price = prices[market];
      // Rounded against the sweep on both sides.
      const longsWorth = (long * price + WAD - 1n) / WAD;
      const shortsWorth = (short * price) / WAD;
      if (longsWorth > w.oi[market][0]) owed += longsWorth - w.oi[market][0];
      if (w.oi[market][1] > shortsWorth) owed += w.oi[market][1] - shortsWorth;
      // A margin for positions past the price where their margin is gone, not yet liquidated.
      owed += ((w.oi[market][0] + w.oi[market][1]) * SWEEP_MARGIN_BPS + BPS - 1n) / BPS;
    });
    const excess = lpExcess();
    return excess > owed ? excess - owed : 0n;
  }

  // Staking.pendingReward
  const pendingReward = (user: string): bigint =>
    (w.coin.accrued[key(user)] ?? 0n) + ((w.coin.staked[key(user)] ?? 0n) * (perShareNow() - (w.coin.paidPerShare[key(user)] ?? 0n))) / (WAD * WAD);

  // Staking._accrue
  function accrue(user: string): void {
    settleStream();
    w.coin.accrued[key(user)] = pendingReward(user);
    w.coin.paidPerShare[key(user)] = w.coin.rewardPerShare;
  }

  function stake(user: string, amount: bigint): void {
    const held = w.coin.wallet[key(user)] ?? 0n;
    if (amount <= 0n) throw new BookError("Enter an amount.");
    if (amount > held) throw new BookError("More than your wallet holds.");
    accrue(user);
    const first = w.coin.totalStaked === 0n;
    w.coin.wallet[key(user)] = held - amount;
    w.coin.staked[key(user)] = (w.coin.staked[key(user)] ?? 0n) + amount;
    w.coin.totalStaked += amount;
    // The first staker in sets the waiting USDC flowing, from now.
    if (first && w.coin.waiting !== 0n) {
      const waiting = w.coin.waiting;
      w.coin.waiting = 0n;
      startStream(waiting);
    }
  }

  function unstake(user: string, amount: bigint): void {
    const held = w.coin.staked[key(user)] ?? 0n;
    if (amount <= 0n) throw new BookError("Enter an amount.");
    if (amount > held) throw new BookError("More than you have staked.");
    accrue(user);
    w.coin.staked[key(user)] = held - amount;
    w.coin.totalStaked -= amount;
    // The last staker out: stop the stream and keep what is left of it for the next one in.
    if (w.coin.totalStaked === 0n) {
      w.coin.waiting += unstreamed();
      w.coin.rewardRate = 0n;
      w.coin.periodFinish = seconds();
    }
    w.coin.wallet[key(user)] = (w.coin.wallet[key(user)] ?? 0n) + amount;
  }

  /** Rewards are credited to the trading balance, as on the chain. */
  function claim(user: string): bigint {
    accrue(user);
    const amount = w.coin.accrued[key(user)] ?? 0n;
    if (amount === 0n) throw new BookError("Nothing to claim yet.");
    w.coin.accrued[key(user)] = 0n;
    w.coin.claimed += amount;
    credit(user, amount);
    return amount;
  }

  /**
   * Checks the books against themselves and returns whatever does not add up (nothing, if they
   * are sound). These are the identities the contract's invariant tests hold it to.
   */
  function audit(coinSupplyOutside: bigint): string[] {
    const wrong: string[] = [];
    const sum = (record: Record<string, bigint>) => Object.values(record).reduce((total, v) => total + v, 0n);
    const negative = (name: string, value: bigint) => {
      if (value < 0n) wrong.push(`${name} is negative (${value})`);
    };

    negative("vault cash", w.lpCash);
    negative("total queued", w.totalQueued);
    negative("staker fees", w.stakerFees);
    negative("developer fees", w.devFees);
    for (const [user, value] of Object.entries(w.balances)) negative(`balance of ${user}`, value);
    for (const [user, value] of Object.entries(w.queuedOf)) negative(`queued winnings of ${user}`, value);
    for (const [user, value] of Object.entries(w.queueSpent)) negative(`spent queue of ${user}`, value);

    if (sum(w.queuedOf) !== w.totalQueued) wrong.push(`queued winnings add up to ${sum(w.queuedOf)}, total says ${w.totalQueued}`);
    // Every claim in the queue is either still owed or was already spent as margin.
    const claimed: Record<string, bigint> = {};
    for (const claim of w.claims) claimed[key(claim.user)] = (claimed[key(claim.user)] ?? 0n) + claim.amount;
    for (const user of new Set([...Object.keys(claimed), ...Object.keys(w.queuedOf), ...Object.keys(w.queueSpent)])) {
      const owed = (w.queuedOf[user] ?? 0n) + (w.queueSpent[user] ?? 0n);
      if ((claimed[user] ?? 0n) !== owed) wrong.push(`queue entries of ${user} total ${claimed[user] ?? 0n}, but ${owed} is owed or spent`);
    }

    let cash = 0n;
    let debt = 0n;
    const interest = w.oi.map(() => [0n, 0n]);
    const sizes = w.oi.map(() => [0n, 0n]);
    for (const p of w.positions) {
      cash += p.margin - p.debtMargin;
      debt += p.debtMargin;
      interest[p.market][p.isLong ? 0 : 1] += p.margin * BigInt(p.leverage);
      sizes[p.market][p.isLong ? 0 : 1] += (p.margin * BigInt(p.leverage) * WAD) / p.entryPrice;
    }
    if (cash !== w.totalCashMargin) wrong.push(`open positions hold ${cash} cash margin, total says ${w.totalCashMargin}`);
    if (debt !== w.debtMarginOpen) wrong.push(`open positions hold ${debt} queue-funded margin, total says ${w.debtMarginOpen}`);
    interest.forEach(([long, short], market) => {
      if (long !== w.oi[market][0] || short !== w.oi[market][1]) wrong.push(`open interest of market ${market} does not match its positions`);
    });
    sizes.forEach(([long, short], market) => {
      if (long !== w.size[market][0] || short !== w.size[market][1]) wrong.push(`open size of market ${market} does not match its positions`);
    });

    // No coin is made or lost: what left the reserve is in wallets or staked.
    if (sum(w.coin.staked) !== w.coin.totalStaked) wrong.push(`stakes add up to ${sum(w.coin.staked)}, total says ${w.coin.totalStaked}`);
    if (sum(w.coin.wallet) + w.coin.totalStaked !== w.coin.mined + coinSupplyOutside) wrong.push("coin in wallets and stakes is not what was mined");
    // Staking can never owe more USDC than it holds: what stakers have earned, what is still to
    // be streamed and what is waiting for a first staker all come out of what it received.
    negative("USDC waiting for a staker", w.coin.waiting);
    let promised = 0n;
    for (const user of new Set([...Object.keys(w.coin.staked), ...Object.keys(w.coin.accrued)])) promised += pendingReward(user);
    const held = w.coin.received - w.coin.claimed;
    if (promised + unstreamed() + w.coin.waiting > held) wrong.push(`staking owes ${promised + unstreamed() + w.coin.waiting}, only ${held} is there`);
    return wrong;
  }

  return {
    audit,
    balanceOf,
    queuedOf,
    credit,
    totalBalances,
    treasury,
    lpExcess,
    harvest,
    donate,
    mineQuote,
    open,
    settlePosition,
    isBusted: (p: BookPosition, price: bigint) => crossed(price, p.bust, p.isLong),
    pushStakerFees,
    sweep,
    sweepable,
    unstreamed,
    pendingReward,
    stake,
    unstake,
    claim,
  };
}
