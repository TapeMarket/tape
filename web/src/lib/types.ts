// Shapes of what the relayer (or the in-browser preview) returns. Amounts arrive as decimal
// strings: USDC with 6 decimals, prices with 8, the coin with 18.

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface Market {
  id: number;
  symbol: string;
  feedId: Hex;
  maxLeverage: number;
  maxKeepBps: number;
  maxConfBps: number;
  /** The impact curve's two parameters; the second is in thousandths (814598 for 814.598). */
  rateMultiplier: number;
  positionMultiplier: number;
  /** One price tick in 1e8 terms: 10000000 is ten cents. */
  tick: number;
  /** How far the bust trigger sits before zero equity, as a 1e18 fraction of that price. */
  bustBuffer: string;
  retired: boolean;
  frozenPrice: string;
  maxNotional: string;
  oiLong: string;
  oiShort: string;
  capLong: string;
  capShort: string;
  /** How much may be open on one side at the curve's own price, in whole dollars. */
  depth: number;
  price: string | null;
  /** The price about a day ago (or the oldest on record), as a plain number. */
  ref24h?: number | null;
}

/** One entry of the ticker tape: somebody opened, or somebody's position settled. */
export interface TapeChip {
  type: "open" | "close";
  id: Hex;
  owner: Address;
  market: number;
  isLong: boolean | null;
  notional?: string;
  pnl?: string;
  busted?: boolean;
  time: number;
}

export interface Config {
  name: string;
  chainId: number;
  time: number;
  priceSource: "dev" | "hermes" | "hyperliquid" | "preview";
  addresses: {
    exchange: Address;
    sessions: Address;
    lens: Address;
    gateway: Address;
    /** Gives every wallet a deposit address. Absent on a deployment made before it existed. */
    deposits?: Address | null;
    oracle: Address;
    usdc: Address;
    coin: Address | null;
    staking: Address | null;
    lossMining: Address | null;
    sweeper?: Address | null;
    batcher?: Address | null;
    jackpot?: Address | null;
  };
  usdcPermit: { name: string; version: string };
  timing: {
    execDelay: number;
    pinWindow: number;
    intentTtl: number;
    directDelay: number;
    withdrawDelay: number;
    grace: number;
    requestExpiry: number;
  };
  markets: Market[];
  minMargin: string;
  /** The smallest position (margin times leverage) that can be opened. */
  minNotional: string;
  opensPaused: boolean;
  coin: { address: Address; staking: Address; lossMining: Address; symbol: string } | null;
  tape: TapeChip[];
}

export interface Position {
  id: Hex;
  owner: Address;
  market: number;
  isLong: boolean;
  leverage: number;
  margin: string;
  debtMargin: string;
  entryPrice: string;
  entryTime: number;
  bust: string;
  /** What a win's impact is charged on, in whole dollars: 100000 unless the side was crowded at open. */
  impactNotional: number;
  status: "pending" | "open";
  closeRequestedAt: number;
  liquidating: boolean;
  /** The take-profit and stop-loss prices (8 decimals), when set. */
  takeProfit?: string | null;
  stopLoss?: string | null;
}

export interface AccountBalance {
  address: Address;
  blockNumber: string;
  balance: string;
  queued: string;
  marginInUse: string;
  reserved?: string;
}

export interface Trade {
  id: Hex;
  owner: Address;
  market: number;
  isLong: boolean | null;
  leverage: number | null;
  margin: string | null;
  entryPrice: string | null;
  entryTime: number | null;
  exitPrice: string;
  pnl: string;
  busted: boolean;
  credited: string;
  queued: string;
  fee: string;
  time: number;
  tx: Hex;
  /** Confirmed collateral at the close's indexed block, sent only on the owner's stream. */
  accountBalance?: AccountBalance;
}

export interface Intent {
  id: Hex;
  kind: "open" | "close";
  owner: Address;
  status: "accepted" | "filled" | "confirmed" | "failed";
  pinTime: number;
  positionId: Hex;
  fill: { price: string; time?: number; pnl?: string; busted?: boolean } | null;
  error: string | null;
  tx: Hex | null;
}

/** A payout still waiting in the queue, and how much is owed to the people in front of it. */
export interface QueueClaim {
  id: number;
  user: Address;
  amount: string;
  ahead: string;
  time: number;
}

/** One account's referrals, as the relayer keeps them. Amounts are USDC with 6 decimals. */
export interface ReferralPage {
  address: Address;
  /** Custom code, username or address, in that order. */
  code: string;
  customCode?: string | null;
  /** Who referred this account, if anybody. */
  referrer: Address | null;
  /** The referrer's cut of each fee, in basis points of the fee. */
  shareOfFeeBps: number;
  referred: { address: Address; since: number; trades: number; volume: string; fees: string; reward: string }[];
  earned: string;
  paid: string;
  owed: string;
  names: Record<string, string>;
}

export interface Account {
  address: Address;
  /** Block used for the authoritative collateral read; absent on older/practice backends. */
  blockNumber?: string;
  name: string | null;
  /** Who referred this account, if anybody. Absent on a relayer from before referrals. */
  referrer?: Address | null;
  balance: string;
  queued: string;
  queueAhead: string | null;
  claims: QueueClaim[];
  reserved: string;
  marginInUse: string;
  sessionNonce: string;
  withdrawNonce: string;
  withdrawRequest: { amount: string; requestedAt: string; executableAt: string } | null;
  positions: Position[];
  intents: Intent[];
  wallet: { usdc: string; usdcNonce: string; eth: string };
  coin: { wallet: string; staked: string; pending: string; stakingAllowance: string; claimed: string } | null;
  stats: { address: Address; volume: string; pnl: string; trades: number; wins: number; busts: number; mined: string; rewards: string };
  badges: { window: string; rank: number }[];
}

export interface Transfer {
  type: "deposit" | "withdraw" | "withdraw-request" | "reward";
  amount: string;
  to?: Address;
  time: number;
  tx: Hex;
}

export interface StakingEntry {
  type: "stake" | "unstake" | "claim";
  amount: string;
  time: number;
  tx: Hex;
}

export interface QueueEntry {
  type: "queued" | "paid" | "spent";
  claimId: number | null;
  amount: string;
  time: number;
  tx: Hex;
}

export interface Emission {
  usd: string;
  amount: string;
  time: number;
  tx: Hex;
}

export interface History {
  trades: Trade[];
  transfers: Transfer[];
  staking: StakingEntry[];
  queue: QueueEntry[];
  emissions: Emission[];
}

export interface HouseState {
  lpCash: string;
  totalQueued: string;
  debtMarginOpen: string;
  equity: string;
  excess: string;
  stakerCap: string;
  stakerFees: string;
  devFees: string;
  queueLength: string;
  treasury: string;
  totalBalances: string;
  totalCashMargin: string;
  minMargin: string;
  minNotional: string;
  opensPaused: boolean;
}

/** An open position as the house sees it: market, side, margin, leverage, entry, bust, and what its wins are charged on. No names. */
export interface HousePosition {
  m: number;
  l: boolean;
  g: string;
  x: number;
  e: string;
  b: string;
  i: number;
}

export interface HousePayload {
  house: HouseState;
  queue: { id: string; user: Address; amount: string }[];
  queueStats: { entries: number; largest: string; front: string };
  markets: Market[];
  totals: {
    volume: string;
    volumeByMarket: (string | null)[];
    bustVolume: string;
    pnl: string;
    trades: number;
    busts: number;
    deposits: string;
    withdrawals: string;
    traders: number;
    openPositions: number;
    openMargin: string;
    volume24h: string;
    volume24hByMarket: string[];
    trades24h: number;
  };
  feed: Trade[];
  positions: HousePosition[];
}

export interface CoinEvent {
  type: "mined" | "stake" | "unstake" | "claim" | "distribution";
  user: Address | null;
  usd?: string;
  amount: string;
  time: number;
  tx: Hex;
}

export interface CoinPayload {
  attached: boolean;
  address: Address;
  staking: Address;
  lossMining: Address;
  name: string;
  symbol: string;
  supply: string;
  mining: { reserve: string; cumulativeLossUsd: string; scaleUsd: string; perDollar: string; mined: string };
  stakingState: {
    totalStaked: string;
    /** The stream paying stakers: USDC per second scaled by 1e18 (zero when none is running). */
    streamRate: string;
    /** When the stream ends, in unix seconds. */
    streamEnds: number;
    /** What the stream still has to pay. */
    unstreamed: string;
    /** USDC that arrived while nobody was staked, waiting for the next staker. */
    waiting: string;
    totalReceived: string;
    totalClaimed: string;
    /** The last payment from the exchange into the stream. */
    lastDistributionAt: string;
    lastDistributionAmount: string;
  };
  /** On the exchange and not yet sent to staking. */
  pendingFees: string;
  /** Stakers' share of settled PnL right now, in percent: 0, 1 or 99. */
  rewardRate: number;
  events: CoinEvent[];
  daily: { t: number; amount: string }[];
}

export interface LeaderAccount {
  address: Address;
  pnl: string;
  volume: string;
  trades: number;
  wins: number;
  busts: number;
}

/** A weekly season (shared/seasons.mjs): amounts in 6-decimal USDC, as strings. */
export interface SeasonRow {
  address: Address;
  pnl: string;
  volume: string;
  trades: number;
  wins: number;
  prize: string;
  qualified: boolean;
  rank?: number;
}

export interface Season {
  number: number;
  start: number;
  end: number;
  now: number;
  live: boolean;
  fees: string;
  pool: string;
  prizeBps: number;
  minTrades: number;
  split: number[];
  rows: SeasonRow[];
  past: { number: number; start: number; pool: string; winners: SeasonRow[] }[];
  names: Record<string, string>;
}

/** The Rekt Jackpot: this hour's pot and tickets (6-decimal USDC, as strings), recent winners. */
export interface JackpotPayload {
  address: string | null;
  round: number;
  start: number;
  end: number;
  now: number;
  pot: string;
  prize: string;
  tickets: string;
  mine: string;
  winners: { round: number; winner: Address; prize: string; tickets: string; time: number }[];
  names: Record<string, string>;
}

export interface Leaderboard {
  window: string;
  positions: Trade[];
  accounts: LeaderAccount[];
  names: Record<string, string>;
}

/** One minute sample of the exchange. Plain numbers: dollars and whole coins. */
export interface SeriesPoint {
  t: number;
  lp: number;
  eq: number;
  q: number;
  tvl: number;
  oi: [number, number][];
  px?: number[];
  mined: number;
  staked: number;
  paid: number;
  vol: number;
  volm?: number[];
  pnl?: number;
  n: number;
  users?: number;
}

export interface Status {
  ok: boolean;
  time: number;
  startedAt: number;
  chainId: number;
  block: string;
  source: string;
  opensPaused: boolean;
  feeds: { market: number; symbol: string; retired: boolean; time: number | null; price: string | null }[];
  operator: Address;
  operatorEth: string;
  /** ETH the oracle holds for Pyth's fees. Null when prices are signed and cost nothing to read. */
  oracleFloat: string | null;
  streams: number;
  openPositions: number;
  queue: { id: number; user: Address; amount: string; time: number }[];
  blocks: { number: string; time: number; gasUsed: string; gasLimit: string; baseFee: string; txs: number }[];
}
