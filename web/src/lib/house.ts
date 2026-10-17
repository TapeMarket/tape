// Figures the charts derive from the list of open positions. Plain floating point: these are
// pictures of the book, not settlements. Anything that pays money uses shared/math.mjs.

import { useEffect } from "react";
import type { HousePosition, Market } from "./types";

export interface Pos {
  market: number;
  isLong: boolean;
  margin: number;
  leverage: number;
  entry: number;
  bust: number;
  /** What a win's impact is charged on, in dollars: 100,000 unless the side was crowded at open. */
  impact: number;
}

export const toPos = (p: HousePosition): Pos => ({
  market: p.m,
  isLong: p.l,
  margin: Number(p.g) / 1e6,
  leverage: p.x,
  entry: Number(p.e) / 1e8,
  bust: Number(p.b) / 1e8,
  impact: p.i,
});

/** What closing at `price` would be worth to the trader. Mirrors `quoteClose`. */
export function traderPnl(p: Pos, price: number, market: Pick<Market, "rateMultiplier" | "positionMultiplier" | "tick" | "maxKeepBps">): number {
  if (p.isLong ? price <= p.bust : price >= p.bust) return -p.margin;
  const delta = Math.abs(price - p.entry);
  if (delta === 0) return 0;
  const notional = p.margin * p.leverage;
  const win = p.isLong ? price > p.entry : price < p.entry;
  if (!win) return -Math.min((notional * delta) / p.entry, p.margin);
  // The deadband is a fifty-thousandth of the entry, in whole ticks.
  const tick = market.tick / 1e8;
  const deadband = Math.floor(p.entry / tick / 50_000) * tick;
  if (delta <= deadband) return 0;
  const move = (delta - deadband) / p.entry;
  // positionMultiplier is in thousandths; the size term is charged on the position's impact notional.
  const keep = market.maxKeepBps / 10_000 / (1 + 1 / (move * market.rateMultiplier) + p.impact / 1_000 / (move * market.positionMultiplier));
  return notional * move * keep * 0.98;
}

/** The house's result if every position closed at the current prices. */
export function openHousePnl(positions: Pos[], prices: (number | undefined)[], markets: Market[]): number {
  let total = 0;
  for (const p of positions) {
    const price = prices[p.market];
    if (price) total -= traderPnl(p, price, markets[p.market]);
  }
  return total;
}

/** The house's result on one market for price moves from -range to +range. */
export function housePnlCurve(positions: Pos[], marketId: number, price: number, market: Market, range = 0.01, steps = 60): { x: number; v: number }[] {
  const mine = positions.filter((p) => p.market === marketId);
  const out: { x: number; v: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = -range + (2 * range * i) / steps;
    const at = price * (1 + x);
    let v = 0;
    for (const p of mine) v -= traderPnl(p, at, market);
    out.push({ x, v });
  }
  return out;
}

/** Notional that would bust in each of `rows` price bands between `top` and `bottom`. */
export function bustBins(positions: Pos[], marketId: number, top: number, bottom: number, rows: number): number[] {
  const bins = new Array<number>(rows).fill(0);
  for (const p of positions) {
    if (p.market !== marketId || p.bust > top || p.bust < bottom) continue;
    const row = Math.min(rows - 1, Math.floor(((top - p.bust) / (top - bottom)) * rows));
    bins[row] += p.margin * p.leverage;
  }
  return bins;
}

/** One dot per position: across by side and leverage, up by what the house is making on it. */
export function topologyDots(positions: Pos[], prices: (number | undefined)[], markets: Market[]): { x: number; y: number; r: number }[] {
  return positions.slice(0, 600).map((p) => {
    const price = prices[p.market] ?? p.entry;
    const house = -traderPnl(p, price, markets[p.market]);
    const reach = Math.min(Math.log10(Math.max(p.leverage, 1)) / 3, 1);
    const height = Math.min(Math.log10(Math.max(Math.abs(house), 1)) / 4, 1);
    return {
      // A little scatter so equal positions do not stack into one dot.
      x: (p.isLong ? 1 : -1) * Math.max(reach, 0.06) * (0.94 + ((p.entry * 7919) % 1) * 0.06),
      y: Math.sign(house) * height,
      r: Math.max(2, Math.min(9, Math.sqrt(p.margin) / 2.5)),
    };
  });
}

/** Runs `run` now and every `ms` while the component is mounted and the tab is visible. */
export function usePoll(run: () => Promise<unknown> | void, ms: number, deps: unknown[] = []): void {
  useEffect(() => {
    let active = true;
    let busy = false;
    const go = async () => {
      if (!active || busy || document.visibilityState !== "visible") return;
      busy = true;
      try { await run(); } catch {} finally { busy = false; }
    };
    void go();
    const timer = setInterval(go, ms);
    document.addEventListener("visibilitychange", go);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", go); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
