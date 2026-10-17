import { clockText, useJackpot } from "../lib/jackpot";
import { nameOf } from "../lib/names";
import { useEffect, useRef, useState } from "react";
import { Chart } from "../components/Chart";
import { PageTabs } from "../components/PageTabs";
import { MarketDataCredit } from "../components/MarketDataCredit";
import { AssetIcon, Link, tapeUsd } from "../components/Shell";
import { PositionStrips, TradesTable, useSecond } from "../components/Tables";
import { Ticket } from "../components/Ticket";
import { closeAll } from "../lib/actions";
import { loadHistory, loadHouse, loadPrices, loadStatus } from "../lib/api";
import { ago, big, percent, price, priceNumber, usd, usdCompact, usdNumber } from "../lib/format";
import { usePoll } from "../lib/house";
import { serverNow, setState, useStore } from "../lib/store";
import { pendingOpens } from "../lib/open-orders";
import type { Market, Status, TapeChip } from "../lib/types";
import { warmCandles } from "../lib/candles";
import { coinOf } from "../lib/hl";

// Tick and 15s draw the line of live prints. From a minute up the chart draws candles, with as
// much history as the reader scrolls back for.
const CANDLES_FROM = 60;
const STEPS: [string, number][] = [
  ["Tick", 0],
  ["15s", 15],
  ["1m", 60],
  ["5m", 300],
  ["15m", 900],
  ["1h", 3600],
  ["4h", 14400],
  ["1d", 86400],
];

/** A day of one market's price as a small line, the live price at its end. */
function Spark({ market }: { market: Market }) {
  const tick = useStore((s) => s.ticks[market.id]);
  const [past, setPast] = useState<number[]>([]);
  useEffect(() => {
    let live = true;
    loadPrices(market.id, 86400).then(
      ({ points }) => {
        if (!live) return;
        // The rail draws about sixty points. Reduce history once, rather than copying and
        // filtering a full day of prints every time a live price arrives.
        const every = Math.max(1, Math.floor(points.length / 60));
        setPast(points.filter((_, i) => i % every === 0 || i === points.length - 1).map((p) => Number(p.p) / 1e8));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [market.id]);
  const values = tick ? [...past, priceNumber(tick.p)] : past;
  if (values.length < 2) return <svg className="spark" viewBox="0 0 100 28" aria-hidden="true" />;
  const points = values;
  const low = Math.min(...points);
  const span = Math.max(...points) - low || 1;
  const d = points.map((v, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * 100).toFixed(2)},${(26 - ((v - low) / span) * 23).toFixed(2)}`).join("");
  return (
    <svg className={`spark ${points[points.length - 1] >= points[0] ? "up" : "down"}`} viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <path className="spark-fill" d={`${d}L100,28L0,28Z`} />
      <path className="spark-line" d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** One market in the rail: what it is, where it is, and its day. */
function MarketCard({ market, on }: { market: Market; on: boolean }) {
  const tick = useStore((s) => s.ticks[market.id]);
  const now = tick ? priceNumber(tick.p) : 0;
  const change = market.ref24h && now ? now / market.ref24h - 1 : null;
  return (
    <button className="mcard" aria-pressed={on} onPointerEnter={() => warmCandles([coinOf(market)])} onFocus={() => warmCandles([coinOf(market)])} onClick={() => setState({ marketId: market.id })}>
      <AssetIcon symbol={market.symbol} size={24} />
      <span className="mcard-name">
        <b>
          {market.symbol}
          <small>{market.maxLeverage}x</small>
        </b>
        <span>{nameOf(market.symbol)}</span>
      </span>
      <span className="mcard-num">
        <b>{tick ? price(tick.p) : "–"}</b>
        {change !== null ? <span className={change >= 0 ? "up" : "down"}>{percent(change, 2, true)}</span> : <span className="dim">–</span>}
      </span>
      {on && <Spark market={market} />}
    </button>
  );
}

/** The jackpot's pot and how long until it is drawn: a way into its page from the trade screen. */
function JackpotChip() {
  const jackpot = useJackpot();
  const now = useSecond();
  if (!jackpot) return null;
  return (
    <Link to="/jackpot" className="jp-chip">
      <span>Rekt Jackpot</span>
      <b>{usd(jackpot.prize)}</b>
      <small>draws in {clockText(jackpot.end - now)}</small>
    </Link>
  );
}

/** One line of the tape: a position opened, closed or liquidated, by anyone, as it happened. */
function Print({ chip, symbol, now }: { chip: TapeChip; symbol: string; now: number }) {
  const opened = chip.type === "open";
  const pnl = opened ? 0 : usdNumber(chip.pnl);
  const tone = opened ? (chip.isLong ? "up" : "down") : chip.busted ? "bust" : pnl >= 0 ? "up" : "down";
  const what = opened ? (chip.isLong ? "Long" : "Short") : chip.busted ? "Liquidated" : pnl >= 0 ? "Win" : "Loss";
  return (
    <li className={`print ${tone}`}>
      <AssetIcon symbol={symbol} size={14} />
      <span className="print-k">{what}</span>
      <span className="print-v">{opened ? tapeUsd(usdNumber(chip.notional), false) : tapeUsd(pnl, true)}</span>
      <span className="print-t">{now - chip.time < 60 ? `${Math.max(0, now - chip.time)}s` : ago(chip.time, now)}</span>
    </li>
  );
}

function Prints() {
  const tape = useStore((s) => s.tape);
  const markets = useStore((s) => s.config?.markets);
  const now = useSecond();
  return (
    <section className="prints" aria-label="Latest trades">
      <header className="rail-head">
        <span>Live trades</span>
      </header>
      {tape.length ? (
        <ol className="prints-list">
          {tape.slice(0, 40).map((chip) => (
            <Print key={`${chip.type}${chip.id}${chip.time}`} chip={chip} symbol={markets?.[chip.market]?.symbol ?? "BTC"} now={now} />
          ))}
        </ol>
      ) : (
        <p className="empty">No trades yet. Yours will show here.</p>
      )}
    </section>
  );
}

/** How the chart is drawn: a line of prints or candles, and how wide one step is. */
function ChartControls({ market, step, setStep }: { market: Market; step: number; setStep: (seconds: number) => void }) {
  const tick = useStore((s) => s.ticks[market.id]);
  const now = useSecond();
  const live = tick !== undefined && now - tick.t <= 6;
  const candles = step >= CANDLES_FROM;
  // Each kind comes back at the step it was last looked at.
  const lastLine = useRef(0);
  const lastCandles = useRef(CANDLES_FROM);
  if (candles) lastCandles.current = step;
  else lastLine.current = step;
  return (
    <span className="seg chart-pill">
      <button aria-pressed={!candles} onClick={() => setStep(lastLine.current)} title="Every price as it prints">
        Line
      </button>
      <button aria-pressed={candles} onClick={() => setStep(lastCandles.current)} title="Open, high, low and close of each step">
        Candles
      </button>
      <select aria-label="Chart step" value={step} onChange={(e) => setStep(Number(e.target.value))}>
        {STEPS.map(([label, seconds]) => (
          <option key={label} value={seconds}>
            {label}
          </option>
        ))}
      </select>
      <span className={`live ${live ? "" : "off"}`} title={live ? "Prices are arriving" : "Waiting for the next price"}>
        <i />
        {live ? "Live" : "Waiting"}
      </span>
    </span>
  );
}

/** The board over the chart: the price as big as a ticker board, the day, and who is crowding which side. */
function Board({ market }: { market: Market }) {
  const tick = useStore((s) => s.ticks[market.id]);
  const house = useStore((s) => s.house);
  const info = house?.markets[market.id];
  const now = tick ? priceNumber(tick.p) : 0;
  const change = market.ref24h && now ? now / market.ref24h - 1 : null;
  const long = Number(big(info?.oiLong));
  const short = Number(big(info?.oiShort));
  const longShare = long + short > 0 ? long / (long + short) : 0.5;
  return (
    <header className="board">
      <div className="board-price">
        <span className="board-sym">
          <AssetIcon symbol={market.symbol} size={24} />
          {market.symbol}
          <span className="dim">/USD</span>
        </span>
        <span className="board-px">{tick ? price(tick.p) : "–"}</span>
        {change !== null && <span className={`board-chg ${change >= 0 ? "up" : "down"}`}>{percent(change, 2, true)}</span>}
      </div>
      <div className="board-stats hide-narrow">
        <span className="board-stat">
          <small>Tape volume 24h</small>
          <b>{house ? usdCompact(house.totals.volume24hByMarket[market.id]) : "–"}</b>
        </span>
        <span className="board-stat board-oi" title="Open positions on each side. Past the market's depth, a crowded side keeps less of a small win.">
          <small>
            <span className="up">Long {info ? usdCompact(info.oiLong) : "–"}</span>
            <span className="down">Short {info ? usdCompact(info.oiShort) : "–"}</span>
          </small>
          <span className="oi-bar">
            <i style={{ width: `${(longShare * 100).toFixed(1)}%` }} />
          </span>
        </span>
      </div>
    </header>
  );
}

function StatusTab() {
  const [status, setStatus] = useState<Status | null>(null);
  const config = useStore((s) => s.config);
  const now = useSecond();
  usePoll(() => loadStatus().then(setStatus), 5_000);
  if (!status || !config) return <div className="empty">Checking.</div>;
  return (
    <div className="panel-body" style={{ maxWidth: 520, paddingTop: 12 }}>
      {status.feeds.map((feed) => (
        <div className="kv" key={feed.market}>
          <span>{feed.symbol} price feed</span>
          <span>
            <i className={`dot ${feed.time && now - feed.time <= 6 ? "" : "bad"}`} /> {feed.time ? `${ago(feed.time, now)} ago` : "no price yet"}
          </span>
        </div>
      ))}
      <div className="kv">
        <span>Prices from</span>
        <span>
          {status.source === "hyperliquid"
            ? "Hyperliquid"
            : status.source === "hermes"
              ? "Pyth"
              : status.source === "preview"
                ? "Hyperliquid (preview)"
                : "simulated (local test)"}
        </span>
      </div>
      <div className="kv">
        <span>New positions</span>
        <span className={status.opensPaused ? "warn" : ""}>{status.opensPaused ? "Paused" : "Open"}</span>
      </div>
      <div className="kv">
        <span>Fill delay</span>
        <span>{config.timing.execDelay === 0 ? "Next fresh price · no fixed wait" : `${config.timing.execDelay}s after you click`}</span>
      </div>
      {status.chainId !== 0 && (
        <div className="kv">
          <span>Indexed to block</span>
          <span>#{Number(status.block).toLocaleString("en-US")}</span>
        </div>
      )}
    </div>
  );
}

export function Trade() {
  const markets = useStore((s) => s.config!.markets);
  const marketId = useStore((s) => s.marketId);
  const owner = useStore((s) => s.owner);
  const offline = useStore((s) => s.offline);
  const trades = useStore((s) => s.history.trades);
  const open = useStore((s) => s.account?.positions.filter((p) => p.status === "open").length ?? 0);
  const positionCount = useStore(s => s.account?.positions.length ?? 0);
  const pendingCount = useStore(s => pendingOpens(s, serverNow()).length);
  const [step, setStep] = useState(0);
  const [tab, setTab] = useState<"positions" | "history" | "status">("positions");
  const market = markets[marketId] ?? markets[0];
  // Close All sends one close per position; a second click while they are going out sends nothing.
  // The lock is a ref as well as state: both clicks of a double click run before React redraws.
  const [closingAll, setClosingAll] = useState(false);
  const closingAllNow = useRef(false);

  usePoll(loadHouse, 6_000);
  usePoll(loadHistory, 30_000, [owner]);

  return (
    <div className="tt">
      <aside className="tt-rail" aria-label="Markets">
        <header className="rail-head">
          <span>Markets</span>
          <span className="dim">USDC, up to {Math.max(...markets.map((m) => m.maxLeverage))}x</span>
        </header>
        <div className="mcards">
          {markets
            .filter((m) => !m.retired)
            .map((m) => (
              <MarketCard key={m.id} market={m} on={m.id === market.id} />
            ))}
        </div>
        <JackpotChip />
        <Prints />
      </aside>

      <section className="tt-chart" aria-label={`${market.symbol} price`}>
        <Board market={market} />
        <div className="chart-wrap">
          <div className="chart-tools">
            <ChartControls market={market} step={step} setStep={setStep} />
          </div>
          <Chart key={`${market.id}:${step}`} marketId={market.id} interval={step} />
          <MarketDataCredit className="chart-data-credit" />
        </div>
      </section>

      <Ticket market={market} onOrder={() => setTab("positions")} />

      <section className="tt-book" aria-label="Your positions">
        <div className="tt-book-head">
          <PageTabs id="trade-tabs" label="Trading account" value={tab} onChange={setTab} tabs={(["positions", "history", "status"] as const).map((id) => ({ id, label: <>{id[0].toUpperCase() + id.slice(1)}{id === "positions" && owner ? <><span className="count">{positionCount}</span>{pendingCount > 0 && <span className="count pending-count">{pendingCount} pending</span>}</> : null}</> }))} />
          <button
            className="btn small"
            disabled={open === 0 || closingAll || Boolean(offline)}
            onClick={async () => {
              if (closingAllNow.current) return;
              closingAllNow.current = true;
              setClosingAll(true);
              await closeAll();
              // The closes are on their way; keep the button quiet until they show as closing.
              setTimeout(() => {
                closingAllNow.current = false;
                setClosingAll(false);
              }, 1500);
            }}
          >
            Close all
          </button>
        </div>
        <div id="trade-tabs-panel" role="tabpanel" aria-labelledby={`trade-tabs-${tab}`} tabIndex={0}>
        {tab === "positions" && <PositionStrips />}
        {tab === "history" && (owner ? <TradesTable trades={trades.slice(0, 50)} /> : <div className="empty">Connect a wallet to view your history.</div>)}
        {tab === "status" && <StatusTab />}
        </div>
      </section>
    </div>
  );
}
