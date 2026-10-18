import { tx } from "../lib/i18n";
import type { ReactNode } from "react";

export interface Figure {
  label: string;
  value: ReactNode;
  tone?: "up" | "down" | "bust" | "warn" | "";
  hint?: string;
}

/**
 * The top of every page but the trade page: the page's name, what it is for in one line, what can
 * be done from here, and the page's key numbers.
 */
export function Hero({ title, lede, actions, figures }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode; figures?: Figure[] }) {
  return (
    <header className="hero">
      <div className="hero-copy">
        <h1>{tx(title)}</h1>
        {lede && <p>{tx(lede)}</p>}
      </div>
      {actions && <div className="hero-actions">{actions}</div>}
      {figures && figures.length > 0 && (<dl className="hero-figs">
          {figures.map((f) => (
            <div key={tx(f.label)} title={tx(f.hint)}>
              <dt>{tx(f.label)}</dt>
              <dd className={f.tone ?? ""}>{f.value}</dd>
            </div>
          ))}
        </dl>)}
    </header>
  );
}
