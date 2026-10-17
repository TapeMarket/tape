/**
 * Weekly seasons: a leaderboard that starts again every Monday at 00:00 UTC, and prizes for its top
 * ten paid out of the fees the exchange took that week. Shared by the relayer, the preview and the
 * payout tool, so all three rank and pay the same way.
 *
 * Ranked by realised profit over the week. A trader needs MIN_TRADES closed trades to be ranked,
 * so a single lucky shot does not take the week. The pool is `prizeBps` of the fees taken that
 * week; the team's half of every fee is where it is paid from.
 */

export const WEEK = 7 * 86_400;
/** 1970-01-05, the first Monday of the unix clock. */
const FIRST_MONDAY = 4 * 86_400;
export const MIN_TRADES = 5;
/** How the pool is split between the top ten, in basis points. Adds up to 10,000. */
export const PRIZE_SPLIT_BPS = [3000, 2000, 1200, 900, 700, 600, 500, 400, 400, 300];

/** The Monday 00:00 UTC that starts the week holding `time` (unix seconds). */
export const weekOf = (time) => Math.floor((time - FIRST_MONDAY) / WEEK) * WEEK + FIRST_MONDAY;

/** Season 1 is the week of `first`; every week after it is the next number. */
export const seasonNumber = (start, first) => Math.floor((start - weekOf(first)) / WEEK) + 1;

/**
 * The season that starts at `start`: everyone who closed a trade in it, best first, and what the
 * top ten are paid. `trades` are closed trades with owner, pnl, fee, margin, leverage and time,
 * amounts as 6-decimal bigints.
 */
export function season(trades, start, prizeBps) {
  const end = start + WEEK;
  const rows = new Map();
  let fees = 0n;
  for (const t of trades) {
    if (t.time < start || t.time >= end) continue;
    fees += BigInt(t.fee ?? 0n);
    const key = t.owner.toLowerCase();
    const row = rows.get(key) ?? { address: t.owner, pnl: 0n, volume: 0n, trades: 0, wins: 0, prize: 0n };
    row.pnl += BigInt(t.pnl);
    if (t.margin !== null && t.margin !== undefined) row.volume += BigInt(t.margin) * BigInt(t.leverage ?? 1);
    row.trades += 1;
    if (BigInt(t.pnl) > 0n) row.wins += 1;
    rows.set(key, row);
  }
  const pool = (fees * BigInt(prizeBps)) / 10_000n;
  const ranked = [...rows.values()].sort((a, b) => (b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : b.volume > a.volume ? 1 : -1));
  let place = 0;
  for (const row of ranked) {
    row.qualified = row.trades >= MIN_TRADES;
    // Only a ranked trader in profit is paid; a share nobody qualifies for stays with the team.
    if (row.qualified && row.pnl > 0n && place < PRIZE_SPLIT_BPS.length) {
      row.prize = (pool * BigInt(PRIZE_SPLIT_BPS[place])) / 10_000n;
      row.rank = ++place;
    }
  }
  return { start, end, fees, pool, prizeBps, rows: ranked };
}
