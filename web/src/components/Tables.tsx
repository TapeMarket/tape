import { tx, Localized } from "../lib/i18n";
import { TriggerEditor } from "./Triggers";
import { share, shareTrade, ShareButton } from "./Share";
import { useEffect, useState, type ReactNode } from "react";
import { keepShare, quoteClose, sizeLevel } from "@shared/math.mjs";
import { checkOpenSubmission, closePosition, closingIntent } from "../lib/actions";
import { ago, big, coin as coinText, dateTime, duration, percent, price, shortAddress, usd } from "../lib/format";
import { PREVIEW } from "../lib/mode";
import { getState, serverNow, setState, useStore } from "../lib/store";
import type { Emission, Intent, Market, Position, QueueClaim, QueueEntry, StakingEntry, Trade, Transfer } from "../lib/types";
import { AssetIcon } from "./Shell";
import { pendingOpens, type PendingOpen } from "../lib/open-orders";

const EMPTY_POSITIONS: Position[] = [];
const NO_MARKETS: Market[] = [];

/** Re-renders once a second, for countdowns and "ago" labels. */
export function useSecond(): number {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function Asset({ market }: { market: Market | undefined }) {
  if (!market) return <span className="asset">?</span>;
  return (
    <span className="asset">
      <AssetIcon symbol={market.symbol} />
      {market.symbol}
    </span>
  );
}

export const Side = ({ isLong }: { isLong: boolean | null }) =>
  isLong === null ? <span className="dim">–</span> : <span className={`side ${isLong ? "up" : "down"}`}>{isLong ? tx("Long") : tx("Short")}</span>;

/** A transaction hash, linked to the explorer where there is one. */
function Tx({ hash }: { hash: string }) {
  const chainId = useStore((s) => s.config?.chainId);
  if (chainId === 1) {
    return (
      <a className="linkish" href={`https://etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer">
        {hash.slice(0, 10)}
      </a>
    );
  }
  return <span className="dim">{chainId === 0 ? tx("preview") : hash.slice(0, 10)}</span>;
}

/** Which column a table is sorted by, and which way. Click a heading to sort; again to reverse. */
export interface Sorting {
  key: string | null;
  down: boolean;
  /** The headings that can be sorted by. */
  by: Set<string>;
  toggle: (key: string) => void;
}

/** Sorts `rows` by the heading the person picked. `values` says what each sortable heading compares. */
export function useSorted<T>(rows: T[], values: Record<string, (row: T) => number | string>): [T[], Sorting] {
  const [key, setKey] = useState<string | null>(null);
  const [down, setDown] = useState(true);
  const read = key ? values[key] : null;
  const sorted = read
    ? [...rows].sort((a, b) => {
        const x = read(a);
        const y = read(b);
        const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return down ? -order : order;
      })
    : rows;
  const toggle = (next: string) => {
    if (next === key) {
      // Third click on the same heading puts the table back in its own order.
      if (!down) setKey(null);
      setDown(!down);
    } else {
      setKey(next);
      setDown(true);
    }
  };
  return [sorted, { key, down, by: new Set(Object.keys(values)), toggle }];
}

export function Table({ head, children, empty, sorting }: { head: (string | [string, "r"])[]; children: ReactNode[]; empty: ReactNode; sorting?: Sorting }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {head.map((cell) => {
              const label = typeof cell === "string" ? cell : cell[0];
              const sortable = sorting?.by.has(label);
              const active = sortable && sorting?.key === label;
              return (
                <th key={label} className={typeof cell === "string" ? undefined : "r"} aria-sort={active ? (sorting.down ? "descending" : "ascending") : undefined}>
                  {sortable ? (<button className="sort" onClick={() => sorting!.toggle(label)}>
                      {tx(label)}
                      <span aria-hidden="true">{active ? (sorting.down ? " ▼" : " ▲") : ""}</span>
                    </button>) : (tx(label))}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {children.length === 0 && <div className="empty">{tx(empty)}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Open positions
// ---------------------------------------------------------------------------------------------

function usePendingOpens(now: number) {
  const owner = useStore(s => s.owner), account = useStore(s => s.account), history = useStore(s => s.history);
  const intents = useStore(s => s.intents), openSubmissions = useStore(s => s.openSubmissions);
  return pendingOpens({ owner, account, history, intents, openSubmissions }, now);
}

function OpenStatus({ order, now }: { order: PendingOpen; now: number }) {
  useEffect(() => {
    if (order.stage !== "checking" || !order.submissionId) return;
    const id = order.submissionId;
    const check = () => { if (!document.hidden) void checkOpenSubmission(id); };
    check();
    const timer = setInterval(check, 3000);
    document.addEventListener("visibilitychange", check);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [order.stage, order.submissionId]);
  return <span className="open-status" role="status"><b>{order.stage === "sending" ? tx("Sending order") : order.stage === "checking" ? tx("Checking order") : order.stage === "confirming" ? tx("Price set") : tx("Waiting for price")}</b><small>{order.stage === "sending" ? tx("Waiting for acceptance") : order.stage === "checking" ? tx("Response interrupted. Verifying status.") : order.stage === "confirming" ? tx("Confirming on Ethereum") : order.pinTime && order.pinTime > now ? tx("Price window in {0}s", [order.pinTime - now]) : tx("Waiting for the first eligible price")}</small></span>;
}

function OpeningStrip({ order, markets, now }: { order: PendingOpen; markets: Market[]; now: number }) {
  const request = order.order, market = request && markets.find(m => m.id === request.market);
  return <article className="strip opening-order" aria-label={market && request ? tx("{0} {1} order", [market.symbol, request.isLong ? "long" : "short"]) : tx("Opening order")}>
    {request && market && <><div className="strip-id"><Asset market={market} /><Side isLong={request.isLong} /><span className="strip-lev">{request.leverage}x</span></div><div className="strip-cell"><small>{tx("Size")}</small><span>{usd(BigInt(request.margin) * BigInt(request.leverage), { cents: false })}</span></div><div className="strip-cell"><small>{tx("Margin")}</small><span>{usd(request.margin)}</span></div></>}
    <OpenStatus order={order} now={now} />
  </article>;
}

function PositionRow({ position, market, closing }: { position: Position; market: Market; closing: Intent | null }) {
  const tick = useStore((s) => s.ticks[position.market]);
  const [sending, setSending] = useState(false);
  const mark = tick?.p ?? big(position.entryPrice);
  const margin = big(position.margin);
  const quote = quoteClose({ entryPrice: big(position.entryPrice), margin, leverage: position.leverage, isLong: position.isLong, impactNotional: position.impactNotional }, market, mark);
  const roi = Number(quote.pnl) / Number(margin);
  // Above 1 the position opened on a crowded side, and keeps less of a small win for it.
  const level = sizeLevel(position.impactNotional);

  let action: ReactNode;
  if (position.liquidating) action = <span className="bust">{tx("Liquidating")}</span>;
  else if (closing?.status === "filled" && closing.fill) action = <span className="dim"><Localized message={"Closed at {0}"} values={[price(closing.fill.price)]} /></span>;
  else if (closing || sending) action = <span className="dim">{tx("Closing")}</span>;
  else if (position.closeRequestedAt) action = <span className="dim">{tx("Direct close pending")}</span>;
  else {
    action = (
      <button
        className="btn small"
        onClick={async () => {
          setSending(true);
          await closePosition(position.id);
          setSending(false);
        }}
      >{tx("Close")}</button>
    );
  }

  return (
    <tr>
      <td>
        <Asset market={market} />
        {position.status === "pending" && <small className="strip-confirmation">{tx("Confirming on Ethereum")}</small>}
      </td>
      <td>
        <Side isLong={position.isLong} />
      </td>
      <td className="r">
        {usd(margin * BigInt(position.leverage), { cents: false })}
        {level > 1 && (<span
            className="warn size-level"
            title={tx("Opened on a crowded side: the size term of the win haircut is {0} times the usual. A 0.10% win keeps {1}% here against {2}% on a quiet side. Losses and the liquidation price are the same. These terms were fixed when it opened.", [level.toFixed(2), (keepShare(10, market, position.impactNotional) * 100).toFixed(0), (keepShare(10, market) * 100).toFixed(0)])}
          >
            {" "}
            ×{level.toFixed(level < 10 ? 1 : 0)}
          </span>)}
      </td>
      <td className="r">{price(position.entryPrice)}</td>
      <td className="r">{price(mark)}</td>
      <td className="r bust">{price(position.bust)}</td>
      <td className={`r ${quote.pnl > 0n ? "up" : quote.pnl < 0n ? "down" : ""}`}>
        <b>{usd(quote.pnl, { sign: true })}</b> <span className="dim">{percent(roi, 1, true)}</span>
      </td>
      <td className="r">
        <b>{position.leverage}x</b>
      </td>
      <td className="r">{usd(margin)}</td>
      <td className="r"><div className="position-actions">
        {!position.liquidating && !closing && !sending && !position.closeRequestedAt && position.status === "open" && <TriggerEditor position={position} market={market} mark={tick?.p ?? null} />}
        {action}
      </div></td>
    </tr>
  );
}

export function PositionsTable() {
  const owner = useStore((s) => s.owner);
  const positions = useStore((s) => s.account?.positions) ?? EMPTY_POSITIONS;
  const intents = useStore((s) => s.intents);
  const markets = useStore((s) => s.config?.markets) ?? NO_MARKETS;
  const now = useSecond();
  // Orders signed and waiting for their price show up before the position exists.
  const filling = usePendingOpens(now);
  const newestFirst = [...positions].sort((a, b) => b.entryTime - a.entryTime);
  const livePnl = (p: Position) => {
    const mark = getState().ticks[p.market]?.p;
    return mark ? Number(quoteClose({ entryPrice: big(p.entryPrice), margin: big(p.margin), leverage: p.leverage, isLong: p.isLong, impactNotional: p.impactNotional }, markets[p.market], mark).pnl) : 0;
  };
  const [rows, sorting] = useSorted(newestFirst, {
    Asset: (p) => markets[p.market]?.symbol ?? "",
    Side: (p) => (p.isLong ? "Long" : "Short"),
    Size: (p) => Number(big(p.margin)) * p.leverage,
    Entry: (p) => Number(big(p.entryPrice)),
    PnL: livePnl,
    Lev: (p) => p.leverage,
    Margin: (p) => Number(big(p.margin)),
  });

  return (
    <Table
      head={["Asset", "Side", ["Size", "r"], ["Entry", "r"], ["Mark", "r"], ["Liq. price", "r"], ["PnL", "r"], ["Lev", "r"], ["Margin", "r"], ["", "r"]]}
      sorting={sorting}
      empty={
        owner ? (tx("No open positions. Pick a side and a leverage on the right.")) : (<span>
            <button className="linkish" onClick={() => setState({ dialog: "connect" })}>
              {PREVIEW ? tx("Start trading") : tx("Connect a wallet")}
            </button>{" "}
            {tx(" to view your positions. ")}</span>)
      }
    >
      {[
        ...filling.map(order => <tr key={order.id} className="opening-order"><td colSpan={10}><OpeningStrip order={order} markets={markets} now={now} /></td></tr>),
        ...rows.map((p) => <PositionRow key={p.id} position={p} market={markets[p.market]} closing={closingIntent(intents, p.id, now)} />),
      ]}
    </Table>
  );
}


/** How much of the way from entry to bust is still there, 0 at the bust price, 1 at entry, above 1 in profit. */
function room(position: Position, mark: bigint): number {
  const entry = Number(big(position.entryPrice));
  const bust = Number(big(position.bust));
  const now = Number(mark);
  const whole = entry - bust;
  return whole === 0 ? 1 : (now - bust) / whole;
}

function PositionStrip({ position, market, closing }: { position: Position; market: Market; closing: Intent | null }) {
  const tick = useStore((s) => s.ticks[position.market]);
  const [sending, setSending] = useState(false);
  const mark = tick?.p ?? big(position.entryPrice);
  const margin = big(position.margin);
  const quote = quoteClose({ entryPrice: big(position.entryPrice), margin, leverage: position.leverage, isLong: position.isLong, impactNotional: position.impactNotional }, market, mark);
  const roi = Number(quote.pnl) / Number(margin);
  const level = sizeLevel(position.impactNotional);
  const left = Math.max(0, room(position, mark));
  const tone = quote.pnl > 0n ? "up" : quote.pnl < 0n ? "down" : "";

  let action: ReactNode;
  if (position.liquidating) action = <span className="bust">{tx("Liquidating")}</span>;
  else if (closing?.status === "filled" && closing.fill) action = <span className="dim"><Localized message={"Closed at {0}"} values={[price(closing.fill.price)]} /></span>;
  else if (closing || sending) action = <span className="dim">{tx("Closing")}</span>;
  else if (position.closeRequestedAt) action = <span className="dim">{tx("Direct close pending")}</span>;
  else {
    action = (
      <button
        className="btn small"
        onClick={async () => {
          setSending(true);
          await closePosition(position.id);
          setSending(false);
        }}
      >{tx("Close")}</button>
    );
  }

  const onShare = () =>
    share({
      symbol: market.symbol,
      isLong: position.isLong,
      leverage: position.leverage,
      entry: big(position.entryPrice),
      exit: mark,
      pnl: quote.pnl,
      margin,
      liquidated: false,
      open: true,
      held: position.entryTime ? Math.max(0, Math.floor(Date.now() / 1000) - position.entryTime) : 0,
      time: Math.floor(Date.now() / 1000),
    });

  return (
    <article className={`strip ${position.isLong ? "long" : "short"}`}>
      <div className="strip-id">
        <AssetIcon symbol={market.symbol} size={20} />
        <b>{market.symbol}</b>
        <span className={`side ${position.isLong ? "up" : "down"}`}>{position.isLong ? tx("Long") : tx("Short")}</span>
        <span className="strip-lev">{position.leverage}x</span>
        {position.status === "pending" && <small className="strip-confirmation" role="status">{tx("Confirming on Ethereum")}</small>}
      </div>
      <div className="strip-cell">
        <small>{tx("Size")}</small>
        <span>
          {usd(margin * BigInt(position.leverage), { cents: false })}
          {level > 1 && (<span className="warn size-level" title={tx("Opened on a crowded side: a 0.10% win keeps {0}% here against {1}% on a quiet side. These terms were fixed when it opened.", [(keepShare(10, market, position.impactNotional) * 100).toFixed(0), (keepShare(10, market) * 100).toFixed(0)])}>
              {" "}
              ×{level.toFixed(level < 10 ? 1 : 0)}
            </span>)}
        </span>
      </div>
      <div className="strip-cell">
        <small>{tx("Entry → mark")}</small>
        <span>
          {price(position.entryPrice)} → {price(mark)}
        </span>
      </div>
      <div className="strip-room" title={tx("How much of the way from entry to the liquidation price is left")}>
        <small><Localized message={"Liq. price <0>{0}</0>"} values={[price(position.bust)]} components={[<span className="bust" />]} /></small>
        <span className={`room ${left < 0.34 ? "low" : ""}`}>
          <i style={{ width: `${(Math.min(left, 1) * 100).toFixed(1)}%` }} />
        </span>
      </div>
      <div className={`strip-pnl ${tone}`}>
        <b>{usd(quote.pnl, { sign: true })}</b>
        <small><Localized message={"{0} on {1}"} values={[percent(roi, 1, true), usd(margin)]} /></small>
      </div>
      <div className="strip-act">
        {!position.liquidating && !closing && position.status === "open" && <TriggerEditor position={position} market={market} mark={tick?.p ?? null} />}
        <ShareButton onClick={onShare} />
        {action}
      </div>
    </article>
  );
}

/** The trade page's positions: one strip each, newest first, with what is still being filled on top. */
export function PositionStrips() {
  const owner = useStore((s) => s.owner);
  const positions = useStore((s) => s.account?.positions) ?? EMPTY_POSITIONS;
  const intents = useStore((s) => s.intents);
  const markets = useStore((s) => s.config?.markets) ?? NO_MARKETS;
  const now = useSecond();
  const filling = usePendingOpens(now);
  const newestFirst = [...positions].sort((a, b) => b.entryTime - a.entryTime);
  if (!filling.length && !newestFirst.length) {
    return (
      <div className="empty strips-empty">
        {owner ? (tx("No open positions. Pick a side on the slip.")) : (<span>
            <button className="linkish" onClick={() => setState({ dialog: "connect" })}>
              {PREVIEW ? tx("Start trading") : tx("Connect a wallet")}
            </button>{" "}
            {tx(" to see your positions here. ")}</span>)}
      </div>
    );
  }
  return (
    <div className="strips">
      {filling.map(order => <OpeningStrip key={order.id} order={order} markets={markets} now={now} />)}
      {newestFirst.map((p) => (
        <PositionStrip key={p.id} position={p} market={markets[p.market]} closing={closingIntent(intents, p.id, now)} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Histories
// ---------------------------------------------------------------------------------------------

export function TradesTable({ trades, withOwner = false }: { trades: Trade[]; withOwner?: boolean }) {
  const markets = useStore((s) => s.config?.markets) ?? [];
  const now = useSecond();
  const [rows, sorting] = useSorted(trades, {
    Asset: (t) => markets[t.market]?.symbol ?? "",
    Side: (t) => (t.isLong ? "Long" : "Short"),
    Size: (t) => Number(big(t.margin)) * (t.leverage ?? 0),
    PnL: (t) => Number(big(t.pnl)),
    Lev: (t) => t.leverage ?? 0,
    Margin: (t) => Number(big(t.margin)),
    Held: (t) => (t.entryTime ? t.time - t.entryTime : 0),
    Closed: (t) => t.time,
  });
  return (
    <Table
      head={[...(withOwner ? ["User"] : []), "Asset", "Side", ["Size", "r"], ["Entry", "r"], ["Exit", "r"], ["PnL", "r"], ["Lev", "r"], ["Margin", "r"], ["Held", "r"], ["Closed", "r"], ...(withOwner ? [] : [["", "r"] as [string, "r"]])]}
      sorting={sorting}
      empty={tx("No closed trades yet.")}
    >
      {rows.map((t) => {
        const pnl = big(t.pnl);
        const queued = big(t.queued);
        return (
          <tr key={t.id + t.time}>
            {withOwner && <td className="soft">{shortAddress(t.owner)}</td>}
            <td>
              <Asset market={markets[t.market]} />
            </td>
            <td>
              <Side isLong={t.isLong} /> {t.busted && <span className="badge bust">{tx("Liquidated")}</span>}
            </td>
            <td className="r">{t.margin && t.leverage ? usd(big(t.margin) * BigInt(t.leverage), { cents: false }) : "–"}</td>
            <td className="r">{t.entryPrice ? price(t.entryPrice) : "–"}</td>
            <td className="r">{price(t.exitPrice)}</td>
            <td className={`r ${pnl > 0n ? "up" : pnl < 0n ? "down" : ""}`}>
              <b>{usd(pnl, { sign: true })}</b>
              {queued > 0n && (<span className="dim" title={tx("Waiting in the payout queue")}><Localized message={" {0} queued"} values={[usd(queued)]} /></span>)}
            </td>
            <td className="r">{t.leverage ? `${t.leverage}x` : "–"}</td>
            <td className="r">{t.margin ? usd(t.margin) : "–"}</td>
            <td className="r soft">{t.entryTime ? duration(t.time - t.entryTime) : "–"}</td>
            <td className="r soft"><Localized message={"{0} ago"} values={[ago(t.time, now)]} /></td>
            {!withOwner && (<td className="r">{markets[t.market] && t.margin && <ShareButton onClick={() => shareTrade(t, markets[t.market].symbol)} />}</td>)}
          </tr>
        );
      })}
    </Table>
  );
}

const TRANSFER_LABEL: Record<Transfer["type"], [string, string]> = {
  deposit: ["Deposit", "up"],
  withdraw: ["Withdrawal", "down"],
  "withdraw-request": ["Direct withdrawal requested", ""],
  reward: ["Staking reward", "warn"],
};

export function TransfersTable({ rows }: { rows: Transfer[] }) {
  return (
    <Table head={["Date / time", "Type", ["Amount", "r"], ["Transaction", "r"]]} empty={tx("No deposits or withdrawals yet.")}>
      {rows.map((row, i) => (
        <tr key={row.tx + i}>
          <td className="soft">{dateTime(row.time)}</td>
          <td>
            <span className={`badge ${TRANSFER_LABEL[row.type][1]}`}>{tx(TRANSFER_LABEL[row.type][0])}</span>
          </td>
          <td className="r">
            <b>{usd(row.amount)}</b>
          </td>
          <td className="r">
            <Tx hash={row.tx} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

const STAKING_LABEL: Record<StakingEntry["type"], [string, string]> = { stake: ["Stake", "up"], unstake: ["Unstake", "down"], claim: ["Reward claim", "warn"] };

export function StakingTable({ rows, symbol }: { rows: StakingEntry[]; symbol: string }) {
  return (
    <Table head={["Date / time", "Type", ["Amount", "r"], ["Transaction", "r"]]} empty={tx("Nothing staked yet. {0} you stake earns USDC from the exchange.", [symbol])}>
      {rows.map((row, i) => (
        <tr key={row.tx + i}>
          <td className="soft">{dateTime(row.time)}</td>
          <td>
            <span className={`badge ${STAKING_LABEL[row.type][1]}`}>{tx(STAKING_LABEL[row.type][0])}</span>
          </td>
          <td className="r">
            <b>{row.type === "claim" ? usd(row.amount) : `${coinText(row.amount)} ${symbol}`}</b>
          </td>
          <td className="r">
            <Tx hash={row.tx} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function QueueOpenTable({ rows }: { rows: QueueClaim[] }) {
  const now = useSecond();
  return (
    <Table head={[["Entry", "r"], ["Owed to you", "r"], ["Ahead of you", "r"], ["Queued", "r"]]} empty={tx("Nothing of yours is waiting in the payout queue.")}>
      {rows.map((row) => (
        <tr key={row.id}>
          <td className="r soft">#{row.id}</td>
          <td className="r">
            <b>{usd(row.amount)}</b>
          </td>
          <td className="r">{usd(row.ahead)}</td>
          <td className="r soft"><Localized message={"{0} ago"} values={[ago(row.time, now)]} /></td>
        </tr>
      ))}
    </Table>
  );
}

const QUEUE_LABEL: Record<QueueEntry["type"], [string, string]> = { queued: ["Queued", ""], paid: ["Paid out", "up"], spent: ["Used as margin", "warn"] };

export function QueueHistoryTable({ rows }: { rows: QueueEntry[] }) {
  return (
    <Table head={["Date / time", "Type", ["Entry", "r"], ["Amount", "r"], ["Transaction", "r"]]} empty={tx("No queue activity yet.")}>
      {rows.map((row, i) => (
        <tr key={row.tx + i}>
          <td className="soft">{dateTime(row.time)}</td>
          <td>
            <span className={`badge ${QUEUE_LABEL[row.type][1]}`}>{tx(QUEUE_LABEL[row.type][0])}</span>
          </td>
          <td className="r soft">{row.claimId === null ? "–" : `#${row.claimId}`}</td>
          <td className="r">
            <b>{usd(row.amount)}</b>
          </td>
          <td className="r">
            <Tx hash={row.tx} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function EmissionsTable({ rows, symbol }: { rows: Emission[]; symbol: string }) {
  return (
    <Table head={["Date / time", ["Loss", "r"], [tx("{0} received", [symbol]), "r"], ["Rate", "r"], ["Transaction", "r"]]} empty={tx("No {0} yet. Every dollar you lose pays you in {1}.", [symbol, symbol])}>
      {rows.map((row, i) => {
        const perDollar = Number(big(row.amount)) / 1e18 / (Number(big(row.usd)) / 1e6 || 1);
        return (
          <tr key={row.tx + i}>
            <td className="soft">{dateTime(row.time)}</td>
            <td className="r down">{usd(row.usd)}</td>
            <td className="r">
              <b>{coinText(row.amount)}</b>
            </td>
            <td className="r soft">{perDollar.toFixed(perDollar >= 10 ? 1 : 2)} / $1</td>
            <td className="r">
              <Tx hash={row.tx} />
            </td>
          </tr>
        );
      })}
    </Table>
  );
}
