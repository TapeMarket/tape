import { tx } from "../lib/i18n";
import { Hero } from "../components/Hero";
import { Link } from "../components/Shell";
import { useSecond } from "../components/Tables";
import { big, shortAddress, usd } from "../lib/format";
import { PREVIEW } from "../lib/mode";
import { setState, useStore } from "../lib/store";
import { clockText, useJackpot } from "../lib/jackpot";
export { clockText, useJackpot } from "../lib/jackpot";

function JackpotHow({ pending = false }: { pending?: boolean }) {
  return <section className="jp-how" aria-labelledby="jackpot-how-title">
    <h2 id="jackpot-how-title">{pending ? tx("What starts at activation") : tx("How it works")}</h2>
    <ol className="jackpot-steps">
      <li><b>{tx("A loss becomes tickets.")}</b><p>{tx("A losing close counts the loss; a liquidation counts its whole margin. $1 lost is $1 of tickets, added automatically when the trade settles.")}</p></li>
      <li><b>{tx("One draw every hour.")}</b><p>{tx("The draw picks a point among that hour’s tickets. $100 of tickets has ten times the chance of $10.")}</p></li>
      <li><b>{tx("The whole pot, in USDC.")}</b><p>{tx("The contract sends the prize to the winning wallet when drawn. An hour with no losses rolls its pot into the next.")}</p></li>
    </ol>
    <p className="note">{tx("The pot receives a share of exchange fees. The draw uses the hash of an Ethereum block made after the hour ends.")}</p>
  </section>;
}

export function JackpotTicket() {
  return <svg className="jackpot-ticket" viewBox="0 0 420 230" aria-hidden="true">
    <g transform="rotate(-7 210 115)" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M36 30H384V83A32 32 0 0 0 384 147V200H36V147A32 32 0 0 0 36 83Z" />
      <path d="M300 30V200" strokeDasharray="5 7" />
      <path d="M66 57H267M66 173H267" opacity=".35" />
      <text x="65" y="118" fill="currentColor" stroke="none" fontSize="49" fontWeight="750" letterSpacing="-2">{tx("REKT.")}</text>
      <text x="68" y="150" fill="currentColor" stroke="none" fontSize="15">{tx("ONE HOUR. ONE WINNER.")}</text>
      <text x="342" y="126" fill="currentColor" stroke="none" fontSize="24" fontWeight="650" textAnchor="middle" transform="rotate(90 342 126)">{tx("TAPE")}</text>
    </g>
  </svg>;
}

export function Jackpot() {
  const jackpot = useJackpot();
  const owner = useStore((s) => s.owner);
  const now = useSecond();
  const available = useStore((s) => Boolean(s.config?.addresses.jackpot));
  const left = jackpot ? jackpot.end - now : 0;
  const total = big(jackpot?.tickets);
  const mine = big(jackpot?.mine);
  const chance = total > 0n ? Number((mine * 10_000n) / total) / 100 : 0;
  const nameOf = (address: string) => jackpot?.names[address.toLowerCase()] ?? shortAddress(address);

  if (!PREVIEW && !available) return <div className="sheet work-page jackpot jackpot-page">
    <Hero title={tx("Rekt Jackpot")} lede={tx("Every hour. One winner. The jackpot starts with the coin launch.")} />
    <section className="pending-banner">
      <div><h2>{tx("Jackpot not active yet")}</h2><p>{tx("The exchange is live. Tickets and hourly draws will start after the coin and its reward contracts are attached.")}</p><div className="pending-actions"><Link to="/trade" className="btn primary">{tx("Go to exchange")}</Link><Link to="/docs" className="btn">{tx("Read the rules")}</Link></div></div>
      <JackpotTicket />
    </section>
    <div className="jp-cols"><JackpotHow pending /><section className="jp-winners"><h2>{tx("Recent winners")}</h2><div className="quiet-empty"><p>{tx("No draws yet.")}</p><span>{tx("Winners will appear here after the jackpot is activated.")}</span></div></section></div>
  </div>;

  return (
    <div className="sheet work-page jackpot jackpot-page">
      <Hero
        title={tx("Rekt Jackpot")}
        lede={tx("Every dollar you lose on Tape is a ticket. Every hour, one ticket wins the whole pot, paid in USDC straight to the wallet.")}
        actions={
          <Link to="/trade" className="btn primary">{tx("Trade")}</Link>
        }
      />

      <section className="panel jp-main">
        <div className="jp-pot">
          <span>{tx("This hour's pot")}</span>
          <b>{jackpot ? usd(jackpot.prize) : "–"}</b>
        </div>
        <div className="jp-countdown"><span>{tx("Next draw in")}</span><b>{jackpot ? clockText(left) : "–"}</b><small>{PREVIEW ? tx("Practice round · no real USDC") : tx("Hourly draw · paid in USDC")}</small></div>
        <dl className="jp-figs">
          <div>
            <dt>{tx("Tickets in this hour")}</dt>
            <dd>{jackpot ? usd(total, { cents: false }) : "–"}</dd>
          </div>
          <div>
            <dt>{tx("Your tickets")}</dt>
            <dd>{owner ? usd(mine, { cents: false }) : "–"}</dd>
          </div>
          <div>
            <dt>{tx("Your chance")}</dt>
            <dd>{owner && total > 0n ? `${chance.toFixed(chance < 1 ? 2 : 1)}%` : "–"}</dd>
          </div>
        </dl>
        {!owner && (<button className="btn primary" onClick={() => setState({ dialog: "connect" })}>
            {PREVIEW ? tx("Start trading") : tx("Connect wallet")}
          </button>)}
      </section>

      <div className="jp-cols">
        <JackpotHow />

        <section className="jp-winners">
          <h2>{tx("Recent winners")}</h2>
          {jackpot && jackpot.winners.length > 0 ? (<ol>
              {jackpot.winners.map((w) => (
                <li key={w.round}>
                  <span className="jp-who">{nameOf(w.winner)}</span>
                  <span className="jp-prize">{usd(w.prize)}</span>
                  <span className="dim">{new Date(w.time * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
                </li>
              ))}
            </ol>) : (<div className="quiet-empty"><p>{tx("No draws yet.")}</p><span>{tx("The first draw is at the end of this hour.")}</span></div>)}
        </section>
      </div>
    </div>
  );
}
