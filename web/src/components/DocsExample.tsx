import { tx, Localized } from "../lib/i18n";
import { useState } from "react";
import { BPS, FEE_BPS, REFERENCE_NOTIONAL, bustPrice, keepShare, settle } from "@shared/math.mjs";
import { big, usd } from "../lib/format";
import type { Market } from "../lib/types";

const USD = 1_000_000n;
const fallbackEntry = 100_000n * 100_000_000n;
const price = (value: bigint) => usd(value / 100n);
const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** A cash-funded long, calculated with the same integer math used to preview a real position. */
export function DocsExample({ markets }: { markets: Market[] }) {
  const lead = markets.find(market => market.symbol === "BTC") ?? markets[0];
  const [marketId, setMarketId] = useState(lead.id);
  const [leverage, setLeverage] = useState(Math.min(100, lead.maxLeverage));
  const [move, setMove] = useState(50);
  const [impact, setImpact] = useState(1);
  // Snapshot example prices. Live quotes must not change an example while someone is reading it.
  const [entries] = useState(() => Object.fromEntries(markets.map(market => [market.id, big(market.price) > 0n ? big(market.price) : fallbackEntry])));
  const market = markets.find(item => item.id === marketId) ?? lead;
  const lev = Math.min(leverage, market.maxLeverage);
  const entry = entries[market.id] ?? fallbackEntry;
  const margin = 100n * USD;
  const notional = margin * BigInt(lev);
  const exit = entry + entry * BigInt(move) / 10_000n;
  const raw = notional * (exit - entry) / entry;
  const tick = BigInt(market.tick);
  const deadband = entry / tick / 50_000n * tick;
  const afterDeadband = notional * (exit - entry > deadband ? exit - entry - deadband : 0n) / entry;
  const afterImpact = settle(entry, exit, notional, true, market, REFERENCE_NOTIONAL * BigInt(impact)).amount;
  const fee = afterImpact * FEE_BPS / BPS;
  const net = afterImpact - fee;
  const bust = bustPrice(entry, lev, true, market);
  const liquidationMove = Number(entry - bust) / Number(entry) * 100;
  const levels = [...new Set([1, 10, 100, 500, 1000, market.maxLeverage])].filter(value => value <= market.maxLeverage).sort((a, b) => a - b);

  return <div className="docs-example">
    <header><h3>{tx("Try a winning close")}</h3><p>{tx("A long position with $100 of cash margin. Change the inputs to see what reaches your balance.")}</p></header>
    <div className="docs-example-controls">
      <label>{tx("Market")}<select aria-label={tx("Market")} value={market.id} onChange={event => setMarketId(Number(event.target.value))}>{markets.map(item => <option key={item.id} value={item.id}>{item.symbol}</option>)}</select></label>
      <label>{tx("Leverage")}<select aria-label={tx("Leverage")} value={lev} onChange={event => setLeverage(Number(event.target.value))}>{levels.map(value => <option key={value} value={value}>{value}x</option>)}</select></label>
      <label>{tx("Price increase")}<select aria-label={tx("Price increase")} value={move} onChange={event => setMove(Number(event.target.value))}>{[1, 2, 5, 10, 25, 50, 100].map(value => <option key={value} value={value}>{percent(value)}</option>)}</select></label>
      <label>{tx("Size Impact")}<select aria-label={tx("Size Impact")} value={impact} onChange={event => setImpact(Number(event.target.value))}>{[1, 2, 5, 10, 20].map(value => <option key={value} value={value}>{value}x</option>)}</select></label>
    </div>
    <dl className="docs-example-position">
      <div><dt>{tx("Example entry")}</dt><dd>{price(entry)}</dd></div>
      <div><dt>{tx("Position size")}</dt><dd>{usd(notional)}</dd></div>
      <div><dt>{tx("Long liquidates at")}</dt><dd>{price(bust)} <small>−{liquidationMove.toFixed(4)}%</small></dd></div>
    </dl>
    <dl className="docs-receipt">
      <div><dt>{tx("Raw price gain")}</dt><dd>{usd(raw)}</dd></div>
      <div><dt>{tx("Deadband")}</dt><dd>{usd(-(raw - afterDeadband))}</dd></div>
      <div><dt>{tx("Impact haircut")}</dt><dd>{usd(-(afterDeadband - afterImpact))}</dd></div>
      <div><dt><Localized message={"Win fee · {0}%"} values={[Number(FEE_BPS) / 100]} /></dt><dd>{usd(-fee)}</dd></div>
      <div className="docs-receipt-total"><dt>{tx("Net profit")}</dt><dd><output aria-live="polite" aria-label={tx("Example net profit")}>{usd(net)}</output></dd></div>
    </dl>
    <p className="docs-example-note">{tx("Your $100 cash margin is returned separately. Profit can enter the payout queue if the vault cannot pay it yet.")}</p>
    <details className="docs-details">
      <summary><Localized message={"Compare price moves on {0}"} values={[market.symbol]} /></summary>
      <div className="docs-table-scroll" tabIndex={0} role="region" aria-label={tx("Profit retained at different price moves")}>
        <table><caption><Localized message={"Approximate share of the raw gain paid after deductions, at {0}x Size Impact."} values={[impact]} /></caption><thead><tr><th>{tx("Price increase")}</th><th>{tx("Raw gain retained")}</th></tr></thead><tbody>
          {[1, 2, 5, 10, 25, 50, 100].map(value => <tr key={value}><td>{percent(value)}</td><td>{(keepShare(value, market, REFERENCE_NOTIONAL * BigInt(impact)) * 100).toFixed(1)}%</td></tr>)}
        </tbody></table>
      </div>
    </details>
  </div>;
}
