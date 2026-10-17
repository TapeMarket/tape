// Hyperliquid's public market data: where every market's price comes from, on the real exchange
// (signed by the relayer) and in the preview (read straight from here). No key, no account.

export const HL_API = "https://api.hyperliquid.xyz/info";
export const HL_WS = "wss://api.hyperliquid.xyz/ws";

/** Asks Hyperliquid's info endpoint. */
export async function hlInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(HL_API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`hyperliquid ${res.status}`);
  return (await res.json()) as T;
}

/** A feed id as the contracts hold it: "hyperliquid:<coin>" as text in a bytes32. */
export function feedIdOf(coin: string): `0x${string}` {
  const hex = [...`hyperliquid:${coin}`].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `0x${hex.padEnd(64, "0")}`;
}

/** The Hyperliquid coin a market is priced from, read out of its feed id ("BTC", "xyz:TSLA"). */
export function coinOf(market: { feedId?: string; symbol: string }): string {
  const hex = market.feedId?.startsWith("0x") ? market.feedId.slice(2) : "";
  let text = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  const m = /^hyperliquid:([A-Za-z0-9:]{1,24})$/.exec(text);
  return m ? m[1] : market.symbol;
}

/** Hyperliquid's own name for a candle size, for each size the chart offers. */
export const INTERVALS: Record<number, string> = { 60: "1m", 300: "5m", 900: "15m", 3600: "1h", 14400: "4h", 86400: "1d" };

export interface HlCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
}

/** Candles of `step` seconds between two times (unix seconds), oldest first. */
export async function hlCandles(coin: string, step: number, from: number, to: number): Promise<HlCandle[]> {
  const interval = INTERVALS[step];
  if (!interval) throw new Error(`no ${step}s candles`);
  const rows = await hlInfo<HlCandle[]>({ type: "candleSnapshot", req: { coin, interval, startTime: from * 1000, endTime: to * 1000 } });
  return rows.filter((r) => Number(r.c) > 0).sort((a, b) => a.t - b.t);
}
