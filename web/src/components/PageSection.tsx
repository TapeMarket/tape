import { tx } from "../lib/i18n";
import type { ReactNode } from "react";

/** A readable break between related tools, without another card around them. */
export function PageSection({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return <section className="page-section" aria-label={tx(title)}>
    <header className="page-section-head"><h2>{tx(title)}</h2>{detail && <p>{tx(detail)}</p>}</header>
    {children}
  </section>;
}
