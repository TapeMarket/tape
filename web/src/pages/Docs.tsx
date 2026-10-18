import { tx, Localized } from "../lib/i18n";
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
const duration = (seconds: number) => seconds >= 120 && seconds % 60 === 0 ? tx("{0} minutes", [seconds / 60]) : tx("{0} seconds", [seconds]);
const Arrow = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const Anchor = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m10 13 4-4m-6 6-1.5 1.5a3.5 3.5 0 0 1-5-5L6 7a3.5 3.5 0 0 1 5 0m2 10a3.5 3.5 0 0 0 5 0l4.5-4.5a3.5 3.5 0 0 0-5-5L16 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;

function Section({ id, children }: { id: string; children: ReactNode }) {
  const topic = TOPICS.find(item => item.id === id)!;
  return <section className="docs-section" aria-labelledby={id}>
    <h2 id={id} tabIndex={-1}><a href={`#${id}`}>{tx(topic.title)}<span className="docs-heading-link"><Anchor /></span></a></h2>
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
  if (!config || !ready) return <div className="sheet work-page docs-page"><Hero title={tx("Docs")} lede={tx("How trading, deposits and payouts work.")} /><p role="status"><Localized message={"Market information is unavailable. <0>Read the source code.</0>"} components={[<a href={SOURCE} target="_blank" rel="noopener noreferrer" />]} /></p></div>;

  const { timing, addresses } = config;
  const markets = config.markets.some(market => !market.retired) ? config.markets.filter(market => !market.retired) : config.markets;
  const lead = markets.find(market => market.symbol === "BTC") ?? markets[0];
  const maxLeverage = Math.max(...markets.map(market => market.maxLeverage));
  const ticker = `$${config.coin?.symbol.replace(/^\$/, "") ?? "TAPE"}`;
  const attached = Boolean(config.coin && addresses.staking && addresses.lossMining);
  const mining = coin?.attached ? coin.mining : null;
  const filtered = TOPICS.filter(topic => `${tx(topic.title)} ${topic.title} ${topic.terms}`.toLowerCase().includes(query.trim().toLowerCase()));
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
    <Hero title={tx("Docs")} lede={tx("How trading, deposits and payouts work.")} actions={<>
      <a className="btn docs-source" href={SOURCE} target="_blank" rel="noopener noreferrer"><Localized message={"Source code {0}"} values={[<Arrow />]} /></a>
      <Link to="/trade" className="btn primary">{tx("Open exchange")}</Link>
    </>} />
    <div className="docs-wrap">
      <nav className="docs-toc" aria-label={tx("On this page")}>
        <details open={contentsOpen} onToggle={event => setContentsOpen(event.currentTarget.open)}>
          <summary><span>{tx("On this page")}</span><span className="docs-active-topic">{TOPICS.find(topic => topic.id === active)?.title}</span><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></summary>
          <div className="docs-toc-body">
            <label className="docs-search"><Localized message={"Find a topic{0}"} values={[<input type="search" placeholder={tx("Fees, gas, rewards…")} value={query} onChange={event => setQuery(event.target.value)} maxLength={80} />]} /></label>
            {filtered.length ? ["Trading", "Vault and rewards", "Protocol"].map(group => {
              const topics = filtered.filter(topic => topic.group === group);
              return topics.length ? <div className="docs-topic-group" key={group}><p>{tx(group)}</p><ol>{topics.map(topic => <li key={topic.id}><a href={`#${topic.id}`} onClick={event => go(event, topic.id)} aria-current={active === topic.id ? "location" : undefined}>{tx(topic.title)}</a></li>)}</ol></div> : null;
            }) : <div className="docs-no-results" role="status"><p>{tx("No matching topics.")}</p><button type="button" onClick={() => setQuery("")}>{tx("Clear search")}</button></div>}
          </div>
        </details>
      </nav>
      <article className="docs-card docs-body" ref={article}>
        {PREVIEW && <p className="docs-state">{tx("Practice mode uses simulated balances and rewards. No funds move on Ethereum.")}</p>}
        <Section id="what">
          <p className="lede">{tx("Trade long or short with USDC on Ethereum. Every position settles against Tape’s vault.")}</p>
          <p><Localized message={"You choose a market, a margin and leverage up to {0}x. Your position tracks the market’s price; you do not receive the underlying asset. The vault pays winning trades and receives trading losses."} values={[maxLeverage]} /></p>
          <p>{tx("Three rules matter before your first trade:")}</p>
          <ul className="docs-essential"><li><Localized message={"<0>Liquidation takes the full margin.</0> The liquidation price sits before the point where your margin reaches zero."} components={[<a href="#liquidation" />]} /></li><li><Localized message={"<0>Net profit includes pricing deductions.</0> A small price gain pays less than its raw leveraged value."} components={[<a href="#win" />]} /></li><li><Localized message={"<0>Profit can wait in a payout queue.</0> Payment depends on available vault cash."} components={[<a href="#vault" />]} /></li></ul>
          <p><Localized message={"The sections below separate contract rules from services run by the team. <0>Risks</0> lists the permissions and dependencies."} components={[<a href="#risks" />]} /></p>
        </Section>

        <Section id="deposits">
          <h3>{tx("Fund your trading balance")}</h3>
          <ol><li><Localized message={"Connect the wallet you want to trade with and open <0>Deposit</0>."} components={[<strong />]} /></li><li>{tx("Send USDC on Ethereum to the deposit address shown. The connected-wallet flow prepares this transfer for you; the other-wallet flow gives you an address and QR code.")}</li><li>{tx("Wait for the transfer to confirm and the collector to credit your trading balance. A confirmed transfer can appear before collection finishes.")}</li></ol>
          <p><Localized message={"<0>A normal USDC transfer needs ETH for gas.</0> Where available, the permit option lets you sign an exact USDC amount and the relayer pays the transaction gas. A deposit permit does not enable one-click trading."} components={[<strong />]} /></p>
          <p>{tx("Use the network and minimum shown in the deposit dialog. If you send less than the collection minimum, the automatic collector waits for more USDC at that address. Sending tokens on another chain does not fund this exchange.")}</p>
          <h3>{tx("Withdraw USDC")}</h3>
          <p>{tx("Open Withdraw and sign with your wallet. The relayer submits the transaction and USDC returns to your wallet. You can withdraw your free balance; margin in open positions and unpaid queued winnings are unavailable.")}</p>
          <p><Localized message={"If the relayer is unavailable, use the <0>direct withdrawal</0>. It has a waiting period and requires ETH for gas."} components={[<a href="#exit" />]} /></p>
        </Section>

        <Section id="trade">
          <p>{tx("Choose long or short, set your margin and leverage, then review the ticket. Position size equals margin × leverage. Margin and leverage stay fixed after opening; closing settles the whole position.")}</p>
          <p><Localized message={"The current minimum margin is <0>{0}</0>{1}. One account can hold up to 200 open positions."} values={[usd(config.minMargin), big(config.minNotional) > 0n && <>{tx(", with a minimum position size of ")}<strong>{usdCompact(config.minNotional)}</strong></>]} components={[<strong />]} /></p>
          <h3>{tx("One-click trading")}</h3>
          <p><Localized message={"Your wallet registers a browser session key. It can trade your balance for up to 30 days and starts working after {0}. The relayer pays the gas for trades. Withdrawals still require your wallet’s signature."} values={[duration(timing.grace)]} /></p>
          <p>{tx("A stolen session key can spend your balance on losing trades. It cannot sign withdrawals.")}</p>
          <h3>{tx("Prices and fills")}</h3>
          <p><Localized message={"Tape reads the midpoint of Hyperliquid’s best bid and ask. Its price signer signs the update, which the Ethereum oracle verifies. {0}"} values={[timing.execDelay === 0 ? <>{tx("A manual order uses the first fresh feed observation after it reaches the relayer. The quote is signed for that exact order and saved before the fill is returned. There is ")}<strong>{tx("no fixed pricing wait")}</strong>{tx("; Ethereum confirmation follows.")}</> : <>{tx("The fill is the first valid signed price at least ")}<strong><Localized message={"{0} seconds after the order’s timestamp"} values={[timing.execDelay]} /></strong>.</>]} /></p>
          <p>{tx("The fill can appear in the interface before the Ethereum transaction confirms. Size does not change the entry price. Size Impact changes how much a winning close pays.")}</p>
          <p><Localized message={"The standard ticket uses no price limit. Your fill can change while you wait. An order cannot be cancelled after submission; it expires if it does not land within {0}. A usable price must arrive within the contract’s {1}-second pricing window."} values={[duration(timing.intentTtl), timing.pinWindow]} /></p>
          <p><Localized message={"New positions can be refused when opens are paused, a side reaches capacity or the price feed fails its checks. The relayer stops taking orders after {0} without a price. An unfilled order charges no trading fee."} values={[duration(6)]} /></p>
          <h3>{tx("Take profit and stop loss")}</h3>
          <p><Localized message={"Set either trigger when opening or edit it later. {0} Execution can pass your trigger price, and liquidation can happen before the close."} values={[timing.execDelay === 0 ? tx("An active trigger fills at the signed observation that crosses its level, without an additional pricing wait. A newly signed trigger becomes eligible from the following second.") : tx("When the relayer observes the trigger, it sends a close that uses the same {0}-second fill rule.", [timing.execDelay])]} /></p>
          <p>{tx("You can remove a trigger before it activates. An activated closing order cannot be cancelled. Trigger execution depends on the relayer; an outage can delay or miss it.")}</p>
          <details className="docs-details"><summary>{tx("Market limits")}</summary><div className="docs-table-scroll" tabIndex={0} role="region" aria-label={tx("Configured market limits")}><table><caption>{tx("Current configured limits. Available capacity also depends on vault cash and open positions.")}</caption><thead><tr><th>{tx("Market")}</th><th>{tx("Max leverage")}</th><th>{tx("Max position")}</th><th>{tx("Long / short cap")}</th></tr></thead><tbody>{markets.map(market => <tr key={market.id}><td>{market.symbol}</td><td>{market.maxLeverage}x</td><td>{usdCompact(market.maxNotional)}</td><td>{usdCompact(market.capLong)} / {usdCompact(market.capShort)}</td></tr>)}</tbody></table></div><p>{tx("The immutable cash ceiling limits each side to $2,000,000 plus 50 times actual vault cash. Deposits, open cash margin and accrued fees do not increase it.")}</p></details>
        </Section>

        <Section id="liquidation">
          <p><Localized message={"<0>A signed price at or past your liquidation level loses the full margin.</0> There is no partial liquidation or grace period. A later price recovery does not restore the position."} components={[<strong />]} /></p>
          <p>{tx("Liquidation happens before the price would use up all your margin. The exact level depends on leverage, the market’s buffer and price ticks. The ticket shows it before you open.")}</p>
          <div className="docs-table-scroll" tabIndex={0} role="region" aria-label={tx("Leverage and liquidation distance")}><table><caption><Localized message={"{0} long examples. Distances are adverse moves from entry and use the current market parameters."} values={[lead.symbol]} /></caption><thead><tr><th>{tx("Leverage")}</th><th>{tx("Margin reaches zero")}</th><th>{tx("Liquidation")}</th></tr></thead><tbody>{[2, 10, 100, 500, 1000].filter(value => value <= lead.maxLeverage).map(value => <tr key={value}><td>{value}x</td><td>{(100 / value).toFixed(value >= 100 ? 2 : 1)}%</td><td>{(bustDistance(value, lead) * 100).toFixed(4)}%</td></tr>)}</tbody></table></div>
          <p><Localized message={"A short liquidates above its entry; a long liquidates below it. A manual close priced beyond that level also counts as a liquidation. The relayer can liquidate immediately; other callers must wait {0} after the liquidation price was published."} values={[duration(timing.intentTtl)]} /></p>
        </Section>

        <Section id="win">
          <p>{tx("Net profit is calculated in three steps. The position’s displayed PnL already includes them.")}</p>
          <ol><li><Localized message={"<0>Deadband:</0> subtract 0.2 basis points, or 0.002% of the entry price, rounded down to a price tick. Gains inside it pay zero."} components={[<strong />]} /></li><li><Localized message={"<0>Impact haircut:</0> apply the market’s payout curve. Small moves retain a smaller share of their raw gain. The share grows with the move, up to the market’s configured limit."} components={[<strong />]} /></li><li><Localized message={"<0>Win fee:</0> deduct {0}% of the gain left after the first two steps."} values={[feePct]} components={[<strong />]} /></li></ol>
          <DocsExample markets={markets} />
          <h3 id="impact">{tx("Size Impact")}</h3>
          <p>{tx("A crowded side pays less on a winning close. Each market has a depth: positions opened beyond it receive a higher Size Impact, which increases the size term in the payout curve.")}</p>
          <p>{tx("The ticket shows Size Impact before opening. That value stays with the position. Later changes to depth or other traders’ positions do not reprice it. Splitting orders across wallets still adds to the same side.")}</p>
          <p>{tx("An order accepts at most 25% more Size Impact than the ticket showed, or one additional level, whichever is larger. Above that limit it is rejected. Size Impact does not change the entry price, the liquidation level or the loss calculation.")}</p>
        </Section>

        <Section id="fees">
          <div className="docs-table-scroll" tabIndex={0} role="region" aria-label={tx("Trading and network fees")}><table><thead><tr><th>{tx("Action")}</th><th>{tx("Cost")}</th></tr></thead><tbody>
            <tr><td>{tx("Open or hold a position")}</td><td>{tx("No opening fee or funding")}</td></tr><tr><td>{tx("Close at a profit")}</td><td><Localized message={"Deadband, impact haircut, then {0}% of the remaining gain"} values={[feePct]} /></td></tr><tr><td>{tx("Close at a loss")}</td><td>{tx("The trading loss; no extra fee added")}</td></tr><tr><td>{tx("Liquidation")}</td><td>{tx("The full margin")}</td></tr><tr><td>{tx("Normal USDC deposit")}</td><td>{tx("Ethereum gas, paid by the sender")}</td></tr><tr><td>{tx("Permit deposit, relayed trade or withdrawal")}</td><td>{tx("Gas paid by the relayer")}</td></tr><tr><td>{tx("Stake, unstake, claim or exit directly")}</td><td>{tx("Ethereum gas, paid by the caller")}</td></tr>
          </tbody></table></div>
          <p>{tx("On losing closes, the vault pays its fee from the loss it receives. Your loss is not increased. Collected fees split equally between stakers and the team.")}</p>
          <p>{tx("Queued trader claims take priority over new fee allocations and surplus transfers. Winning closes still use the net-profit calculation above. Referral rewards come from the team’s share.")}</p>
        </Section>

        <Section id="vault">
          <p>{tx("The vault is the USDC pool that settles trades. It started without seed capital. Trading losses add cash; winning payouts remove it. A voluntary donation creates no ownership or redemption rights.")}</p>
          <p><Localized message={"If the vault cannot pay a winning close in full, the unpaid profit enters a <0>first-in, first-out queue</0>. Later losses supply cash to pay the oldest claims. Payments can be partial and arrive in your trading balance."} components={[<strong />]} /></p>
          <ul><li>{tx("Cash-funded margin returns at settlement. Unpaid profit can wait.")}</li><li>{tx("A queued claim has no expiry or guaranteed payment date.")}</li><li>{tx("New winners cannot be paid ahead of existing queued claims.")}</li><li><Localized message={"Each loss processes up to four queue entries automatically. The keeper can process more, and anyone can call <0>harvest(maxEntries)</0>."} components={[<code />]} /></li></ul>
          <h3>{tx("Trading with queued winnings")}</h3>
          <p>{tx("The ticket can use queued winnings as margin before cash. This spends the claim’s place in line. A loss cancels the corresponding debt; surviving queue-funded margin and new profit are paid if possible or join the back of the queue.")}</p>
          <p><Localized message={"Cash and queue-funded margin share a loss proportionally. A liquidation consumes both. <0>View the vault and payout queue.</0>"} components={[<Link to="/vault" children={null} />]} /></p>
        </Section>

        <Section id="coin">
          {!attached && <p className="docs-state">{tx("Coin launch pending. Loss rewards and staking are not active on the live exchange. These sections describe the reward-contract implementation.")}</p>}
          <p><Localized message={"Loss mining pays {0} for eligible settled losses. The token reserve is held in a separate <0>LossMining</0> contract. Tape’s launch plan allocates 20% of the fixed supply to that reserve."} values={[ticker]} components={[<code />]} /></p>
          <p><Localized message={"<0>Mining transfers existing tokens.</0> It does not mint more supply. A liquidation uses the full margin to calculate rewards; a losing close uses the loss less any house-side fee. Winning closes earn no loss reward."} components={[<strong />]} /></p>
          <p>{tx("The amount depends on the remaining reserve and cumulative eligible losses. Earlier losses generally receive more tokens per dollar. Funding the reserve adds tokens available for future rewards.")}</p>
          <details className="docs-details"><summary>{tx("Reward formula and delivery")}</summary><pre><code>{tx("reward = reserve × loss / (scale + cumulativeLoss + loss)")}</code></pre><p><Localized message={"Amounts use the contract’s units: USDC has six decimals and {0} has eighteen. With no top-ups, roughly half the initial reserve is emitted when cumulative eligible losses reach the scale; roughly three quarters at three times the scale. Integer rounding can eventually produce a zero reward."} values={[ticker]} /></p><p><Localized message={"A rejected token delivery stays reserved in <0>pendingRewards(user)</0>. Anyone can retry <1>claim(user)</1>; it always pays the original trader. Retrying neither mines again nor changes the loss total. Reward delivery is separate from jackpot tickets. A failure of the entire reward hook is logged by the Exchange and does not reverse the trade."} components={[<code />, <code />]} /></p></details>
          {mining && <p><Localized message={"Reported reserve: {0} {1}. Total rewards mined: {2} {3}. Cumulative eligible losses: {4}."} values={[coinText(mining.reserve), ticker, coinText(mining.mined), ticker, usdCompact(mining.cumulativeLossUsd)]} /></p>}
          <p>{tx("The token’s market price is separate from its emission formula. A reward does not guarantee that its value covers the trading loss.")}</p>
        </Section>

        <Section id="staking">
          {!attached && <p className="docs-state">{tx("Staking starts after the coin and staking contracts are attached.")}</p>}
          <p><Localized message={"Stakers receive USDC from half of collected fees and eligible vault surplus{0}. The keeper calculates surplus after reserving for open positions; the sweeper applies its own on-chain limit. An authorized operator decides when to sweep and how much to request."} values={[cap != null ? tx("above the {0} cap", [usdCompact(cap)]) : tx(" above its cap")]} /></p>
          <p>{tx("Every payment is streamed over 24 hours, in proportion to stake held each second. A new payment spreads the undistributed remainder over a fresh 24 hours with the new funds. When nobody is staked, funds wait; the first stake starts the stream.")}</p>
          <ul><li>{tx("No staking lockup or cooldown. Unstaking preserves rewards already earned.")}</li><li>{tx("A claim credits your Tape trading balance. Withdraw from there to receive USDC in your wallet.")}</li><li>{tx("Staking, unstaking and claiming use wallet transactions and require gas.")}</li><li>{tx("Queued payouts stop new fee allocations and surplus transfers. Funds already in the staking contract can keep streaming.")}</li></ul>
          <p><Localized message={"Before attachment, the staker share of collected fees stays in the Exchange. It enters the stream after attachment and transfer. <0>View staking.</0>"} components={[<Link to="/staking" children={null} />]} /></p>
        </Section>

        <Section id="jackpot">
          {!PREVIEW && !addresses.jackpot && <p className="docs-state">{tx("The jackpot is not active on this exchange yet.")}</p>}
          <p>{tx("Eligible losses add tickets through the loss-mining contract. A liquidation counts its full margin; a losing close counts its eligible loss after the house-side fee. There is no separate ticket purchase.")}</p>
          <p>{tx("The planned rounds last one hour. After a round ends, anyone can close it. Closing freezes its prize and selects an Ethereum block five blocks ahead. Once that block is available, anyone can draw a winner from its hash.")}</p>
          <p><Localized message={"Each round reserves its own prize. Later funding belongs to later rounds. Empty rounds and funding not allocated to a prize roll forward. If a winning USDC transfer fails, the winner and prize stay reserved; <0>claim(round)</0> retries payment to that winner."} components={[<code />]} /></p>
          <p><Localized message={"The draw depends on block hashes, which block producers can influence. It does not use an independent randomness service. <0>View jackpot rounds.</0>"} components={[<Link to="/jackpot" children={null} />]} /></p>
        </Section>

        <Section id="referrals">
          <p><Localized message={"Connect your wallet on <0>Referrals</0> to get a link or create a custom code. The code belongs to your wallet and is separate from your display name."} components={[<Link to="/referrals" children={null} />]} /></p>
          <p>{tx("A new trader follows the link, then enables one-click trading with a wallet that has not traded here before. Each wallet can have one referrer. It cannot refer itself or replace a confirmed referrer.")}</p>
          <p>{tx("The referral page shows the rate, accrued USDC rewards and completed payments. Rewards come from the team’s share of collected fees; the referred trader pays the standard fees. The team sends referral payments to your wallet. They are not an automatic on-chain claim.")}</p>
        </Section>

        <Section id="exit">
          <p>{tx("Your wallet can call the Exchange directly if the relayer stops submitting transactions. Direct calls require ETH for gas. Withdrawals use free USDC balance; queued claims cannot be withdrawn until paid.")}</p>
          <details className="docs-details"><summary>{tx("Withdraw without the relayer")}</summary><ol><li><Localized message={"Call <0>requestWithdraw(amount)</0> from your wallet. USDC uses six decimals: 100 USDC is <1>100000000</1>."} components={[<code />, <code />]} /></li><li><Localized message={"Wait {0}."} values={[duration(timing.withdrawDelay)]} /></li><li><Localized message={"Call <0>executeWithdraw(to)</0> from the same wallet. It sends the requested amount, or the available balance if smaller, to that address."} components={[<code />]} /></li></ol><p><Localized message={"New opens freeze {0} after the request. Closes remain available. To cancel the request, call <0>requestWithdraw(0)</0>. After a request ends, wait {1} before creating another."} values={[duration(timing.grace), duration(timing.grace + timing.intentTtl)]} components={[<code />]} /></p></details>
          <details className="docs-details"><summary>{tx("Close a position directly")}</summary><ol><li><Localized message={"Call <0>requestClose(positionId)</0>. The request cannot be cancelled. Its fill is the first valid price at least {0} after the request."} values={[duration(timing.directDelay)]} components={[<code />]} /></li><li><Localized message={"A non-operator can call <0>executeClose(positionId, priceUpdate)</0> after more than {0} from the request. A valid signed price update for the fill window is required."} values={[duration(timing.directDelay + timing.intentTtl)]} components={[<code />]} /></li><li><Localized message={"The request expires after {0}. If it cannot execute in time, create a new request."} values={[duration(timing.requestExpiry)]} /></li></ol><p><Localized message={"A direct close still depends on a valid oracle price. If the price signer stops, an open position cannot close until a usable price is available. The relayer’s <0>/print</0> endpoint can return recorded signed updates while that service is reachable."} components={[<code />]} /></p></details>
          <p><Localized message={"Use the verified Exchange address under <0>Contracts and code</0>. Reading the code or opening an explorer link does not submit a transaction."} components={[<a href="#contracts" />]} /></p>
        </Section>

        <Section id="risks">
          <dl className="docs-risks">
            <div><dt>{tx("Full-margin liquidation")}</dt><dd><Localized message={"At {0}x on {1}, an adverse move of roughly {2}% can liquidate a position. Stops do not guarantee an earlier exit."} values={[lead.maxLeverage, lead.symbol, (bustDistance(lead.maxLeverage, lead) * 100).toFixed(4)]} /></dd></div>
            <div><dt>{tx("Delayed or unpaid profit")}</dt><dd>{tx("The vault pays from available cash. A queued win has no guaranteed payment date, and may remain unpaid if cash stops arriving.")}</dd></div>
            <div><dt>{tx("A trusted price signer")}</dt><dd><Localized message={"The oracle verifies a signature from Tape’s signing key. Whoever controls that key can sign a false price.{0} The owner can replace the signer."} values={[timing.execDelay === 0 && <> {tx(" The contract checks which order the quote belongs to, but cannot prove it was the first venue observation after intake.")}</>]} /></dd></div>
            <div><dt>{tx("A trusted relayer")}</dt><dd>{tx("The operator submits signed orders and triggers. It can delay, refuse or selectively submit them until expiry. It cannot forge your wallet signature. Direct withdrawals remain available; direct closes also need valid prices.")}</dd></div>
            <div><dt>{tx("Price-feed outages")}</dt><dd>{tx("The server checks quote age, clock drift, book spread and a configured reference. The source defaults compare against Hyperliquid’s own oracle with a 1.5% tolerance. These checks run off-chain. If signing stops, positions stay exposed and can liquidate when prices return.")}</dd></div>
            <div><dt>{tx("Market manipulation and gaps")}</dt><dd>{tx("Prices come from one venue. Caps and Size Impact limit exposure but cannot eliminate manipulation. Stock, index and gold markets can move sharply when their underlying markets reopen.")}</dd></div>
            <div><dt>{tx("Owner and guardian powers")}</dt><dd>{tx("The owner can set market caps, depth, minimum trade sizes, operators and the fee recipient, and attach reward contracts once. The guardian can stop new positions or permanently retire a market. Retired positions settle at the frozen retirement price.")}</dd></div>
            <div><dt>{config?.recovery ? tx("Upgradeable exchange, no outside audit") : tx("Immutable code, no outside audit")}</dt><dd><Localized message={"{0}No outside firm has audited the contracts. Contract, token and signing-key failures can cause loss of funds."} values={[config?.recovery ? tx("The upgrade owner can replace the exchange implementation at the same address. This is a trusted role: replacement code can change how funds are handled. The guardian can immediately install fixed recovery code to stop trading; recovery supports a rescue vault, direct withdrawals of available balances and approved same-wallet migration. Open positions and unpaid claims remain recorded until settled. ") : tx("These contracts cannot be upgraded in place. Code fixes require a new deployment. ")]} /></dd></div>
          </dl>
        </Section>

        <Section id="contracts">
          <p><Localized message={"Tape’s contracts, relayer and interface are <0>open source under MIT {0}</0>. The repository includes tests and the <1>Ethereum deployment record</1>."} values={[<Arrow />]} components={[<a href={SOURCE} target="_blank" rel="noopener noreferrer" />, <a href={`${SOURCE}/blob/main/deployments/1.json`} target="_blank" rel="noopener noreferrer" />]} /></p>
          {!PREVIEW && config.chainId !== 0 ? <>
            <p><Localized message={"Addresses reported by this deployment, chain ID {0}. Ethereum links open verified contract source on Etherscan. Undeployed reward contracts are omitted."} values={[config.chainId]} /></p>
            <dl className="docs-contracts">{contractRows.map(([label, address, description]) => <div key={label}><dt>{tx(label)}<span>{tx(description)}</span></dt><dd>{config.chainId === 1 ? <a href={`https://etherscan.io/address/${address}#code`} target="_blank" rel="noopener noreferrer"><code>{address}</code><Arrow /></a> : <code>{address}</code>}</dd></div>)}</dl>
          </> : <p>{tx("Practice mode runs in your browser. The repository’s deployment record lists the real Ethereum addresses.")}</p>}
          <div className="docs-resources"><a href={`${SOURCE}/blob/main/SECURITY.md`} target="_blank" rel="noopener noreferrer"><Localized message={"Report a vulnerability {0}"} values={[<Arrow />]} /></a><Link to="/status"><Localized message={"Exchange status {0}"} values={[<Arrow />]} /></Link><a href="https://x.com/TapeTrade_" target="_blank" rel="noopener noreferrer"><Localized message={"Tape on X {0}"} values={[<Arrow />]} /></a></div>
        </Section>
      </article>
    </div>
  </div>;
}
