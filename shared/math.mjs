/**
 * The pricing rules of a position, mirrored from src/libraries/PerpMath.sol.
 *
 * Prices are 1e8 bigints, USD amounts are 6-decimal bigints. Keep this file step for step with the
 * contract: the site previews with it and the keeper decides liquidations with it. Both follow
 * the reference exchange's settlement arithmetic, including where each division rounds.
 *
 * A market, wherever one is asked for, is an object with:
 *   rateMultiplier       the impact curve's first parameter (15000)
 *   positionMultiplier   its second, in thousandths (814598 for 814.598)
 *   maxKeepBps           the most of a raw gain a win keeps (9000)
 *   tick                 one price tick in 1e8 terms (BTC 1e7, ETH 1e6)
 *   bustBuffer           how far the bust trigger sits before zero equity, as a 1e18 fraction of
 *                        the zero-equity price
 * Numbers, strings and bigints are all accepted for those fields.
 *
 * A position, wherever one is asked for, carries `impactNotional`: the notional its impact is
 * charged on, in whole dollars, fixed when it opened (see `impactNotionalFor`).
 */

export const BPS = 10_000n;
export const WAD = 10n ** 18n;
export const DEADBAND_DIVISOR = 50_000n;
/** What the impact curve is charged on while a side is no fuller than its market's depth, in dollars. */
export const REFERENCE_NOTIONAL = 100_000n;
/** The most a position's impact notional can be: what the Exchange has room to store. */
export const MAX_IMPACT_NOTIONAL = 2n ** 32n - 1n;
export const FEE_BPS = 200n;

/** The hard-liquidation trigger. Crossing it forfeits the whole margin. */
export function bustPrice(entry, leverage, isLong, market) {
  const tick = BigInt(market.tick);
  const distance = (entry / tick / BigInt(leverage)) * tick;
  const zero = isLong ? entry - distance : entry + distance;
  const buffer = (((zero / tick) * BigInt(market.bustBuffer)) / WAD) * tick;
  return isLong ? zero + buffer : zero - buffer;
}

/** Whether a position at `entry` and `leverage` has a trigger strictly on the losing side of entry. */
export function hasRoom(entry, leverage, market) {
  const tick = BigInt(market.tick);
  const distance = (entry / tick / BigInt(leverage)) * tick;
  const buffer = ((((entry + distance) / tick) * BigInt(market.bustBuffer)) / WAD) * tick;
  return distance > buffer;
}

export function crossed(price, bust, isLong) {
  return isLong ? price <= bust : price >= bust;
}

/**
 * The notional a new position's impact is charged on, in whole dollars.
 *
 * A side's open interest is a stack: the position sits on top of `ahead` (what is already open on
 * its side, in USDC) and takes up the next `notional` of it. It is charged on where the middle of
 * that stretch stands against `depth` (whole dollars): nothing extra up to the depth, and in step
 * with how full the side is past it. Rounded up.
 */
export function impactNotionalFor(ahead, notional, depth) {
  const divisor = 2_000_000n * BigInt(depth);
  const charge = ((2n * ahead + notional) * REFERENCE_NOTIONAL + divisor - 1n) / divisor;
  if (charge < REFERENCE_NOTIONAL) return REFERENCE_NOTIONAL;
  return charge > MAX_IMPACT_NOTIONAL ? MAX_IMPACT_NOTIONAL : charge;
}

/** How many times the reference a position is charged on: 1 on a quiet side, more on a crowded one. */
export function sizeLevel(impactNotional) {
  return Number(BigInt(impactNotional)) / Number(REFERENCE_NOTIONAL);
}

/**
 * Values a close. For a win, `amount` is the gain after the deadband and the impact haircut,
 * before the win fee. For a loss it is the raw loss, not capped at margin.
 *
 * `impactNotional` is the position's own, in whole dollars. The reference notional prices it the
 * way the reference exchange prices every position.
 */
export function settle(entry, exit, notional, isLong, market, impactNotional = REFERENCE_NOTIONAL) {
  if (exit === entry) return { win: false, amount: 0n };
  const win = isLong ? exit > entry : exit < entry;
  let delta = exit > entry ? exit - entry : entry - exit;
  if (!win) return { win: false, amount: (notional * delta) / entry };

  const tick = BigInt(market.tick);
  const deadband = (entry / tick / DEADBAND_DIVISOR) * tick;
  if (delta <= deadband) return { win: true, amount: 0n };
  delta -= deadband;

  const move = (delta * WAD) / entry;
  const byRate = move * BigInt(market.rateMultiplier);
  const byPosition = move * BigInt(market.positionMultiplier) * 1_000n;
  if (byRate === 0n || byPosition === 0n) return { win: true, amount: 0n };

  const term1 = (WAD * WAD) / byRate;
  const term2 = (BigInt(impactNotional) * WAD * WAD) / byPosition;
  if (term1 > WAD * WAD || term2 > WAD * WAD) return { win: true, amount: 0n };

  const scale = (BigInt(market.maxKeepBps) * 10n ** 14n * WAD) / (WAD + term1 + term2);
  const raw = (notional * 10n ** 12n * delta) / entry;
  return { win: true, amount: (raw * scale) / WAD / 10n ** 12n };
}

/**
 * What closing `position` at `exit` is worth: profit after every deduction, or minus the loss.
 * @param {{entryPrice: bigint, margin: bigint, leverage: number, isLong: boolean, impactNotional: bigint | number | string}} position
 */
export function quoteClose(position, market, exit) {
  const bust = bustPrice(position.entryPrice, position.leverage, position.isLong, market);
  if (crossed(exit, bust, position.isLong)) return { busted: true, pnl: -position.margin };
  const notional = position.margin * BigInt(position.leverage);
  const { win, amount } = settle(position.entryPrice, exit, notional, position.isLong, market, position.impactNotional ?? REFERENCE_NOTIONAL);
  if (win) return { busted: false, pnl: amount - (amount * FEE_BPS) / BPS };
  return { busted: false, pnl: -(amount < position.margin ? amount : position.margin) };
}

/**
 * Share of a raw gain a win keeps for a move of `moveBps` basis points, as a number in [0, 1], for
 * a position charged on `impactNotional` (the reference notional unless its side was crowded).
 */
export function keepShare(moveBps, market, impactNotional = REFERENCE_NOTIONAL) {
  // A round entry far above any tick, so tick rounding does not colour the answer.
  const entry = 100_000_00000000n;
  const exit = entry + (entry * BigInt(Math.round(moveBps * 1000))) / 10_000_000n;
  if (exit === entry) return 0;
  const notional = 1_000_000_000000n;
  const raw = (notional * (exit - entry)) / entry;
  if (raw === 0n) return 0;
  const { amount } = settle(entry, exit, notional, true, market, impactNotional);
  const net = amount - (amount * FEE_BPS) / BPS;
  return Number((net * 1_000_000n) / raw) / 1_000_000;
}

/** How far the bust trigger is from entry, as a fraction of entry, at a round price. */
export function bustDistance(leverage, market) {
  const entry = 100_000_00000000n;
  return Number(entry - bustPrice(entry, leverage, true, market)) / Number(entry);
}
