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
  if (/^0x0+$/.test(value)) return <span className="dim">not deployed yet</span>;
  return (
    <span className="copy">
      {shortAddress(value)}
      <button
        onClick={() => {
          navigator.clipboard.writeText(value).then(() => toast("info", "Address copied"), () => toast("info", "Couldn’t copy address", "Select the contract address in Docs and copy it manually."));
        }}
      >
        copy
      </button>
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
        {label} <span className="dim" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>{coinText(max)} available</span>
      </label>
      <div className="field-row">
        <input id={id} className="input" inputMode="decimal" placeholder="0" aria-label={label} value={text} onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ""))} />
        <button className="chip" onClick={() => setText(formatUnits(max, 18))}>
          Max
        </button>
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
        {busy ? "Working" : amount && amount > max ? "More than you have" : action}
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
        <Hero title="Staking" lede="Staking begins when the coin is deployed and attached to the exchange." />
        <ExchangeDataNotice data={data} />
        <section className="pending-banner staking-pending">
          <div>
          <h2>Coin launch pending</h2>
          <p>The exchange is available for trading. There is no coin attached yet, so staking and loss rewards are not active.</p>
          <div className="pending-actions"><Link to="/trade" className="btn primary">Go to exchange</Link><Link to="/docs" className="btn">How staking works</Link></div>
          </div>
          <ol className="staking-roadmap"><li><b>Earn the coin</b><span>Loss rewards after attachment</span></li><li><b>Stake your balance</b><span>No lockup or cooldown</span></li><li><b>Claim USDC</b><span>Rewards to your trading balance</span></li></ol>
        </section>
        <PageSection title="What staking will do" detail="Available after the coin and reward contracts are attached.">
          <dl className="referral-rules"><div><dt>A share of settled fees</dt><dd>Staked tokens earn a share of what the exchange settles, paid in USDC.</dd></div><div><dt>Rewards stream over time</dt><dd>Each distribution streams over 24 hours to whoever is staked at the time.</dd></div><div><dt>Leave when you want</dt><dd>Unstake without a lockup or cooldown. Your trading account works independently.</dd></div></dl>
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
        title="Staking"
        lede={`Stake ${symbol} to earn a share of what the exchange settles, paid in USDC. Losing trades are paid in ${symbol}. No lockup.`}
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

      <PageSection title="Your stake" detail="Move tokens in or out, and claim USDC to your trading balance.">
      <div className="cells staking-actions">
      <Panel title={`Stake ${symbol}`} area="form">
        <div className="panel-body">
          {owner && mine ? (
            <>
              <div className="stake-form">
                <AmountForm label="Stake" max={big(mine.wallet)} action={`Stake ${symbol}`} run={stake} />
                <AmountForm label="Unstake" max={big(mine.staked)} action={`Unstake ${symbol}`} run={unstake} />
              </div>
              <p className="note" style={{ marginTop: 12 }}>
                No lockup and no cooldown. Rewards are paid in USDC and land in your trading balance when you claim.
              </p>
            </>
          ) : (
            <div className="empty" style={{ minHeight: 96 }}>
              Connect a wallet to stake or unstake {symbol}.
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Your rewards" area="claim">
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className={`claim-figure ${pending > 0n ? "up" : ""}`}>{mine ? usd(pending) : "– –"}</div>
          {owner ? (
            <button
              className="btn primary wide"
              disabled={pending === 0n || claiming}
              onClick={async () => {
                setClaiming(true);
                try { await claimRewards(); }
                finally { setClaiming(false); }
              }}
            >
              {claiming ? "Claiming" : pending === 0n ? "Nothing to claim yet" : "Claim to trading balance"}
            </button>
          ) : (
            <button className="btn primary wide" onClick={() => setState({ dialog: "connect" })}>
              {PREVIEW ? "Start trading" : "Connect wallet"}
            </button>
          )}
          <div>
            <div className="kv">
              <span>You have staked</span>
              <span>{mine ? coinText(mine.staked) : dash}</span>
            </div>
            <div className="kv">
              <span>In your wallet</span>
              <span>{mine ? coinText(mine.wallet) : dash}</span>
            </div>
            <div className="kv">
              <span>Your share of the stake</span>
              <span>{mine ? percent(share, share > 0 && share < 0.01 ? 3 : 1) : dash}</span>
            </div>
            <div className="kv">
              <span>Claimed so far</span>
              <span>{mine ? usd(mine.claimed) : dash}</span>
            </div>
          </div>
        </div>
      </Panel>

      </div>
      </PageSection>
      <PageSection title="Distribution and reward rate" detail="Fees collected, rewards streaming and the current rate.">
      <div className="cells staking-distribution">

      <Panel title="Distribution" area="dist">
        <div className="panel-body">
          <div className="kv">
            <span title="Collected by the exchange and not yet sent to stakers.">Waiting to be sent</span>
            <span>{coin ? usd(coin.pendingFees) : "–"}</span>
          </div>
          <div className="kv">
            <span title="Each payment from the exchange is paid to stakers evenly over the next 24 hours, second by second, to whoever is staked at the time.">
              Streaming now
            </span>
            <span>
              {!state ? (
                "–"
              ) : parked > 0n ? (
                `${usd(parked)} · starts with the first stake`
              ) : unstreamed > 0n ? (
                `${usd(unstreamed)} · over the next ${duration(streamLeft)}`
              ) : (
                <span className="dim">Nothing</span>
              )}
            </span>
          </div>
          <div className="kv">
            <span>Latest payment</span>
            <span>{lastAt > 0 ? `${usd(state?.lastDistributionAmount)} · ${ago(lastAt, now)} ago` : <span className="dim">None yet</span>}</span>
          </div>
          <div className="kv rule">
            <span>Token</span>
            <span>{coin ? <Copyable value={coin.address} /> : "–"}</span>
          </div>
          <div className="kv">
            <span>Staking contract</span>
            <span>{coin ? <Copyable value={coin.staking} /> : "–"}</span>
          </div>
        </div>
      </Panel>
      <RewardCurvePanel area="curve" />
      </div>
      </PageSection>

      <PageSection title="Reward history" detail="Revenue, total rewards paid and the token supply over time.">
        <div className="cells staking-history"><StakingRevenue area="revenue" /><StakingRewards area="paid" /><CoinSupply area="supply" /></div>
      </PageSection>

      <PageSection title="Latest activity" detail="The latest 25 loss rewards, stakes, withdrawals and distributions.">
      <Panel title={`${symbol} activity`} tools={<span className="title dim">Last 25</span>}>
        <div className="tbl-wrap" style={{ flex: 1 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Date / time</th>
                <th>Type</th>
                <th>User</th>
                <th className="r">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(coin?.events ?? []).map((event, i) => (
                <tr key={event.tx + i}>
                  <td className="soft">{dateTime(event.time)}</td>
                  <td>
                    <span className={`badge ${EVENT_LABEL[event.type][1]}`}>{EVENT_LABEL[event.type][0]}</span>
                  </td>
                  <td className="soft">{event.user ? shortAddress(event.user) : "all stakers"}</td>
                  <td className="r">
                    <b>{event.type === "claim" || event.type === "distribution" ? usd(event.amount) : coinText(event.amount)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {coin && coin.events.length === 0 && <div className="empty">Nothing yet. The first losing trade starts it.</div>}
        </div>
      </Panel>
      </PageSection>
    </div>
  );
}
