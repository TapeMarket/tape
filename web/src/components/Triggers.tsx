import { tx, Localized } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { quoteClose } from "@shared/math.mjs";
import { cancelTrigger, setTrigger } from "../lib/actions";
import { big, price, usd } from "../lib/format";
import type { Market, Position } from "../lib/types";

/** A price typed in dollars, as an 8-decimal integer. Null if it is not a price. */
export function parsePrice(text: string): bigint | null {
  const clean = text.replace(/[,\s$]/g, "");
  if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") return null;
  const [whole, frac = ""] = clean.split(".");
  const value = BigInt(whole || "0") * 100_000_000n + BigInt((frac + "00000000").slice(0, 8));
  return value > 0n ? value : null;
}

/** An 8-decimal price as the box shows it: plain digits, no separators. */
const plain = (p: bigint) => {
  const fraction = (p % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${p / 100_000_000n}${fraction ? `.${fraction}` : ""}`;
};

interface Shape {
  entryPrice: bigint;
  margin: bigint;
  leverage: number;
  isLong: boolean;
  impactNotional: number;
  bust: bigint | null;
}

export interface TriggerCheck {
  takeProfit: bigint | null;
  stopLoss: bigint | null;
  /** What is wrong with what was typed, if anything. */
  error: string | null;
}

/** Reads the two boxes against the position: a take-profit past the mark, a stop between the mark and the liquidation price. */
export function checkTriggers(tpText: string, slText: string, shape: Shape, mark: bigint | null): TriggerCheck {
  const takeProfit = tpText.trim() ? parsePrice(tpText) : null;
  const stopLoss = slText.trim() ? parsePrice(slText) : null;
  if (tpText.trim() && takeProfit === null) return { takeProfit, stopLoss, error: tx("The take-profit is not a price.") };
  if (slText.trim() && stopLoss === null) return { takeProfit, stopLoss, error: tx("The stop-loss is not a price.") };
  const up = shape.isLong;
  if (takeProfit !== null && mark !== null && (up ? takeProfit <= mark : takeProfit >= mark)) {
    return { takeProfit, stopLoss, error: tx("A take-profit goes {0} the price.", [up ? tx("above") : tx("below")]) };
  }
  if (stopLoss !== null && mark !== null && (up ? stopLoss >= mark : stopLoss <= mark)) {
    return { takeProfit, stopLoss, error: tx("A stop-loss goes {0} the price.", [up ? tx("below") : tx("above")]) };
  }
  if (stopLoss !== null && shape.bust !== null && (up ? stopLoss < shape.bust : stopLoss > shape.bust)) {
    return { takeProfit, stopLoss, error: tx("That stop is past the liquidation price, which comes first.") };
  }
  return { takeProfit, stopLoss, error: null };
}

/** What the position would come out with at `at`. */
function outcome(shape: Shape, market: Market, at: bigint | null) {
  if (at === null) return null;
  return quoteClose({ entryPrice: shape.entryPrice, margin: shape.margin, leverage: shape.leverage, isLong: shape.isLong, impactNotional: shape.impactNotional }, market, at);
}

/** The two boxes, each with what closing there would pay. */
export function TriggerFields({
  market,
  shape,
  tp,
  sl,
  setTp,
  setSl,
  check,
  disabled = false,
}: {
  market: Market;
  shape: Shape;
  tp: string;
  sl: string;
  setTp: (v: string) => void;
  setSl: (v: string) => void;
  check: TriggerCheck;
  disabled?: boolean;
}) {
  const win = outcome(shape, market, check.takeProfit);
  const loss = outcome(shape, market, check.stopLoss);
  return (
    <div className="triggers">
      <label className="trigger">
        <span>{tx("Take profit")}</span>
        <input className="input" inputMode="decimal" placeholder={tx("Price")} value={tp} onChange={(e) => setTp(e.target.value)} aria-label={tx("Take-profit price")} disabled={disabled} />
        <small className={win && win.pnl > 0n ? "up" : "dim"}>{win ? usd(win.pnl, { sign: true }) : "–"}</small>
      </label>
      <label className="trigger">
        <span>{tx("Stop loss")}</span>
        <input className="input" inputMode="decimal" placeholder={tx("Price")} value={sl} onChange={(e) => setSl(e.target.value)} aria-label={tx("Stop-loss price")} disabled={disabled} />
        <small className={loss && loss.pnl < 0n ? "down" : "dim"}>{loss ? usd(loss.pnl, { sign: true }) : "–"}</small>
      </label>
      {check.error && <p className="trigger-error">{check.error}</p>}
    </div>
  );
}

/** The take-profit and stop-loss of an open position: shown, set, changed or taken off. */
export function TriggerEditor({ position, market, mark }: { position: Position; market: Market; mark: bigint | null }) {
  const tp = position.takeProfit ? big(position.takeProfit) : null;
  const sl = position.stopLoss ? big(position.stopLoss) : null;
  const label =
    tp || sl ? (
      <>
        {tp && <span className="up"><Localized message={"TP {0}"} values={[price(tp)]} /></span>}
        {tp && sl && " · "}
        {sl && <span className="down"><Localized message={"SL {0}"} values={[price(sl)]} /></span>}
      </>
    ) : (
      "TP / SL"
    );
  const [at, setAt] = useState<{ right: number; top?: number; bottom?: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    panel.current?.querySelector<HTMLInputElement>("input")?.focus();
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setAt(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setAt(null); button.current?.focus(); }
    };
    const onFocus = (e: FocusEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setAt(null);
    };
    const onScroll = () => setAt(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("focusin", onFocus);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", onScroll);
    };
  }, [at]);
  // Fixed to the window, so the list it sits in (which scrolls) cannot cut it off. It opens
  // upward when there is more room above the button than below.
  const toggle = () => {
    if (at) return setAt(null);
    const rect = button.current!.getBoundingClientRect();
    const right = Math.max(12, Math.min(window.innerWidth - rect.right, window.innerWidth - 320));
    setAt(rect.top > window.innerHeight - rect.bottom ? { right, bottom: window.innerHeight - rect.top + 6 } : { right, top: rect.bottom + 6 });
  };
  return (
    <>
      <button ref={button} className="trigger-pop" aria-expanded={at !== null} aria-haspopup="dialog" onClick={toggle}>
        <span className="trigger-label">{tx(label)}</span>
      </button>
      {at && createPortal(
        <div ref={panel} className="trigger-float" style={{ right: at.right, top: at.top, bottom: at.bottom }} role="dialog" aria-label={tx("Take profit and stop loss")}>
          {/* Mounted each time it opens, so its boxes start from what is set at that moment. */}
          <TriggerMenu position={position} market={market} mark={mark} current={{ tp, sl }} onDone={() => { setAt(null); button.current?.focus(); }} />
        </div>, document.body
      )}
    </>
  );
}

function TriggerMenu({ position, market, mark, current, onDone }: { position: Position; market: Market; mark: bigint | null; current: { tp: bigint | null; sl: bigint | null }; onDone: () => void }) {
  const [tp, setTp] = useState(current.tp ? plain(current.tp) : "");
  const [sl, setSl] = useState(current.sl ? plain(current.sl) : "");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const shape: Shape = {
    entryPrice: big(position.entryPrice),
    margin: big(position.margin),
    leverage: position.leverage,
    isLong: position.isLong,
    impactNotional: position.impactNotional,
    bust: big(position.bust),
  };
  const check = checkTriggers(tp, sl, shape, mark);
  const unchanged = check.takeProfit === current.tp && check.stopLoss === current.sl;

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      // A take-profit is on the winning side: above the price for a long.
      const tpAbove = position.isLong;
      if (check.takeProfit !== current.tp) {
        const ok = check.takeProfit === null ? await cancelTrigger(position.id, tpAbove) : await setTrigger(position.id, check.takeProfit, tpAbove);
        if (!ok) { setSaveError("Take profit was not saved. Check the error and try again."); return; }
      }
      if (check.stopLoss !== current.sl) {
        const ok = check.stopLoss === null ? await cancelTrigger(position.id, !tpAbove) : await setTrigger(position.id, check.stopLoss, !tpAbove);
        if (!ok) { setSaveError("Stop loss was not saved. Check the error and try again."); return; }
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trigger-menu">
      <TriggerFields market={market} shape={shape} tp={tp} sl={sl} setTp={setTp} setSl={setSl} check={check} disabled={busy} />
      {saveError && <p className="trigger-error" role="alert">{saveError}</p>}
      <button className="btn primary wide" disabled={busy || check.error !== null || unchanged} onClick={save}>
        {busy ? tx("Saving") : tx("Save")}
      </button>
      <p className="note">{tx("Closes the position at the first price two seconds after one is touched, as if you had clicked Close then. Clear a box to remove it.")}</p>
    </div>
  );
}
