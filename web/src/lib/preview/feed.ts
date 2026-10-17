// Real prices for preview mode, from Hyperliquid's public market data: the same venue, and the
// same number (the middle of the best bid and ask), that the real exchange's prices are signed from.
//
// The live price is pushed over a WebSocket. If the socket goes quiet the same number is polled
// over HTTP until it comes back.
import { HL_WS, hlCandles, hlInfo } from "../hl";

const QUIET_MS = 6_000;
const MIN_GAP_MS = 250;

export interface Candle {
  time: number;
  low: number;
  high: number;
  open: number;
  close: number;
}

/** One-minute candles, oldest first: about the last five hours. */
export async function loadCandles(coin: string): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await hlCandles(coin, 60, now - 300 * 60, now);
  return rows.map((r) => ({ time: Math.floor(r.t / 1000), low: Number(r.l), high: Number(r.h), open: Number(r.o), close: Number(r.c) }));
}

/**
 * The latest trades as one price a second, oldest first: the last trade of every second that had
 * one, as far back as Hyperliquid's recent-trades list reaches (a few seconds to a few minutes).
 */
export async function loadRecentPrints(coin: string): Promise<{ t: number; p: number }[]> {
  const rows = await hlInfo<{ px: string; time: number }[]>({ type: "recentTrades", coin });
  const bySecond = new Map<number, number>();
  for (const row of [...rows].sort((a, b) => a.time - b.time)) {
    const t = Math.floor(row.time / 1000);
    const p = Number(row.px);
    if (t > 0 && p > 0) bySecond.set(t, p);
  }
  return [...bySecond].map(([t, p]) => ({ t, p })).sort((a, b) => a.t - b.t);
}

type Contexts = [{ universe: { name: string }[] }, { prevDayPx: string }[]];
/** One request per dex answers for all of its coins. */
const contexts = new Map<string, { at: number; promise: Promise<Contexts> }>();

/** The price 24 hours ago. */
export async function loadDayOpen(coin: string): Promise<number | null> {
  const dex = coin.includes(":") ? coin.split(":")[0] : "";
  let cached = contexts.get(dex);
  if (!cached || Date.now() - cached.at >= 60_000) {
    const entry = { at: Date.now(), promise: hlInfo<Contexts>(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" }) };
    entry.promise = entry.promise.catch((error) => {
      if (contexts.get(dex) === entry) contexts.delete(dex);
      throw error;
    });
    contexts.set(dex, entry);
    cached = entry;
  }
  const [meta, ctxs] = await cached.promise;
  const i = meta.universe.findIndex((u) => u.name === coin);
  const open = i >= 0 ? Number(ctxs[i]?.prevDayPx) : NaN;
  return Number.isFinite(open) && open > 0 ? open : null;
}

export function createFeed(coins: string[], onMid: (index: number, mid: number) => void) {
  const lastSent: (number | null)[] = coins.map(() => null);
  const lastHeard: (number | null)[] = coins.map(() => null);
  const polling = new Set<string>();
  let generation = 0;
  let socket: WebSocket | null = null;
  let retry = 1_000;
  let stopped = true;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const fresh = (index: number) => lastHeard[index] !== null && lastHeard[index] !== undefined && Date.now() - lastHeard[index]! < QUIET_MS;

  function push(index: number, mid: number, observedAt = Date.now()): void {
    if (stopped || !Number.isFinite(mid) || !(mid > 0)) return;
    if (lastHeard[index] !== null && observedAt < lastHeard[index]!) return;
    lastHeard[index] = observedAt;
    const now = Date.now();
    // A few prints a second is all the chart and the liquidations need.
    if (lastSent[index] !== null && now - lastSent[index]! < MIN_GAP_MS) return;
    lastSent[index] = now;
    onMid(index, mid);
  }

  function connect(): void {
    if (stopped) return;
    const current = (socket = new WebSocket(HL_WS));
    current.onopen = () => {
      if (stopped || socket !== current) return;
      retry = 1_000;
      for (const coin of coins) current.send(JSON.stringify({ method: "subscribe", subscription: { type: "bbo", coin } }));
    };
    current.onmessage = (event) => {
      if (stopped || socket !== current) return;
      try {
        const message = JSON.parse(event.data as string);
        if (message.channel !== "bbo" || !message.data) return;
        const index = coins.indexOf(message.data.coin);
        if (index < 0) return;
        const observedAt = Number(message.data.time), now = Date.now();
        if (!Number.isFinite(observedAt) || observedAt <= 0 || now - observedAt >= QUIET_MS || observedAt > now + 2_000) return;
        const [bid, ask] = message.data.bbo ?? [];
        const b = Number(bid?.px);
        const a = Number(ask?.px);
        if (b > 0 && a >= b) push(index, (b + a) / 2, observedAt);
      } catch {
        // Not a message we understand.
      }
    };
    current.onclose = () => {
      if (socket !== current) return;
      socket = null;
      if (stopped) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, retry);
      retry = Math.min(retry * 2, 15_000);
    };
    current.onerror = () => current.close();
  }

  // One request answers for every coin of a dex.
  const dexes = [...new Set(coins.map((c) => (c.includes(":") ? c.split(":")[0] : "")))];
  const dexOf = (coin: string) => coin.includes(":") ? coin.split(":")[0] : "";
  async function poll(): Promise<void> {
    if (stopped) return;
    const currentGeneration = generation;
    await Promise.all(
      dexes.map(async (dex) => {
        if (polling.has(dex) || !coins.some((coin, index) => dexOf(coin) === dex && !fresh(index))) return;
        polling.add(dex);
        try {
          const mids = await hlInfo<Record<string, string>>(dex ? { type: "allMids", dex } : { type: "allMids" });
          if (stopped || generation !== currentGeneration) return;
          coins.forEach((coin, index) => {
            // Do not replace a resumed live quote with a slower fallback response.
            if (dexOf(coin) === dex && !fresh(index) && mids[coin] !== undefined) push(index, Number(mids[coin]));
          });
        } catch {
          // Offline. The interface says so.
        } finally {
          if (generation === currentGeneration) polling.delete(dex);
        }
      }),
    );
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      generation++;
      polling.clear();
      lastHeard.fill(null);
      lastSent.fill(null);
      connect();
      poll();
      pollTimer = setInterval(poll, 2_500);
    },
    stop() {
      stopped = true;
      generation++;
      if (pollTimer) clearInterval(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      pollTimer = reconnectTimer = null;
      socket?.close();
      socket = null;
    },
    /** A market is fresh only when that market has received a recent real quote. */
    healthy: (index?: number) => !stopped && (index === undefined ? coins.length > 0 && coins.every((_, i) => fresh(i)) : fresh(index)),
  };
}
