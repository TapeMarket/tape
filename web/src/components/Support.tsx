import { tx } from "../lib/i18n";
import { lazy, Suspense, useRef, useState } from "react";
import "./support.css";

const load = () => import("./SupportChat");
const Chat = lazy(load);
export function Support() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return <div className="support-widget">
    {open && <Suspense fallback={<section className="support-chat" role="status"><div className="support-intro">{tx("Opening support…")}</div><button className="support-close" aria-label={tx("Close support")} onClick={() => setOpen(false)}>×</button></section>}>
      <Chat onClose={() => { setOpen(false); button.current?.focus(); }} />
    </Suspense>}
    <button ref={button} className={`support-launcher${open ? " active" : ""}`} aria-expanded={open} aria-controls="tape-support" aria-label={open ? tx("Close support chat") : tx("Open support chat")}
      onPointerEnter={() => { void load(); }} onFocus={() => { void load(); }} onClick={() => setOpen(value => !value)}>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-6 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M7 9h10M7 13h6" stroke="currentColor" strokeWidth="1.6"/></svg>
      <span>{tx("Support")}</span>
    </button>
  </div>;
}
