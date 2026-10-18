import { tx, Localized } from "../lib/i18n";
import { useId, useState } from "react";
import { formatUnits } from "viem";
import { Hero } from "../components/Hero";
import { PageSection } from "../components/PageSection";
import { Link } from "../components/Shell";
import { CoinSupply, ExchangeDataNotice, Panel, RewardCurvePanel, StakingRevenue, StakingRewards, useExchangeData } from "../components/Panels";
import { useSecond } from "../components/Tables";
import { claimRewards, stake, unstake } from "../lib/actions";
import { loadAccount } from "../lib/api";
import { usePoll } from "../lib/house";
import { ago, big, coin as coinText, dateTime, duration, parseCoin, percent, shortAddress, usd } from "../lib/format";
import { PREVIEW } from "../lib/mode";
import { setState, toast, useStore } from "../lib/store";
import type { CoinEvent } from "../lib/types";

const dash = <span className="dim">– –</span>;

const EVENT_LABEL: Record<CoinEvent["type"], [string, string]> = {
  mined: ["Loss close", "down"],
  stake: ["Stake", "up"],
  unstake: ["Unstake", ""],
  claim: ["Reward claim", "warn"],
  distribution: ["Distribution", "warn"],
};

function Copyable({ value }: { value: string }) {
  if (/^0x0+$/.test(value)) return <span className="dim">{tx("not deployed yet")}</span>;
  return (
    <span className="copy">
      {shortAddress(value)}
      <button
        onClick={() => {
          navigator.clipboard.writeText(value).then(() => toast("info", "Address copied"), () => toast("info", "Couldn’t copy address", "Select the contract address in Docs and copy it manually."));
        }}
      >{tx("copy")}</button>
    </span>
  );
}

function AmountForm({ label, max, action, run }: { label: string; max: bigint; action: string; run: (amount: bigint) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const amount = parseCoin(text);
  const invalid = !amount || amount === 0n || amount > max;
  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {tx(label)} <span className="dim" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}><Localized message={"{0} available"} values={[coinText(max)]} /></span>
      </label>
      <div className="field-row">
        <input id={id} className="input" inputMode="decimal" placeholder="0" aria-label={tx(label)} value={text} onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ""))} />
        <button className="chip" onClick={() => setText(formatUnits(max, 18))}>{tx("Max")}</button>
      </div>
      <button
        className="btn wide"
        disabled={invalid || busy}
        onClick={async () => {
          if (!amount) return;
          setBusy(true);
          try { if (await run(amount)) setText(""); }
          finally { setBusy(false); }
        }}
      >
        {busy ? tx("Working") : amount && amount > max ? tx("More than you have") : action}
      </button>
    </div>
  );
}

export function Staking() {
  const data = useExchangeData();
  const coin = useStore((s) => s.coin);
  const owner = useStore((s) => s.owner);
  const mine = useStore((s) => s.account?.coin) ?? null;
  // A payout announces itself on the stream. This slow poll only covers a dropped connection.
  usePoll(loadAccount, 15_000, [owner]);
  const now = useSecond();
  const [claiming, setClaiming] = useState(false);

  if (coin && !coin.attached) {
    return (
      <div className="sheet work-page staking-page">
        <Hero title={tx("Staking")} lede={tx("Staking begins when the coin is deployed and attached to the exchange.")} />
        <ExchangeDataNotice data={data} />
        <section className="pending-banner staking-pending">
          <div>
          <h2>{tx("Coin launch pending")}</h2>
          <p>{tx("The exchange is available for trading. There is no coin attached yet, so staking and loss rewards are not active.")}</p>
          <div className="pending-actions"><Link to="/trade" className="btn primary">{tx("Go to exchange")}</Link><Link to="/docs" className="btn">{tx("How staking works")}</Link></div>
          </div>
          <ol className="staking-roadmap"><li><b>{tx("Earn the coin")}</b><span>{tx("Loss rewards after attachment")}</span></li><li><b>{tx("Stake your balance")}</b><span>{tx("No lockup or cooldown")}</span></li><li><b>{tx("Claim USDC")}</b><span>{tx("Rewards to your trading balance")}</span></li></ol>
        </section>
        <PageSection title={tx("What staking will do")} detail={tx("Available after the coin and reward contracts are attached.")}>
          <dl className="referral-rules"><div><dt>{tx("A share of settled fees")}</dt><dd>{tx("Staked tokens earn a share of what the exchange settles, paid in USDC.")}</dd></div><div><dt>{tx("Rewards stream over time")}</dt><dd>{tx("Each distribution streams over 24 hours to whoever is staked at the time.")}</dd></div><div><dt>{tx("Leave when you want")}</dt><dd>{tx("Unstake without a lockup or cooldown. Your trading account works independently.")}</dd></div></dl>
        </PageSection>
      </div>
    );
  }
  const symbol = coin?.symbol ?? "Coin";
  const state = coin?.stakingState;
  const totalStaked = big(state?.totalStaked);
  const share = mine && totalStaked > 0n ? Number((big(mine.staked) * 1_000_000n) / totalStaked) / 1_000_000 : 0;
  const mined = big(coin?.mining.mined);
  const pending = big(mine?.pending);
  const lastAt = Number(state?.lastDistributionAt ?? 0);
  // What staking holds and has not paid out yet: the rest of the running stream, or, while nobody
  // is staked, what is waiting for the first staker.
  const unstreamed = big(state?.unstreamed);
  const parked = big(state?.waiting);
  const streamLeft = Math.max(0, Number(state?.streamEnds ?? 0) - now);

  const ratio = coin && big(coin.supply) > big(coin.mining.reserve) ? Number((totalStaked * 10_000n) / (big(coin.supply) - big(coin.mining.reserve))) / 10_000 : null;

  return (
    <div className="sheet work-page staking-page">
      <Hero
        title={tx("Staking")}
        lede={tx("Stake {0} to earn a share of what the exchange settles, paid in USDC. Losing trades are paid in {1}. No lockup.", [symbol, symbol])}
        figures={[
          { label: "Total supply", value: coin ? coinText(coin.supply) : "–", hint: "Fixed. No more can ever be made." },
          { label: "Mined so far", value: coin ? coinText(mined) : "–", hint: "Paid out to losing traders." },
          { label: "Staked", value: coin ? coinText(totalStaked) : "–" },
          { label: "Stake ratio", value: ratio === null ? "–" : percent(ratio, 1), hint: "Staked, as a share of everything outside the mining reserve." },
          { label: "Paid to stakers", value: state ? usd(state.totalReceived) : "–" },
          { label: "Reward rate", value: coin ? `${coin.rewardRate}%` : "–", hint: "Stakers' cut of every settled profit or loss: nothing while winners are queued, 1% normally, 99% once the vault is over its cap." },
        ]}
      />
      <ExchangeDataNotice data={data} />

      <PageSection title={tx("Your stake")} detail={tx("Move tokens in or out, and claim USDC to your trading balance.")}>
      <div className="cells staking-actions">
      <Panel title={tx("Stake {0}", [symbol])} area="form">
        <div className="panel-body">
          {owner && mine ? (<>
              <div className="stake-form">
                <AmountForm label={tx("Stake")} max={big(mine.wallet)} action={`Stake ${symbol}`} run={stake} />
                <AmountForm label={tx("Unstake")} max={big(mine.staked)} action={`Unstake ${symbol}`} run={unstake} />
              </div>
              <p className="note" style={{ marginTop: 12 }}>{tx("No lockup and no cooldown. Rewards are paid in USDC and land in your trading balance when you claim.")}</p>
            </>) : (<div className="empty" style={{ minHeight: 96 }}><Localized message={"Connect a wallet to stake or unstake {0}."} values={[symbol]} /></div>)}
        </div>
      </Panel>

      <Panel title={tx("Your rewards")} area="claim">
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className={`claim-figure ${pending > 0n ? "up" : ""}`}>{mine ? usd(pending) : "– –"}</div>
          {owner ? (<button
              className="btn primary wide"
              disabled={pending === 0n || claiming}
              onClick={async () => {
                setClaiming(true);
                try { await claimRewards(); }
                finally { setClaiming(false); }
              }}
            >
              {claiming ? tx("Claiming") : pending === 0n ? tx("Nothing to claim yet") : tx("Claim to trading balance")}
            </button>) : (<button className="btn primary wide" onClick={() => setState({ dialog: "connect" })}>
              {PREVIEW ? tx("Start trading") : tx("Connect wallet")}
            </button>)}
          <div>
            <div className="kv">
              <span>{tx("You have staked")}</span>
              <span>{mine ? coinText(mine.staked) : dash}</span>
            </div>
            <div className="kv">
              <span>{tx("In your wallet")}</span>
              <span>{mine ? coinText(mine.wallet) : dash}</span>
            </div>
            <div className="kv">
              <span>{tx("Your share of the stake")}</span>
              <span>{mine ? percent(share, share > 0 && share < 0.01 ? 3 : 1) : dash}</span>
            </div>
            <div className="kv">
              <span>{tx("Claimed so far")}</span>
              <span>{mine ? usd(mine.claimed) : dash}</span>
            </div>
          </div>
        </div>
      </Panel>

      </div>
      </PageSection>
      <PageSection title={tx("Distribution and reward rate")} detail={tx("Fees collected, rewards streaming and the current rate.")}>
      <div className="cells staking-distribution">

      <Panel title={tx("Distribution")} area="dist">
        <div className="panel-body">
          <div className="kv">
            <span title={tx("Collected by the exchange and not yet sent to stakers.")}>{tx("Waiting to be sent")}</span>
            <span>{coin ? usd(coin.pendingFees) : "–"}</span>
          </div>
          <div className="kv">
            <span title={tx("Each payment from the exchange is paid to stakers evenly over the next 24 hours, second by second, to whoever is staked at the time.")}>{tx("Streaming now")}</span>
            <span>
              {!state ? ("–") : parked > 0n ? (tx("{0} · starts with the first stake", [usd(parked)])) : unstreamed > 0n ? (tx("{0} · over the next {1}", [usd(unstreamed), duration(streamLeft)])) : (<span className="dim">{tx("Nothing")}</span>)}
            </span>
          </div>
          <div className="kv">
            <span>{tx("Latest payment")}</span>
            <span>{lastAt > 0 ? tx("{0} · {1} ago", [usd(state?.lastDistributionAmount), ago(lastAt, now)]) : <span className="dim">{tx("None yet")}</span>}</span>
          </div>
          <div className="kv rule">
            <span>{tx("Token")}</span>
            <span>{coin ? <Copyable value={coin.address} /> : "–"}</span>
          </div>
          <div className="kv">
            <span>{tx("Staking contract")}</span>
            <span>{coin ? <Copyable value={coin.staking} /> : "–"}</span>
          </div>
        </div>
      </Panel>
      <RewardCurvePanel area="curve" />
      </div>
      </PageSection>

      <PageSection title={tx("Reward history")} detail={tx("Revenue, total rewards paid and the token supply over time.")}>
        <div className="cells staking-history"><StakingRevenue area="revenue" /><StakingRewards area="paid" /><CoinSupply area="supply" /></div>
      </PageSection>

      <PageSection title={tx("Latest activity")} detail={tx("The latest 25 loss rewards, stakes, withdrawals and distributions.")}>
      <Panel title={tx("{0} activity", [symbol])} tools={<span className="title dim">{tx("Last 25")}</span>}>
        <div className="tbl-wrap" style={{ flex: 1 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{tx("Date / time")}</th>
                <th>{tx("Type")}</th>
                <th>{tx("User")}</th>
                <th className="r">{tx("Amount")}</th>
              </tr>
            </thead>
            <tbody>
              {(coin?.events ?? []).map((event, i) => (
                <tr key={event.tx + i}>
                  <td className="soft">{dateTime(event.time)}</td>
                  <td>
                    <span className={`badge ${EVENT_LABEL[event.type][1]}`}>{EVENT_LABEL[event.type][0]}</span>
                  </td>
                  <td className="soft">{event.user ? shortAddress(event.user) : tx("all stakers")}</td>
                  <td className="r">
                    <b>{event.type === "claim" || event.type === "distribution" ? usd(event.amount) : coinText(event.amount)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {coin && coin.events.length === 0 && <div className="empty">{tx("Nothing yet. The first losing trade starts it.")}</div>}
        </div>
      </Panel>
      </PageSection>
    </div>
  );
}
