import { useEffect, useState, type ReactNode } from "react";
import { Hero } from "../components/Hero";
import { SeasonBoard } from "../components/Season";
import { AssetIcon, Link } from "../components/Shell";
import { useSecond } from "../components/Tables";
import { loadLeaderboard } from "../lib/api";
import { ago, big, duration, percent, price, shortAddress, usd, usdNumber } from "../lib/format";
import { PREVIEW } from "../lib/mode";
import { setState, useStore } from "../lib/store";
import type { Leaderboard as Board } from "../lib/types";

const WINDOWS: [string, string][] = [
  ["24h", "24h"],
  ["7d", "7d"],
  ["30d", "30d"],
  ["all", "All"],
];

/** One of the top three: on a step of the podium, the winner in the middle and a step higher. */
function Step({ rank, who, pnl, meta, me }: { rank: number; who: string; pnl: bigint; meta: ReactNode; me: boolean }) {
  return (
    <article className={`step pos${rank} ${rank === 1 ? "first" : ""} ${me ? "me" : ""}`}>
      <span className="step-rank">#{rank}</span>
      <span className="step-who">{who}</span>
      <span className={`step-pnl ${pnl > 0n ? "up" : pnl < 0n ? "down" : ""}`}>{usd(pnl, { sign: true })}</span>
      <span className="step-meta">{meta}</span>
    </article>
  );
}

export function Leaderboard() {
  const [view, setView] = useState<"positions" | "accounts">("positions");
  const [window, setWindow] = useState("24h");
  const [result, setBoard] = useState<Board | null>(null);
  const board = result?.window === window ? result : null;
  const [search, setSearch] = useState("");
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const markets = useStore((s) => s.config!.markets);
  const owner = useStore((s) => s.owner);
  const myName = useStore((s) => s.account?.name);
  const now = useSecond();

  useEffect(() => {
    let alive = true;
    let busy = false;
    setBoard(null);
    setError(false);
    const load = async () => {
      if (busy) return;
      busy = true;
      try { const next = await loadLeaderboard(window); if (alive) { setBoard(next); setError(false); } }
      catch { if (alive) setError(true); }
      finally { busy = false; }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [window, retry]);

  const nameOf = (address: string) => board?.names[address.toLowerCase()] ?? shortAddress(address);
  const needle = search.trim().toLowerCase();
  const matches = (address: string) => !needle || address.toLowerCase().includes(needle) || (board?.names[address.toLowerCase()] ?? "").toLowerCase().includes(needle);
  const isMe = (address: string) => owner !== null && address.toLowerCase() === owner.toLowerCase();

  const positions = (board?.positions ?? []).map((t, i) => ({ t, rank: i + 1 })).filter(({ t }) => matches(t.owner));
  const accounts = (board?.accounts ?? []).map((row, i) => ({ row, rank: i + 1 })).filter(({ row }) => matches(row.address));
  const count = view === "positions" ? positions.length : accounts.length;
  const total = view === "positions" ? board?.positions.length ?? 0 : board?.accounts.length ?? 0;
  // The podium is the top three of the whole board; a search only narrows the list below it.
  const podium =
    view === "positions"
      ? (board?.positions ?? []).slice(0, 3).map((t, i) => {
          const market = markets[t.market];
          const margin = big(t.margin);
          return (
            <Step
              key={t.id}
              rank={i + 1}
              who={nameOf(t.owner)}
              pnl={big(t.pnl)}
              me={isMe(t.owner)}
              meta={
                <>
                  <span>
                    {market?.symbol} {t.leverage}x {t.isLong ? "long" : "short"}
                  </span>
                  <span>{margin > 0n ? percent(usdNumber(t.pnl) / usdNumber(margin), 1, true) : "–"}</span>
                  <span>{t.entryTime ? `held ${duration(t.time - t.entryTime)}` : ""}</span>
                </>
              }
            />
          );
        })
      : (board?.accounts ?? []).slice(0, 3).map((row, i) => (
          <Step
            key={row.address}
            rank={i + 1}
            who={nameOf(row.address)}
            pnl={big(row.pnl)}
            me={isMe(row.address)}
            meta={
              <>
                <span>{usd(row.volume, { cents: false })} traded</span>
                <span>{row.trades ? `${percent(row.wins / row.trades, 0)} won` : ""}</span>
                <span>{row.busts} liquidations</span>
              </>
            }
          />
        ));

  return (
    <div className="sheet work-page leaderboard-page">
      <Hero
        title="Leaderboard"
        lede={view === "positions" ? "The biggest winning trades in the period." : "Traders ranked by profit in the period."}
        actions={
          <>
            {owner ? (
              <button className="btn" onClick={() => setState({ dialog: "username" })}>
                {myName ? `You are ${myName}` : "Claim a username"}
              </button>
            ) : (
              <button className="btn primary" onClick={() => setState({ dialog: "connect" })}>
                {PREVIEW ? "Start trading" : "Connect wallet"}
              </button>
            )}
          </>
        }
      />

      <div className="page-toolbar leaderboard-toolbar">
            <span className="seg" role="group" aria-label="Leaderboard">
              <button aria-pressed={view === "positions"} onClick={() => setView("positions")}>
                Trades
              </button>
              <button aria-pressed={view === "accounts"} onClick={() => setView("accounts")}>
                Traders
              </button>
            </span>
            <span className="seg" role="group" aria-label="Period">
              {WINDOWS.map(([id, label]) => (
                <button key={id} aria-pressed={window === id} onClick={() => setWindow(id)}>
                  {label}
                </button>
              ))}
            </span>
            <input className="input left lb-search" placeholder="Search name or address" aria-label="Search name or address" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <SeasonBoard />

      {podium.length > 0 && <div className="podium">{podium}</div>}

      <section className="panel lb-card">
        <div className="panel-head">
          <h2 className="title">{view === "positions" ? "All winning trades" : "All traders"}</h2>
          <span className="soft">{board ? `${count}${needle ? ` of ${total}` : ""} ${view === "positions" ? "trades" : "traders"}` : ""}</span>
        </div>
        {error && <div className="page-feedback" role="alert"><span>Couldn’t refresh the {window === "all" ? "all-time" : window} board.{board ? " Showing the last available results." : " Try again to load results."}</span><button className="btn small" onClick={() => setRetry((n) => n + 1)}>Retry</button></div>}
        <div className="lb-wrap" hidden={!board || total === 0 || count === 0}>
          {view === "positions" ? (
            <div className="lb">
              <div className="lb-cols">
                <span>#</span>
                <span>Trader</span>
                <span>Trade</span>
                <span className="r">Size</span>
                <span className="r">Entry → exit</span>
                <span className="r">Profit</span>
                <span className="r">%</span>
                <span className="r">Margin</span>
                <span className="r">Held</span>
                <span className="r">Closed</span>
              </div>
              {positions.map(({ t, rank }) => {
                const market = markets[t.market];
                const margin = big(t.margin);
                return (
                  <div key={t.id} className={`lb-row r${rank} ${isMe(t.owner) ? "me" : ""}`}>
                    <span className="rank">{rank}</span>
                    <span className="who">{nameOf(t.owner)}</span>
                    <span className="asset">
                      <AssetIcon symbol={market?.symbol ?? "BTC"} />
                      {market?.symbol}
                      <span className={`side ${t.isLong ? "up" : "down"}`}>
                        {t.leverage}x {t.isLong ? "Long" : "Short"}
                      </span>
                    </span>
                    <span className="r">{t.leverage ? usd(margin * BigInt(t.leverage), { cents: false }) : "–"}</span>
                    <span className="r">
                      {t.entryPrice ? price(t.entryPrice) : "–"} <span className="dim">→</span> {price(t.exitPrice)}
                    </span>
                    <span className="r pnl up">{usd(t.pnl, { sign: true })}</span>
                    <span className="r up">{margin > 0n ? percent(usdNumber(t.pnl) / usdNumber(margin), 1, true) : "–"}</span>
                    <span className="r">{usd(margin).slice(1)}</span>
                    <span className="r">{t.entryTime ? duration(t.time - t.entryTime) : "–"}</span>
                    <span className="r soft">{ago(t.time, now)} ago</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="lb lb-accounts">
              <div className="lb-cols">
                <span>#</span>
                <span>Trader</span>
                <span className="r">Profit</span>
                <span className="r">Volume</span>
                <span className="r">Trades</span>
                <span className="r">Win rate</span>
                <span className="r">Liquidations</span>
              </div>
              {accounts.map(({ row, rank }) => {
                const pnl = big(row.pnl);
                return (
                  <div key={row.address} className={`lb-row r${rank} ${isMe(row.address) ? "me" : ""}`}>
                    <span className="rank">{rank}</span>
                    <span className="who">{nameOf(row.address)}</span>
                    <span className={`r pnl ${pnl > 0n ? "up" : pnl < 0n ? "down" : ""}`}>{usd(pnl, { sign: true })}</span>
                    <span className="r">{usd(row.volume, { cents: false })}</span>
                    <span className="r">{row.trades}</span>
                    <span className="r">{row.trades ? percent(row.wins / row.trades, 0) : "–"}</span>
                    <span className="r">{row.busts}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!board && !error && <div className="quiet-empty" role="status"><p>Loading the board…</p><span>Finding the results for this period.</span></div>}
        {board && count === 0 && <div className="quiet-empty">
          <p>{needle ? "No traders match your search." : "First place is still open."}</p>
          <span>{needle ? "Try a different name or wallet address." : view === "positions" ? "Winning trades in this period will appear here." : "Traders appear after their first closed trade in this period."}</span>
          {needle ? <button className="btn" onClick={() => setSearch("")}>Clear search</button> : <Link to="/trade" className="btn">Go to exchange</Link>}
        </div>}
      </section>
    </div>
  );
}
