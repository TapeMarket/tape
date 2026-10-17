import { useEffect, useRef, useState } from "react";
import { MAX_IMPACT_NOTIONAL, REFERENCE_NOTIONAL, bustPrice, impactNotionalFor, keepShare, quoteClose, sizeLevel } from "@shared/math.mjs";
import { openPosition, startSession, triggersOnFill } from "../lib/actions";
import { checkTriggers, TriggerFields } from "./Triggers";
import { useSecond } from "./Tables";
import { amountTyped, big, parseUsd, percent, price, priceNumber, usd, usdCompact, usdDown, usdInput } from "../lib/format";
import { PREVIEW } from "../lib/mode";
import { setState, useStore } from "../lib/store";
import type { Market } from "../lib/types";

const STOPS = 1000;
const least = (a: bigint, b: bigint) => (a < b ? a : b);
const most = (a: bigint, b: bigint) => (a > b ? a : b);
const SHARES = [10n, 25n, 50n, 100n];

// The slider is exponential: half way is about 30x, so the low end stays usable.
const toLeverage = (stop: number, max: number) => Math.max(1, Math.min(max, Math.round(Math.exp((Math.log(max) * stop) / STOPS))));
const toStop = (leverage: number, max: number) => Math.round((STOPS * Math.log(Math.max(1, leverage))) / Math.log(max));

/** Everything the account is worth right now, and how it splits: the slip's foot. */
function Equity() {
  const account = useStore((s) => s.account);
  const ticks = useStore((s) => s.ticks);
  const markets = useStore((s) => s.config?.markets);
  const dash = <span className="dim">– –</span>;
  let openPnl = 0n;
  let margin = 0n;
  let available = 0n;
  if (account && markets) {
    for (const p of account.positions) {
      margin += big(p.margin);
      const mark = ticks[p.market]?.p;
      if (mark) openPnl += quoteClose({ entryPrice: big(p.entryPrice), margin: big(p.margin), leverage: p.leverage, isLong: p.isLong, impactNotional: p.impactNotional }, markets[p.market], mark).pnl;
    }
    const free = big(account.balance) - big(account.reserved);
    available = free > 0n ? free : 0n;
  }
  const known = Boolean(account && markets);
  return (
    <div className="slip-account" aria-label="Account">
      <div className="slip-equity">
        <small>Equity</small>
        <b>{known ? usd(available + margin + openPnl + big(account!.queued)) : dash}</b>
      </div>
      <div className="slip-account-grid">
        <span>
          <small>Available</small>
          {known ? usdDown(available) : dash}
        </span>
        <span>
          <small>In use</small>
          {known ? usd(margin) : dash}
        </span>
        <span>
          <small>Open PnL</small>
          {known ? <span className={openPnl > 0n ? "up" : openPnl < 0n ? "down" : ""}>{usd(openPnl, { sign: true })}</span> : dash}
        </span>
        {known && big(account!.queued) > 0n && (
          <span title="Winnings the vault owes you. Paid in order as losses come in.">
            <small>Queued</small>
            <span className="warn">{usd(account!.queued)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/** Distances on the tape measure: a log scale from 0.01% to 100%. */
const MEASURE_LO = Math.log10(0.0001);
const MEASURE_HI = Math.log10(1);
const MEASURE_TICKS: [number, string][] = [
  [0.0001, "0.01%"],
  [0.001, "0.1%"],
  [0.01, "1%"],
  [0.1, "10%"],
  [1, "100%"],
];
const onMeasure = (fraction: number) => Math.min(1, Math.max(0, (Math.log10(Math.max(fraction, 1e-6)) - MEASURE_LO) / (MEASURE_HI - MEASURE_LO)));

/** The tape measure: how far the price can move against the position before it busts. */
function Measure({ mark, bust, isLong, symbol }: { mark: bigint | null; bust: bigint | null; isLong: boolean; symbol: string }) {
  if (!mark || !bust) {
    return (
      <div className="measure">
        <div className="measure-say dim">Waiting for a price.</div>
      </div>
    );
  }
  const markNumber = priceNumber(mark);
  const gap = Math.abs(markNumber - priceNumber(bust));
  const fraction = gap / markNumber;
  const reach = onMeasure(fraction);
  const tight = fraction < 0.002;
  return (
    <div className={`measure ${tight ? "tight" : ""}`}>
      <div className="measure-say">
        {symbol} can move <b>{percent(fraction, fraction < 0.01 ? 3 : 2)}</b> (${gap >= 100 ? gap.toFixed(0) : gap.toFixed(2)}) {isLong ? "down" : "up"} before this is liquidated.
      </div>
      <div className="measure-tape" aria-hidden="true">
        <i style={{ width: `${(reach * 100).toFixed(2)}%` }} />
        {MEASURE_TICKS.map(([at, label]) => (
          <span key={label} style={{ left: `${(onMeasure(at) * 100).toFixed(2)}%` }}>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Ticket({ market }: { market: Market }) {
  const owner = useStore((s) => s.owner);
  const account = useStore((s) => s.account);
  const ticket = useStore((s) => s.ticket);
  const tick = useStore((s) => s.ticks[market.id]);
  const config = useStore((s) => s.config)!;
  const offline = useStore((s) => s.offline);
  const session = useStore((s) => s.session);
  const now = useSecond();
  // The market as the house last reported it: how much is open on each side right now.
  const book = useStore((s) => s.house?.markets[market.id]) ?? market;
  const [marginText, setMarginText] = useState("10");
  const [leverageText, setLeverageText] = useState<string | null>(null);
  const [useQueued, setUseQueued] = useState(false);
  const [withTriggers, setWithTriggers] = useState(false);
  const [tpText, setTpText] = useState("");
  const [slText, setSlText] = useState("");
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState(0);

  const { isLong } = ticket;
  const leverage = Math.min(ticket.leverage, market.maxLeverage);
  // While the box is being typed in it can hold something that is not a leverage (nothing, 0,
  // 1001). The order waits until it does: it must never go out at a number other than the one shown.
  const leverageValid = leverageText === null || (/^\d+$/.test(leverageText) && Number(leverageText) >= 1 && Number(leverageText) <= market.maxLeverage);
  // One click, one order. The relayer answers in a few milliseconds, so the button's own
  // "sending" state is over before the second click of a double click arrives. A second click
  // inside a double click's span is that; one after it is a second order, and is sent.
  const lastOrderAt = useRef(0);
  const DOUBLE_CLICK_MS = 300;
  const setTicket = (patch: Partial<typeof ticket>) => setState((s) => ({ ticket: { ...s.ticket, ...patch } }));

  const free = big(account?.balance) - big(account?.reserved);
  const queued = big(account?.queued);
  const spendable = (free > 0n ? free : 0n) + (useQueued ? queued : 0n);
  const minMargin = big(config.minMargin);
  const minNotional = big(config.minNotional);

  // The smallest margin that makes the smallest position at this market's top leverage: $10 at
  // 1000x, $50 at 200x. The quick amounts start there.
  const USD = 1_000_000n;
  const floorUsd = Number((minNotional + BigInt(market.maxLeverage) * USD - 1n) / (BigInt(market.maxLeverage) * USD));
  const smallest = Math.max(Number(minMargin / USD), floorUsd, 1);
  const presets = smallest <= 10 ? ["10", "25", "50", "100"] : [smallest, smallest * 2, smallest * 5, smallest * 10].map(String);
  useEffect(() => {
    // A market whose smallest position needs more margin than the box holds starts at that margin.
    const typed = parseUsd(marginText);
    if (typed === null || typed < BigInt(smallest) * USD) setMarginText(String(smallest));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.id]);

  const margin = parseUsd(marginText);
  const size = margin ? margin * BigInt(leverage) : 0n;
  const bust = tick ? bustPrice(tick.p, leverage, isLong, market) : null;
  // A position opened on a side that already holds more than the market's depth keeps less of a
  // small win. What it would be charged on is known before the click: it follows what is open.
  const ahead = big(isLong ? book.oiLong : book.oiShort);
  const impact = size > 0n && market.depth ? impactNotionalFor(ahead, size, market.depth) : null;
  const level = impact ? sizeLevel(impact) : 1;
  // The side can fill up in the two seconds an order takes to land. The order says how much of
  // that it will take: a quarter more than the ticket shows, or one depth deeper where that is
  // more (ordinary flow moves a quiet side by more than a quarter). Past that it is refused.
  const impactLimit = impact ? Number(least(MAX_IMPACT_NOTIONAL, most((impact * 5n + 3n) / 4n, impact + REFERENCE_NOTIONAL))) : 0;

  // A new trading key starts signing one block-slot after it is registered. Count that down.
  const activatesIn = session ? session.validFrom - now : 0;

  // The take-profit and stop-loss, checked against the position this ticket would open now.
  const triggerShape = {
    entryPrice: tick?.p ?? 0n,
    margin: margin ?? 0n,
    leverage,
    isLong,
    impactNotional: Number(impact ?? 100_000n),
    bust,
  };
  const triggerCheck = withTriggers ? checkTriggers(tpText, slText, triggerShape, tick?.p ?? null) : { takeProfit: null, stopLoss: null, error: null };

  let action: { label: string; disabled?: boolean; tone?: "primary" | "side"; run?: () => void };
  if (!owner) action = { label: PREVIEW ? "Start trading" : "Connect wallet", tone: "primary", run: () => setState({ dialog: "connect" }) };
  else if (!session) {
    action = {
      label: busy ? "Check your wallet" : "Turn on one-click trading",
      tone: "primary",
      disabled: busy,
      run: async () => {
        setBusy(true);
        await startSession();
        setBusy(false);
      },
    };
  } else if (activatesIn > 0) action = { label: `Trading on in ${activatesIn}s`, disabled: true };
  else if (offline) action = { label: "Offline: prices are not live", disabled: true };
  else if (!tick || now - tick.t > 6 || tick.t > now + 2) action = { label: "Waiting for live prices", disabled: true };
  else if (market.retired) action = { label: "Market retired", disabled: true };
  else if (config.opensPaused) action = { label: "New positions are paused", disabled: true };
  else if (!leverageValid) action = { label: `Leverage is a whole number, 1 to ${market.maxLeverage}`, disabled: true };
  else if (!margin || margin === 0n) action = { label: "Enter a margin", disabled: true };
  else if (margin < minMargin) action = { label: `Minimum ${usd(minMargin)}`, disabled: true };
  else if (size < minNotional) action = { label: `Minimum size is ${usdCompact(minNotional)}`, disabled: true };
  else if (size > big(market.maxNotional)) action = { label: `Size limit is ${usdCompact(market.maxNotional)}`, disabled: true };
  else if (margin > spendable) action = { label: "Deposit to trade", tone: "primary", run: () => setState({ dialog: "deposit" }) };
  else if (withTriggers && triggerCheck.error) action = { label: "Check the take-profit and stop-loss", disabled: true };
  else {
    action = {
      label: busy ? "Sending" : `${isLong ? "Long" : "Short"} ${market.symbol}`,
      tone: "side",
      disabled: busy,
      run: async () => {
        if (Date.now() - lastOrderAt.current < DOUBLE_CLICK_MS) return;
        lastOrderAt.current = Date.now();
        setBusy(true);
        const id = await openPosition({ market: market.id, isLong, margin, leverage, useQueued, impactLimit });
        if (id && withTriggers) {
          triggersOnFill(id, isLong, triggerCheck.takeProfit, triggerCheck.stopLoss);
          setTpText("");
          setSlText("");
        }
        setBusy(false);
      },
    };
  }
  const tone = action.disabled ? "" : action.tone === "side" ? (isLong ? "long" : "short") : action.tone === "primary" ? "primary" : "";

  const scaleMargin = (num: bigint, den: bigint) => {
    if (!margin) return;
    const next = (margin * num) / den;
    // Halving stops at the smallest margin. It never raises one that is already under it.
    if (next < margin && margin <= minMargin) return;
    setMarginText(usdInput(next > minMargin ? next : minMargin));
  };
  // Each press of % steps through 10, 25, 50 and 100 percent of what can be spent.
  const nextShare = () => {
    const percent = SHARES[share % SHARES.length];
    setShare(share + 1);
    setMarginText(usdInput((spendable * percent) / 100n));
  };

  const stop = toStop(leverage, market.maxLeverage);
  // Spread out on the log scale: closer marks would print over each other.
  const marks = [1, 10, 50, 200, 1000].filter((v) => v <= market.maxLeverage);

  return (
    <aside className="slip" aria-label="Order ticket">
      <div className="slip-body">
        <header className="slip-head"><h2>Place a trade</h2><span>{market.symbol} / USDC</span></header>
        <div className="slip-sides" role="group" aria-label="Direction">
          <button className="slip-side long" aria-label={`Select Long: ${market.symbol} goes up`} aria-pressed={isLong} onClick={() => setTicket({ isLong: true })}>
            <b><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 13 6-6 6 6M10 7v10" /></svg>Long</b>
            <small>{market.symbol} goes up</small>
          </button>
          <button className="slip-side short" aria-label={`Select Short: ${market.symbol} goes down`} aria-pressed={!isLong} onClick={() => setTicket({ isLong: false })}>
            <b><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 7 6 6 6-6M10 3v10" /></svg>Short</b>
            <small>{market.symbol} goes down</small>
          </button>
        </div>

        <div className="slip-field">
          <div className="slip-label">
            <label htmlFor="margin">Margin</label>
            <span>{owner && account ? `${usdDown(spendable)} available` : ""}</span>
          </div>
          <div className="slip-amount">
            <span aria-hidden="true">$</span>
            <input
              id="margin"
              inputMode="decimal"
              placeholder="0"
              value={marginText}
              onChange={(e) => setMarginText(amountTyped(marginText, e.target.value, e.nativeEvent as InputEvent))}
            />
            <small>USDC</small>
          </div>
          <div className="slip-chips">
            {presets.map((v) => (
              <button key={v} className="chip" aria-pressed={marginText === v} onClick={() => setMarginText(v)}>
                ${v}
              </button>
            ))}
            <button className="chip" onClick={() => scaleMargin(1n, 2n)} title="Halve the margin">
              ½
            </button>
            <button className="chip" onClick={nextShare} disabled={!owner} title="A share of what you can spend: 10, 25, 50, then 100 percent">
              %
            </button>
          </div>
        </div>

        <div className="slip-field">
          <div className="slip-label">
            <label htmlFor="leverage">Leverage</label>
            <span className="slip-lev">
              <input
                id="leverage"
                inputMode="numeric"
                value={leverageText ?? String(leverage)}
                onChange={(e) => {
                  const text = e.target.value.trim().slice(0, 6);
                  const whole = /^\d+$/.test(text);
                  // More than the market allows is held to the most it allows, in the box too.
                  if (whole && Number(text) > market.maxLeverage) {
                    setLeverageText(String(market.maxLeverage));
                    setTicket({ leverage: market.maxLeverage });
                    return;
                  }
                  // Anything that is not a whole number ("2.5", "1e2", nothing) stays as typed, and
                  // the order button waits for one: it is never read as some other number.
                  setLeverageText(text);
                  if (whole && Number(text) >= 1) setTicket({ leverage: Number(text) });
                }}
                onBlur={() => setLeverageText(null)}
              />
              x
            </span>
          </div>
          <input
            type="range"
            className="ruler"
            aria-label="Leverage"
            min={0}
            max={STOPS}
            value={stop}
            style={{ ["--at" as string]: `${(stop / STOPS) * 100}%` }}
            onChange={(e) => {
              setLeverageText(null);
              setTicket({ leverage: toLeverage(Number(e.target.value), market.maxLeverage) });
            }}
          />
          <div className="ruler-marks">
            {marks.map((v) => (
              <button
                key={v}
                aria-pressed={leverage === v}
                style={{ left: `${(toStop(v, market.maxLeverage) / STOPS) * 100}%` }}
                onClick={() => {
                  setLeverageText(null);
                  setTicket({ leverage: v });
                }}
              >
                {v}x
              </button>
            ))}
          </div>
        </div>

        <Measure mark={tick?.p ?? null} bust={bust} isLong={isLong} symbol={market.symbol} />

        <dl className="slip-receipt">
          <div>
            <dt>Position size</dt>
            <dd>{usdCompact(size)}</dd>
          </div>
          <div>
            <dt>Liquidation price</dt>
            <dd className="bust">{bust ? `$${price(bust)}` : "–"}</dd>
          </div>
          {impact !== null && level > 1 && (
            <div>
              <dt
                title={`${market.symbol} ${isLong ? "longs" : "shorts"} already hold ${usdCompact(ahead)}. Past ${usdCompact(BigInt(market.depth) * 1_000_000n)} on a side, a new position keeps less of a small win. Losses and the liquidation price are the same, and the terms are fixed once it opens.`}
              >
                Crowded side
              </dt>
              <dd className="warn">×{level.toFixed(level < 10 ? 2 : 1)}</dd>
            </div>
          )}
          <div>
            <dt>Fee to open</dt>
            <dd>$0</dd>
          </div>
        </dl>

        {impact !== null && level > 1 && (
          <p className="note">
            This side is crowded. A 0.10% win keeps {(keepShare(10, market, impact) * 100).toFixed(0)}% here, {(keepShare(10, market) * 100).toFixed(0)}% on a quiet side; a 1% win keeps{" "}
            {(keepShare(100, market, impact) * 100).toFixed(0)}%.
          </p>
        )}

        <div className="slip-triggers">
          <button className="trigger-toggle" aria-expanded={withTriggers} onClick={() => setWithTriggers(!withTriggers)}>
            <span>Take profit / stop loss</span>
            <span className="trigger-more">{withTriggers ? "Hide" : "Add"}</span>
          </button>
          {withTriggers && (
            <TriggerFields market={market} shape={triggerShape} tp={tpText} sl={slText} setTp={setTpText} setSl={setSlText} check={triggerCheck} />
          )}
        </div>

        {queued > 0n && (
          <label className="check">
            <input type="checkbox" checked={useQueued} onChange={(e) => setUseQueued(e.target.checked)} />
            Use queued winnings first ({usd(queued)})
          </label>
        )}

        <button className={`btn big wide slip-go ${tone}`} disabled={action.disabled} onClick={action.run}>
          {action.label}
          {action.tone === "side" && !action.disabled && !busy && (
            <small>
              {leverage}x · {usd(margin ?? 0n)}
            </small>
          )}
        </button>

        {owner && !session && !PREVIEW && (
          <p className="note">One signature, no gas. It makes a key in this browser that places your trades without a popup each time. That key can trade; it can never withdraw.</p>
        )}
      </div>

      <Equity />
    </aside>
  );
}
