import { useEffect, useId, useRef, useState } from "react";
import { withdraw } from "../lib/actions";
import { get, loadAccount, loadHistory } from "../lib/api";
import { depositAmount } from "../lib/deposit-flow";
import { amountTyped, big, parseUsd, shortAddress } from "../lib/format";
import { PREVIEW } from "../lib/mode";
import { getState, setState, useStore } from "../lib/store";
import type { History } from "../lib/types";
import { withdrawActive, withdrawalSince } from "../lib/withdraw-flow";
import { Dialog } from "./Dialog";

function Arrow({ check = false }: { check?: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={check ? "m5 12 4 4L19 6" : "M4 12h16m-6-6 6 6-6 6"} /></svg>;
}

export default function WithdrawDialog() {
  const owner = useStore(s => s.owner);
  const account = useStore(s => s.account);
  const config = useStore(s => s.config);
  const emergency = config?.recovery?.paused && config.recovery.available;
  const offline = useStore(s => s.offline);
  const slot = owner?.toLowerCase() ?? "";
  const flow = useStore(s => s.withdrawFlows[slot]);
  const [text, setText] = useState(flow?.stage === "error" ? depositAmount(flow.amount) : "");
  const [watchError, setWatchError] = useState(false);
  const lock = useRef(false), id = useId();
  const free = big(account?.balance) - (emergency ? 0n : big(account?.reserved));
  const max = free > 0n ? free : 0n;
  const amount = parseUsd(text);
  const busy = withdrawActive(flow?.stage);
  const complete = flow?.stage === "complete";
  const issue = !account ? "Loading your available balance…" : amount !== null && amount > max ? "This is more than your available balance." : max === 0n ? "Close a position or add funds to make USDC available." : null;
  const disabled = busy || !!offline || config?.recovery?.available === false || !owner || !account || !amount || amount > max;
  const network = PREVIEW ? "Practice funds" : config?.chainId === 1 ? "Ethereum" : "Local test network";
  const close = () => {
    if (complete) setState(s => ({ withdrawFlows: { ...s.withdrawFlows, [slot]: undefined } }));
    setState({ dialog: null });
  };

  useEffect(() => {
    if (flow?.stage !== "pending" || !owner) return;
    let alive = true, checking = false;
    const check = async () => {
      if (!alive || checking || document.hidden) return;
      checking = true;
      try {
        const history = await get<History>(`/history/${owner}?limit=200`);
        if (!alive || getState().owner?.toLowerCase() !== slot) return;
        setWatchError(false);
        const receipt = withdrawalSince(flow, history.transfers);
        if (receipt) {
          setState(s => s.withdrawFlows[slot]?.id === flow.id ? { withdrawFlows: { ...s.withdrawFlows, [slot]: { ...flow, stage: "complete", tx: receipt.tx, error: undefined } } } : {});
          void Promise.allSettled([loadAccount(), loadHistory()]);
        }
      } catch { if (alive) setWatchError(true); }
      finally { checking = false; }
    };
    void check();
    const timer = setInterval(check, 3000);
    document.addEventListener("visibilitychange", check);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [flow?.id, flow?.stage, owner, slot]);

  return <Dialog title="Withdraw USDC" className="deposit-dialog withdraw-dialog" onClose={close}>
    {complete ? <div className="deposit-complete" role="status" aria-live="polite">
      <div className="deposit-stamp"><Arrow check /></div>
      <h3>Back in your wallet.</h3>
      <p className="deposit-received" data-long={depositAmount(flow.amount, true).length > 10}>{depositAmount(flow.amount, true)}<span>USDC</span></p>
      <p>{PREVIEW ? "Practice funds returned to your wallet." : `Sent on ${network} to ${shortAddress(flow.owner)}.`}</p>
      {flow.tx && !PREVIEW && config?.chainId === 1 && <a className="deposit-transaction" href={`https://etherscan.io/tx/${flow.tx}`} target="_blank" rel="noreferrer">View transaction <Arrow /></a>}
      <button className="btn primary deposit-primary" onClick={close}>Done <Arrow check /></button>
    </div> : busy ? <section className="deposit-progress" aria-label="Withdrawal progress">
      <div className="deposit-stamp"><img src="/img/usdc.png" width="40" height="40" alt="" /></div>
      <h3>{flow.stage === "preparing" ? "Checking your balance." : flow.stage === "wallet" ? "Confirm in your wallet." : flow.stage === "pending" ? "Checking your withdrawal." : PREVIEW ? "Returning your funds." : "Confirming on Ethereum."}</h3>
      <p className="deposit-moving">{depositAmount(flow.amount)} USDC</p>
      <ol className="deposit-steps" aria-label="Withdrawal stages">{(PREVIEW ? ["Trading balance", "Practice wallet"] : [emergency ? "Wallet transaction" : "Wallet signature", "Ethereum confirmation", "Your wallet"]).map((step, index) => {
        const current = flow.stage === "preparing" || flow.stage === "wallet" ? 0 : 1;
        return <li key={step} className={index < current ? "done" : index === current ? "current" : ""} aria-current={index === current ? "step" : undefined}><span>{index < current ? <Arrow check /> : <i />}</span>{step}</li>;
      })}</ol>
      <p className="deposit-help">{flow.stage === "wallet" ? emergency ? "Confirm a direct withdrawal to your wallet. Your wallet pays Ethereum gas." : "Sign only this withdrawal to your connected wallet. The relayer pays the gas." : flow.stage === "pending" ? flow.error : "You can close this window. Reopen Withdraw to check the same transfer."}</p>
      {watchError && <p className="deposit-feedback" role="status">Status is temporarily unavailable. Checking again automatically.</p>}
      <button className="btn deposit-primary" onClick={close}>Close</button>
    </section> : <>
      <div className="deposit-network"><span><img src="/img/usdc.png" width="28" height="28" alt="" /><strong>USDC</strong></span><span className="deposit-chain">{!PREVIEW && <img src="/img/eth.png" width="16" height="16" alt="" />}{network}</span></div>
      <div className="deposit-wallet"><span>Available to withdraw</span><span>{account ? `${depositAmount(max)} USDC` : "Loading balance…"}</span></div>
      <label className="deposit-amount" htmlFor={`${id}-amount`} data-long={text.length > 10}>
        <span>Amount to withdraw</span><div><input id={`${id}-amount`} inputMode="decimal" autoComplete="off" autoFocus aria-label="Amount in USDC" aria-describedby={`${id}-help`} aria-invalid={!!issue && !!text} placeholder="0.00" value={text} onChange={event => setText(amountTyped(text, event.target.value, event.nativeEvent as InputEvent))} /><span>USDC</span></div>
      </label>
      <div className="deposit-presets" aria-label="Quick withdrawal amounts">{[25, 50, 100].map(value => <button type="button" key={value} disabled={!account || max < BigInt(value) * 1_000_000n} className={amount === BigInt(value) * 1_000_000n ? "selected" : ""} onClick={() => setText(String(value))}>${value}</button>)}<button type="button" disabled={!account || max === 0n} className={amount === max && max > 0n ? "selected" : ""} onClick={() => setText(depositAmount(max))}>Max</button></div>
      <p id={`${id}-help`} className={`deposit-amount-help ${issue && text ? "invalid" : ""}`} aria-live="polite">{issue ?? "Withdraw any available amount. No withdrawal fee."}</p>
      {flow?.stage === "error" && <p className="deposit-feedback invalid" role="alert">{flow.error}</p>}
      <div className="withdraw-destination"><span>To your connected wallet</span><strong>{owner ?? "Connect a wallet"}</strong></div>
      <dl className="deposit-receipt"><div><dt>You receive</dt><dd>{amount ? depositAmount(amount) : "0.00"} USDC</dd></div><div><dt>Network fee</dt><dd>{PREVIEW ? "None in practice" : emergency ? "Paid by your wallet" : "Paid by the relayer"}</dd></div><div><dt>Available after withdrawal</dt><dd>{depositAmount(amount && amount <= max ? max - amount : max)} USDC</dd></div></dl>
      <button className="btn primary deposit-primary" disabled={disabled} onClick={async () => {
        if (disabled || !amount || lock.current) return;
        lock.current = true;
        try { await withdraw(amount); } finally { lock.current = false; }
      }}>{offline ? "Reconnecting…" : !amount ? "Enter an amount" : "Withdraw"}<Arrow /></button>
      <p className="deposit-help">{PREVIEW ? "Moves practice funds back to your wallet. No real money moves." : "USDC goes straight to this wallet on Ethereum. Open margin and queued winnings stay in your trading account."}</p>
    </>}
  </Dialog>;
}
