import { tx, Localized } from "../lib/i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { claimUsername } from "../lib/actions";
import { post } from "../lib/api";
import { big, percent, price, priceNumber, shortAddress, usd, usdExact, usdNumber } from "../lib/format";
import { BRAND, LEGACY, PREVIEW, exchangeHref } from "../lib/mode";
import { navigate, setState, toast, useStore } from "../lib/store";
import { connectWith, disconnect, walletOptions, type WalletOption } from "../lib/wallet";
import type { TapeChip } from "../lib/types";
import { ShareDialog } from "./Share";
import { Wordmark } from "./Wordmark";
import { Link } from "./Link";
import { Dialog } from "./Dialog";
import DepositDialog from "./Deposit";
import WithdrawDialog from "./Withdraw";
import { LanguagePicker } from "./LanguagePicker";
export { Dialog } from "./Dialog";
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
        {tx(label)}
      </button>
      {open && (<div className={`menu ${align ?? ""}`} role="menu">
          {children}
        </div>)}
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
      href={exchangeHref("/trade")}
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

/** The secondary pages shared by the desktop and mobile More menus. */
function MoreItems() {
  return (
    <>
      {MORE.map(([to, label]) => (
        <Link key={to} to={to}>
          {tx(label)}
        </Link>
      ))}
      {PREVIEW && (
        <button
          onClick={async () => {
            // The tab that runs the exchange drops its world and tells every tab to reload.
            await post("/reset", {}).catch(() => {});
            for (const key of Object.keys(localStorage)) if (key.startsWith("tape:")) localStorage.removeItem(key);
            location.reload();
          }}
        >{tx("Start the preview over")}</button>
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
  // Total account funds include posted margin and unpaid winnings. Cash availability is separate.
  const free = big(account?.balance) - big(account?.reserved);
  const available = free > 0n ? free : 0n;
  const queued = big(account?.queued);
  const margin = big(account?.marginInUse);
  const reserved = big(account?.reserved);
  const balance = big(account?.balance) + margin + queued;
  const inMore = MORE.some(([to]) => to === path);
  const live = (markets ?? []).filter((m) => !m.retired);

  return (
    <>
      <header className="top">
        <Link to="/" className="top-brand">
          <Wordmark height={26} title={name} />
        </Link>
        <div className="top-quotes hide-narrow" aria-label={tx("Prices")}>
          {live.slice(0, 2).map((m) => (
            <Quote key={m.id} id={m.id} symbol={m.symbol} ref24h={m.ref24h} />
          ))}
        </div>
        <nav className="top-nav" aria-label={tx("Main")}>
          <Link to="/trade">{tx("Trade")}</Link>
          <Link to="/jackpot">{tx("Jackpot")}</Link>
          <Link to="/vault">{tx("Vault")}</Link>
          {coin && <Link to="/staking">{tx("Staking")}</Link>}
          <Link to="/leaderboard">{tx("Leaderboard")}</Link>
          <Link to="/stats">{tx("Stats")}</Link>
          <Popover
            align="right"
            className={inMore ? "on" : ""}
            label={
              <>
                {tx(" More ")}<i className="caret" aria-hidden="true" />
              </>
            }
          >
            <MoreItems />
          </Popover>
        </nav>
        <LanguagePicker />
        {owner ? (<div className="wallet">
            <Popover
              align="right"
              className="wallet-main"
              label={
                <>
                  <i className="wallet-dot" aria-hidden="true" />
                  <span className="wallet-text" title={tx("Total balance includes cash, margin in open positions and queued winnings.")}>
                    <b aria-label={tx("Total balance {0}", [account ? usd(balance) : "loading"])}>{account ? usd(balance) : "—"}</b>
                    {queued > 0n
                      ? <small className="wallet-queue-label"><Localized message={"{0}{1} queued"} values={[PREVIEW ? tx("practice · ") : "", usd(queued)]} /></small>
                      : <small>{PREVIEW ? tx("practice") : (account?.name ?? shortAddress(owner))}</small>}
                  </span>
                  <i className="caret" aria-hidden="true" />
                </>
              }
            >
              <div className="wallet-summary" role="group" aria-label={tx("Balance breakdown")}>
                <strong className="wallet-summary-owner">{account?.name ?? shortAddress(owner)}</strong>
                <dl>
                  <div className="wallet-summary-total"><dt>{tx("Total balance")}</dt><dd>{account ? usd(balance) : "—"}</dd></div>
                  <div><dt>{tx("Available to withdraw")}</dt><dd>{account ? usdExact(available) : "—"}</dd></div>
                  {margin > 0n && <div><dt>{tx("In open positions")}</dt><dd>{usd(margin)}</dd></div>}
                  {reserved > 0n && <div><dt>{tx("Pending orders")}</dt><dd>{usd(reserved)}</dd></div>}
                  <div><dt>{tx("Queued winnings")}</dt><dd>{account ? usd(queued) : "—"}</dd></div>
                </dl>
                {queued > 0n && <p>{tx("Queued winnings are included in your total. They become withdrawable once the vault pays them.")}</p>}
              </div>
              <Link to="/portfolio">{tx("Portfolio")}</Link>
              {!LEGACY && <button onClick={() => setState({ dialog: "deposit" })}>{tx("Deposit")}</button>}
              <button onClick={() => setState({ dialog: "withdraw" })}>{tx("Withdraw")}</button>
              <button onClick={() => navigator.clipboard?.writeText(owner).then(() => toast("info", "Address copied"), () => {})}>{tx("Copy address")}</button>
              <button onClick={() => setState({ dialog: "username" })}>{account?.name ? tx("Change username") : tx("Claim a username")}</button>
              <hr className="menu-rule" />
              <button onClick={disconnect}>{tx("Disconnect")}</button>
            </Popover>
            <button className="wallet-withdraw" onClick={() => setState({ dialog: "withdraw" })} aria-label={tx("Withdraw")} title={tx("Withdraw")}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5" /></svg>
              <span className="hide-narrow">{tx("Withdraw")}</span>
            </button>
            {!LEGACY && <button className="wallet-add" onClick={() => setState({ dialog: "deposit" })} aria-label={tx("Deposit")} title={tx("Deposit")}>
              <span aria-hidden="true">+</span>
              <span className="hide-narrow">{tx("Deposit")}</span>
            </button>}
          </div>) : (<button className="wallet-connect" onClick={() => setState({ dialog: "connect" })}>
            {PREVIEW ? tx("Start trading") : tx("Connect wallet")}
          </button>)}
      </header>

      {/* On a phone the menu is a row of tabs along the bottom of the screen, under the thumb. */}
      <nav className="tabbar" aria-label={tx("Main")}>
        <Link to="/trade"><Localized message={"{0}Trade"} values={[<Glyph name="trade" />]} /></Link>
        <Link to="/portfolio"><Localized message={"{0}Portfolio"} values={[<Glyph name="portfolio" />]} /></Link>
        <Link to="/vault"><Localized message={"{0}Vault"} values={[<Glyph name="vault" />]} /></Link>
        {coin && (<Link to="/staking"><Localized message={"{0}Staking"} values={[<Glyph name="coin" />]} /></Link>)}
        <Popover
          align="up"
          className={inMore || path === "/leaderboard" || path === "/stats" || path === "/jackpot" ? "on" : ""}
          label={
            <>
              <Glyph name="more" />
              {tx(" More ")}</>
          }
        >
          <Link to="/jackpot">{tx("Jackpot")}</Link>
          <Link to="/leaderboard">{tx("Leaderboard")}</Link>
          <Link to="/stats">{tx("Stats")}</Link>
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
        <b>{tx("Offline.")}</b> {tx(offline)}
      </div>
    );
  }
  if (source === "preview") {
    return null;
  }
  if (source === "dev") {
    return (
      <div className="banner"><Localized message={"<0>Test mode.</0> Local chain {0}, play money, simulated prices. Nothing here is real."} values={[chainId]} components={[<b />]} /></div>
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
      <span className={`tchip ${chip.isLong ? "win" : "loss"}`} title={tx("{0} {1} opened", [symbol, chip.isLong ? "long" : "short"])}>
        <AssetIcon symbol={symbol} size={16} />
        <span className="arrow">{chip.isLong ? "▲" : "▼"}</span>
        {tapeUsd(usdNumber(chip.notional), false)}
      </span>
    );
  }
  const pnl = usdNumber(chip.pnl);
  return (
    <span className={`tchip ${chip.busted ? "busted" : pnl >= 0 ? "win" : "loss"}`} title={chip.busted ? tx("{0} position liquidated", [symbol]) : tx("{0} position closed", [symbol])}>
      <AssetIcon symbol={symbol} size={16} />
      {tapeUsd(pnl, true)}
    </span>
  );
}

export function Tape({ inline = false }: { inline?: boolean }) {
  const tape = useStore((s) => s.tape);
  return (
    <div className={`tape ${inline ? "inline" : ""}`} aria-label={tx("Latest trades")}>
      {tape.slice(0, 24).map((chip) => (
        <Chip key={`${chip.type}${chip.id}${chip.time}`} chip={chip} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

function ConnectDialog() {
  const [options, setOptions] = useState<WalletOption[]>(walletOptions);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    // Wallets announce themselves a moment after load.
    const timer = setTimeout(() => setOptions(walletOptions()), 150);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Dialog title={PREVIEW ? tx("Start trading") : tx("Connect a wallet")}>
      {options.length === 0 && <p className="note">{tx("No wallet found in this browser. Install one such as MetaMask or Rabby, then reload this page.")}</p>}
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
          <small>{busy === option.id ? tx("Connecting") : option.note}</small>
        </button>
      ))}
      <p className="note">
        {PREVIEW
          ? tx("$10,000 to trade with, kept in this browser. Nothing to install.")
          : tx("Connecting only shows your address. You sign once more to turn on one-click trading; that key can trade but can never withdraw.")}
      </p>
    </Dialog>
  );
}

function UsernameDialog() {
  const current = useStore((s) => s.account?.name);
  const [text, setText] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const name = text.trim().toLowerCase();
  const valid = /^[a-z0-9_]{3,16}$/.test(name);
  return (
    <Dialog title={tx("Claim a username")}>
      <input
        className="input left"
        style={{ height: 36, fontSize: 15 }}
        autoFocus
        aria-label={tx("Username")}
        placeholder={tx("3 to 16 letters, numbers or _")}
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
        {busy ? tx("Waiting for your signature") : valid ? tx("Claim {0}", [name]) : tx("Pick a name")}
      </button>
      <p className="note">{tx("It replaces your address on the leaderboard. Signing it costs nothing and moves nothing.")}</p>
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const owner = useStore((s) => s.owner);
  const recovery = useStore((s) => s.config?.recovery);
  if (dialog === "connect") return <ConnectDialog />;
  if (dialog === "deposit" && recovery?.paused) return <Dialog title={tx("Deposits paused")}><p>{tx("Deposits are unavailable during emergency recovery. Your available trading balance can be withdrawn to your wallet.")}</p><button className="btn primary" onClick={() => setState({ dialog: "withdraw" })}>{tx("Withdraw USDC")}</button></Dialog>;
  if (dialog === "deposit" && LEGACY) return <Dialog title={tx("Previous exchange")}><p>{tx("Deposits have moved to the current exchange.")}</p><a className="btn primary" href="/trade">{tx("Open current Tape")}</a></Dialog>;
  // Ready with the exchange shell: opening a money action must not wait for another script.
  if (dialog === "deposit") return <DepositDialog key={owner} />;
  if (dialog === "withdraw") return <WithdrawDialog key={owner} />;
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
          <b>{tx(t.title)}</b>
          {t.body && <span>{tx(t.body)}</span>}
        </div>
      ))}
    </div>
  );
}
