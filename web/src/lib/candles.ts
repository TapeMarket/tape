// Chart history: candles from Hyperliquid's public market data, the venue every price here comes from.
//
// This is for reading the market, not for settling anything. A position is priced by the
// exchange's own oracle, and that same price draws the candle in progress; only the candles
// already closed come from here.

import { hlCandles } from "./hl";

/** How many candles one request asks for. */
const PAGE = 300;
/** How long a first page is served again without asking. */
const FRESH_MS = 20_000;

export interface Bar {
  /** Start of the candle, unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const held = new Map<string, { at: number; bars: Bar[] }>();
const pending = new Map<string, Promise<Bar[]>>();
const copy = (bars: Bar[]): Bar[] => bars.map((bar) => ({ ...bar }));
const keyOf = (coin: string, step: number) => `${coin}:${step}`;

/** Fetches the latest candles of every coin given, in the background, so a chart opens on them at once. */
export function warmCandles(coins: string[], step = 60): void {
  for (const coin of coins) loadCandles(coin, step).catch(() => {});
}

/** The latest candles already fetched for this market and step, however old. Empty if none. */
export function heldCandles(coin: string, step: number): Bar[] {
  return copy(held.get(keyOf(coin, step))?.bars ?? []);
}

/**
 * Up to 300 candles of `step` seconds, oldest first: the latest ones, or with `before` the ones
 * that end before that time (for scrolling back).
 */
export async function loadCandles(coin: string, step: number, before?: number): Promise<Bar[]> {
  const key = keyOf(coin, step);
  if (before === undefined) {
    const fresh = held.get(key);
    if (fresh && Date.now() - fresh.at < FRESH_MS) return copy(fresh.bars);
  }
  const requestKey = `${key}:${before ?? "latest"}`;
  let request = pending.get(requestKey);
  if (!request) {
    request = (async () => {
      const end = before ?? Math.floor(Date.now() / 1000) + step;
      const rows = await hlCandles(coin, step, end - step * PAGE, end - 1);
      const bars = rows
        .map((r) => ({ time: Math.floor(r.t / 1000), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c) }))
        .filter((bar) => bar.close > 0 && (before === undefined || bar.time < before));
      if (before === undefined) held.set(key, { at: Date.now(), bars: copy(bars) });
      return bars;
    })().finally(() => pending.delete(requestKey));
    pending.set(requestKey, request);
  }
  return copy(await request);
}
