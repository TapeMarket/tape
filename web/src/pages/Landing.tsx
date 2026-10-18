import { clockText, useJackpot } from "../lib/jackpot";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Link } from "../components/Link";
import { Wordmark } from "../components/Wordmark";
import { MarketDataCredit } from "../components/MarketDataCredit";
import { LandingArrow, TapeSculpture } from "../components/TapeHero";
import { loadCoin, loadHouse } from "../lib/api";
import { coin as coinText, usd, usdCompact, usdNumber } from "../lib/format";
import { usePoll } from "../lib/house";
import { BRAND, PREVIEW } from "../lib/mode";
import { useStore } from "../lib/store";

const delay = (seconds: number) => ({ "--d": `${seconds}s` }) as CSSProperties;
const toHow = (e: { preventDefault: () => void }) => {
  e.preventDefault();
  document.getElementById("how")?.scrollIntoView({ behavior: "smooth" });
};

/** Marks each [data-reveal] inside `root` once it scrolls into view; the stylesheet animates it in. */
function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // Only with this class does anything start hidden: without script the page is all there.
    el.classList.add("lp-js");
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    el.querySelectorAll("[data-reveal]").forEach((item) => io.observe(item));
    return () => io.disconnect();
  }, []);
}

/** The Rekt Jackpot: this hour's pot, live, and what it is. */
function JackpotBand() {
  const jackpot = useJackpot();
  const available = useStore((s) => Boolean(s.config?.addresses.jackpot));
  const now = Math.floor(Date.now() / 1000);
  if (!PREVIEW && !available) return null;
  return (
    <section className="lp-jackpot" data-reveal>
      <div>
        <h2>Rekt Jackpot</h2>
        <p>Every dollar you lose is a ticket. Every hour, one ticket wins the whole pot, paid in USDC to the winner's wallet.</p>
        <Link to="/jackpot" className="lp-btn primary">
          See the pot <LandingArrow />
        </Link>
      </div>
      <div className="lp-jackpot-pot">
        <span>This hour's pot</span>
        <b>{jackpot ? usd(jackpot.prize) : "–"}</b>
        <small>{jackpot ? `draws in ${clockText(jackpot.end - now)}` : ""}</small>
      </div>
    </section>
  );
}

/** A strip of tape that never stops: the same run twice, side by side, sliding by one run's width. */
function Band({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={`band ${className}`}>
      <div className="band-track">
        <div className="band-run">{children}</div>
        <div className="band-run" aria-hidden="true">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Brand tape, with no market quotes or simulated trade prints. */
function BrandBand() {
  return <Band className="band-a">{Array.from({ length: 8 }, (_, i) => <span className="band-item band-logo" key={i}><Wordmark height={30} /></span>)}</Band>;
}

function TermsBand() {
  const words = ["1000x leverage", "0 fees to open", "0 funding", "0 market impact", "Crypto, gold and stocks", "Fully onchain settlement", "Settled in USDC"];
  return <Band className="band-b">{[0, 1].flatMap((n) => words.map((word) => <span className="band-item" key={`${n}${word}`}>{word}</span>))}</Band>;
}

function SocialLinks() {
  return <>
    <a className="lp-social-link" href="https://x.com/TapeTrade_" target="_blank" rel="noopener noreferrer" aria-label="X / Twitter (opens in a new tab)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
      X / Twitter
    </a>
    <a className="lp-social-link" href="https://github.com/TapeMarket/tape" target="_blank" rel="noopener noreferrer" aria-label="GitHub (opens in a new tab)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.37 0 0 5.373 0 12c0 5.303 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.084-.73.084-.73 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.42-1.305.763-1.605-2.665-.305-5.467-1.334-5.467-5.93 0-1.31.468-2.38 1.235-3.22-.123-.303-.535-1.523.117-3.176 0 0 1.008-.322 3.301 1.23A11.52 11.52 0 0 1 12 5.603c1.02.005 2.045.138 3.003.404 2.291-1.552 3.297-1.23 3.297-1.23.654 1.653.242 2.873.119 3.176.769.84 1.233 1.91 1.233 3.22 0 4.608-2.807 5.622-5.479 5.918.43.372.823 1.103.823 2.222 0 1.606-.015 2.898-.015 3.293 0 .32.216.694.825.576C20.565 21.796 24 17.3 24 12c0-6.627-5.373-12-12-12z" /></svg>
      GitHub
    </a>
  </>;
}

function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className={`lp-nav ${scrolled ? "scrolled" : ""}`}>
      <Link to="/" className="lp-logo">
        <Wordmark height={28} />
      </Link>
      <nav aria-label="Site">
        <a href="#how" onClick={toHow}>
          How it works
        </a>
        <Link to="/jackpot">Jackpot</Link>
        <Link to="/staking">Staking</Link>
        <Link to="/leaderboard">Leaderboard</Link>
        <Link to="/docs">Docs</Link>
      </nav>
      <Link to="/trade" className="lp-launch">
        Launch app <LandingArrow />
      </Link>
    </header>
  );
}

/** The front page. */
export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  useReveal(root);
  usePoll(loadHouse, 15_000);
  usePoll(loadCoin, 30_000);
  const house = useStore((s) => s.house);
  const coinState = useStore((s) => s.coin);
  const markets = useStore((s) => s.config?.markets);
  const exchange = useStore((s) => s.config?.addresses.exchange);
  const chainId = useStore((s) => s.config?.chainId);
  const coin = useStore((s) => s.config?.coin?.symbol) ?? BRAND.toUpperCase();
  const coinPending = !PREVIEW && !coinState?.attached;
  const listed = (markets ?? []).filter((m) => !m.retired);
  const leverage = listed.length ? Math.max(...listed.map((m) => m.maxLeverage)) : 1000;
  const figures = [
    { label: "Traded", value: house ? usdNumber(house.totals.volume) : 0, format: (n: number) => usdCompact(BigInt(Math.round(n * 1e6))) },
    { label: "Trades", value: house ? house.totals.trades : 0, format: (n: number) => Math.round(n).toLocaleString("en-US") },
    { label: "Traders", value: house ? house.totals.traders : 0, format: (n: number) => Math.round(n).toLocaleString("en-US") },
    { label: "Max leverage", value: leverage, format: (n: number) => `${Math.round(n)}x` },
  ];

  return (
    <div className={`lp ${paused ? "lp-paused" : ""}`} ref={root}>
      <Nav />

      <section className="lp-hero">
        <div className="lp-hero-grid">
          <div className="lp-hero-copy">
            <h1 className="rise" style={delay(0.15)}>
              <span>{listed.length ? `Trade ${listed.length} markets.` : "Trade global markets."}</span>
              <span>Up to <em>{leverage}x</em>.</span>
            </h1>
            <div className="lp-hero-description rise" style={delay(0.3)}>
              <p className="lp-hero-markets">Crypto, stocks, gold and the S&amp;P 500.</p>
              <ul className="lp-hero-benefits" role="list">
                <li><strong>0 market impact</strong> on underlying prices.</li>
                <li><strong>Fully onchain</strong> USDC settlement on Ethereum.</li>
                <li><strong>No opening fee or funding.</strong></li>
              </ul>
              <p className="lp-hero-disclosure">Leverage varies by market.</p>
            </div>
            <div className="lp-cta rise" style={delay(0.42)}>
              <Link to="/trade" className="lp-btn primary">
                Start trading <LandingArrow />
              </Link>
              <a href="#how" className="lp-btn" onClick={toHow}>
                How it works
              </a>
            </div>
            <nav className="lp-socials" aria-label="Community">
              <SocialLinks />
            </nav>
            <MarketDataCredit className="lp-data-credit" logo />
            {coinPending && <p className="lp-live-note">Exchange live on Ethereum. Coin launch pending.</p>}
          </div>
          <TapeSculpture />
        </div>
        <div className="lp-bands" aria-hidden="true">
          <BrandBand />
          <TermsBand />
        </div>
        <button type="button" className="lp-motion-control" aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? "Play tape" : "Pause tape"}<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">{paused ? <path d="M3 1.5 10 6 3 10.5Z" fill="currentColor" /> : <path d="M3 2v8m6-8v8" stroke="currentColor" strokeWidth="2" />}</svg></button>
      </section>

      <section className="lp-numbers" aria-label="The exchange so far">
        <p className="lp-numbers-caption">{PREVIEW ? "Practice exchange activity" : "Exchange activity"}</p>
        {figures.map((f, i) => (
          <div className="lp-number" key={f.label} data-reveal style={delay(i * 0.08)}>
            <b>
              {f.format(f.value)}
            </b>
            <span>{f.label}</span>
          </div>
        ))}
      </section>

      <section className="lp-shot">
        <header className="lp-shot-head"><h2>The trading screen.</h2><Link to="/trade" className="lp-link">Open app <LandingArrow /></Link></header>
        <div className="lp-frame" data-reveal>
          <div className="lp-frame-bar"><Wordmark height={18} /><span>{PREVIEW ? "Practice preview" : "Tape trading"}</span><Link to="/trade">Open trading screen <LandingArrow /></Link></div>
          <Link to="/trade" className="lp-frame-img">
            <picture><source media="(max-width: 600px)" srcSet="/img/terminal-mobile.png?v=landing3" /><img src="/img/terminal-landing.png?v=landing3" alt={`The ${BRAND} trading screen in practice preview`} width="1360" height="780" loading="lazy" /></picture>
          </Link>
        </div>
        <p className="lp-caption">Practice preview of the trading screen: price chart, order ticket, your positions and exchange activity.</p>
      </section>

      <section className="lp-how" id="how">
        <header data-reveal>
          <h2>How a trade works</h2>
        </header>
        <ol className="lp-steps">
          <li data-reveal style={delay(0)}>
            <div className="art art-side" aria-hidden="true">
              <span className="art-long">▲ Long</span>
              <span className="art-short">▼ Short</span>
            </div>
            <span className="lp-step-n">01</span>
            <h3>Pick a side</h3>
            <p>Long if you think the price will rise, short if you think it will fall.</p>
          </li>
          <li data-reveal style={delay(0.12)}>
            <div className="art art-lev" aria-hidden="true">
              <span className="art-ruler">
                <i />
              </span>
              <span className="art-marks">
                <span>1x</span>
                <span>10x</span>
                <span>100x</span>
                <span>{leverage}x</span>
              </span>
            </div>
            <span className="lp-step-n">02</span>
            <h3>Set the leverage</h3>
            <p>From 1x to {leverage}x. Your position size is margin times leverage and is fixed when it opens.</p>
          </li>
          <li data-reveal style={delay(0.24)}>
            <div className="art art-measure" aria-hidden="true">
              <span className="art-tape">
                <i />
              </span>
              <span className="art-say">
                <b>0.45%</b> to liquidation
              </span>
              <span className="art-win">+$93.40</span>
            </div>
            <span className="lp-step-n">03</span>
            <h3>Close it</h3>
            <p>Close whenever you want. If the price reaches your liquidation price first, you lose the margin. The order ticket shows how far away that is.</p>
          </li>
        </ol>
      </section>

      <section className="lp-terms">
        <div className="lp-terms-copy" data-reveal>
          <h2>Fees.</h2>
          <p>
            There is no opening fee, no funding and no spread. The vault takes its share from winning trades when they close. {coinPending ? "Loss rewards will start when the coin is attached." : `Losing trades earn $${coin}.`}
          </p>
          <Link to="/docs" className="lp-link">
            Read the docs <LandingArrow />
          </Link>
        </div>
        <dl className="lp-receipt" data-reveal style={delay(0.1)}>
          <div className="lp-receipt-head">
            <Wordmark height={22} />
            <span>Terms of trade</span>
          </div>
          {[
            ["Fee to open", "$0"],
            ["Funding", "$0"],
            ["Spread", "$0"],
            ["Max leverage", `${leverage}x`],
            ["Markets", listed.length ? String(listed.length) : "–"],
            ["Settled in", "USDC"],
            ["Loss rewards", coinPending ? "Coin launch pending" : `$${coin}`],
            ["Vault started at", "$0"],
          ].map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
          <p className="lp-receipt-foot">settled on Ethereum</p>
        </dl>
      </section>

      <JackpotBand />

      <section className="lp-stake">
        <div className="lp-stake-copy" data-reveal>
          <h2>{coinPending ? "Coin launch pending." : `Staking $${coin}`}</h2>
          <p>
            {coinPending ? "The exchange is live. Staking and loss rewards will be enabled when the coin is deployed and attached." : `Every losing trade earns $${coin}. Stake it to earn a share of what the exchange settles, paid in USDC. There is no lockup: unstake whenever you want.`}
          </p>
          <Link to="/staking" className="lp-btn primary">
            {coinPending ? "About staking" : `Stake $${coin}`} <LandingArrow />
          </Link>
        </div>
        <dl className="lp-stake-figs" data-reveal style={delay(0.1)}>
          <div>
            <dt>Total supply</dt>
            <dd>{coinState?.attached ? coinText(coinState.supply) : "–"}</dd>
          </div>
          <div>
            <dt>Paid to losing traders</dt>
            <dd>{coinState?.attached ? coinText(coinState.mining.mined) : "–"}</dd>
          </div>
          <div>
            <dt>Staked</dt>
            <dd>{coinState?.attached ? coinText(coinState.stakingState.totalStaked) : "–"}</dd>
          </div>
          <div>
            <dt>Paid to stakers</dt>
            <dd>{coinState?.attached ? usd(coinState.stakingState.totalReceived) : "–"}</dd>
          </div>
        </dl>
      </section>

      <section className="lp-final" data-reveal>
        <div className="lp-final-tape">
          <h2>Trade from $10.</h2>
          <Link to="/trade" className="lp-btn light">
            Start trading <LandingArrow />
          </Link>
        </div>
      </section>

      <footer className="lp-foot">
        <Wordmark height={52} />
        <p>Perps on Ethereum, settled in USDC. A position can lose all of its margin.</p>
        <nav aria-label="More">
          <Link to="/docs">Docs</Link>
          <Link to="/status">Status</Link>
          <Link to="/leaderboard">Leaderboard</Link>
          <div className="lp-foot-socials"><SocialLinks /></div>
          {!PREVIEW && exchange && chainId === 1 && (
            <a href={`https://etherscan.io/address/${exchange}#code`} target="_blank" rel="noreferrer">
              Contract
            </a>
          )}
        </nav>
      </footer>
    </div>
  );
}
