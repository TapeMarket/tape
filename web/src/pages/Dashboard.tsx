import { Hero } from "../components/Hero";
import { useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import {
  Chrome,
  CoinCard,
  CoinSupply,
  Exposure,
  ExchangeDataNotice,
  HouseFunds,
  HousePnl,
  HouseStats,
  LiquidationHeatmap,
  OpenInterest,
  PositionTopology,
  QueueDebt,
  QueuePlacement,
  QueueStats,
  RewardCurvePanel,
  StakingRevenue,
  StakingRewards,
  TotalUsers,
  TotalVolume,
  TraderPnl,
  Tvl,
  UserPositions,
  useExchangeData,
} from "../components/Panels";
import { Popover } from "../components/Shell";

interface Widget {
  id: string;
  title: string;
  /** Width in columns, out of 12. */
  w: number;
  /** Height in rows of the board. */
  h: number;
  render: () => ReactNode;
}

// Every panel the board can hold, in the order Tidy puts them back in: the house, the queue, the
// coin, then the exchange's totals.
const WIDGETS: Widget[] = [
  { id: "user-positions", title: "Open positions", w: 3, h: 3, render: () => <UserPositions /> },
  { id: "house-stats", title: "Vault", w: 3, h: 3, render: () => <HouseStats /> },
  { id: "house-funds", title: "Vault value", w: 6, h: 3, render: () => <HouseFunds /> },
  { id: "exposure", title: "Exposure", w: 6, h: 2, render: () => <Exposure /> },
  { id: "liquidation-heatmap", title: "Liquidation map", w: 6, h: 3, render: () => <LiquidationHeatmap /> },
  { id: "house-pnl", title: "Vault PnL on a 1% move", w: 3, h: 2, render: () => <HousePnl /> },
  { id: "position-topology", title: "Position map", w: 3, h: 2, render: () => <PositionTopology /> },
  { id: "queue-stats", title: "Payout queue", w: 6, h: 2, render: () => <QueueStats /> },
  { id: "queue-placement", title: "Queue placement", w: 3, h: 2, render: () => <QueuePlacement /> },
  { id: "queue-debt", title: "Queued wins", w: 6, h: 2, render: () => <QueueDebt /> },
  { id: "coin", title: "Coin", w: 3, h: 2, render: () => <CoinCard /> },
  { id: "coin-supply", title: "Coin mined and staked", w: 6, h: 2, render: () => <CoinSupply /> },
  { id: "reward-curve", title: "Reward curve", w: 6, h: 3, render: () => <RewardCurvePanel /> },
  { id: "staking-revenue", title: "Staking revenue", w: 6, h: 2, render: () => <StakingRevenue /> },
  { id: "staking-rewards", title: "Total staking rewards", w: 6, h: 2, render: () => <StakingRewards /> },
  { id: "open-interest", title: "Open interest", w: 6, h: 2, render: () => <OpenInterest /> },
  { id: "total-volume", title: "Total volume", w: 6, h: 2, render: () => <TotalVolume /> },
  { id: "trader-pnl", title: "Total trader PnL", w: 6, h: 2, render: () => <TraderPnl /> },
  { id: "tvl", title: "TVL", w: 6, h: 2, render: () => <Tvl /> },
  { id: "total-users", title: "Total users", w: 6, h: 2, render: () => <TotalUsers /> },
];

const BY_ID = new Map(WIDGETS.map((widget) => [widget.id, widget]));

// The board everybody starts from. In this order the nine panels fill eight rows with no gaps.
const OVERVIEW = ["house-funds", "house-stats", "user-positions", "exposure", "open-interest", "queue-stats", "total-volume", "trader-pnl", "tvl"];

type View = "overview" | "custom";

interface Board {
  view: View;
  /** The visitor's own arrangement. It starts as a copy of the overview. */
  custom: string[];
}

const STORAGE_KEY = "tape:dash:v1";

function restore(): Board {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Board> | null;
    if (saved && Array.isArray(saved.custom)) {
      // Panels that no longer exist are dropped, and nothing appears twice.
      const custom = [...new Set(saved.custom.filter((id) => BY_ID.has(id)))];
      return { view: saved.view === "custom" ? "custom" : "overview", custom };
    }
  } catch {
    // Storage is blocked or holds something else: start from the overview.
  }
  return { view: "overview", custom: OVERVIEW };
}

/** Takes `from` out of the list and puts it where `to` is. */
function move(ids: string[], from: string, to: string): string[] {
  const start = ids.indexOf(from);
  const end = ids.indexOf(to);
  if (start < 0 || end < 0 || start === end) return ids;
  const next = [...ids];
  next.splice(start, 1);
  next.splice(end, 0, from);
  return next;
}

/** The same panels as the other pages, on a board the visitor arranges. */
export function Dashboard() {
  const data = useExchangeData();
  const [board, setBoard] = useState(restore);
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const [saved, setSaved] = useState(true);

  const ids = board.view === "overview" ? OVERVIEW : board.custom;
  const tidied = WIDGETS.filter((widget) => ids.includes(widget.id)).map((widget) => widget.id);
  const isTidy = tidied.every((id, i) => id === ids[i]);
  const missing = WIDGETS.filter((widget) => !ids.includes(widget.id));

  const show = (next: Board) => {
    setBoard(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSaved(true);
    } catch {
      setSaved(false);
    }
  };

  /** Every change lands in Custom. Changing the overview copies it there first. */
  const change = (next: string[]) => {
    if (next.length === ids.length && next.every((id, i) => id === ids[i])) return;
    show({ view: "custom", custom: next });
  };

  const dragProps = (id: string) => {
    // Accepts the drop: only another panel of this board may land here.
    const hover = (e: DragEvent<HTMLElement>) => {
      if (!drag || drag.id === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDrag((held) => (held && held.over !== id ? { ...held, over: id } : held));
    };
    return {
      draggable: true,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        e.dataTransfer.effectAllowed = "move";
        // Firefox only starts a drag that carries data.
        e.dataTransfer.setData("text/plain", id);
        setDrag({ id, over: null });
      },
      onDragEnter: hover,
      onDragOver: hover,
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        // This also fires when the pointer crosses onto something inside the panel: only a real exit counts.
        const box = e.currentTarget.getBoundingClientRect();
        if (e.clientX > box.left && e.clientX < box.right && e.clientY > box.top && e.clientY < box.bottom) return;
        setDrag((held) => (held && held.over === id ? { ...held, over: null } : held));
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        if (drag) change(move(ids, drag.id, id));
        setDrag(null);
      },
      onDragEnd: () => setDrag(null),
    };
  };

  return (
    <div className="sheet work-page dashboard-page">
      <Hero
        title="Dashboard"
        lede="Build your view of the exchange. Drag panels or use their arrow buttons to arrange them. Your layout stays in this browser."
      />
      <ExchangeDataNotice data={data} />
      <div className="dash-bar page-toolbar">
        <span className="seg" role="group" aria-label="Layout">
          <button aria-pressed={board.view === "overview"} onClick={() => show({ ...board, view: "overview" })}>
            Overview
          </button>
          <button aria-pressed={board.view === "custom"} onClick={() => show({ ...board, view: "custom" })}>
            Custom
          </button>
        </span>
        <span className="dash-count" role="status">{ids.length} panels · {saved ? "Saved in this browser" : "Storage unavailable; changes last for this visit"}</span>
        <button className="btn small" disabled={isTidy} onClick={() => change(tidied)}>
          Tidy
        </button>
        <Popover className="btn small" align="right" label="Add">
          <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {missing.map((widget) => (
              <button key={widget.id} role="menuitem" onClick={() => change([...ids, widget.id])}>
                {widget.title}
              </button>
            ))}
            {missing.length === 0 && (
              <span className="dim" style={{ display: "block", padding: "8px 10px", whiteSpace: "nowrap" }}>
                Everything is on the board
              </span>
            )}
          </div>
        </Popover>
        <button className="btn small" disabled={ids.length === 0} onClick={() => change([])}>
          Clear
        </button>
      </div>

      {ids.length === 0 ? (
        <div className="quiet-empty">
          <p>Nothing on the board. Add a panel to start.</p>
          <span>Choose a panel with Add, or return to the exchange overview.</span>
          <button className="btn primary" onClick={() => show({ ...board, view: "overview" })}>Restore overview</button>
        </div>
      ) : (
        <div className="cells dash">
          {ids.map((id, index) => {
            const widget = BY_ID.get(id);
            if (!widget) return null;
            const style = { "--w": widget.w, "--h": widget.h, overflow: "hidden auto" } as CSSProperties;
            return (
              <Chrome.Provider
                key={id}
                value={{
                  before: <span className="grip" aria-hidden style={{ flex: "none" }} />,
                  after: (
                    <span className="widget-controls" role="group" aria-label={`Arrange ${widget.title}`}>
                      <button className="widget-move" aria-label={`Move ${widget.title} earlier`} disabled={index === 0} onClick={() => change(move(ids, id, ids[index - 1]))}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 12 5-5 5 5" /></svg></button>
                      <button className="widget-move" aria-label={`Move ${widget.title} later`} disabled={index === ids.length - 1} onClick={() => change(move(ids, id, ids[index + 1]))}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg></button>
                      <button className="close-x" aria-label={`Remove ${widget.title}`} onClick={() => change(ids.filter((other) => other !== id))}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg></button>
                    </span>
                  ),
                  className: `widget${drag?.id === id ? " dragging" : ""}${drag?.over === id ? " over" : ""}`,
                  style,
                  props: dragProps(id),
                }}
              >
                {widget.render()}
              </Chrome.Provider>
            );
          })}
        </div>
      )}
    </div>
  );
}
