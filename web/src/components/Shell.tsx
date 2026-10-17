import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { claimUsername, withdraw } from "../lib/actions";
import { post } from "../lib/api";
import { amountTyped, big, parseUsd, percent, price, priceNumber, shortAddress, usdDown, usdInput, usdNumber } from "../lib/format";
import { BRAND, PREVIEW } from "../lib/mode";
import { navigate, setState, toast, useStore } from "../lib/store";
import { connectWith, disconnect, walletOptions, type WalletOption } from "../lib/wallet";
import type { TapeChip } from "../lib/types";
import { ShareDialog } from "./Share";
import { Wordmark } from "./Wordmark";
import { Link } from "./Link";
export { Link } from "./Link";

const MORE: [string, string][] = [
  ["/dashboard", "Dashboard"],
  ["/referrals", "Referrals"],
  ["/docs", "Docs"],
  ["/status", "Status"],
];

export function AssetIcon({ symbol, size = 17 }: { symbol: string; size?: number }) {
  return <img src={`/img/${symbol.toLowerCase()}.png`} alt="" width={size} height={size} />;
}

/** A button that opens a small menu under itself. Closes on any click outside or on a choice. */
export function Popover({ label, className, align, children }: { label: ReactNode; className?: string; align?: "right" | "up"; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      // A choice inside the menu closes it too, after its own handler has run.
      if (!ref.current?.querySelector("button")?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="pop" ref={ref}>
      <button className={className} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className={`menu ${align ?? ""}`} role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

/** A market's price in the bar: what it is now and how it moved over the day. Opens its chart. */
function Quote({ id, symbol, ref24h }: { id: number; symbol: string; ref24h?: number | null }) {
  const tick = useStore((s) => s.ticks[id]);
  const now = tick ? priceNumber(tick.p) : 0;
  const change = ref24h && now ? now / ref24h - 1 : null;
  return (
    <a
      href="/trade"
      className="quote"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        setState({ marketId: id });
        navigate("/trade");
      }}
    >
      <AssetIcon symbol={symbol} size={16} />
      <span className="quote-sym">{symbol}</span>
      <b>{tick ? price(tick.p) : "–"}</b>
      {change !== null && <span className={change >= 0 ? "up" : "down"}>{percent(change, 2, true)}</span>}
    </a>
  );
}

/** Everything under "More": the other pages, then the small print. */
function MoreItems() {
  return (
    <>
      {MORE.map(([to, label]) => (
        <Link key={to} to={to}>
          {label}
        </Link>
      ))}
      <hr className="menu-rule" />
      {/* The chart library's licence asks for this credit on the site. */}
      <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
        Charts by TradingView
      </a>
      {PREVIEW && (
        <button
          onClick={async () => {
            // The tab that runs the exchange drops its world and tells every tab to reload.
            await post("/reset", {}).catch(() => {});
            for (const key of Object.keys(localStorage)) if (key.startsWith("tape:")) localStorage.removeItem(key);
            location.reload();
          }}
        >
          Start the preview over
        </button>
      )}
    </>
  );
}

const GLYPHS: Record<string, ReactNode> = {
  trade: <path d="M3 17l5-6 4 3 6-8M15 6h3v3" />,
  portfolio: <path d="M4 7h16v11H4zM4 11h16M9 7V5h6v2" />,
  vault: <path d="M4 5h16v14H4zM4 19v1.5M20 19v1.5M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 9V7.5M12 16.5V15M17 9v6" />,
  coin: <path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v8M9.5 10.5c0-1 1-1.6 2.5-1.6s2.5.6 2.5 1.6-1 1.4-2.5 1.5-2.5.6-2.5 1.6 1 1.6 2.5 1.6 2.5-.6 2.5-1.6" />,
  more: <path d="M6 12h.01M12 12h.01M18 12h.01" />,
};
const Glyph = ({ name }: { name: string }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {GLYPHS[name]}
  </svg>
);

export function TopBar() {
  const name = useStore((s) => s.config?.name) ?? BRAND;
  const coin = useStore((s) => s.config?.coin?.symbol);
  const markets = useStore((s) => s.config?.markets);
  const owner = useStore((s) => s.owner);
  const account = useStore((s) => s.account);
  const path = useStore((s) => s.path);
  // Free balance: what is not already spoken for by an order on its way to the chain.
  const free = big(account?.balance) - big(account?.reserved);
  const inMore = MORE.some(([to]) => to === path);
  const live = (markets ?? []).filter((m) => !m.retired);

  return (
    <>
      <header className="top">
        <Link to="/" className="top-brand">
          <Wordmark height={26} title={name} />
        </Link>
        <div className="top-quotes hide-narrow" aria-label="Prices">
          {live.slice(0, 2).map((m) => (
            <Quote key={m.id} id={m.id} symbol={m.symbol} ref24h={m.ref24h} />
          ))}
        </div>
        <nav className="top-nav" aria-label="Main">
          <Link to="/trade">Trade</Link>
          <Link to="/jackpot">Jackpot</Link>
          <Link to="/vault">Vault</Link>
          {coin && <Link to="/staking">Staking</Link>}
          <Link to="/leaderboard">Leaderboard</Link>
          <Link to="/stats">Stats</Link>
          <Popover
            align="right"
            className={inMore ? "on" : ""}
            label={
              <>
                More <i className="caret" aria-hidden="true" />
              </>
            }
          >
            <MoreItems />
          </Popover>
        </nav>
        {owner ? (
          <div className="wallet">
            <Popover
              align="right"
              className="wallet-main"
              label={
                <>
                  <i className="wallet-dot" aria-hidden="true" />
                  <span className="wallet-text">
                    <b>{usdDown(free > 0n ? free : 0n)}</b>
                    <small>{PREVIEW ? "practice" : (account?.name ?? shortAddress(owner))}</small>
                  </span>
                  <i className="caret" aria-hidden="true" />
                </>
              }
            >
              <Link to="/portfolio">Portfolio</Link>
              <button onClick={() => setState({ dialog: "deposit" })}>Deposit</button>
              <button onClick={() => setState({ dialog: "withdraw" })}>Withdraw</button>
              <button onClick={() => navigator.clipboard?.writeText(owner).then(() => toast("info", "Address copied"), () => {})}>Copy address</button>
              <button onClick={() => setState({ dialog: "username" })}>{account?.name ? "Change username" : "Claim a username"}</button>
              <hr className="menu-rule" />
              <button onClick={disconnect}>Disconnect</button>
            </Popover>
            <button className="wallet-add" onClick={() => setState({ dialog: "deposit" })} aria-label="Deposit" title="Deposit">
              <span aria-hidden="true">+</span>
              <span className="hide-narrow">Deposit</span>
            </button>
          </div>
        ) : (
          <button className="wallet-connect" onClick={() => setState({ dialog: "connect" })}>
            {PREVIEW ? "Start trading" : "Connect wallet"}
          </button>
        )}
      </header>

      {/* On a phone the menu is a row of tabs along the bottom of the screen, under the thumb. */}
      <nav className="tabbar" aria-label="Main">
        <Link to="/trade">
          <Glyph name="trade" />
          Trade
        </Link>
        <Link to="/portfolio">
          <Glyph name="portfolio" />
          Portfolio
        </Link>
        <Link to="/vault">
          <Glyph name="vault" />
          Vault
        </Link>
        {coin && (
          <Link to="/staking">
            <Glyph name="coin" />
            Staking
          </Link>
        )}
        <Popover
          align="up"
          className={inMore || path === "/leaderboard" || path === "/stats" || path === "/jackpot" ? "on" : ""}
          label={
            <>
              <Glyph name="more" />
              More
            </>
          }
        >
          <Link to="/jackpot">Jackpot</Link>
          <Link to="/leaderboard">Leaderboard</Link>
          <Link to="/stats">Stats</Link>
          <MoreItems />
        </Popover>
      </nav>
    </>
  );
}

export function Banner() {
  const offline = useStore((s) => s.offline);
  const source = useStore((s) => s.config?.priceSource);
  const chainId = useStore((s) => s.config?.chainId);
  if (offline) {
    return (
      <div className="banner bad">
        <b>Offline.</b> {offline}
      </div>
    );
  }
  if (source === "preview") {
    return null;
  }
  if (source === "dev") {
    return (
      <div className="banner">
        <b>Test mode.</b> Local chain {chainId}, play money, simulated prices. Nothing here is real.
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The tape
// ---------------------------------------------------------------------------------------------

/** "+$20.9", "-$3.04K", "$10M", and "+<$0.01" for less than a cent */
export function tapeUsd(value: number, signed: boolean): string {
  const a = Math.abs(value);
  if (a === 0) return "$0";
  const sign = signed ? (value < 0 ? "-" : "+") : "";
  if (a >= 1e6) return `${sign}$${+(a / 1e6).toPrecision(3)}M`;
  if (a >= 1e3) return `${sign}$${+(a / 1e3).toPrecision(3)}K`;
  if (a >= 1) return `${sign}$${+a.toPrecision(3)}`;
  return a < 0.01 ? `${sign}<$0.01` : `${sign}$${a.toFixed(2)}`;
}

function Chip({ chip }: { chip: TapeChip }) {
  const symbol = useStore((s) => s.config?.markets[chip.market]?.symbol) ?? "BTC";
  if (chip.type === "open") {
    return (
      <span className={`tchip ${chip.isLong ? "win" : "loss"}`} title={`${symbol} ${chip.isLong ? "long" : "short"} opened`}>
        <AssetIcon symbol={symbol} size={16} />
        <span className="arrow">{chip.isLong ? "▲" : "▼"}</span>
        {tapeUsd(usdNumber(chip.notional), false)}
      </span>
    );
  }
  const pnl = usdNumber(chip.pnl);
  return (
    <span className={`tchip ${chip.busted ? "busted" : pnl >= 0 ? "win" : "loss"}`} title={chip.busted ? `${symbol} position liquidated` : `${symbol} position closed`}>
      <AssetIcon symbol={symbol} size={16} />
      {tapeUsd(pnl, true)}
    </span>
  );
}

export function Tape({ inline = false }: { inline?: boolean }) {
  const tape = useStore((s) => s.tape);
  return (
    <div className={`tape ${inline ? "inline" : ""}`} aria-label="Latest trades">
      {tape.slice(0, 24).map((chip) => (
        <Chip key={`${chip.type}${chip.id}${chip.time}`} chip={chip} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";
const DepositDialog = lazy(() => import("./Deposit"));

// The last thing that had the focus outside any dialog: where the focus goes back to when one
// closes. (By the time a dialog's own effect runs, its first field has already taken the focus.)
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
    // Whatever opened the dialog gets the focus back when it closes.
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
      <div className={`dialog ${wide ? "wide" : ""} ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={box}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="close-x" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

function ConnectDialog() {
  const [options, setOptions] = useState<WalletOption[]>(walletOptions);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    // Wallets announce themselves a moment after load.
    const timer = setTimeout(() => setOptions(walletOptions()), 150);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Dialog title={PREVIEW ? "Start trading" : "Connect a wallet"}>
      {options.length === 0 && <p className="note">No wallet found in this browser. Install one such as MetaMask or Rabby, then reload this page.</p>}
      {options.map((option) => (
        <button
          key={option.id}
          className="wallet-option"
          disabled={busy !== null}
          onClick={async () => {
            setBusy(option.id);
            await connectWith(option);
            setBusy(null);
          }}
        >
          {option.icon && <img src={option.icon} alt="" />}
          {option.name}
          <small>{busy === option.id ? "Connecting" : option.note}</small>
        </button>
      ))}
      <p className="note">
        {PREVIEW
          ? "$10,000 to trade with, kept in this browser. Nothing to install."
          : "Connecting only shows your address. You sign once more to turn on one-click trading; that key can trade but can never withdraw."}
      </p>
    </Dialog>
  );
}

function WithdrawDialog() {
  const account = useStore(s => s.account);
  const offline = useStore(s => s.offline);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const free = big(account?.balance) - big(account?.reserved);
  const max = free > 0n ? free : 0n;
  const amount = parseUsd(text);
  const disabled = busy || !!offline || !amount || amount > max;
  const label = offline ? "Offline" : !amount ? "Enter an amount" : amount > max ? "More than your free balance" : busy ? "Waiting for your signature" : "Withdraw";
  return <Dialog title="Withdraw USDC">
    <div className="kv"><span>Free balance</span><span>{usdDown(max)}</span></div>
    <div className="field-row"><img src="/img/usdc.png" alt="" width="20" height="20" />
      <input className="input" style={{ height: 36, fontSize: 15 }} autoFocus inputMode="decimal" aria-label="Amount in USDC" placeholder="0" value={text} onChange={event => setText(amountTyped(text, event.target.value, event.nativeEvent as InputEvent))} />
      <button className="chip" style={{ height: 36 }} onClick={() => setText(usdInput(max))}>Max</button>
    </div>
    <button className="btn primary big wide" disabled={disabled} onClick={async () => {
      if (disabled || !amount || locked.current) return;
      locked.current = true; setBusy(true);
      try { if (await withdraw(amount)) setState({ dialog: null }); } finally { locked.current = false; setBusy(false); }
    }}>{label}</button>
    <p className="note">{PREVIEW ? "Moves between this account's wallet and the exchange." : "You sign with your wallet and the USDC goes straight to it. Margin in open positions and queued winnings stay where they are."}</p>
  </Dialog>;
}

function UsernameDialog() {
  const current = useStore((s) => s.account?.name);
  const [text, setText] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const name = text.trim().toLowerCase();
  const valid = /^[a-z0-9_]{3,16}$/.test(name);
  return (
    <Dialog title="Claim a username">
      <input
        className="input left"
        style={{ height: 36, fontSize: 15 }}
        autoFocus
        aria-label="Username"
        placeholder="3 to 16 letters, numbers or _"
        maxLength={16}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        className="btn primary big wide"
        disabled={!valid || busy || name === current}
        onClick={async () => {
          setBusy(true);
          const ok = await claimUsername(name);
          setBusy(false);
          if (ok) setState({ dialog: null });
        }}
      >
        {busy ? "Waiting for your signature" : valid ? `Claim ${name}` : "Pick a name"}
      </button>
      <p className="note">It replaces your address on the leaderboard. Signing it costs nothing and moves nothing.</p>
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const owner = useStore((s) => s.owner);
  if (dialog === "connect") return <ConnectDialog />;
  if (dialog === "deposit") return <Suspense fallback={<Dialog title="Deposit USDC" className="deposit-dialog"><div className="deposit-address-loading" role="status">Opening your deposit…</div></Dialog>}><DepositDialog key={owner} /></Suspense>;
  if (dialog === "withdraw") return <WithdrawDialog />;
  if (dialog === "username") return <UsernameDialog />;
  if (dialog === "share") return <ShareDialog />;
  return null;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <b>{t.title}</b>
          {t.body && <span>{t.body}</span>}
        </div>
      ))}
    </div>
  );
}
