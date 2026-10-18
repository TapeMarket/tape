import { tx } from "../lib/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Hero } from "../components/Hero";
import { AssetIcon } from "../components/Shell";
import { Lines, BLUE, type Line } from "../components/Plots";
import { useSecond } from "../components/Tables";
import { loadCoin, loadHouse, loadSeries } from "../lib/api";
import { ago, big, compact, dollars, usd, usdCompact } from "../lib/format";
import { usePoll } from "../lib/house";
import { PREVIEW } from "../lib/mode";
import { useStore } from "../lib/store";
import type { SeriesPoint } from "../lib/types";

const GREEN = "#087f57", RED = "#ce3045";
const RANGES = [["1h", 3600], ["6h", 21600], ["24h", 86400], ["All", Infinity]] as const;
const LOADERS = { house: loadHouse, coin: loadCoin, history: loadSeries };
type Source = keyof typeof LOADERS;

/** Keep existing samples visible through a failed refresh, with an explicit recovery path. */
function useStatsData() {
  const alive = useRef(true);
  const running = useRef(new Map<Source, Promise<void>>());
  const [loaded, setLoaded] = useState<Partial<Record<Source, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<Source, boolean>>>({});
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback((source: Source): Promise<void> => {
    const pending = running.current.get(source);
    if (pending) return pending;
    const request = LOADERS[source]().then(() => {
      if (!alive.current) return;
      setLoaded((prev) => ({ ...prev, [source]: true }));
      setErrors((prev) => ({ ...prev, [source]: false }));
    }).catch(() => {
      if (alive.current) setErrors((prev) => ({ ...prev, [source]: true }));
    }).finally(() => { running.current.delete(source); });
    running.current.set(source, request);
    return request;
  }, []);
  usePoll(() => load("house"), 4000);
  usePoll(() => load("coin"), 8000);
  usePoll(() => load("history"), 30000);
  const refresh = async () => {
    setRefreshing(true);
    await Promise.all((Object.keys(LOADERS) as Source[]).map(load));
    if (alive.current) setRefreshing(false);
  };
  return { loaded, errors, refreshing, refresh };
}

function line(name: string, color: string, samples: SeriesPoint[], pick: (p: SeriesPoint) => number | undefined, area = false): Line {
  return { name, color, area, points: samples.flatMap((p) => {
    const value = pick(p);
    return value !== undefined && Number.isFinite(value) ? [{ t: p.t, v: value }] : [];
  }) };
}

function StatChart({ title, value, lines, detail, empty, loaded, failed, className = "", count = false }: {
  title: string; value: string; lines: Line[]; detail: string; empty: string;
  loaded?: boolean; failed?: boolean; className?: string; count?: boolean;
}) {
  const hasHistory = lines.some((l) => l.points.length >= 2);
  const hasActivity = lines.some((l) => l.points.some((p) => p.v !== 0));
  const message = failed && !hasHistory ? "History is unavailable. Use Refresh to try again."
    : !loaded && !hasHistory ? "Loading exchange history…"
    : !hasHistory ? "Collecting samples. The chart fills in as the exchange runs."
    : !hasActivity ? empty : null;
  return <section className={`stats-chart ${className}`} aria-label={tx(title)}>
    <header><h3>{tx(title)}</h3><b>{value}</b></header>
    {lines.length > 1 && <div className="stats-legend">{lines.map((l) => <span key={l.name}><i style={{ background: l.color }} />{l.name}</span>)}</div>}
    <div className={`stats-plot ${message ? "is-empty" : ""}`} role="img" aria-label={tx("{0} history. {1}", [title, message ?? detail])}>
      {message ? <p>{message}</p> : <Lines lines={lines} format={count ? compact : dollars} labelColor="#4b5675" labelSize={11} lastValueVisible={false} />}
    </div>
    <p className="stats-chart-note">{tx(detail)}</p>
  </section>;
}

/** Tape activity: all-time totals, a shared history window and per-market books. */
export function Stats() {
  const { loaded, errors, refreshing, refresh } = useStatsData();
  const house = useStore((s) => s.house);
  const coin = useStore((s) => s.coin);
  const configMarkets = useStore((s) => s.config?.markets);
  const series = useStore((s) => s.series);
  const now = useSecond();
  const windowEnd = Math.floor(now / 30) * 30;
  const [seconds, setSeconds] = useState<number>(86400);
  const [marketId, setMarketId] = useState(-1);
  const markets = house?.markets ?? configMarkets ?? [];
  const market = markets.find((m) => m.id === marketId);
  const samples = useMemo(() => series.filter((p) => p.t >= windowEnd - seconds), [series, windowEnd, seconds]);
  const vol = market ? house?.totals.volumeByMarket[market.id] : house?.totals.volume;
  const volume = useMemo(() => [line(market?.symbol ?? "Total", BLUE, samples, (p) => market ? p.volm?.[market.id] : p.vol, true)], [market, samples]);
  const oi = useMemo(() => [
    line("Long", GREEN, samples, (p) => market ? p.oi[market.id]?.[0] : p.oi.reduce((sum, pair) => sum + pair[0], 0)),
    line("Short", RED, samples, (p) => market ? p.oi[market.id]?.[1] : p.oi.reduce((sum, pair) => sum + pair[1], 0)),
  ], [market, samples]);
  const openInterest = house?.markets.filter((m) => !market || m.id === market.id).reduce((sum, m) => sum + big(m.oiLong) + big(m.oiShort), 0n);
  const pnlDown = house !== null && big(house.totals.pnl) < 0n;
  const other = useMemo(() => ({
    pnl: [line("Trader PnL", pnlDown ? RED : GREEN, samples, (p) => p.pnl, true)],
    tvl: [line("TVL", BLUE, samples, (p) => p.tvl, true)],
    rewards: [line("Staker rewards", BLUE, samples, (p) => p.paid, true)],
    users: [line("Traders", BLUE, samples, (p) => p.users, true)],
  }), [samples, pnlDown]);
  const lastSample = series[series.length - 1]?.t;
  const failed = Object.values(errors).some(Boolean);
  const history = { loaded: loaded.history, failed: errors.history };

  return <div className="sheet stats-page">
    <Hero title={tx("Stats")} lede={tx("Totals since the exchange opened.")} actions={<span className="stats-mode">{PREVIEW ? tx("Practice activity") : tx("Exchange activity")}</span>} />
    {PREVIEW && <p className="stats-preview-note">{tx("Practice preview. These figures reflect activity saved in this browser.")}</p>}

    <dl className="stats-summary" aria-label={tx("Exchange totals and current TVL")}>
      {[
        { label: "Volume", value: house ? usdCompact(house.totals.volume) : "—", exact: house ? usd(house.totals.volume) : "Loading" },
        { label: "Liquidated volume", value: house ? usdCompact(house.totals.bustVolume) : "—", exact: house ? usd(house.totals.bustVolume) : "Loading" },
        { label: "Trades", value: house ? house.totals.trades.toLocaleString("en-US") : "—" },
        { label: "Traders", value: house ? house.totals.traders.toLocaleString("en-US") : "—" },
        { label: "Staker rewards", value: coin?.attached ? usdCompact(coin.stakingState.totalReceived) : "—", exact: coin?.attached ? usd(coin.stakingState.totalReceived) : "Coin not attached" },
        { label: "TVL", value: house ? usdCompact(house.house.treasury) : "—", exact: house ? usd(house.house.treasury) : "Loading" },
      ].map((f) => <div key={tx(f.label)}><dt>{tx(f.label)}</dt><dd title={f.exact}>{f.value}</dd></div>)}
    </dl>

    <div className="stats-toolbar">
      <div><h2>{tx("Exchange activity")}</h2><p>{tx("Charts show up to 24 hours of recorded history.")}</p></div>
      <div className="stats-controls">
        <label className="stats-market">{tx("Market")}<select value={marketId} onChange={(e) => setMarketId(Number(e.target.value))} aria-label={tx("Chart market")}><option value={-1}>{tx("All markets")}</option>{markets.map((m) => <option key={m.id} value={m.id}>{m.symbol}</option>)}</select></label>
        <div className="stats-range" role="group" aria-label={tx("Chart time range")}>{RANGES.map(([label, value]) => <button type="button" key={label} aria-pressed={seconds === value} onClick={() => setSeconds(value)}>{tx(label)}</button>)}</div>
        <button type="button" className="btn stats-refresh" onClick={refresh} disabled={refreshing}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1.7 7M20 4v6h-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>{refreshing ? tx("Refreshing…") : tx("Refresh")}</button>
      </div>
    </div>
    {failed && <div className="stats-warning" role="alert">{tx("Some stats could not refresh. Available values remain visible. Use Refresh to try again.")}</div>}

    <div className="stats-primary">
      <StatChart title={market ? tx("{0} volume", [market.symbol]) : tx("Total volume")} value={vol == null ? "—" : usdCompact(vol)} lines={volume} detail={tx("Cumulative traded notional in USDC.")} empty={tx("No trading volume recorded in this window yet.")} className="stats-volume" {...history} />
      <section className="stats-markets" aria-labelledby="stats-markets-title">
        <header><h3 id="stats-markets-title">{tx("By market")}</h3><span>{tx("All-time volume")}</span></header>
        <table><thead><tr><th scope="col">{tx("Market")}</th><th scope="col">{tx("Volume")}</th><th scope="col">{tx("Open interest")}</th></tr></thead><tbody>
          {markets.map((m) => <tr key={m.id} className={marketId === m.id ? "selected" : ""}>
            <th scope="row"><button type="button" onClick={() => setMarketId(m.id === marketId ? -1 : m.id)} aria-label={tx("Show {0} charts", [m.symbol])} aria-pressed={marketId === m.id}><AssetIcon symbol={m.symbol} size={20} />{m.symbol}</button></th>
            <td title={house?.totals.volumeByMarket[m.id] == null ? undefined : usd(house.totals.volumeByMarket[m.id])}>{house?.totals.volumeByMarket[m.id] == null ? "—" : usdCompact(house.totals.volumeByMarket[m.id])}</td>
            <td title={house ? usd(big(m.oiLong) + big(m.oiShort)) : undefined}>{house ? usdCompact(big(m.oiLong) + big(m.oiShort)) : "—"}</td>
          </tr>)}
        </tbody></table>
      </section>
    </div>

    <div className="stats-secondary">
      <StatChart title={market ? tx("{0} open interest", [market.symbol]) : tx("Open interest")} value={openInterest == null ? "—" : usdCompact(openInterest)} lines={oi} detail={tx("Open notional, split by long and short.")} empty={tx("No open interest recorded in this window.")} {...history} />
      <StatChart title={tx("Total trader PnL")} value={house ? usdCompact(house.totals.pnl) : "—"} lines={other.pnl} detail={tx("Cumulative realised trader profit and loss.")} empty={tx("Trader PnL is $0 throughout this window.")} {...history} />
    </div>
    <div className="stats-tertiary">
      <StatChart title={tx("TVL")} value={house ? usdCompact(house.house.treasury) : "—"} lines={other.tvl} detail={tx("USDC held across the exchange.")} empty={tx("TVL is $0 throughout this window.")} {...history} />
      <StatChart title={tx("Total staking rewards")} value={coin?.attached ? usdCompact(coin.stakingState.totalReceived) : "—"} lines={other.rewards} detail={tx("Cumulative USDC received by staking.")} empty={tx("No staking rewards recorded in this window yet.")} {...history} />
      <StatChart title={tx("Total users")} value={house ? house.totals.traders.toLocaleString("en-US") : "—"} lines={other.users} detail={tx("Traders recorded by the exchange.")} empty={tx("No traders recorded in this window yet.")} count {...history} />
    </div>
    <footer className="stats-foot"><span>{lastSample ? tx("Last chart sample {0} ago", [ago(lastSample, now)]) : tx("Waiting for the first chart sample")}</span><span>{tx("TVL and open interest are current; other headline figures are all-time. Market selection applies to volume and open interest.")}</span></footer>
  </div>;
}
