import { tx, Localized } from "../lib/i18n";
import { useMemo, useState, type ReactNode } from "react";
import { quoteClose } from "@shared/math.mjs";
import { Hero } from "../components/Hero";
import { PageSection } from "../components/PageSection";
import { PageTabs } from "../components/PageTabs";
import { Link } from "../components/Shell";
import { Panel } from "../components/Panels";
import { GREEN, Lines, RED } from "../components/Plots";
import { EmissionsTable, PositionsTable, QueueHistoryTable, QueueOpenTable, StakingTable, TradesTable, TransfersTable } from "../components/Tables";
import { closeAll } from "../lib/actions";
import { loadHistory } from "../lib/api";
import { big, coin as coinText, usd, usdNumber, usdDown } from "../lib/format";
import { usePoll } from "../lib/house";
import { PREVIEW } from "../lib/mode";
import { navigate, serverNow, setState, useStore } from "../lib/store";
import { filterTrades, tradesCsv, type TradeResult } from "../lib/trade-history";

const PER_PAGE = 25;

const TAB_IDS = ["positions", "history", "cashflow", "staking", "queueOpen", "queueHistory", "emissions"] as const;
type TabId = (typeof TAB_IDS)[number];

const dash = <span className="dim">– –</span>;

/** One page of `rows`, and the control that turns the page. */
function usePaged<T>(rows: T[]): [T[], ReactNode] {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const at = Math.min(page, pages - 1);
  const pager = (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 18, padding: "12px 0 20px" }} className="soft">
      <button className="linkish" disabled={at === 0} onClick={() => setPage(at - 1)}>{tx("‹ Previous")}</button>
      <span>
        {at + 1} / {pages}
      </span>
      <button className="linkish" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>{tx("Next ›")}</button>
    </div>
  );
  return [rows.slice(at * PER_PAGE, (at + 1) * PER_PAGE), pager];
}

function Paged<T>({ rows, children }: { rows: T[]; children: (page: T[]) => ReactNode }) {
  const [page, pager] = usePaged(rows);
  return (
    <>
      {children(page)}
      {pager}
    </>
  );
}

export function Portfolio() {
  const owner = useStore((s) => s.owner);
  const account = useStore((s) => s.account);
  const history = useStore((s) => s.history);
  const ticks = useStore((s) => s.ticks);
  const config = useStore((s) => s.config)!;
  const symbol = config.coin?.symbol ?? "Coin";
  const coinActive = Boolean(config.coin);
  // The tab is whatever the address says, so Back and Forward move between tabs, and an address
  // naming no tab shows the first.
  const search = useStore((s) => s.search);
  const asked = new URLSearchParams(search).get("tab");
  const tab: TabId = TAB_IDS.find((id) => id === asked) ?? "positions";
  const setTab = (id: TabId) => navigate(id === "positions" ? "/portfolio" : `/portfolio?tab=${id}`);
  const [historyMarket, setHistoryMarket] = useState("all");
  const [historyResult, setHistoryResult] = useState<TradeResult>("all");
  const filteredTrades = useMemo(() => filterTrades(history.trades, historyMarket, historyResult), [history.trades, historyMarket, historyResult]);
  const exportTrades = () => {
    const url = URL.createObjectURL(new Blob(["\uFEFF", tradesCsv(filteredTrades, config.markets, PREVIEW)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `tape-${PREVIEW ? "practice-" : ""}trades-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  usePoll(loadHistory, 15_000, [owner]);

  let openPnl = 0n;
  let notional = 0n;
  let margin = 0n;
  for (const p of account?.positions ?? []) {
    margin += big(p.margin);
    notional += big(p.margin) * BigInt(p.leverage);
    const mark = ticks[p.market]?.p;
    if (mark) openPnl += quoteClose({ entryPrice: big(p.entryPrice), margin: big(p.margin), leverage: p.leverage, isLong: p.isLong, impactNotional: p.impactNotional }, config.markets[p.market], mark).pnl;
  }
  const free = account ? big(account.balance) - big(account.reserved) : 0n;
  const available = free > 0n ? free : 0n;
  const equity = available + margin + openPnl + big(account?.queued);
  const tone = (v: bigint) => (v > 0n ? "up" : v < 0n ? "down" : "");

  // Realised PnL over the chosen period as a running total, ending on what is open right now.
  const [pnlRange, setPnlRange] = useState(86_400);
  const openPnlNumber = usdNumber(openPnl);
  const pnlLine = useMemo(() => {
    const now = serverNow();
    const since = now - pnlRange;
    const recent = history.trades.filter((t) => t.time >= since).sort((a, b) => a.time - b.time);
    let running = 0;
    const points = [{ t: since, v: 0 }];
    for (const t of recent) {
      running += usdNumber(t.pnl);
      points.push({ t: t.time, v: running });
    }
    points.push({ t: now, v: running + openPnlNumber });
    return [{ name: "PnL", color: running + openPnlNumber < 0 ? RED : GREEN, area: true, points }];
    // One point a minute is plenty; the open figure beside the chart is the live one.
  }, [history.trades, Math.round(openPnlNumber), Math.floor(serverNow() / 60), pnlRange]);
  const dayPnl = pnlLine[0].points[pnlLine[0].points.length - 1].v;

  const tabs: [TabId, string][] = [
    ["positions", "Open positions"],
    ["history", "Trade history"],
    ["cashflow", "Deposits and withdrawals"],
    ["staking", "Staking"],
    ["queueOpen", "Queued now"],
    ["queueHistory", "Queue history"],
    ["emissions", coinActive ? tx("{0} earned", [symbol]) : "Loss rewards"],
  ];
  const connect = <div className="empty">{tx("Connect a wallet to view this.")}</div>;

  return (
    <div className="sheet work-page portfolio portfolio-page">
      <Hero
        title={tx("Portfolio")}
        lede={owner ? tx("Your balance, open positions and history.") : PREVIEW ? tx("Start trading to see a portfolio.") : tx("Connect a wallet to see your portfolio.")}
        actions={
          owner ? (
            <>
              <button className="btn" onClick={() => setState({ dialog: "withdraw" })}>{tx("Withdraw")}</button>
              <button className="btn primary" onClick={() => setState({ dialog: "deposit" })}>{tx("Deposit")}</button>
            </>
          ) : (
            <button className="btn primary" onClick={() => setState({ dialog: "connect" })}>
              {PREVIEW ? tx("Start trading") : tx("Connect wallet")}
            </button>
          )
        }
        figures={[
          { label: "Equity", value: account ? usd(equity) : dash },
          { label: "Available", value: account ? usdDown(available) : dash },
          { label: "Open PnL", value: account ? usd(openPnl, { sign: true }) : dash, tone: tone(openPnl) },
          { label: "Open interest", value: account ? usd(notional, { cents: false }) : dash },
          { label: "All-time PnL", value: account ? usd(account.stats.pnl, { sign: true }) : dash, tone: tone(big(account?.stats.pnl)) },
          { label: "Volume", value: account ? usd(account.stats.volume, { cents: false }) : dash },
        ]}
      />

      <PageSection title={tx("Performance and balances")} detail={tx("Your trading result, available rewards and winnings in the queue.")}>
      <div className="cells portfolio-top">
        <Panel
          area="pnl"
          chart
          title={
            <span className="seg">
              <span className="label">{tx("PnL")}</span>
              <span className={dayPnl > 0 ? "up" : dayPnl < 0 ? "down" : ""}>{owner ? `${dayPnl > 0 ? "+" : dayPnl < 0 ? "-" : ""}$${Math.abs(dayPnl).toFixed(2)}` : "– –"}</span>
            </span>
          }
          tools={
            <span className="seg">
              <select aria-label={tx("PnL period")} value={pnlRange} onChange={(e) => setPnlRange(Number(e.target.value))}>
                <option value={3_600}>1h</option>
                <option value={21_600}>6h</option>
                <option value={86_400}>1d</option>
                <option value={30 * 86_400}>30d</option>
              </select>
              <span className="live">{tx("Live")}</span>
            </span>
          }
        >
          <div className="fill" style={{ minHeight: 220 }}>
            {owner ? history.trades.length || account?.positions.length ? <Lines lines={pnlLine} /> : <div className="plot quiet-empty"><p>{tx("Your next trade starts the chart.")}</p><span>{tx("Closed trades and open PnL appear here.")}</span><Link to="/trade" className="btn">{tx("Go to exchange")}</Link></div> : <div className="plot empty">{tx("Connect a wallet to view performance.")}</div>}
          </div>
          <p className="chart-caption">{tx("Realised PnL from your latest 200 loaded trades, plus current open PnL. The period selector filters this history.")}</p>
        </Panel>

        <Panel title={coinActive ? symbol : tx("Loss rewards")} area="coin">
          {!coinActive ? <div className="panel-body"><p className="note">{tx("Coin launch pending. Loss rewards and staking will be enabled after attachment.")}</p><Link to="/staking" className="linkish">{tx("About staking")}</Link></div> :
          <div className="panel-body">
            <div className="kv">
              <span>{tx("In your wallet")}</span>
              <span>{account?.coin ? coinText(account.coin.wallet) : dash}</span>
            </div>
            <div className="kv">
              <span>{tx("Staked")}</span>
              <span>{account?.coin ? coinText(account.coin.staked) : dash}</span>
            </div>
            <div className="kv">
              <span>{tx("Rewards claimed")}</span>
              <span>{account?.coin ? usd(account.coin.claimed) : dash}</span>
            </div>
            <div className="kv">
              <span>{tx("Rewards to claim")}</span>
              <span className={account?.coin && big(account.coin.pending) > 0n ? "up" : ""}>{account?.coin ? usd(account.coin.pending) : dash}</span>
            </div>
          </div>}
        </Panel>

        <Panel title={tx("Badges and the queue")} area="badges">
          <div className="panel-body">
            <div className="kv">
              <span>{tx("Leaderboard badges")}</span>
              <span>
                {!account
                  ? dash
                  : account.badges.length === 0
                    ? tx("None yet")
                    : account.badges.map((b) => (
                        <span key={b.window} className="badge warn" style={{ marginLeft: 4 }} title={tx("Rank {0} by PnL over {1}", [b.rank, b.window])}>
                          #{b.rank} {b.window}
                        </span>
                      ))}
              </span>
            </div>
            <div className="kv">
              <span>{tx("Margin in use")}</span>
              <span>{account ? usd(margin) : dash}</span>
            </div>
            <div className="kv">
              <span title={tx("Winnings the vault owes you. Paid in order as losses come in.")}>{tx("Queued winnings")}</span>
              <span className={account && big(account.queued) > 0n ? "warn" : ""}>{account ? usd(account.queued) : dash}</span>
            </div>
          </div>
        </Panel>
      </div>
      </PageSection>

      <PageSection title={tx("Your activity")} detail={tx("Positions, trade history, transfers and payouts.")}>
      <section className="panel book">
        <div className="book-head">
          <PageTabs id="portfolio-tabs" label={tx("Portfolio activity")} tabs={tabs.map(([id, label]) => ({ id, label }))} value={tab} onChange={setTab} />
          <div className="spacer" />
          <button className="btn small" disabled={!account?.positions.length} onClick={() => closeAll()}>{tx("Close all")}</button>
        </div>
        <div id="portfolio-tabs-panel" role="tabpanel" aria-labelledby={`portfolio-tabs-${tab}`} tabIndex={0}>
        {tab === "positions" && <PositionsTable />}
        {tab !== "positions" && !owner && connect}
        {owner && tab === "history" && <>
          <div className="history-tools">
            <label>{tx("Market")}<select value={historyMarket} onChange={(e) => setHistoryMarket(e.target.value)} aria-label={tx("History market")}>
              <option value="all">{tx("All markets")}</option>
              {config.markets.map((m) => <option key={m.id} value={m.id}>{m.symbol}</option>)}
            </select></label>
            <label>{tx("Result")}<select value={historyResult} onChange={(e) => setHistoryResult(e.target.value as TradeResult)} aria-label={tx("History result")}>
              <option value="all">{tx("All results")}</option><option value="wins">{tx("Wins")}</option><option value="losses">{tx("Losses")}</option><option value="flat">{tx("Break-even")}</option><option value="liquidated">{tx("Liquidated")}</option>
            </select></label>
            <div className="history-scope" role="status"><Localized message={"{0} of {1} loaded trades<0>Latest 200 trades. Export includes all matches.</0>"} values={[filteredTrades.length, history.trades.length]} components={[<small />]} /></div>
            <button className="btn small" disabled={!filteredTrades.length} onClick={exportTrades}>{tx("Export CSV")}</button>
          </div>
          {filteredTrades.length ? <Paged key={`${historyMarket}:${historyResult}`} rows={filteredTrades}>{(rows) => <TradesTable trades={rows} />}</Paged> : <div className="empty history-empty">
            <p>{history.trades.length ? tx("No trades match these filters.") : tx("Your closed trades will appear here.")}</p>
            {history.trades.length > 0 && <button className="linkish" onClick={() => { setHistoryMarket("all"); setHistoryResult("all"); }}>{tx("Clear filters")}</button>}
          </div>}
        </>}
        {owner && tab === "cashflow" && <Paged rows={history.transfers}>{(rows) => <TransfersTable rows={rows} />}</Paged>}
        {owner && tab === "staking" && coinActive && <Paged rows={history.staking}>{(rows) => <StakingTable rows={rows} symbol={symbol} />}</Paged>}
        {owner && tab === "queueOpen" && <QueueOpenTable rows={account?.claims ?? []} />}
        {owner && tab === "queueHistory" && <Paged rows={history.queue}>{(rows) => <QueueHistoryTable rows={rows} />}</Paged>}
        {owner && tab === "emissions" && coinActive && <Paged rows={history.emissions}>{(rows) => <EmissionsTable rows={rows} symbol={symbol} />}</Paged>}
        {owner && !coinActive && (tab === "staking" || tab === "emissions") && <div className="quiet-empty"><p>{tx("Coin launch pending.")}</p><span>{tx("Staking and loss rewards will become available after attachment.")}</span><Link to="/staking" className="btn">{tx("About staking")}</Link></div>}
        </div>
      </section>
      </PageSection>
    </div>
  );
}
