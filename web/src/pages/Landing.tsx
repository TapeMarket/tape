import { clockText, useJackpot } from "../lib/jackpot";
import { isTradFi, listWords, nameOf } from "../lib/names";
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
  const words = ["1000x leverage", "0 fees to open", "0 funding", "Crypto, gold and stocks", "Settled in USDC"];
  return <Band className="band-b">{[0, 1].flatMap((n) => words.map((word) => <span className="band-item" key={`${n}${word}`}>{word}</span>))}</Band>;
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
  const leverage = Math.max(1000, ...(markets ?? []).map((m) => m.maxLeverage));
  const listed = (markets ?? []).filter((m) => !m.retired);
  // The headline names the markets at the top leverage; the line under it the rest.
  const top = listed.filter((m) => m.maxLeverage === leverage).map((m) => m.symbol);
  const pair = top.length ? listWords(top) : "BTC and ETH";
  const others = listed.filter((m) => m.maxLeverage !== leverage);
  const crypto = others.filter((m) => !isTradFi(m.symbol)).map((m) => m.symbol);
  const tradfi = others.filter((m) => isTradFi(m.symbol)).map((m) => (m.symbol === "SPX" ? "the S&P 500" : m.symbol === "GOLD" ? "gold" : nameOf(m.symbol)));
  const more = [...crypto, ...tradfi];
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
              <span>Trade {pair}</span>
              <span>at <em>{leverage}x</em>.</span>
            </h1>
            <p className="rise" style={delay(0.3)}>
              {more.length ? `Plus ${listWords(more)}, at up to ${Math.max(...others.map((m) => m.maxLeverage))}x.` : `Up to ${leverage}x on ${pair}.`} Settled in USDC on
              Ethereum. Opening a position is free and there is no funding.
            </p>
            <div className="lp-cta rise" style={delay(0.42)}>
              <Link to="/trade" className="lp-btn primary">
                Start trading <LandingArrow />
              </Link>
              <a href="#how" className="lp-btn" onClick={toHow}>
                How it works
              </a>
            </div>
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
            ["Markets", pair],
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
