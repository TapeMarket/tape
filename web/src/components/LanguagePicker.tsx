import { useEffect, useRef, useState } from "react";
import { LANGUAGES, setLocale, tx, useLocale } from "../lib/i18n";

export function LanguagePicker() {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } };
    window.addEventListener("pointerdown", outside); window.addEventListener("keydown", escape);
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="language-picker" ref={root}>
    <button ref={button} type="button" className="language-button" aria-label={tx("Language")} title={tx("Language")} aria-expanded={open} aria-haspopup="menu" aria-busy={loading} onClick={() => setOpen(!open)}>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6.5h14M5 17.5h14"/></svg>
      <span>{LANGUAGES.find(language => language.id === locale)!.short}</span>
    </button>
    {open && <div className="language-menu" role="menu" aria-label={tx("Language")} onKeyDown={event => {
      const choices = [...root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
      const at = choices.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (at + 1) % choices.length : event.key === "ArrowUp" ? (at + choices.length - 1) % choices.length : event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); choices[next].focus(); }
      if (event.key === "Tab") setOpen(false);
    }}>
      {LANGUAGES.map(language => <button type="button" role="menuitemradio" aria-checked={locale === language.id} lang={language.id} key={language.id} disabled={loading} onClick={async () => {
        setLoading(true); setError(false);
        try { await setLocale(language.id); setOpen(false); button.current?.focus(); }
        catch { setError(true); }
        finally { setLoading(false); }
      }}>{language.name}<span aria-hidden="true">{locale === language.id && <svg viewBox="0 0 20 20" width="16" height="16" fill="none"><path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}</span></button>)}
      {error && <p role="alert">{tx("Could not load this language. Try again.")}</p>}
    </div>}
  </div>;
}
