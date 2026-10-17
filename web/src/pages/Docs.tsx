import { Hero } from "../components/Hero";
import { useEffect, useState } from "react";
import { Link } from "../components/Shell";
import { BPS, FEE_BPS, REFERENCE_NOTIONAL, bustDistance, bustPrice, keepShare, settle } from "@shared/math.mjs";
import { loadCoin, loadHouse } from "../lib/api";
import { big, coin as coinText, usd, usdCompact } from "../lib/format";
import { PREVIEW } from "../lib/mode";
import { useStore } from "../lib/store";
import type { Market } from "../lib/types";

const SECTIONS: [string, string][] = [
  ["what", "What Tape is"],
  ["trade", "Opening and closing"],
  ["liquidation", "Liquidation"],
  ["win", "How a win is paid"],
  ["vault", "The vault and the payout queue"],
  ["coin", "The coin"],
  ["staking", "Staking"],
  ["jackpot", "Rekt Jackpot"],
  ["fees", "Fees"],
  ["exit", "Leaving without the relayer"],
  ["risks", "Risks"],
];

/** Price moves, in basis points, for the table of what a win keeps. */
const MOVES = [1, 2, 5, 10, 25, 50, 100];
const LEVERAGES = [2, 10, 100, 500, 1000];
/** Size impacts, and the moves they are shown against, for the table of what a crowded side keeps. */
const LEVELS = [1, 2, 5, 10, 20];
const LEVEL_MOVES = [5, 10, 50, 100, 500];
/** Losses, in dollars, for the table of what a loss mines right now. */
const LOSSES = [10n, 100n, 1000n];

const USD = 1_000_000n;
/** The entry price of every worked example: $100,000, with 8 decimals. */
const ENTRY = 100_000n * 100_000_000n;

// Fixed in the contracts and in the relayer; none of these travel in the config.
const DEADBAND_BPS = 0.2;
const MAX_OPEN_POSITIONS = 200;
const SESSION_DAYS = 30;
const STREAM_HOURS = 24;
const QUIET_FEED_SECONDS = 6;
const AUTO_PAID_PER_LOSS = 4;

const feePct = Number(FEE_BPS) / 100;
/** How far before the price where the margin is gone the bust trigger sits, in basis points of that price. */
const bufferBps = (market: Market) => Number(market.bustBuffer) / 1e14;
/** The half-point of a market's impact curve on a quiet side, in basis points: a move this size keeps half the most a win can keep. */
const impactBps = (market: Market) => (1 / market.rateMultiplier + 100 / market.positionMultiplier) * 10_000;
/** The part of that which stands for size. It is this part a crowded side multiplies. */
const sizeBps = (market: Market) => (100 / market.positionMultiplier) * 10_000;
/** A market's depth, as a 6-decimal dollar amount. */
const depthOf = (market: Market) => BigInt(market.depth) * USD;
/** One price tick, in dollars. */
const tickText = (market: Market) => usd(BigInt(market.tick) / 100n, { cents: true });

const listOf = (words: string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);
const span = (seconds: number) => (seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`);
/** A 6-decimal dollar amount, with cents only when there are some. */
const money = (v: bigint) => usd(v, { cents: v % USD !== 0n });
/** An 8-decimal price, the same way. */
const dollarPrice = (p: bigint) => money(p / 100n);

/** A long from $100,000: where the margin runs out, where it busts, and what is lost on paper there. */
function bustExample(market: Market, leverage: number, marginUsd: bigint) {
  const margin = marginUsd * USD;
  const notional = margin * BigInt(leverage);
  const bust = bustPrice(ENTRY, leverage, true, market);
  const move = ENTRY - bust;
  return {
    leverage,
    margin,
    notional,
    zero: ENTRY - ENTRY / BigInt(leverage),
    bust,
    movePct: (Number(move) * 100) / Number(ENTRY),
    // An 8-decimal price difference as a 6-decimal dollar amount.
    moveUsd: move / 100n,
    paperLoss: (notional * move) / ENTRY,
  };
}

/** A $100 long from $100,000 closed half a percent higher, cut by cut. */
function winExample(market: Market) {
  const leverage = Math.min(100, market.maxLeverage);
  const margin = 100n * USD;
  const notional = margin * BigInt(leverage);
  const exit = ENTRY + ENTRY / 200n;
  const raw = (notional * (exit - ENTRY)) / ENTRY;
  // The deadband is a fifty-thousandth of the entry, in whole price ticks.
  const tick = BigInt(market.tick);
  const deadband = (ENTRY / tick / 50_000n) * tick;
  const afterDeadband = (notional * (exit - ENTRY - deadband)) / ENTRY;
  const afterHaircut = settle(ENTRY, exit, notional, true, market, REFERENCE_NOTIONAL).amount;
  const fee = (afterHaircut * FEE_BPS) / BPS;
  const net = afterHaircut - fee;
  return { leverage, margin, notional, exit, raw, afterDeadband, afterHaircut, fee, net, share: Number((net * 1000n) / raw) / 10 };
}

export function Docs() {
  const config = useStore((s) => s.config);
  const coin = useStore((s) => s.coin);
  const cap = useStore((s) => s.house?.house.stakerCap);
  const [contentsOpen, setContentsOpen] = useState(() => matchMedia("(min-width: 901px)").matches);
  const [active, setActive] = useState(location.hash.slice(1) || "what");

  useEffect(() => {
    loadCoin().catch(() => {});
    loadHouse().catch(() => {});
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.find((entry) => entry.isIntersecting);
      if (visible) setActive(visible.target.id);
    }, { root: document.querySelector(".page"), rootMargin: "-5% 0px -75% 0px" });
    document.querySelectorAll(".docs-body h2[id]").forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [config]);

  if (!config || config.markets.length === 0) return null;
  const { timing, addresses } = config;
  const name = config.name;
  const live = config.markets.filter((m) => !m.retired);
  const markets = live.length > 0 ? live : config.markets;
  const lead = markets.find((m) => m.symbol === "BTC") ?? markets[0];
  const maxLeverage = Math.max(...markets.map((m) => m.maxLeverage));
  const maxKeepPct = Math.max(...markets.map((m) => m.maxKeepBps)) / 100;
  const bestSharePct = (maxKeepPct * (100 - feePct)) / 100;
  const minNotional = big(config.minNotional);

  // The coin's ticker. Where it is the same word as the exchange, a dollar sign tells them apart.
  const symbol = config.coin ? (config.coin.symbol === name ? `$${config.coin.symbol}` : config.coin.symbol) : null;
  const mining = coin?.attached && coin.mining ? coin.mining : null;
  const scale = mining ? big(mining.scaleUsd) : null;
  const minesNow = (dollars: bigint) =>
    mining ? (big(mining.reserve) * dollars * USD) / (big(mining.scaleUsd) + big(mining.cumulativeLossUsd) + dollars * USD) : 0n;

  const top = bustExample(lead, lead.maxLeverage, 10n);
  const low = bustExample(lead, Math.min(10, lead.maxLeverage), 1_000n);
  // At the highest leverage, how much of the distance to zero the bust trigger gives away.
  const topRoomLost = 1 - bustDistance(lead.maxLeverage, lead) * lead.maxLeverage;
  const win = winExample(lead);
  const smallMove = MOVES[0];
  const smallShare = (keepShare(smallMove, lead) * 100).toFixed(0);
  const directWait = timing.directDelay + timing.intentTtl;
  const showContracts = !PREVIEW && config.chainId !== 0;

  return (
    <div className="sheet work-page docs-page">
      <Hero title="Docs" lede={`How ${name} works: opening and closing, liquidation, how wins are paid, the vault and the coin.`} actions={<Link to="/trade" className="btn primary">Open exchange</Link>} />
      <div className="docs-wrap">
      <nav className="docs-toc" aria-label="On this page">
        <details open={contentsOpen} onToggle={(event) => setContentsOpen(event.currentTarget.open)}>
          <summary>On this page</summary>
          <ol>
            {[...SECTIONS, ...(showContracts ? [["contracts", "Contract addresses"]] : [])].map(([id, label]) => <li key={id}><a href={`#${id}`} aria-current={active === id ? "location" : undefined} onClick={() => { setActive(id); if (matchMedia("(max-width: 900px)").matches) setContentsOpen(false); }}>{label}</a></li>)}
          </ol>
        </details>
      </nav>
      <article className="panel docs-card docs-body">
        <p className="lede">
          Every rule on this page is enforced by contracts on Ethereum. Where something depends on the relayer or on a person instead, the page says so.
        </p>

        <h2 id="what">What {name} is</h2>
        <p>
          {name} is an exchange for trading {listOf(markets.map((m) => m.symbol))} at up to {maxLeverage}x leverage, in USDC on Ethereum. There
          is no order book. The other side of every position is the vault, a pool of USDC that began empty. Winners are paid out of
          what losers lost, and a win the vault cannot pay yet waits in a first-in, first-out queue.{" "}
          {symbol
            ? `Losers are paid in ${symbol}, and staking ${symbol} earns USDC from the exchange.`
            : "A coin can be attached later: losers will be paid in it, and staking it will earn USDC from the exchange."}
        </p>

        <h2 id="trade">Opening and closing</h2>
        <p>
          Pick long or short, a margin, and a leverage from 1 to {maxLeverage}. Your position size is margin times leverage. Both are fixed when
          the position opens. You cannot add or remove margin, and you can only close the whole position.
        </p>
        <p>
          <strong>Opening costs nothing.</strong> There is no fee on size, no funding however long you hold, and no spread. The exchange takes
          its cut from winning closes only.
        </p>
        <p>
          <strong>Your fill.</strong> When you click, the order is stamped with the current second. It fills at the first price published
          at least {timing.execDelay} seconds after that stamp. The price is the middle of Hyperliquid's best bid and ask for that market,
          read and signed by Tape's price signer. Only one price fits the rule, and the contract checks that it is the signer's first
          for that second. You cannot pick your fill, and the relayer cannot pick among prices. Size does not move it either. A $1 position
          and a $1,000,000 position get the same price.
        </p>
        <p>
          You see the fill about {timing.execDelay} seconds after you click. The transaction lands on Ethereum a block or two later. The
          position is priced from the fill, and you can close it before the transaction lands.
        </p>
        <p>
          The {timing.execDelay} seconds are deliberate. Without them, someone watching a faster price feed could trade on prices they have
          already seen. The site sends orders with no price limit, so you get the price at that moment even if it moved while you waited.
        </p>
        <div className="callout">
          <p>
            <strong>An order cannot be cancelled once sent.</strong> The price is fixed when you click, but the transaction lands later. If you
            could cancel in between, you could keep only the orders that moved your way.
          </p>
        </div>
        <p>
          <strong>When an order does not fill.</strong> An order fails if no oracle price appears within {timing.pinWindow} seconds of its
          moment, or if it has not landed {timing.intentTtl} seconds after its stamp. An open also fails while new positions are paused, while
          that side of the market is at its cap, and while the best bid and ask are{" "}
          {PREVIEW ? "unusually far apart" : `more than ${((lead.maxConfBps * 2) / 100).toFixed(2)}% of the price apart`}. The relayer
          takes no orders at all once it has seen no price for {QUIET_FEED_SECONDS} seconds. An order that does not fill costs nothing.
        </p>
        <p>
          <strong>Closing</strong> works the same way. Click, and the position closes at the first oracle price at least {timing.execDelay}{" "}
          seconds later.
        </p>
        <p>
          <strong>Take profit and stop loss.</strong> You can give a position a take-profit price, a stop-loss price, or both, when you open
          it or later. Your trading key signs each one once. The relayer holds it, and when a price at or past it prints, closes the
          position exactly as if you had clicked Close at that moment: at the first price {timing.execDelay} seconds later, so a fast market
          can fill it a little past your price, either way. The contract checks the signature, that the price really printed after you set
          it, and that the close lands within {timing.intentTtl} seconds of that print. A stop cannot sit past the liquidation price, which
          would come first. Clearing one takes it off; once it has been touched, the close is on its way and cannot be called back.
        </p>
        <table>
          <thead>
            <tr>
              <th>Market</th>
              <th>Leverage</th>
              <th>Largest position</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => (
              <tr key={m.id}>
                <td>{m.symbol}</td>
                <td>1x to {m.maxLeverage}x</td>
                <td>{usdCompact(m.maxNotional)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          The smallest margin is {usd(config.minMargin, { cents: false })}
          {minNotional > 0n && `, and the smallest position is ${usd(minNotional, { cents: false })} (margin times leverage)`}. One account can
          hold up to {MAX_OPEN_POSITIONS} open positions. Each side of each market also has a cap on total open size:{" "}
          {listOf(markets.map((m) => `${usdCompact(m.capLong)} of longs and ${usdCompact(m.capShort)} of shorts on ${m.symbol}`))}. When a
          side is full, an order that would add to it is refused until some of it closes. The cap is there because every size fills at
          the oracle's price: without it, someone holding enough of one side could push the real market a little, close, and be paid on
          the whole position. For the same reason size costs something well before the cap: see <a href="#win">how a win is paid</a>.{" "}
          On top of that, the contracts hold each side of each market to $2,000,000 plus fifty times the vault's cash, so what can be open grows with what can
          pay it. Deposits and margin in open positions do not count as vault cash. This ceiling cannot be raised by the operator or owner.
        </p>
        <p>
          <strong>One-click trading.</strong> The first time you trade, your wallet asks for one signature. It registers a session key that
          lives in this browser and signs your orders from then on. There are no more popups, and you pay no gas: the relayer pays it.{" "}
          <strong>The session key can open and close positions. It can never withdraw.</strong> It starts working {timing.grace} seconds after
          it is registered, which is the countdown on the ticket. The site sets it to expire after {SESSION_DAYS} days. If someone got into this
          browser, the worst they could do with the key is trade your balance badly. They could not take it out.
        </p>
        <p>
          <strong>Deposits and withdrawals.</strong> To deposit, you sign a USDC permit and the relayer submits it, so you need no ETH. To
          withdraw, you sign with your wallet itself and the USDC goes back to it, usually within a block. You can withdraw anything that is not
          margin in an open position and not waiting in the queue.
        </p>

        <h2 id="liquidation">Liquidation</h2>
        <p>
          Every position has a liquidation price. <strong>If the oracle prints at or past it, the whole margin is lost.</strong> There is no
          partial liquidation and no grace period. A position that touches its liquidation price is closed even if the price comes straight back.
        </p>
        <p>
          Where it sits: your margin would be exactly used up after a move of 1 divided by your leverage against you. The liquidation price is a
          little before that point: {listOf(markets.map((m) => `${bufferBps(m).toFixed(2)} basis points of that price for ${m.symbol}`))}. A
          basis point (bp) is 0.01%. At low leverage the gap hardly matters. At {maxLeverage}x it is {(topRoomLost * 100).toFixed(0)}% of the
          room you have. Prices here are counted in whole ticks ({listOf(markets.map((m) => `${tickText(m)} for ${m.symbol}`))}), so the
          figures on your position can differ from these by a tick.
        </p>
        <table>
          <thead>
            <tr>
              <th>Leverage</th>
              <th>Margin is used up at</th>
              <th>Liquidated at</th>
            </tr>
          </thead>
          <tbody>
            {LEVERAGES.filter((lev) => lev <= maxLeverage).map((lev) => (
              <tr key={lev}>
                <td>{lev}x</td>
                <td>{(100 / lev).toFixed(lev >= 100 ? 2 : 1)}% against you</td>
                <td>{(bustDistance(lev, lead) * 100).toFixed(lev >= 100 ? 4 : 2)}% against you</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <strong>At {top.leverage}x.</strong> {lead.symbol} is at {dollarPrice(ENTRY)}. You go long with {money(top.margin)} of margin, a{" "}
          {money(top.notional)} position. Your margin would be used up at {dollarPrice(top.zero)}. You are liquidated at {dollarPrice(top.bust)}: a move
          of {top.movePct.toFixed(4)}%, or {money(top.moveUsd)}. At that price the position is down {money(top.paperLoss)} on paper. You lose
          the full {money(top.margin)}.
        </p>
        <p>
          <strong>At {low.leverage}x.</strong> Same entry, {money(low.margin)} of margin, a {money(low.notional)} position. Your margin would be
          used up at {dollarPrice(low.zero)}. You are liquidated at {dollarPrice(low.bust)}: a move of {low.movePct.toFixed(2)}%. On paper the position
          is down {money(low.paperLoss)}. You lose the full {money(low.margin)}.
        </p>
        <p>
          A short mirrors this, with the liquidation price above the entry. Closing before the liquidation price returns what is left of the margin. Reaching
          it returns nothing, and a close that prices at or past it counts as a liquidation.
        </p>
        <p>
          The relayer liquidates a position the moment a price crosses its line. If it does not, anyone can do it {timing.intentTtl} seconds later by
          showing the contract that price.
        </p>

        <h2 id="win">How a win is paid</h2>
        <p>
          A win is cut three times before it reaches you. A loss is never cut: <strong>losing costs the loss and nothing more.</strong>
        </p>
        <ol>
          <li>
            <strong>The deadband.</strong> A win is measured as if the exit price were {DEADBAND_BPS} basis points (
            {(DEADBAND_BPS / 100).toFixed(3)}% of your entry price, rounded down to a whole tick) worse. A win smaller than that pays nothing.
          </li>
          <li>
            <strong>The impact haircut.</strong> You keep a share of what is left, and the share grows with the move: {maxKeepPct}% times the move,
            divided by the move plus k. Here k is a fixed number for each market:{" "}
            {listOf(markets.map((m) => `${impactBps(m).toFixed(2)} basis points for ${m.symbol}`))}. A move the size of k keeps{" "}
            {maxKeepPct / 2}%. Smaller moves keep less, and no move keeps more than {maxKeepPct}%. On a crowded side k is larger: see Size
            Impact below.
          </li>
          <li>
            <strong>The fee.</strong> {feePct}% of what remains.
          </li>
        </ol>
        <p>All three together, as the share of the raw gain that reaches you:</p>
        <table>
          <thead>
            <tr>
              <th>Price moves your way by</th>
              {markets.map((m) => (
                <th key={m.id}>{m.symbol} pays</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MOVES.map((move) => (
              <tr key={move}>
                <td>
                  {move} {move === 1 ? "bp" : "bps"} ({(move / 100).toFixed(2)}%)
                </td>
                {markets.map((m) => (
                  <td key={m.id}>{(keepShare(move, m) * 100).toFixed(1)}%</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          The share climbs toward {bestSharePct.toFixed(1)}% and never passes it. The profit shown on an open position is already after all
          three cuts.
        </p>
        <p>
          <strong>Size Impact.</strong> That table holds while a side of a market is quiet: up to{" "}
          {listOf(markets.map((m) => `${usdCompact(depthOf(m))} of ${m.symbol} longs or of ${m.symbol} shorts`))} open. Past that, a new position is
          charged for the size already on its side. Count how deep the middle of your position sits in what is open on your side, in
          multiples of that depth: that number is your Size Impact, and the part of k that stands for size (
          {listOf(markets.map((m) => `${sizeBps(m).toFixed(2)} basis points for ${m.symbol}`))}) is multiplied by it. The ticket shows it before
          you click whenever it is above 1, and a position keeps the figure it opened with for as long as it is open, whatever anyone else
          does afterwards. It follows the side and not the order, so splitting an order, or using more wallets, climbs the same stack. The
          side can fill up in the {timing.execDelay} seconds an order takes to land, so your order carries a limit: a quarter above the
          Size Impact the ticket showed, or 1 more than it where that is more. Past that it is refused, not opened on terms you did not
          see.
        </p>
        <p>What a {lead.symbol} win keeps at each Size Impact, all cuts included:</p>
        <table>
          <thead>
            <tr>
              <th>Price moves your way by</th>
              {LEVELS.map((level) => (
                <th key={level}>×{level}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LEVEL_MOVES.map((move) => (
              <tr key={move}>
                <td>
                  {move} bps ({(move / 100).toFixed(2)}%)
                </td>
                {LEVELS.map((level) => (
                  <td key={level}>{(keepShare(move, lead, REFERENCE_NOTIONAL * BigInt(level)) * 100).toFixed(1)}%</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          A crowded side takes a good deal out of a small win and very little out of a large one. It never touches a loss or a liquidation price.
          It is what keeps a very large position from being paid in full for a few basis points, which is the one trade that can be made
          to happen by pushing the market.
        </p>
        <p>
          <strong>One example.</strong> {lead.symbol} is at {dollarPrice(ENTRY)}. You go long with {money(win.margin)} at {win.leverage}x, a{" "}
          {money(win.notional)} position, and close at {dollarPrice(win.exit)}, up 0.50%.
        </p>
        <table>
          <tbody>
            <tr>
              <td>Raw gain</td>
              <td>{usd(win.raw)}</td>
            </tr>
            <tr>
              <td>After the deadband</td>
              <td>{usd(win.afterDeadband)}</td>
            </tr>
            <tr>
              <td>After the impact haircut</td>
              <td>{usd(win.afterHaircut)}</td>
            </tr>
            <tr>
              <td>Fee of {feePct}%</td>
              <td>{usd(win.fee)}</td>
            </tr>
            <tr>
              <td>
                <strong>You receive, on top of your margin</strong>
              </td>
              <td>
                <strong>{usd(win.net)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        <p>That is {win.share.toFixed(1)}% of the raw gain.</p>

        <h2 id="vault">The vault and the payout queue</h2>
        <p>
          The vault is the pool of USDC that pays winners. It began empty. Nobody funds it and nobody owns a share of it. It grows when
          traders lose. Anyone can add USDC to it, and gets nothing back for doing so.
        </p>
        <p>
          When you win and the vault can pay, the profit lands in your balance at once. When it cannot pay all of it,{" "}
          <strong>the unpaid part goes into the queue.</strong> The queue is strictly first in, first out. Each loss that comes in pays the
          people at the front. The Vault page shows the queue and where you stand in it.
        </p>
        <ul>
          <li>
            <strong>Your margin is never queued.</strong> It comes back the moment you close. Only profit can wait.
          </li>
          <li>
            While anyone is waiting, the exchange takes no fees, stakers are paid nothing new, and no new winner is paid ahead of the queue.
          </li>
          <li>
            A queued win is a debt the contract owes you. It does not shrink and it does not expire. Nothing says when it will be paid.
          </li>
          <li>
            A payment lands in your trading balance. It can be partial, and then the rest keeps its place at the front.
          </li>
          <li>
            Every loss pays the first {AUTO_PAID_PER_LOSS} entries in the queue automatically, as far as the cash goes. The relayer also pays the
            queue whenever the vault has cash, and anyone can do the same by calling <code>harvest</code> on the contract.
          </li>
          <li>
            <strong>You can use queued winnings as margin.</strong> Tick "Use queued winnings first" on the ticket and they fund the position
            before your cash does. Lose, and that part of the debt is cancelled. Win or break even, and that margin plus any profit is owed to
            you again: paid at once if nobody is waiting, otherwise at the back of the queue. So spending queued winnings gives up their place
            in line.
          </li>
        </ul>
        <div className="callout">
          <p>
            Early on the vault is nearly empty, so early winners wait. The vault needs losses before it can pay wins. If traders stop losing, the
            queue stops moving.
          </p>
        </div>

        <h2 id="coin">The coin</h2>
        {symbol ? (
          <>
            <p>
              <strong>Lose a trade, get {symbol}.</strong> When a loss settles, the mining contract sends {symbol} straight to your wallet in
              the same transaction. There is nothing to claim and nothing vests.
            </p>
            <p>
              A liquidation mines on the whole margin. A close at a loss mines on the loss, less the {feePct}% fee the vault pays out of it. Winners
              mine nothing.
            </p>
            <p>
              The coin comes out of a reserve, along one curve. Each loss takes a slice of what is left, so a dollar lost early mines more
              than a dollar lost late. Half of the reserve is gone once total losses on the exchange reach{" "}
              {scale ? usdCompact(scale) : "a set amount"}. Two thirds is gone at {scale ? usdCompact(scale * 2n) : "twice that"}, and three
              quarters at {scale ? usdCompact(scale * 3n) : "three times that"}. The rate only falls, and the reserve never quite runs out.
            </p>
            {mining && (
              <>
                <p>
                  So far traders have lost {usdCompact(mining.cumulativeLossUsd)} and mined {coinText(mining.mined)} {symbol}.{" "}
                  {coinText(mining.reserve)} {symbol} is left in the reserve. At this point on the curve:
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>A loss of</th>
                      <th>Mines right now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {LOSSES.map((dollars) => (
                      <tr key={String(dollars)}>
                        <td>{usd(dollars * USD, { cents: false })}</td>
                        <td>
                          {coinText(minesNow(dollars))} {symbol}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <p>
              <strong>The supply is fixed{coin?.attached && coin.supply ? ` at ${coinText(coin.supply)} ${symbol}` : ""}.</strong> Mining does
              not create coin. It can only pay out what the reserve already holds. If the transfer of {symbol} fails for any reason, your trade
              still settles and that loss mines nothing.
            </p>
          </>
        ) : (
          <p>
            No coin is attached yet. The exchange works without one. Once a coin is attached, each losing trade is paid in it from a reserve,
            straight to the loser's wallet. A coin can be attached once and never swapped.
          </p>
        )}

        <h2 id="staking">Staking</h2>
        {symbol ? (
          <>
            <p>Stake {symbol} and you earn USDC. Stakers are paid from two sources:</p>
            <ul>
              <li>
                <strong>Half of every {feePct}% fee</strong> the exchange collects. The other half goes to the team.
              </li>
              <li>
                <strong>Everything the vault holds above its cap{cap ? ` of ${usdCompact(cap)}` : ""}.</strong> The vault keeps what it
                wins up to the cap. The surplus goes to stakers.
              </li>
            </ul>
            <p>
              That USDC is sent to the staking contract, which <strong>pays it out as a stream</strong>. Each payment is spread evenly over
              the next {STREAM_HOURS} hours, and every second of it goes to whoever is staked during that second, in proportion to their
              stake. When another payment arrives, what is left of the last one is spread again together with it. So a stake earns exactly
              for the time it is staked: staking for one block around a payment earns one block's worth, not the payment.
            </p>
            <p>
              Sending the fees is a call anyone can make, and the relayer makes it{" "}
              every few minutes once enough has built up. The surplus
              above the cap is sent by the relayer, through a second contract, the sweeper. The relayer first works out, position by position
              at the current oracle price, what every winning position would be owed if it closed now, and sends only what is left after
              that. The sweeper checks the book again on-chain against a signed price and refuses anything above its own figure. The vault
              does not pay stakers with money it may be about to owe traders.
            </p>
            <ul>
              <li>
                <strong>No lockup and no cooldown.</strong> Unstake whenever you like. You keep everything you earned up to that second.
              </li>
              <li>
                <strong>A claim lands in your trading balance.</strong> It does not send USDC to your wallet. From your balance you can trade
                with it or withdraw it.
              </li>
              <li>
                <strong>Nothing new is paid while winners are queued.</strong> The exchange takes no fees until the queue is empty, and the
                vault has no surplus while it owes anyone.
              </li>
              <li>
                If nobody is staked, the USDC waits in the staking contract. When the first staker arrives it starts streaming from that
                moment, over {STREAM_HOURS} hours, so being first does not hand anyone the backlog in one go.
              </li>
              {!PREVIEW && <li>Staking, unstaking and claiming are ordinary transactions from your wallet, so they cost you gas.</li>}
            </ul>
          </>
        ) : (
          <p>
            Staking starts when a coin is attached. Until then the stakers' half of every fee is set aside in the Exchange contract. It goes
            to the coin's first stakers.
          </p>
        )}

        <h2 id="jackpot">Rekt Jackpot</h2>
        {!PREVIEW && !addresses.jackpot && <p className="docs-state">Jackpot is not active on the current exchange. The rules below apply after the coin and reward contracts are attached.</p>}
        <p>
          Every dollar you lose is a ticket in the hour's jackpot: a losing close counts the loss less the fee, a liquidation its whole margin.
          Loss mining enters it on-chain as the trade settles; there is nothing to buy or claim. When the hour ends, anyone can close the round,
          which names an Ethereum block a few blocks ahead; once that block exists, its hash picks a point among the hour's tickets and the ticket
          holding it wins the pot, sent in USDC to the winner's wallet. An hour nobody lost in rolls its pot into the next.
        </p>
        <p>
          The pot is filled with a share of the team's half of every fee, sent by a splitter contract that is the exchange's fee recipient.
          Nobody can enter tickets but the loss-mining contract, and nobody, the team included, knows the block hash when a round closes. The
          validator of that block could in theory refuse to make it, giving up its reward; that is only worth trying for a pot far larger
          than a block's reward.
        </p>

        <h2 id="fees">Fees</h2>
        <table>
          <thead>
            <tr>
              <th>What</th>
              <th>What it costs you</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Opening a position</td>
              <td>Nothing</td>
            </tr>
            <tr>
              <td>Holding it: funding, interest</td>
              <td>Nothing</td>
            </tr>
            <tr>
              <td>Spread, or price impact on entry</td>
              <td>Nothing</td>
            </tr>
            <tr>
              <td>Closing at a loss</td>
              <td>The loss, and nothing more</td>
            </tr>
            <tr>
              <td>Closing at a win</td>
              <td>
                The deadband, the haircut, then {feePct}% of the gain
              </td>
            </tr>
            <tr>
              <td>Being liquidated</td>
              <td>The whole margin</td>
            </tr>
            <tr>
              <td>Depositing and withdrawing</td>
              <td>Nothing. The relayer pays the gas</td>
            </tr>
            <tr>
              <td>Gas for trading</td>
              <td>Nothing. The relayer pays it</td>
            </tr>
            <tr>
              <td>Staking, unstaking, claiming</td>
              <td>Ethereum gas</td>
            </tr>
            <tr>
              <td>Exits without the relayer</td>
              <td>Ethereum gas</td>
            </tr>
          </tbody>
        </table>
        <p>
          Every {feePct}% fee is split in half: half to stakers, half to the team. When you lose, the vault pays the same {feePct}% out of
          what it won from you, split the same way. It is not added to your loss. No fee is taken while winners are waiting in the queue.
        </p>

        <h2 id="exit">Leaving without the relayer</h2>
        <p>
          Orders normally reach Ethereum through the relayer. If it is down, or if it refuses you, you can still close and withdraw by calling
          the Exchange contract from your own wallet. These calls cost you gas.
        </p>
        <p>
          <strong>To close a position:</strong>
        </p>
        <ol>
          <li>
            Call <code>requestClose(positionId)</code>. The request is binding and cannot be cancelled. The position will close at the first
            oracle price published at least {timing.directDelay} seconds after your request.
          </li>
          <li>
            Call <code>executeClose(positionId, priceUpdate)</code> once {directWait} seconds have passed since the request ({timing.directDelay}{" "}
            plus {timing.intentTtl}). Anyone can make this call. It needs the price update the price signer signed for that moment, which
            the relayer's API hands out to anyone (<code>/print</code>). If the relayer is running, it executes the close for you as soon as
            the price exists. If no price was signed for that moment, the request lapses and you make a new one.
          </li>
          <li>
            If nobody has executed it within {span(timing.requestExpiry)} of the request, it lapses and you can make a new one.
          </li>
        </ol>
        <p>
          <strong>To withdraw:</strong>
        </p>
        <ol>
          <li>
            Call <code>requestWithdraw(amount)</code>. No money moves yet. From {timing.grace} seconds after the request until it is executed
            or cancelled, your account cannot open new positions. Closing still works.
          </li>
          <li>
            Wait {span(timing.withdrawDelay)}, then call <code>executeWithdraw(to)</code>. It sends the amount you asked for, or your whole
            balance if that is less, to the address you name.
          </li>
          <li>
            To cancel instead, call <code>requestWithdraw(0)</code>. After a request ends, wait {timing.grace + timing.intentTtl} seconds before
            making another.
          </li>
        </ol>
        <p>
          Only your free balance can leave, so close your positions first. Queued winnings stay in the queue until the vault pays them.
        </p>
        <p>
          The waits exist for the same reason an order cannot be cancelled. By the time you make one of these calls you know where the price
          went, so none of them is allowed to reach an order you had already sent.
        </p>

        <h2 id="risks">Risks</h2>
        <ul>
          <li>
            <strong>
              At {top.leverage}x, a {(top.movePct * 100).toFixed(2)} basis point move liquidates you.
            </strong>{" "}
            That is {top.movePct.toFixed(4)}% against you, and the market often moves that far within seconds. At {top.leverage}x you still have{" "}
            {(100 - (Number(top.paperLoss) * 100) / Number(top.margin)).toFixed(0)}% of your margin on paper when you are liquidated, and you lose all of
            it. Trading at high leverage loses money for most people who do it.
          </li>
          <li>
            <strong>Small wins pay very little.</strong> A {smallMove} basis point win on {lead.symbol} pays {smallShare}% of the raw gain. The
            matching loss costs 100%.
          </li>
          <li>
            <strong>A crowded side pays less.</strong> When a side already holds more than its depth, a position opened on it keeps less of
            a small win, and it keeps those terms even if the side empties later. The ticket shows the Size Impact before you open. An
            order that lands behind a larger one placed in the same moment is charged for it, up to the limit it carries (a quarter more
            than the ticket showed, or 1 more), and refused past that. Closing and opening again takes the terms of that moment.
          </li>
          <li>
            <strong>Wins can be queued.</strong> If the vault cannot pay, your profit waits in line behind everyone who won before you. Nothing
            guarantees when it is paid, or that it is paid at all if losses stop coming in.
          </li>
          <li>
            <strong>The price signer is trusted.</strong> Every price is one that Tape's server read from Hyperliquid and signed with
            a key the contract knows. The contract checks the signature and nothing else: it cannot tell a true price from a false one.
            Whoever holds that key could sign a wrong price, and positions would fill, close and be liquidated on it. The key is kept apart from every
            other key, and the owner can replace it at once. That is the remedy, and there is no other.
          </li>
          <li>
            <strong>Take-profits and stop-losses need the relayer.</strong> It is the one watching the price and sending the close. If it is
            down, they do nothing until it is back, and a price that went past them meanwhile does not count. They are not a promise of a
            price: the close fills at the market two seconds after the touch.
          </li>
          <li>
            <strong>The relayer's operator key is trusted.</strong> The contract trusts it to submit orders promptly, in order, and only when
            they are freshly signed. It cannot forge an order: each one needs your signature or your session key's. It cannot choose among
            prices: the fill is the signer's first price at least {timing.execDelay} seconds after your stamp, checked on-chain. It cannot move
            funds: no function lets anyone touch a trader's balance, and a withdrawal goes only where your wallet signed. What it can do is
            refuse an order, or hold one for up to {timing.intentTtl} seconds until it expires. Your price is fixed when you click, so a
            dishonest relayer could wait, watch the market, and land only the orders that went against you. It could also accept stale orders
            from a partner who already knows the price, which drains the vault and puts that partner ahead of later winners in the queue. It
            cannot keep your balance: a direct withdrawal needs nobody. Closing a position without it still needs a price signed for that
            moment.
          </li>
          <li>
            <strong>Someone can try to move the price.</strong> Positions fill and close at the oracle's price whatever their size, so a
            trader holding a great deal of one side gains from pushing the market a few basis points and closing. The price here comes from
            one venue, Hyperliquid, so what has to be pushed is one order book and not the whole market. Three things limit what that can
            win: each side of each market is capped, so a push is paid on no more than the cap; past a side's depth every further dollar
            opened keeps less of a small win, so a push on a full side is paid a fraction of what the same push earned on a small one, and
            what a whole side can take grows far slower than the side does; and nobody picks their price, which is the first one at least{" "}
            {timing.execDelay} seconds after the click. Together these are meant to make a push cost more than it pays. They do not make
            one impossible, and a loss of this kind comes out of the cash that pays winners.
          </li>
          <li>
            <strong>Price outages stop trading.</strong> Prices come from Hyperliquid's public feed. If Hyperliquid showed a wrong price, or
            its market moved away from everyone else's, positions would open, close and be liquidated on it. The price signer stops signing when
            Hyperliquid and a second venue disagree by more than 1.5%, when Hyperliquid stops answering, and when its own clock is off. While
            no price is signed, no order fills and no position can be closed. Your position stays open through the outage and can be liquidated on the
            first price after it.
          </li>
          {markets.some((m) => ["GOLD", "SPX", "TSLA", "NVDA", "AAPL"].includes(m.symbol)) && (
            <li>
              <strong>Gold, the S&amp;P 500 and the stocks trade around the clock here, their home markets do not.</strong> Their prices come
              from trade.xyz's perpetuals on Hyperliquid, which keep trading at night and at weekends while the stock exchange is shut. When
              it opens, the price can jump to catch up, straight past a liquidation price. Their books are thinner than BTC's and ETH's, so
              their caps and their leverage are lower.
            </li>
          )}
          <li>
            <strong>The contracts are not upgradeable, so a bug cannot be patched.</strong> No one can change the rules or reach your balance.
            The other side of that: the only fix for a bug is a new deployment. A guardian can stop new positions, and can retire a market for
            good. A retired market freezes at its last price, and positions in it then close at that price.
          </li>
          <li>
            <strong>No outside audit.</strong> The contracts are tested, and they have not been audited by an outside firm. A bug could lose
            funds.
          </li>
          {symbol && (
            <li>
              <strong>{symbol} has no price guarantee.</strong> The exchange never buys it and nothing sets its price. The stakers' share
              of fees does not depend on the relayer: anyone can send it to the staking contract, at the cost of gas. The surplus above the
              cap does: only the relayer sweeps it, and if the relayer stops that money stays in the vault.
            </li>
          )}
        </ul>
        <p>Only put in what you can lose entirely.</p>

        {showContracts && (
          <>
            <h2 id="contracts">Contract addresses</h2>
            <p>Chain ID {config.chainId}. The direct exits above are calls to the Exchange.</p>
            <table>
              <tbody>
                {(
                  [
                    ["Exchange", addresses.exchange, "Balances, positions, settlement, the queue"],
                    ["Sessions", addresses.sessions, "One-click trading keys"],
                    ["Price oracle", addresses.oracle, "Checks that a price is the price signer's"],
                    ["Lens", addresses.lens, "Read-only views"],
                    ["Gateway", addresses.gateway, "Deposits by permit"],
                    ["Deposits", addresses.deposits, "USDC transfer deposit addresses"],
                    ["USDC", addresses.usdc, "Collateral"],
                    ["Coin", addresses.coin, "The coin"],
                    ["Staking", addresses.staking, "Stake the coin, earn USDC"],
                    ["Loss mining", addresses.lossMining, "Pays losers in coin"],
                    ["Sweeper", addresses.sweeper ?? null, "Sends vault cash above the cap to stakers"],
                    ["Batcher", addresses.batcher ?? null, "Lets the relayer send many orders in one transaction"],
                    ["Jackpot", addresses.jackpot ?? null, "Hourly ticket draw"],
                  ] as [string, string | null, string][]
                )
                  .filter(([, address]) => address)
                  .map(([label, address, what]) => (
                    <tr key={label}>
                      <td>
                        <strong>{label}</strong>
                        <br />
                        {what}
                      </td>
                      <td>
                        {config.chainId === 1 ? <a href={`https://etherscan.io/address/${address}#code`} target="_blank" rel="noreferrer"><code>{address}</code></a> : <code>{address}</code>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </>
        )}
      </article>
      </div>
    </div>
  );
}
