import { tx, Localized } from "../lib/i18n";
import { useEffect, useState } from "react";
import { loadSeason } from "../lib/api";
import { big, shortAddress, usd } from "../lib/format";
import { useStore } from "../lib/store";
import type { Season } from "../lib/types";
import { useSecond } from "./Tables";

/** "2d 4h", "4h 12m", "12m 30s": how long until `end`. */
function left(seconds: number): string {
  if (seconds <= 0) return "ending";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

/** This week's season: the prize pool, the clock, and the top ten with what each would be paid. */
export function SeasonBoard() {
  const [season, setSeason] = useState<Season | null>(null);
  const owner = useStore((s) => s.owner);
  const now = useSecond();

  useEffect(() => {
    let alive = true;
    const load = () => loadSeason().then((next) => alive && setSeason(next), () => {});
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!season) return null;
  const nameOf = (address: string) => season.names[address.toLowerCase()] ?? shortAddress(address);
  const isMe = (address: string) => owner !== null && address.toLowerCase() === owner.toLowerCase();
  const paid = season.rows.filter((r) => big(r.prize) > 0n);
  const mine = owner ? season.rows.find((r) => isMe(r.address)) : undefined;
  const myPlace = mine ? season.rows.indexOf(mine) + 1 : 0;
  const top = big(season.pool) > 0n ? (big(season.pool) * BigInt(season.split[0])) / 10_000n : 0n;

  return (
    <section className="panel season" aria-label={tx("Season {0}", [season.number])}>
      <div className="season-head">
        <div className="season-title">
          <h2><Localized message={"Season {0}"} values={[season.number]} /></h2>
          <p><Localized message={"Weekly, Monday to Monday (UTC). The ten most profitable traders split the prize pool; you need {0} closed trades to be ranked."} values={[season.minTrades]} /></p>
        </div>
        <dl className="season-figs">
          <div>
            <dt>{tx("Prize pool")}</dt>
            <dd>{usd(season.pool)}</dd>
          </div>
          <div>
            <dt>{tx("First place")}</dt>
            <dd>{usd(top)}</dd>
          </div>
          <div>
            <dt>{season.live ? tx("Ends in") : tx("Ended")}</dt>
            <dd>{season.live ? left(season.end - now) : new Date(season.end * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</dd>
          </div>
        </dl>
      </div>

      {paid.length === 0 ? (<p className="season-empty">{tx("Nobody is in the prizes yet this week. Five trades and a profit puts you on the board.")}</p>) : (<ol className="season-list">
          {paid.map((row) => (
            <li key={row.address} className={isMe(row.address) ? "me" : ""}>
              <span className="season-rank">#{row.rank}</span>
              <span className="season-who">{nameOf(row.address)}</span>
              <span className="season-pnl up">{usd(row.pnl, { sign: true })}</span>
              <span className="season-trades dim"><Localized message={"{0} trades"} values={[row.trades]} /></span>
              <span className="season-prize">{usd(row.prize)}</span>
            </li>
          ))}
        </ol>)}

      {mine && !mine.rank && (<p className="season-you"><Localized message={"You are #{0} this week at {1}{2}"} values={[myPlace, usd(mine.pnl, { sign: true }), mine.trades < season.minTrades ? tx(", trades still needed to rank: {0}.", [season.minTrades - mine.trades]) : "."]} /></p>)}

      {season.past.length > 0 && (<p className="season-past"><Localized message={"Last season: {0}"} values={[season.past[0].winners.map((w, i) => (
            <span key={w.address}><Localized message={"{0}#{1} {2} won {3}"} values={[i > 0 && " · ", i + 1, nameOf(w.address), usd(w.prize)]} /></span>
          ))]} /></p>)}
    </section>
  );
}
