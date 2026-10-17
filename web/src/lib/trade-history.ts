import type { Market, Trade } from "./types";

export type TradeResult = "all" | "wins" | "losses" | "flat" | "liquidated";

export function filterTrades(trades: Trade[], market: string, result: TradeResult): Trade[] {
  return trades.filter((trade) => {
    if (market !== "all" && trade.market !== Number(market)) return false;
    if (result === "liquidated") return trade.busted;
    const pnl = BigInt(trade.pnl);
    return result === "all" || (result === "wins" && pnl > 0n) || (result === "losses" && pnl < 0n) || (result === "flat" && pnl === 0n);
  });
}

/** Preserve every on-chain decimal without converting through a floating-point number. */
function decimal(value: string | null, places: number): string {
  if (value === null) return "";
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
  const scale = 10n ** BigInt(places);
  return `${amount < 0n ? "-" : ""}${absolute / scale}.${(absolute % scale).toString().padStart(places, "0")}`;
}

const textCell = (value: string) => /^[\s]*[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
const utc = (time: number | null) => time === null ? "" : new Date(time * 1000).toISOString();

/** Export exactly the supplied loaded rows, including those outside the visible table page. */
export function tradesCsv(trades: Trade[], markets: Market[], practice: boolean): string {
  const headers = ["Mode", "Position ID", "Wallet", "Market", "Side", "Leverage", "Margin USDC", "Entry USD", "Exit USD", "PnL USDC", "Credited USDC", "Queued USDC", "Fee USDC", "Opened UTC", "Closed UTC", "Liquidated", "Transaction"];
  const rows = trades.map((t) => [
    practice ? "Practice" : "Live", textCell(t.id), textCell(t.owner), textCell(markets[t.market]?.symbol ?? `Market ${t.market}`), t.isLong === null ? "" : t.isLong ? "Long" : "Short",
    t.leverage === null ? "" : String(t.leverage), decimal(t.margin, 6), decimal(t.entryPrice, 8), decimal(t.exitPrice, 8), decimal(t.pnl, 6), decimal(t.credited, 6), decimal(t.queued, 6), decimal(t.fee, 6), utc(t.entryTime), utc(t.time), t.busted ? "Yes" : "No", textCell(t.tx),
  ]);
  return [headers, ...rows].map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n";
}
