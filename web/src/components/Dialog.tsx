import { tx } from "../lib/i18n";
import { useEffect, useRef, type ReactNode } from "react";
import { setState } from "../lib/store";

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";

// Track the opener before autofocus moves into a dialog, then restore it on close.
let focusedOutside: HTMLElement | null = typeof document === "undefined" ? null : document.activeElement as HTMLElement | null;
if (typeof document !== "undefined") {
  document.addEventListener("focusin", (e) => {
    const target = e.target as HTMLElement | null;
    if (target && !target.closest("[role=dialog]")) focusedOutside = target;
  });
}

export function Dialog({ title, wide, className = "", onClose, children }: { title: string; wide?: boolean; className?: string; onClose?: () => void; children: ReactNode }) {
  const close = onClose ?? (() => setState({ dialog: null }));
  const closeRef = useRef(close);
  closeRef.current = close;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = focusedOutside;
    if (!box.current?.contains(document.activeElement)) box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return closeRef.current();
      const inside = box.current;
      if (!inside) return;
      // Enter in a field does what the main button does.
      if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
        e.preventDefault();
        inside.querySelector<HTMLButtonElement>("button.primary:not(:disabled)")?.click();
        return;
      }
      // Tab stays inside the dialog.
      if (e.key !== "Tab") return;
      const stops = [...inside.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement;
      if (!inside.contains(at) || (e.shiftKey && at === first) || (!e.shiftKey && at === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`dialog ${wide ? "wide" : ""} ${className}`} role="dialog" aria-modal="true" aria-label={tx(title)} ref={box}>
        <div className="dialog-head">
          <h2>{tx(title)}</h2>
          <button className="close-x" aria-label={tx("Close")} onClick={close}>
            ×
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
