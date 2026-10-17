export function MarketDataCredit({ className = "", logo = false }: { className?: string; logo?: boolean }) {
  return (
    <a
      className={`market-data-credit ${logo ? "market-data-credit-logo" : ""} ${className}`}
      href="https://hyperliquid.xyz/"
      target="_blank"
      rel="noreferrer"
      aria-label="Market data powered by Hyperliquid (opens in a new tab)"
    >
      {logo ? <>
        <span className="credit-copy"><strong>Powered by</strong><small>Live market data</small></span>
        {/* Unmodified logo from https://hyperliquid.gitbook.io/hyperliquid-docs/brand-kit */}
        <img src="/img/hyperliquid-logo.svg" alt="Hyperliquid" width="856" height="200" />
      </> : <><span>Market data</span><strong>Powered by Hyperliquid</strong></>}
    </a>
  );
}
