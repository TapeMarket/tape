import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Hero } from "../components/Hero";
import { Link } from "../components/Link";
import { DocsExample } from "../components/DocsExample";
import { FEE_BPS, bustDistance } from "@shared/math.mjs";
import { loadCoin, loadHouse } from "../lib/api";
import { big, coin as coinText, usd, usdCompact } from "../lib/format";
import { PREVIEW } from "../lib/mode";
import { useStore } from "../lib/store";

const SOURCE = "https://github.com/TapeMarket/tape";
const TOPICS = [
  { id: "what", title: "What Tape is", group: "Trading", terms: "overview ethereum usdc perpetuals leverage" },
  { id: "deposits", title: "Deposits and withdrawals", group: "Trading", terms: "fund wallet transfer permit gas network minimum credit" },
  { id: "trade", title: "Opening and closing", group: "Trading", terms: "orders fills prices hyperliquid stop loss take profit session keys limits" },
  { id: "liquidation", title: "Liquidation", group: "Trading", terms: "bust risk leverage margin buffer" },
  { id: "win", title: "How a win is paid", group: "Trading", terms: "profit pnl example calculator size impact haircut deadband pricing" },
  { id: "fees", title: "Fees", group: "Trading", terms: "cost gas funding spread commission" },
  { id: "vault", title: "The vault and payout queue", group: "Vault and rewards", terms: "house cash debt fifo queued winnings margin payment" },
  { id: "coin", title: "The coin", group: "Vault and rewards", terms: "tape token mining reserve supply loss rewards retry claim pending" },
  { id: "staking", title: "Staking", group: "Vault and rewards", terms: "stake unstake usdc rewards stream fees surplus claim" },
  { id: "jackpot", title: "Rekt Jackpot", group: "Vault and rewards", terms: "tickets hourly draw prize retry claim pending" },
  { id: "referrals", title: "Referrals", group: "Vault and rewards", terms: "invite code custom link earn commission" },
  { id: "exit", title: "Direct exits", group: "Protocol", terms: "relayer offline withdraw request close delay contract emergency" },
  { id: "risks", title: "Risks", group: "Protocol", terms: "trust signer operator owner outage audit admin security permissions" },
  { id: "contracts", title: "Contracts and code", group: "Protocol", terms: "addresses ethereum etherscan github source open mit deployment" },
];
const feePct = Number(FEE_BPS) / 100;
const duration = (seconds: number) => seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
const Arrow = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const Anchor = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m10 13 4-4m-6 6-1.5 1.5a3.5 3.5 0 0 1-5-5L6 7a3.5 3.5 0 0 1 5 0m2 10a3.5 3.5 0 0 0 5 0l4.5-4.5a3.5 3.5 0 0 0-5-5L16 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;

function Section({ id, children }: { id: string; children: ReactNode }) {
  const topic = TOPICS.find(item => item.id === id)!;
  return <section className="docs-section" aria-labelledby={id}>
    <h2 id={id} tabIndex={-1}><a href={`#${id}`}>{topic.title}<span className="docs-heading-link"><Anchor /></span></a></h2>
    {children}
  </section>;
}

export function Docs() {
  const config = useStore(state => state.config);
  const coin = useStore(state => state.coin);
  const cap = useStore(state => state.house?.house.stakerCap);
  const article = useRef<HTMLElement>(null);
  const [contentsOpen, setContentsOpen] = useState(() => matchMedia("(min-width: 901px)").matches);
  const [active, setActive] = useState(() => TOPICS.some(item => item.id === location.hash.slice(1)) ? location.hash.slice(1) : "what");
  const [query, setQuery] = useState("");
  const ready = Boolean(config?.markets.length);

  useEffect(() => { void loadCoin().catch(() => {}); void loadHouse().catch(() => {}); }, []);
  useEffect(() => {
    const media = matchMedia("(min-width: 901px)");
    const resize = () => setContentsOpen(media.matches);
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    const body = article.current, root = body?.closest<HTMLElement>(".page");
    if (!ready || !body || !root) return;
    const headings = [...body.querySelectorAll<HTMLElement>("h2[id]")];
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = root.getBoundingClientRect().top + 112;
      const current = root.scrollTop + root.clientHeight >= root.scrollHeight - 4
        ? headings.at(-1)
        : [...headings].reverse().find(heading => heading.getBoundingClientRect().top <= line) ?? headings[0];
      if (current) setActive(current.id);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const followHash = () => {
      const heading = document.getElementById(location.hash.slice(1));
      if (heading && body.contains(heading)) { heading.scrollIntoView({ block: "start" }); setActive(heading.id); }
      schedule();
    };
    const initial = requestAnimationFrame(followHash);
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", followHash);
    return () => {
      cancelAnimationFrame(initial); cancelAnimationFrame(frame);
      root.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); window.removeEventListener("hashchange", followHash);
    };
  }, [ready]);

  const go = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (location.hash !== `#${id}`) history.pushState(null, "", `#${id}`);
    setActive(id);
    if (matchMedia("(max-width: 900px)").matches) setContentsOpen(false);
    requestAnimationFrame(() => {
      const heading = document.getElementById(id);
      heading?.scrollIntoView({ block: "start" }); heading?.focus({ preventScroll: true });
    });
  };
  if (!config || !ready) return <div className="sheet work-page docs-page"><Hero title="Docs" lede="How trading, deposits and payouts work." /><p role="status">Market information is unavailable. <a href={SOURCE} target="_blank" rel="noopener noreferrer">Read the source code.</a></p></div>;

  const { timing, addresses } = config;
  const markets = config.markets.some(market => !market.retired) ? config.markets.filter(market => !market.retired) : config.markets;
  const lead = markets.find(market => market.symbol === "BTC") ?? markets[0];
  const maxLeverage = Math.max(...markets.map(market => market.maxLeverage));
  const ticker = `$${config.coin?.symbol.replace(/^\$/, "") ?? "TAPE"}`;
  const attached = Boolean(config.coin && addresses.staking && addresses.lossMining);
  const mining = coin?.attached ? coin.mining : null;
  const filtered = TOPICS.filter(topic => `${topic.title} ${topic.terms}`.toLowerCase().includes(query.trim().toLowerCase()));
  const contractRows = [
    ["Exchange", addresses.exchange, "Balances, positions and payouts"],
    ["Sessions", addresses.sessions, "One-click trading keys"],
    ["Price oracle", addresses.oracle, "Signed price verification"],
    ["Lens", addresses.lens, "Read-only exchange views"],
    ["Gateway", addresses.gateway, "USDC permit deposits"],
    ["Deposits", addresses.deposits, "Wallet-specific deposit addresses"],
    ["Batcher", addresses.batcher, "Batched operator transactions"],
    ["USDC", addresses.usdc, "Trading collateral"],
    ["Coin", addresses.coin, "Loss rewards and staking token"],
    ["Staking", addresses.staking, "USDC reward stream"],
    ["Loss mining", addresses.lossMining, "Loss-reward reserve"],
    ["Sweeper", addresses.sweeper, "Vault surplus transfers"],
    ["Jackpot", addresses.jackpot, "Round funding and prizes"],
  ].filter(([, address]) => address) as [string, string, string][];

  return <div className="sheet work-page docs-page">
    <Hero title="Docs" lede="How trading, deposits and payouts work." actions={<>
      <a className="btn docs-source" href={SOURCE} target="_blank" rel="noopener noreferrer">Source code <Arrow /></a>
      <Link to="/trade" className="btn primary">Open exchange</Link>
    </>} />
    <div className="docs-wrap">
      <nav className="docs-toc" aria-label="On this page">
        <details open={contentsOpen} onToggle={event => setContentsOpen(event.currentTarget.open)}>
          <summary><span>On this page</span><span className="docs-active-topic">{TOPICS.find(topic => topic.id === active)?.title}</span><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></summary>
          <div className="docs-toc-body">
            <label className="docs-search">Find a topic<input type="search" placeholder="Fees, gas, rewards…" value={query} onChange={event => setQuery(event.target.value)} maxLength={80} /></label>
            {filtered.length ? ["Trading", "Vault and rewards", "Protocol"].map(group => {
              const topics = filtered.filter(topic => topic.group === group);
              return topics.length ? <div className="docs-topic-group" key={group}><p>{group}</p><ol>{topics.map(topic => <li key={topic.id}><a href={`#${topic.id}`} onClick={event => go(event, topic.id)} aria-current={active === topic.id ? "location" : undefined}>{topic.title}</a></li>)}</ol></div> : null;
            }) : <div className="docs-no-results" role="status"><p>No matching topics.</p><button type="button" onClick={() => setQuery("")}>Clear search</button></div>}
          </div>
        </details>
      </nav>
      <article className="docs-card docs-body" ref={article}>
        {PREVIEW && <p className="docs-state">Practice mode uses simulated balances and rewards. No funds move on Ethereum.</p>}
        <Section id="what">
          <p className="lede">Trade long or short with USDC on Ethereum. Every position settles against Tape’s vault.</p>
          <p>You choose a market, a margin and leverage up to {maxLeverage}x. Your position tracks the market’s price; you do not receive the underlying asset. The vault pays winning trades and receives trading losses.</p>
          <p>Three rules matter before your first trade:</p>
          <ul className="docs-essential"><li><a href="#liquidation">Liquidation takes the full margin.</a> The liquidation price sits before the point where your margin reaches zero.</li><li><a href="#win">Net profit includes pricing deductions.</a> A small price gain pays less than its raw leveraged value.</li><li><a href="#vault">Profit can wait in a payout queue.</a> Payment depends on available vault cash.</li></ul>
          <p>The sections below separate contract rules from services run by the team. <a href="#risks">Risks</a> lists the permissions and dependencies.</p>
        </Section>

        <Section id="deposits">
          <h3>Fund your trading balance</h3>
          <ol><li>Connect the wallet you want to trade with and open <strong>Deposit</strong>.</li><li>Send USDC on Ethereum to the deposit address shown. The connected-wallet flow prepares this transfer for you; the other-wallet flow gives you an address and QR code.</li><li>Wait for the transfer to confirm and the collector to credit your trading balance. A confirmed transfer can appear before collection finishes.</li></ol>
          <p><strong>A normal USDC transfer needs ETH for gas.</strong> Where available, the permit option lets you sign an exact USDC amount and the relayer pays the transaction gas. A deposit permit does not enable one-click trading.</p>
          <p>Use the network and minimum shown in the deposit dialog. If you send less than the collection minimum, the automatic collector waits for more USDC at that address. Sending tokens on another chain does not fund this exchange.</p>
          <h3>Withdraw USDC</h3>
          <p>Open Withdraw and sign with your wallet. The relayer submits the transaction and USDC returns to your wallet. You can withdraw your free balance; margin in open positions and unpaid queued winnings are unavailable.</p>
          <p>If the relayer is unavailable, use the <a href="#exit">direct withdrawal</a>. It has a waiting period and requires ETH for gas.</p>
        </Section>

        <Section id="trade">
          <p>Choose long or short, set your margin and leverage, then review the ticket. Position size equals margin × leverage. Margin and leverage stay fixed after opening; closing settles the whole position.</p>
          <p>The current minimum margin is <strong>{usd(config.minMargin)}</strong>{big(config.minNotional) > 0n && <>, with a minimum position size of <strong>{usdCompact(config.minNotional)}</strong></>}. One account can hold up to 200 open positions.</p>
          <h3>One-click trading</h3>
          <p>Your wallet registers a browser session key. It can trade your balance for up to 30 days and starts working after {duration(timing.grace)}. The relayer pays the gas for trades. Withdrawals still require your wallet’s signature.</p>
          <p>A stolen session key can spend your balance on losing trades. It cannot sign withdrawals.</p>
          <h3>Prices and fills</h3>
          <p>Tape reads the midpoint of Hyperliquid’s best bid and ask. Its price signer signs the update, which the Ethereum oracle verifies. {timing.execDelay === 0 ? <>A manual order uses the first fresh feed observation after it reaches the relayer. The quote is signed for that exact order and saved before the fill is returned. There is <strong>no fixed pricing wait</strong>; Ethereum confirmation follows.</> : <>The fill is the first valid signed price at least <strong>{timing.execDelay} seconds after the order’s timestamp</strong>.</>}</p>
          <p>The fill can appear in the interface before the Ethereum transaction confirms. Size does not change the entry price. Size Impact changes how much a winning close pays.</p>
          <p>The standard ticket uses no price limit. Your fill can change while you wait. An order cannot be cancelled after submission; it expires if it does not land within {duration(timing.intentTtl)}. A usable price must arrive within the contract’s {timing.pinWindow}-second pricing window.</p>
          <p>New positions can be refused when opens are paused, a side reaches capacity or the price feed fails its checks. The relayer stops taking orders after {duration(6)} without a price. An unfilled order charges no trading fee.</p>
          <h3>Take profit and stop loss</h3>
          <p>Set either trigger when opening or edit it later. {timing.execDelay === 0 ? "An active trigger fills at the signed observation that crosses its level, without an additional pricing wait. A newly signed trigger becomes eligible from the following second." : `When the relayer observes the trigger, it sends a close that uses the same ${timing.execDelay}-second fill rule.`} Execution can pass your trigger price, and liquidation can happen before the close.</p>
          <p>You can remove a trigger before it activates. An activated closing order cannot be cancelled. Trigger execution depends on the relayer; an outage can delay or miss it.</p>
          <details className="docs-details"><summary>Market limits</summary><div className="docs-table-scroll" tabIndex={0} role="region" aria-label="Configured market limits"><table><caption>Current configured limits. Available capacity also depends on vault cash and open positions.</caption><thead><tr><th>Market</th><th>Max leverage</th><th>Max position</th><th>Long / short cap</th></tr></thead><tbody>{markets.map(market => <tr key={market.id}><td>{market.symbol}</td><td>{market.maxLeverage}x</td><td>{usdCompact(market.maxNotional)}</td><td>{usdCompact(market.capLong)} / {usdCompact(market.capShort)}</td></tr>)}</tbody></table></div><p>The immutable cash ceiling limits each side to $2,000,000 plus 50 times actual vault cash. Deposits, open cash margin and accrued fees do not increase it.</p></details>
        </Section>

        <Section id="liquidation">
          <p><strong>A signed price at or past your liquidation level loses the full margin.</strong> There is no partial liquidation or grace period. A later price recovery does not restore the position.</p>
          <p>Liquidation happens before the price would use up all your margin. The exact level depends on leverage, the market’s buffer and price ticks. The ticket shows it before you open.</p>
          <div className="docs-table-scroll" tabIndex={0} role="region" aria-label="Leverage and liquidation distance"><table><caption>{lead.symbol} long examples. Distances are adverse moves from entry and use the current market parameters.</caption><thead><tr><th>Leverage</th><th>Margin reaches zero</th><th>Liquidation</th></tr></thead><tbody>{[2, 10, 100, 500, 1000].filter(value => value <= lead.maxLeverage).map(value => <tr key={value}><td>{value}x</td><td>{(100 / value).toFixed(value >= 100 ? 2 : 1)}%</td><td>{(bustDistance(value, lead) * 100).toFixed(4)}%</td></tr>)}</tbody></table></div>
          <p>A short liquidates above its entry; a long liquidates below it. A manual close priced beyond that level also counts as a liquidation. The relayer can liquidate immediately; other callers must wait {duration(timing.intentTtl)} after the liquidation price was published.</p>
        </Section>

        <Section id="win">
          <p>Net profit is calculated in three steps. The position’s displayed PnL already includes them.</p>
          <ol><li><strong>Deadband:</strong> subtract 0.2 basis points, or 0.002% of the entry price, rounded down to a price tick. Gains inside it pay zero.</li><li><strong>Impact haircut:</strong> apply the market’s payout curve. Small moves retain a smaller share of their raw gain. The share grows with the move, up to the market’s configured limit.</li><li><strong>Win fee:</strong> deduct {feePct}% of the gain left after the first two steps.</li></ol>
          <DocsExample markets={markets} />
          <h3 id="impact">Size Impact</h3>
          <p>A crowded side pays less on a winning close. Each market has a depth: positions opened beyond it receive a higher Size Impact, which increases the size term in the payout curve.</p>
          <p>The ticket shows Size Impact before opening. That value stays with the position. Later changes to depth or other traders’ positions do not reprice it. Splitting orders across wallets still adds to the same side.</p>
          <p>An order accepts at most 25% more Size Impact than the ticket showed, or one additional level, whichever is larger. Above that limit it is rejected. Size Impact does not change the entry price, the liquidation level or the loss calculation.</p>
        </Section>

        <Section id="fees">
          <div className="docs-table-scroll" tabIndex={0} role="region" aria-label="Trading and network fees"><table><thead><tr><th>Action</th><th>Cost</th></tr></thead><tbody>
            <tr><td>Open or hold a position</td><td>No opening fee or funding</td></tr><tr><td>Close at a profit</td><td>Deadband, impact haircut, then {feePct}% of the remaining gain</td></tr><tr><td>Close at a loss</td><td>The trading loss; no extra fee added</td></tr><tr><td>Liquidation</td><td>The full margin</td></tr><tr><td>Normal USDC deposit</td><td>Ethereum gas, paid by the sender</td></tr><tr><td>Permit deposit, relayed trade or withdrawal</td><td>Gas paid by the relayer</td></tr><tr><td>Stake, unstake, claim or exit directly</td><td>Ethereum gas, paid by the caller</td></tr>
          </tbody></table></div>
          <p>On losing closes, the vault pays its fee from the loss it receives. Your loss is not increased. Collected fees split equally between stakers and the team.</p>
          <p>Queued trader claims take priority over new fee allocations and surplus transfers. Winning closes still use the net-profit calculation above. Referral rewards come from the team’s share.</p>
        </Section>

        <Section id="vault">
          <p>The vault is the USDC pool that settles trades. It started without seed capital. Trading losses add cash; winning payouts remove it. A voluntary donation creates no ownership or redemption rights.</p>
          <p>If the vault cannot pay a winning close in full, the unpaid profit enters a <strong>first-in, first-out queue</strong>. Later losses supply cash to pay the oldest claims. Payments can be partial and arrive in your trading balance.</p>
          <ul><li>Cash-funded margin returns at settlement. Unpaid profit can wait.</li><li>A queued claim has no expiry or guaranteed payment date.</li><li>New winners cannot be paid ahead of existing queued claims.</li><li>Each loss processes up to four queue entries automatically. The keeper can process more, and anyone can call <code>harvest(maxEntries)</code>.</li></ul>
          <h3>Trading with queued winnings</h3>
          <p>The ticket can use queued winnings as margin before cash. This spends the claim’s place in line. A loss cancels the corresponding debt; surviving queue-funded margin and new profit are paid if possible or join the back of the queue.</p>
          <p>Cash and queue-funded margin share a loss proportionally. A liquidation consumes both. <Link to="/vault">View the vault and payout queue.</Link></p>
        </Section>

        <Section id="coin">
          {!attached && <p className="docs-state">Coin launch pending. Loss rewards and staking are not active on the live exchange. These sections describe the reward-contract implementation.</p>}
          <p>Loss mining pays {ticker} for eligible settled losses. The token reserve is held in a separate <code>LossMining</code> contract. Tape’s launch plan allocates 20% of the fixed supply to that reserve.</p>
          <p><strong>Mining transfers existing tokens.</strong> It does not mint more supply. A liquidation uses the full margin to calculate rewards; a losing close uses the loss less any house-side fee. Winning closes earn no loss reward.</p>
          <p>The amount depends on the remaining reserve and cumulative eligible losses. Earlier losses generally receive more tokens per dollar. Funding the reserve adds tokens available for future rewards.</p>
          <details className="docs-details"><summary>Reward formula and delivery</summary><pre><code>reward = reserve × loss / (scale + cumulativeLoss + loss)</code></pre><p>Amounts use the contract’s units: USDC has six decimals and {ticker} has eighteen. With no top-ups, roughly half the initial reserve is emitted when cumulative eligible losses reach the scale; roughly three quarters at three times the scale. Integer rounding can eventually produce a zero reward.</p><p>A rejected token delivery stays reserved in <code>pendingRewards(user)</code>. Anyone can retry <code>claim(user)</code>; it always pays the original trader. Retrying neither mines again nor changes the loss total. Reward delivery is separate from jackpot tickets. A failure of the entire reward hook is logged by the Exchange and does not reverse the trade.</p></details>
          {mining && <p>Reported reserve: {coinText(mining.reserve)} {ticker}. Total rewards mined: {coinText(mining.mined)} {ticker}. Cumulative eligible losses: {usdCompact(mining.cumulativeLossUsd)}.</p>}
          <p>The token’s market price is separate from its emission formula. A reward does not guarantee that its value covers the trading loss.</p>
        </Section>

        <Section id="staking">
          {!attached && <p className="docs-state">Staking starts after the coin and staking contracts are attached.</p>}
          <p>Stakers receive USDC from half of collected fees and eligible vault surplus{cap != null ? ` above the ${usdCompact(cap)} cap` : " above its cap"}. The keeper calculates surplus after reserving for open positions; the sweeper applies its own on-chain limit. An authorized operator decides when to sweep and how much to request.</p>
          <p>Every payment is streamed over 24 hours, in proportion to stake held each second. A new payment spreads the undistributed remainder over a fresh 24 hours with the new funds. When nobody is staked, funds wait; the first stake starts the stream.</p>
          <ul><li>No staking lockup or cooldown. Unstaking preserves rewards already earned.</li><li>A claim credits your Tape trading balance. Withdraw from there to receive USDC in your wallet.</li><li>Staking, unstaking and claiming use wallet transactions and require gas.</li><li>Queued payouts stop new fee allocations and surplus transfers. Funds already in the staking contract can keep streaming.</li></ul>
          <p>Before attachment, the staker share of collected fees stays in the Exchange. It enters the stream after attachment and transfer. <Link to="/staking">View staking.</Link></p>
        </Section>

        <Section id="jackpot">
          {!PREVIEW && !addresses.jackpot && <p className="docs-state">The jackpot is not active on this exchange yet.</p>}
          <p>Eligible losses add tickets through the loss-mining contract. A liquidation counts its full margin; a losing close counts its eligible loss after the house-side fee. There is no separate ticket purchase.</p>
          <p>The planned rounds last one hour. After a round ends, anyone can close it. Closing freezes its prize and selects an Ethereum block five blocks ahead. Once that block is available, anyone can draw a winner from its hash.</p>
          <p>Each round reserves its own prize. Later funding belongs to later rounds. Empty rounds and funding not allocated to a prize roll forward. If a winning USDC transfer fails, the winner and prize stay reserved; <code>claim(round)</code> retries payment to that winner.</p>
          <p>The draw depends on block hashes, which block producers can influence. It does not use an independent randomness service. <Link to="/jackpot">View jackpot rounds.</Link></p>
        </Section>

        <Section id="referrals">
          <p>Connect your wallet on <Link to="/referrals">Referrals</Link> to get a link or create a custom code. The code belongs to your wallet and is separate from your display name.</p>
          <p>A new trader follows the link, then enables one-click trading with a wallet that has not traded here before. Each wallet can have one referrer. It cannot refer itself or replace a confirmed referrer.</p>
          <p>The referral page shows the rate, accrued USDC rewards and completed payments. Rewards come from the team’s share of collected fees; the referred trader pays the standard fees. The team sends referral payments to your wallet. They are not an automatic on-chain claim.</p>
        </Section>

        <Section id="exit">
          <p>Your wallet can call the Exchange directly if the relayer stops submitting transactions. Direct calls require ETH for gas. Withdrawals use free USDC balance; queued claims cannot be withdrawn until paid.</p>
          <details className="docs-details"><summary>Withdraw without the relayer</summary><ol><li>Call <code>requestWithdraw(amount)</code> from your wallet. USDC uses six decimals: 100 USDC is <code>100000000</code>.</li><li>Wait {duration(timing.withdrawDelay)}.</li><li>Call <code>executeWithdraw(to)</code> from the same wallet. It sends the requested amount, or the available balance if smaller, to that address.</li></ol><p>New opens freeze {duration(timing.grace)} after the request. Closes remain available. To cancel the request, call <code>requestWithdraw(0)</code>. After a request ends, wait {duration(timing.grace + timing.intentTtl)} before creating another.</p></details>
          <details className="docs-details"><summary>Close a position directly</summary><ol><li>Call <code>requestClose(positionId)</code>. The request cannot be cancelled. Its fill is the first valid price at least {duration(timing.directDelay)} after the request.</li><li>A non-operator can call <code>executeClose(positionId, priceUpdate)</code> after more than {duration(timing.directDelay + timing.intentTtl)} from the request. A valid signed price update for the fill window is required.</li><li>The request expires after {duration(timing.requestExpiry)}. If it cannot execute in time, create a new request.</li></ol><p>A direct close still depends on a valid oracle price. If the price signer stops, an open position cannot close until a usable price is available. The relayer’s <code>/print</code> endpoint can return recorded signed updates while that service is reachable.</p></details>
          <p>Use the verified Exchange address under <a href="#contracts">Contracts and code</a>. Reading the code or opening an explorer link does not submit a transaction.</p>
        </Section>

        <Section id="risks">
          <dl className="docs-risks">
            <div><dt>Full-margin liquidation</dt><dd>At {lead.maxLeverage}x on {lead.symbol}, an adverse move of roughly {(bustDistance(lead.maxLeverage, lead) * 100).toFixed(4)}% can liquidate a position. Stops do not guarantee an earlier exit.</dd></div>
            <div><dt>Delayed or unpaid profit</dt><dd>The vault pays from available cash. A queued win has no guaranteed payment date, and may remain unpaid if cash stops arriving.</dd></div>
            <div><dt>A trusted price signer</dt><dd>The oracle verifies a signature from Tape’s signing key. Whoever controls that key can sign a false price.{timing.execDelay === 0 && <> The contract checks which order the quote belongs to, but cannot prove it was the first venue observation after intake.</>} The owner can replace the signer.</dd></div>
            <div><dt>A trusted relayer</dt><dd>The operator submits signed orders and triggers. It can delay, refuse or selectively submit them until expiry. It cannot forge your wallet signature. Direct withdrawals remain available; direct closes also need valid prices.</dd></div>
            <div><dt>Price-feed outages</dt><dd>The server checks quote age, clock drift, book spread and a configured reference. The source defaults compare against Hyperliquid’s own oracle with a 1.5% tolerance. These checks run off-chain. If signing stops, positions stay exposed and can liquidate when prices return.</dd></div>
            <div><dt>Market manipulation and gaps</dt><dd>Prices come from one venue. Caps and Size Impact limit exposure but cannot eliminate manipulation. Stock, index and gold markets can move sharply when their underlying markets reopen.</dd></div>
            <div><dt>Owner and guardian powers</dt><dd>The owner can set market caps, depth, minimum trade sizes, operators and the fee recipient, and attach reward contracts once. The guardian can stop new positions or permanently retire a market. Retired positions settle at the frozen retirement price.</dd></div>
            <div><dt>Immutable code, no outside audit</dt><dd>These contracts cannot be upgraded in place. Code fixes require a new deployment. No outside firm has audited the contracts. Contract, token and signing-key failures can cause loss of funds.</dd></div>
          </dl>
        </Section>

        <Section id="contracts">
          <p>Tape’s contracts, relayer and interface are <a href={SOURCE} target="_blank" rel="noopener noreferrer">open source under MIT <Arrow /></a>. The repository includes tests and the <a href={`${SOURCE}/blob/main/deployments/1.json`} target="_blank" rel="noopener noreferrer">Ethereum deployment record</a>.</p>
          {!PREVIEW && config.chainId !== 0 ? <>
            <p>Addresses reported by this deployment, chain ID {config.chainId}. Ethereum links open verified contract source on Etherscan. Undeployed reward contracts are omitted.</p>
            <dl className="docs-contracts">{contractRows.map(([label, address, description]) => <div key={label}><dt>{label}<span>{description}</span></dt><dd>{config.chainId === 1 ? <a href={`https://etherscan.io/address/${address}#code`} target="_blank" rel="noopener noreferrer"><code>{address}</code><Arrow /></a> : <code>{address}</code>}</dd></div>)}</dl>
          </> : <p>Practice mode runs in your browser. The repository’s deployment record lists the real Ethereum addresses.</p>}
          <div className="docs-resources"><a href={`${SOURCE}/blob/main/SECURITY.md`} target="_blank" rel="noopener noreferrer">Report a vulnerability <Arrow /></a><Link to="/status">Exchange status <Arrow /></Link><a href="https://x.com/TapeTrade_" target="_blank" rel="noopener noreferrer">Tape on X <Arrow /></a></div>
        </Section>
      </article>
    </div>
  </div>;
}
