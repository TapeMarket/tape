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
    <section className="panel season" aria-label={`Season ${season.number}`}>
      <div className="season-head">
        <div className="season-title">
          <h2>Season {season.number}</h2>
          <p>
            Weekly, Monday to Monday (UTC). The ten most profitable traders split the prize pool; you need {season.minTrades} closed trades to be
            ranked.
          </p>
        </div>
        <dl className="season-figs">
          <div>
            <dt>Prize pool</dt>
            <dd>{usd(season.pool)}</dd>
          </div>
          <div>
            <dt>First place</dt>
            <dd>{usd(top)}</dd>
          </div>
          <div>
            <dt>{season.live ? "Ends in" : "Ended"}</dt>
            <dd>{season.live ? left(season.end - now) : new Date(season.end * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</dd>
          </div>
        </dl>
      </div>

      {paid.length === 0 ? (
        <p className="season-empty">Nobody is in the prizes yet this week. Five trades and a profit puts you on the board.</p>
      ) : (
        <ol className="season-list">
          {paid.map((row) => (
            <li key={row.address} className={isMe(row.address) ? "me" : ""}>
              <span className="season-rank">#{row.rank}</span>
              <span className="season-who">{nameOf(row.address)}</span>
              <span className="season-pnl up">{usd(row.pnl, { sign: true })}</span>
              <span className="season-trades dim">{row.trades} trades</span>
              <span className="season-prize">{usd(row.prize)}</span>
            </li>
          ))}
        </ol>
      )}

      {mine && !mine.rank && (
        <p className="season-you">
          You are #{myPlace} this week at {usd(mine.pnl, { sign: true })}
          {mine.trades < season.minTrades ? `, ${season.minTrades - mine.trades} more trade${season.minTrades - mine.trades === 1 ? "" : "s"} to be ranked.` : "."}
        </p>
      )}

      {season.past.length > 0 && (
        <p className="season-past">
          Last season:{" "}
          {season.past[0].winners.map((w, i) => (
            <span key={w.address}>
              {i > 0 && " · "}#{i + 1} {nameOf(w.address)} won {usd(w.prize)}
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
