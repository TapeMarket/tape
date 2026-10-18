import { tx } from "../lib/i18n";
import { Hero } from "../components/Hero";
import { PageSection } from "../components/PageSection";
import { Link } from "../components/Shell";
import {
  CoinCard,
  Exposure,
  ExchangeDataNotice,
  HouseFunds,
  HousePnl,
  LiquidationHeatmap,
  PositionTopology,
  QueueDebt,
  QueuePlacement,
  QueueStats,
  UserPositions,
  useExchangeData,
  useHouseFigures,
} from "../components/Panels";
import { big, usd, usdCompact } from "../lib/format";

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** The other side of every trade: what the house holds, what it is exposed to, and what it owes. */
export function Vault() {
  const data = useExchangeData();
  const { house, openPnl, funds } = useHouseFigures();
  let open = 0n;
  for (const m of house?.markets ?? []) open += big(m.oiLong) + big(m.oiShort);
  const owed = big(house?.house.totalQueued);
  const tone = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");
  return (
    <div className="sheet work-page vault-page">
      <Hero
        title={tx("Vault")}
        lede={tx("The vault is the other side of every position. It pays winners out of what losers lose, and queues any win it cannot pay yet.")}
        actions={<Link to="/trade" className="btn primary">{tx("Trade")}</Link>}
        figures={[
          { label: "Vault value", value: house ? money(funds) : "–", tone: tone(funds), hint: "Its balance plus what it is up or down on open positions." },
          { label: "Open interest", value: house ? usdCompact(open) : "–", hint: "Everything open on both sides, at size." },
          { label: "Vault open PnL", value: house ? money(openPnl) : "–", tone: tone(openPnl), hint: "The vault's result if every open position closed now." },
          { label: "Queued wins", value: house ? usd(owed) : "–", tone: owed > 0n ? "warn" : "", hint: "Winnings owed and not yet paid." },
          { label: "TVL", value: house ? usdCompact(house.house.treasury) : "–", hint: "All the USDC the exchange holds." },
        ]}
      />
      <ExchangeDataNotice data={data} />
      <PageSection title={tx("Balance and positions")} detail={tx("The vault's value beside the positions it is backing.")}>
        <div className="cells vault-overview"><HouseFunds /><UserPositions /></div>
      </PageSection>
      <PageSection title={tx("Market risk")} detail={tx("Explore exposure, liquidation levels and the effect of a price move.")}>
        <div className="cells vault-risk"><Exposure /><LiquidationHeatmap /><HousePnl /><PositionTopology /></div>
      </PageSection>
      <PageSection title={tx("Payouts and rewards")} detail={tx("Wins waiting to be paid, your place in the queue and rewards distributed.")}>
        <div className="cells vault-payouts"><QueueStats /><QueuePlacement /><QueueDebt /><CoinCard /></div>
      </PageSection>
    </div>
  );
}
