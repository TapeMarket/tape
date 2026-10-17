/** What each market is called in words, beside its ticker. */
const NAMES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ether",
  SOL: "Solana",
  XRP: "XRP",
  DOGE: "Dogecoin",
  GOLD: "Gold",
  SPX: "S&P 500",
  TSLA: "Tesla",
  NVDA: "Nvidia",
  AAPL: "Apple",
};

export const nameOf = (symbol: string): string => NAMES[symbol] ?? symbol;

/** Stocks, indices and metals, as opposed to crypto. */
export const isTradFi = (symbol: string): boolean => ["GOLD", "SPX", "TSLA", "NVDA", "AAPL"].includes(symbol);

/** "a, b and c". */
export const listWords = (words: string[]): string => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);
