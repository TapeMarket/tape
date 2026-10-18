import { tx } from "../lib/i18n";
import type { ReactNode } from "react";

/** Native buttons with the keyboard behavior expected of a horizontal tab list. */
export function PageTabs<T extends string>({ id, label, tabs, value, onChange }: { id: string; label: string; tabs: { id: T; label: ReactNode }[]; value: T; onChange: (value: T) => void }) {
  return <div className="tabs" role="tablist" aria-label={tx(label)} onKeyDown={(event) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    const next = event.key === "ArrowRight" ? (at + 1) % buttons.length : event.key === "ArrowLeft" ? (at + buttons.length - 1) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    onChange(tabs[next].id);
    buttons[next].focus();
  }}>
    {tabs.map((tab) => <button key={tab.id} id={`${id}-${tab.id}`} className="tab" role="tab" aria-selected={value === tab.id} aria-controls={`${id}-panel`} tabIndex={value === tab.id ? 0 : -1} onClick={() => onChange(tab.id)}>{tx(tab.label)}</button>)}
  </div>;
}
