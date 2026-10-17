// The panels the House, coin, Stats and Dashboard pages are assembled from. Each reads what it
// needs from the store; the page (or the dashboard) only decides where it goes.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { loadCoin, loadHouse, loadPrices, loadSeries, onTick } from "../lib/api";
import { big, coinFull, compact, dollars, usd, usdCompact, usdNumber } from "../lib/format";
import { bustBins, housePnlCurve, openHousePnl, toPos, topologyDots, usePoll, type Pos } from "../lib/house";
import { getState, useStore } from "../lib/store";
import type { SeriesPoint } from "../lib/types";
import { AssetIcon } from "./Shell";
import { Bars, GREEN, GREY, Heatmap, Lines, PnlCurve, QueueRing, RED, RewardCurve, Topology, INK, BLUE, type Line } from "./Plots";

const MARKET_COLORS = [BLUE, "#b34800", "#0a1638", "#7354aa", "#006f8c", "#496699", "#986000", "#6c5670", "#3d7452", "#63589f"];

/** Lets the dashboard put a grip and a close button on any panel, and place it. */
export const Chrome = createContext<{ before?: ReactNode; after?: ReactNode; className?: string; style?: CSSProperties; props?: Record<string, unknown> } | null>(null);

export function Panel({ title, sub, tools, area, chart = false, children }: { title: ReactNode; sub?: ReactNode; tools?: ReactNode; area?: string; chart?: boolean; children: ReactNode }) {
  const chrome = useContext(Chrome);
  return (
    <section
      className={`panel ${chart ? "chart-panel" : ""} ${chrome?.className ?? ""}`}
      style={{ ...(area && !chrome ? { gridArea: area } : null), ...chrome?.style }}
      {...chrome?.props}
    >
      <div className="panel-head">
        {chrome?.before}
        <h2 className="title">{title}</h2>
        {sub && <span className="sub">{sub}</span>}
        <div className="tools">
          {tools}
          {chrome?.after}
        </div>
      </div>
      {children}
    </section>
  );
}

/** Keeps the house, the coin and the day of samples fresh while a page that shows them is open. */
export function useExchangeData() {
  const alive = useRef(true);
  const running = useRef(new Map<string, Promise<void>>());
  const [errors, setErrors] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const request = useCallback((name: string, load: () => Promise<void>) => {
    const pending = running.current.get(name);
    if (pending) return pending;
    const result = load().then(() => {
      if (alive.current) setErrors((last) => last.filter((label) => label !== name));
    }).catch(() => {
      if (alive.current) setErrors((last) => last.includes(name) ? last : [...last, name]);
    }).finally(() => { running.current.delete(name); });
    running.current.set(name, result);
    return result;
  }, []);
  usePoll(() => request("vault data", loadHouse), 4_000);
  usePoll(() => request("coin status", loadCoin), 8_000);
  usePoll(() => request("chart history", loadSeries), 30_000);
  const retry = async () => {
    setRefreshing(true);
    await Promise.allSettled([request("vault data", loadHouse), request("coin status", loadCoin), request("chart history", loadSeries)]);
    if (alive.current) setRefreshing(false);
  };
  return { errors, refreshing, retry };
}

export function ExchangeDataNotice({ data }: { data: ReturnType<typeof useExchangeData> }) {
  if (!data.errors.length) return null;
  return <div className="page-feedback" role="alert"><span>Couldn’t refresh {data.errors.join(", ")}. Showing the last available data where possible.</span><button className="btn small" disabled={data.refreshing} onClick={() => void data.retry()}>{data.refreshing ? "Refreshing…" : "Retry"}</button></div>;
}

/** Current prices as plain numbers, refreshed once a second: often enough for a picture. */
function usePrices(): (number | undefined)[] {
  const read = () => {
    const { ticks, config } = getState();
    return (config?.markets ?? []).map((m) => (ticks[m.id] ? Number(ticks[m.id].p) / 1e8 : undefined));
  };
  const [prices, setPrices] = useState(read);
  useEffect(() => {
    const timer = setInterval(() => setPrices(read()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return prices;
}

function usePositions(): Pos[] {
  const raw = useStore((s) => s.house?.positions);
  return useMemo(() => (raw ?? []).map(toPos), [raw]);
}

// "All" is everything on record, which is at most the last day of samples.
const RANGES: [string, number][] = [
  ["1h", 3_600],
  ["6h", 21_600],
  ["1d", 86_400],
  ["All", 10 * 365 * 86_400],
];

function useRange(): [SeriesPoint[], ReactNode] {
  const [seconds, setSeconds] = useState(86_400);
  const series = useStore((s) => s.series);
  const window = useMemo(() => {
    const since = (series[series.length - 1]?.t ?? 0) - seconds;
    return series.filter((p) => p.t >= since);
  }, [series, seconds]);
  const control = (
    <>
      <select aria-label="Time range" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
        {RANGES.map(([label, value]) => (
          <option key={label} value={value}>
            {label}
          </option>
        ))}
      </select>
      <span className="live">Live</span>
    </>
  );
  return [window, control];
}

function useMarket(): [number, ReactNode] {
  const markets = useStore((s) => s.config?.markets) ?? [];
  const [id, setId] = useState(0);
  const selected = markets.find((market) => market.id === id);
  return [
    id,
    <span key="market" className="panel-market-picker">
    {selected && <AssetIcon symbol={selected.symbol} size={18} />}
    <select aria-label="Market" value={id} onChange={(e) => setId(Number(e.target.value))}>
      {markets.map((m) => (
        <option key={m.id} value={m.id}>
          {m.symbol}
        </option>
      ))}
    </select>
    </span>,
  ];
}

const line = (name: string, color: string, points: SeriesPoint[], pick: (p: SeriesPoint) => number | undefined, area = false): Line => ({
  name,
  color,
  area,
  points: points.map((p) => ({ t: p.t, v: pick(p) ?? 0 })),
});

const last = <T,>(list: T[]): T | undefined => list[list.length - 1];

// ---------------------------------------------------------------------------------------------
// The house
// ---------------------------------------------------------------------------------------------

export function UserPositions({ area }: { area?: string }) {
  const house = useStore((s) => s.house);
  const markets = house?.markets ?? [];
  let long = 0n;
  let short = 0n;
  for (const m of markets) {
    long += big(m.oiLong);
    short += big(m.oiShort);
  }
  const net = (a: bigint, b: bigint) => usdCompact(a > b ? a - b : b - a);
  return (
    <Panel title="Open positions" area={area}>
      <div className="panel-body">
        <div className="kv">
          <span>Open interest</span>
          <span>{house ? usd(long + short) : "–"}</span>
        </div>
        <div className="kv">
          <span>Open margin</span>
          <span>{house ? usd(house.totals.openMargin) : "–"}</span>
        </div>
        <div className="kv">
          <span>Open positions</span>
          <span>{house ? house.totals.openPositions.toLocaleString("en-US") : "–"}</span>
        </div>
        <table className="oi-table">
          <thead>
            <tr>
              <th />
              <th>Long</th>
              <th>Short</th>
              <th>Net</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => (
              <tr key={m.id}>
                <td><span className="panel-market-label"><AssetIcon symbol={m.symbol} size={18} />{m.symbol}</span></td>
                <td>{usdCompact(m.oiLong)}</td>
                <td>{usdCompact(m.oiShort)}</td>
                <td>{net(big(m.oiLong), big(m.oiShort))}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Total</td>
              <td>{usdCompact(long)}</td>
              <td>{usdCompact(short)}</td>
              <td>{net(long, short)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** The house's books, marked to the current prices. */
export function useHouseFigures() {
  const house = useStore((s) => s.house);
  const positions = usePositions();
  const prices = usePrices();
  const openPnl = house ? openHousePnl(positions, prices, house.markets) : 0;
  const balance = house ? Number(house.house.equity) / 1e6 : 0;
  return { house, openPnl, balance, funds: balance + openPnl };
}

export function HouseStats({ area }: { area?: string }) {
  const { house, openPnl, balance, funds } = useHouseFigures();
  const tone = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");
  return (
    <Panel title="Stats" area={area}>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column" }}>
        <div className="kv lead">
          <span title="What the vault is worth right now: its balance plus what it is up or down on open positions.">Vault value</span>
          <span className={tone(funds)}>{house ? dollarsFull(funds) : "–"}</span>
        </div>
        <div className="kv rule">
          <span title="Cash the vault holds, less what it owes queued winners.">Vault cash</span>
          <span>{house ? dollarsFull(balance) : "–"}</span>
        </div>
        <div className="kv">
          <span title="The vault's result if every open position closed at this instant.">Vault open PnL</span>
          <span className={tone(openPnl)}>{house ? dollarsFull(openPnl) : "–"}</span>
        </div>
        <div className="kv">
          <span title="Winnings owed to traders and not yet paid.">Queued wins</span>
          <span className={house && big(house.house.totalQueued) > 0n ? "warn" : ""}>{house ? usd(house.house.totalQueued) : "–"}</span>
        </div>
        <div className="spacer" style={{ minHeight: 18 }} />
        <div className="kv">
          <span title="All the USDC the exchange holds: balances, margin and the vault.">TVL</span>
          <span>{house ? usdCompact(house.house.treasury) : "–"}</span>
        </div>
        <div className="kv">
          <span>Volume</span>
          <span>{house ? usdCompact(house.totals.volume) : "–"}</span>
        </div>
      </div>
    </Panel>
  );
}

const dollarsFull = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function CoinCard({ area }: { area?: string }) {
  const coin = useStore((s) => s.coin);
  if (!coin?.attached) {
    return (
      <Panel title="Coin" area={area}>
        <div className="panel-body dim">No coin is attached to this exchange yet.</div>
      </Panel>
    );
  }
  return (
    <Panel title={coin.symbol} area={area}>
      <div className="panel-body">
        <div className="kv">
          <span title="Paid out to losing traders so far.">{coin.symbol} mined</span>
          <span>{coinFull(coin.mining.mined)}</span>
        </div>
        <div className="kv">
          <span>{coin.symbol} staked</span>
          <span>{coinFull(coin.stakingState.totalStaked)}</span>
        </div>
        <div className="kv">
          <span>Staker rewards</span>
          <span>{usd(coin.stakingState.totalReceived)}</span>
        </div>
        <div className="kv">
          <span>Reward token and rate</span>
          <span>USDC / {coin.rewardRate}%</span>
        </div>
      </div>
    </Panel>
  );
}

export function HouseFunds({ area }: { area?: string }) {
  const [window, range] = useRange();
  const { funds, house } = useHouseFigures();
  const lines = useMemo(() => [line("Vault value", BLUE, window, (p) => p.eq, true)], [window]);
  return (
    <Panel
      area={area}
      chart
      title={
        <span className="seg">
          <span className="label">Vault value</span>
          <span>{house ? dollarsFull(funds) : "–"}</span>
        </span>
      }
      tools={<span className="seg">{range}</span>}
    >
      <div className="fill">
        <Lines lines={lines} />
      </div>
    </Panel>
  );
}

export function Exposure({ area }: { area?: string }) {
  const [market, marketSelect] = useMarket();
  const [window, range] = useRange();
  const symbol = useStore((s) => s.config?.markets[market]?.symbol) ?? "";
  const lines = useMemo(
    () => [line(`${symbol} Long`, GREEN, window, (p) => p.oi[market]?.[0]), line(`${symbol} Short`, RED, window, (p) => p.oi[market]?.[1])],
    [window, market, symbol],
  );
  const now = last(window);
  return (
    <Panel
      area={area}
      chart
      title="Exposure"
      tools={
        <>
          <span className="seg">{marketSelect}</span>
          <span className="seg">{range}</span>
        </>
      }
    >
      <div className="legend">
        <span style={{ color: GREEN }}>
          <span className="panel-market-label"><i />{symbol && <AssetIcon symbol={symbol} size={17} />}{symbol} Long</span>
          <b>{dollarsFull(now?.oi[market]?.[0] ?? 0)}</b>
        </span>
        <span style={{ color: RED }}>
          <span className="panel-market-label"><i />{symbol && <AssetIcon symbol={symbol} size={17} />}{symbol} Short</span>
          <b>{dollarsFull(now?.oi[market]?.[1] ?? 0)}</b>
        </span>
      </div>
      <div className="fill">
        <Lines lines={lines} />
      </div>
    </Panel>
  );
}

const SPANS: [string, number][] = [
  ["±0.25%", 0.0025],
  ["±1%", 0.01],
  ["±5%", 0.05],
];

export function LiquidationHeatmap({ area }: { area?: string }) {
  const [market, marketSelect] = useMarket();
  const [span, setSpan] = useState(0.01);
  const positions = usePositions();
  const prices = usePrices();
  const path = useRef<{ t: number; p: number }[]>([]);
  const [, redraw] = useState(0);

  useEffect(() => {
    let alive = true;
    path.current = [];
    loadPrices(market, 1_800)
      .then(({ points }) => {
        if (alive) path.current = [...points.map((pt) => ({ t: pt.t, p: Number(pt.p) / 1e8 })), ...path.current];
        redraw((n) => n + 1);
      })
      .catch(() => {});
    const off = onTick((m, tick) => {
      if (m !== market) return;
      const tail = last(path.current);
      if (tail && tail.t === tick.t) tail.p = Number(tick.p) / 1e8;
      else path.current.push({ t: tick.t, p: Number(tick.p) / 1e8 });
      if (path.current.length > 2_400) path.current.splice(0, 400);
    });
    return () => {
      alive = false;
      off();
    };
  }, [market]);

  const price = prices[market] ?? 0;
  const top = price * (1 + span);
  const bottom = price * (1 - span);
  const bins = useMemo(() => bustBins(positions, market, top, bottom, 48), [positions, market, top, bottom]);
  const peak = Math.max(...bins, 0);
  return (
    <Panel
      area={area}
      chart
      title="Liquidation map"
      tools={
        <>
          <span className="seg">{marketSelect}</span>
          <span className="seg">
            <select aria-label="Price range" value={span} onChange={(e) => setSpan(Number(e.target.value))}>
              {SPANS.map(([label, value]) => (
                <option key={label} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </span>
          <span className="sub hide-narrow" title="Notional that would be liquidated in the brightest band">
            $0 <i style={{ display: "inline-block", width: 70, height: 6, verticalAlign: "middle", background: `linear-gradient(90deg, rgba(11,158,107,.15), ${GREEN}, ${BLUE})` }} /> {dollars(peak)}
          </span>
        </>
      }
    >
      <div className="fill">{price > 0 ? <Heatmap bins={bins} top={top} bottom={bottom} path={path.current} last={price} /> : <div className="plot empty">Waiting for a price.</div>}</div>
    </Panel>
  );
}

export function HousePnl({ area }: { area?: string }) {
  const [market, marketSelect] = useMarket();
  const positions = usePositions();
  const prices = usePrices();
  const info = useStore((s) => s.house?.markets[market]);
  const price = prices[market] ?? 0;
  const points = useMemo(() => (info && price > 0 ? housePnlCurve(positions, market, price, info) : []), [positions, market, price, info]);
  return (
    <Panel area={area} chart title="Vault PnL on a 1% move" tools={<span className="seg">{marketSelect}</span>}>
      <div className="fill">
        <PnlCurve points={points} range={0.01} priceLabel={price ? `$${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : ""} />
      </div>
    </Panel>
  );
}

export function PositionTopology({ area }: { area?: string }) {
  const positions = usePositions();
  const prices = usePrices();
  const markets = useStore((s) => s.house?.markets);
  const dots = useMemo(() => (markets ? topologyDots(positions, prices, markets) : []), [positions, prices, markets]);
  return (
    <Panel area={area} chart title="Position map">
      <div className="fill">
        <Topology dots={dots} />
      </div>
    </Panel>
  );
}

export function QueueStats({ area }: { area?: string }) {
  const house = useStore((s) => s.house);
  const stats = house?.queueStats;
  const none = <span className="dim">None</span>;
  return (
    <Panel title="Payout queue" area={area}>
      <div className="panel-body">
        <div className="kv">
          <span title="Winnings owed to traders and not yet paid.">Queued wins</span>
          <span>{house ? usd(house.house.totalQueued) : "–"}</span>
        </div>
        <div className="kv">
          <span>Entries in the queue</span>
          <span>{stats ? stats.entries.toLocaleString("en-US") : "–"}</span>
        </div>
        <div className="kv">
          <span>Largest entry</span>
          <span>{stats && big(stats.largest) > 0n ? usd(stats.largest) : none}</span>
        </div>
        <div className="kv">
          <span title="The payout at the front of the line: the next one the vault pays.">Paid next</span>
          <span>{stats && big(stats.front) > 0n ? usd(stats.front) : none}</span>
        </div>
        <p className="note" style={{ marginTop: 12 }}>
          When the vault cannot pay a win in full, the rest waits here. It is paid strictly in order as losses come in. Your margin is never queued.
        </p>
      </div>
    </Panel>
  );
}

export function QueuePlacement({ area }: { area?: string }) {
  const owner = useStore((s) => s.owner);
  const account = useStore((s) => s.account);
  const total = usdNumber(useStore((s) => s.house?.house.totalQueued));
  const mine = usdNumber(account?.queued);
  const ahead = account?.queueAhead ? usdNumber(account.queueAhead) : mine > 0 ? 0 : total;
  const behind = Math.max(0, total - ahead - mine);
  const caption = !owner ? "Connect a wallet to see your entries" : mine > 0 ? `${dollars(mine)} of it is yours, ${dollars(ahead)} is ahead of you` : "None of it is yours";
  return (
    <Panel area={area} chart title="Queue placement">
      <div className="fill">
        <QueueRing ahead={ahead} mine={mine} behind={behind} caption={caption} />
      </div>
    </Panel>
  );
}

export function QueueDebt({ area }: { area?: string }) {
  const [window, range] = useRange();
  const queued = useStore((s) => s.house?.house.totalQueued);
  const lines = useMemo(() => [line("Queued wins", BLUE, window, (p) => p.q, true)], [window]);
  return (
    <Panel
      area={area}
      chart
      title={
        <>
          Queued wins <span style={{ fontWeight: 500, marginLeft: 8 }}>{usdCompact(queued)}</span>
        </>
      }
      tools={<span className="seg">{range}</span>}
    >
      <div className="fill">
        <Lines lines={lines} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// The coin
// ---------------------------------------------------------------------------------------------

export function StakingRevenue({ area }: { area?: string }) {
  const series = useStore((s) => s.series);
  const [bucket, setBucket] = useState(3_600);
  // The samples carry a running total; a bar is how much it grew within its bucket.
  const bars = useMemo(() => {
    const out = new Map<number, number>();
    for (let i = 1; i < series.length; i++) {
      const slot = Math.floor(series[i].t / bucket) * bucket;
      out.set(slot, (out.get(slot) ?? 0) + Math.max(0, series[i].paid - series[i - 1].paid));
    }
    return [...out].map(([t, v]) => ({ t, v }));
  }, [series, bucket]);
  return (
    <Panel
      area={area}
      chart
      title="Staking revenue"
      tools={
        <span className="seg">
          <select aria-label="Bar width" value={bucket} onChange={(e) => setBucket(Number(e.target.value))}>
            <option value={600}>10m</option>
            <option value={3_600}>1h</option>
            <option value={14_400}>4h</option>
          </select>
          <span className="live">Live</span>
        </span>
      }
    >
      <div className="fill">{bars.length ? <Bars bars={bars} /> : <div className="plot empty">No rewards have been paid in this window yet.</div>}</div>
    </Panel>
  );
}

export function RewardCurvePanel({ area }: { area?: string }) {
  const coin = useStore((s) => s.coin);
  return (
    <Panel area={area} chart title={`${coin?.symbol ?? "Coin"} reward curve`} sub={`${coin?.symbol ?? "Coin"} paid per $1 of realised loss`}>
      <div className="fill">
        {coin?.attached && (
          <RewardCurve
            perDollar={Number(big(coin.mining.perDollar)) / 1e18}
            lossNow={usdNumber(coin.mining.cumulativeLossUsd)}
            scale={usdNumber(coin.mining.scaleUsd)}
            symbol={coin.symbol}
          />
        )}
      </div>
    </Panel>
  );
}

export function CoinSupply({ area }: { area?: string }) {
  const [window, range] = useRange();
  const symbol = useStore((s) => s.coin?.symbol) ?? "Coin";
  const lines = useMemo(() => [line("Mined", INK, window, (p) => p.mined), line("Staked", "#f7931a", window, (p) => p.staked)], [window]);
  return (
    <Panel area={area} chart title={`${symbol} mined and staked`} tools={<span className="seg">{range}</span>}>
      <div className="legend">
        <span style={{ color: INK }}>
          <i />
          Mined
        </span>
        <span style={{ color: "#f7931a" }}>
          <i />
          Staked
        </span>
      </div>
      <div className="fill">
        <Lines lines={lines} format={compact} />
      </div>
    </Panel>
  );
}

export function StakingRewards({ area }: { area?: string }) {
  const [window, range] = useRange();
  const lines = useMemo(() => [line("Staking rewards", GREEN, window, (p) => p.paid, true)], [window]);
  return (
    <Panel area={area} chart title="Total staking rewards" tools={<span className="seg">{range}</span>}>
      <div className="fill">
        <Lines lines={lines} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

function MarketLegend({ total = false }: { total?: boolean }) {
  const markets = useStore((s) => s.config?.markets) ?? [];
  return (
    <div className="legend">
      {total && (
        <span style={{ color: GREY }}>
          <i />
          Total
        </span>
      )}
      {markets.map((m) => (
        <span key={m.id} className="panel-market-label" style={{ color: MARKET_COLORS[m.id % MARKET_COLORS.length] }}>
          <i />
          <AssetIcon symbol={m.symbol} size={17} />
          {m.symbol}
        </span>
      ))}
    </div>
  );
}

export function OpenInterest({ area }: { area?: string }) {
  const [window, range] = useRange();
  const markets = useStore((s) => s.config?.markets) ?? [];
  const lines = useMemo(
    () => markets.map((m) => line(m.symbol, MARKET_COLORS[m.id % MARKET_COLORS.length], window, (p) => (p.oi[m.id]?.[0] ?? 0) + (p.oi[m.id]?.[1] ?? 0))),
    [window, markets],
  );
  return (
    <Panel area={area} chart title="Open interest" tools={<span className="seg">{range}</span>}>
      <MarketLegend />
      <div className="fill">
        <Lines lines={lines} />
      </div>
    </Panel>
  );
}

export function TotalVolume({ area }: { area?: string }) {
  const [window, range] = useRange();
  const markets = useStore((s) => s.config?.markets) ?? [];
  const lines = useMemo(
    () => [line("Total", GREY, window, (p) => p.vol), ...markets.map((m) => line(m.symbol, MARKET_COLORS[m.id % MARKET_COLORS.length], window, (p) => p.volm?.[m.id]))],
    [window, markets],
  );
  return (
    <Panel area={area} chart title="Total volume" tools={<span className="seg">{range}</span>}>
      <MarketLegend total />
      <div className="fill">
        <Lines lines={lines} />
      </div>
    </Panel>
  );
}

export function TraderPnl({ area }: { area?: string }) {
  const [window, range] = useRange();
  const down = (last(window)?.pnl ?? 0) < 0;
  const lines = useMemo(() => [line("Traders", down ? RED : GREEN, window, (p) => p.pnl, true)], [window, down]);
  return (
    <Panel area={area} chart title="Total trader PnL" tools={<span className="seg">{range}</span>}>
      <div className="fill">
        <Lines lines={lines} />
      </div>
    </Panel>
  );
}

export function Tvl({ area }: { area?: string }) {
  const [window, range] = useRange();
  const lines = useMemo(() => [line("TVL", BLUE, window, (p) => p.tvl, true)], [window]);
  return (
    <Panel area={area} chart title="TVL" tools={<span className="seg">{range}</span>}>
      <div className="fill">
        <Lines lines={lines} />
      </div>
    </Panel>
  );
}

export function TotalUsers({ area }: { area?: string }) {
  const [window, range] = useRange();
  const lines = useMemo(() => [line("Users", BLUE, window, (p) => p.users, true)], [window]);
  return (
    <Panel area={area} chart title="Total users" tools={<span className="seg">{range}</span>}>
      <div className="fill">
        <Lines lines={lines} format={compact} />
      </div>
    </Panel>
  );
}

/** The six headline figures of the Stats page. */
export function StatTiles() {
  const house = useStore((s) => s.house);
  const coin = useStore((s) => s.coin);
  const tiles: [string, string][] = [
    ["Volume", house ? usdCompact(house.totals.volume) : "–"],
    ["Liq. volume", house ? usdCompact(house.totals.bustVolume) : "–"],
    ["Trades", house ? house.totals.trades.toLocaleString("en-US") : "–"],
    ["Users", house ? house.totals.traders.toLocaleString("en-US") : "–"],
    ["Rewards", coin?.attached ? usdCompact(coin.stakingState.totalReceived) : "–"],
    ["TVL", house ? usdCompact(house.house.treasury) : "–"],
  ];
  return (
    <div className="cells tiles">
      {tiles.map(([label, value]) => (
        <div className="tile" key={label}>
          <span className="title">{label}</span>
          <b>{value}</b>
        </div>
      ))}
    </div>
  );
}

