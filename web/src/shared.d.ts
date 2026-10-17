// Types for the plain-JS modules in ../shared, which the relayer uses too.

/** When this build was made, in milliseconds. Set by vite.config.ts. */
declare const __BUILD__: number;
/** Mainnet deposit contract and immutable box pinned from the local deployment record at build time. */
declare const __MAINNET_DEPOSITS__: { deposits: `0x${string}`; box: `0x${string}` } | null;

declare module "@shared/referral-code.mjs" {
  export const REFERRAL_CODE_RULE: RegExp;
  export function referralCodeMessage(value: { code: string; owner: string; chainId: number; exchange: string }): string;
}

declare module "@shared/math.mjs" {
  /** A market's pricing parameters. Numbers, strings and bigints are all accepted. */
  export interface Curve {
    rateMultiplier: number | string | bigint;
    /** In thousandths: 814598 for 814.598. */
    positionMultiplier: number | string | bigint;
    maxKeepBps: number | string | bigint;
    /** One price tick in 1e8 terms. */
    tick: number | string | bigint;
    /** How far the bust trigger sits before zero equity, as a 1e18 fraction of that price. */
    bustBuffer: number | string | bigint;
  }
  export const BPS: bigint;
  export const WAD: bigint;
  export const FEE_BPS: bigint;
  export const DEADBAND_DIVISOR: bigint;
  export const REFERENCE_NOTIONAL: bigint;
  export const MAX_IMPACT_NOTIONAL: bigint;
  export function bustPrice(entry: bigint, leverage: number, isLong: boolean, market: Curve): bigint;
  export function hasRoom(entry: bigint, leverage: number, market: Curve): boolean;
  export function crossed(price: bigint, bust: bigint, isLong: boolean): boolean;
  /** The notional a new position's impact is charged on, in whole dollars. `depth` is in whole dollars too. */
  export function impactNotionalFor(ahead: bigint, notional: bigint, depth: number | string | bigint): bigint;
  /** How many times the reference a position is charged on. */
  export function sizeLevel(impactNotional: number | string | bigint): number;
  export function settle(
    entry: bigint,
    exit: bigint,
    notional: bigint,
    isLong: boolean,
    market: Curve,
    impactNotional: number | string | bigint,
  ): { win: boolean; amount: bigint };
  export function quoteClose(
    position: { entryPrice: bigint; margin: bigint; leverage: number; isLong: boolean; impactNotional: number | string | bigint },
    market: Curve,
    exit: bigint,
  ): { busted: boolean; pnl: bigint };
  export function keepShare(moveBps: number, market: Curve, impactNotional?: number | string | bigint): number;
  export function bustDistance(leverage: number, market: Curve): number;
}

declare module "@shared/seasons.mjs" {
  export const WEEK: number;
  export const MIN_TRADES: number;
  export const PRIZE_SPLIT_BPS: number[];
  export function weekOf(time: number): number;
  export function seasonNumber(start: number, first: number): number;
  export function season(
    trades: { owner: string; pnl: bigint | string; fee?: bigint | string | null; margin?: bigint | string | null; leverage?: number | null; time: number }[],
    start: number,
    prizeBps: number,
  ): {
    start: number;
    end: number;
    fees: bigint;
    pool: bigint;
    prizeBps: number;
    rows: { address: string; pnl: bigint; volume: bigint; trades: number; wins: number; prize: bigint; qualified: boolean; rank?: number }[];
  };
}

declare module "@shared/eip712.mjs" {
  type Field = { name: string; type: string };
  export const EXEC_DELAY: number;
  export const PIN_WINDOW: number;
  export const INTENT_TTL: number;
  export const DIRECT_DELAY: number;
  export const WITHDRAW_DELAY: number;
  export const MAX_SESSION_DURATION: number;
  export const GRACE: number;
  export const REQUEST_EXPIRY: number;
  export function domain(
    name: string,
    chainId: number,
    exchange: `0x${string}`,
  ): { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  export function sessionDomain(
    name: string,
    chainId: number,
    sessions: `0x${string}`,
  ): { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  export const types: { Open: Field[]; Close: Field[]; Trigger: Field[]; CancelTrigger: Field[]; SessionKey: Field[]; Withdraw: Field[] };
  export const permitTypes: { Permit: Field[] };
}
