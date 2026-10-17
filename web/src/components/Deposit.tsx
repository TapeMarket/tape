import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { deposit, depositAddress, type DepositAddress } from "../lib/actions";
import { get, loadAccount, loadHistory } from "../lib/api";
import { depositActive, depositAmount, depositCreditSince, type DepositFlow } from "../lib/deposit-flow";
import { amountTyped, big, parseUsd as parseAmount, shortAddress, usdExact } from "../lib/format";
import { PREVIEW } from "../lib/mode";
import { navigate, setState, toast, useStore } from "../lib/store";
import type { History, Transfer } from "../lib/types";

const DepositQR = lazy(() => import("./DepositQR"));
function Icon({ kind }: { kind: "wallet" | "transfer" | "check" | "arrow" | "copy" | "external" }) {
  const paths = {
    wallet: <><path d="M4 6h14a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12" /><path d="M20 10h-6v5h6M16 12.5h.01" /></>,
    transfer: <><path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 8V4H4v11h4" /></>,
    external: <path d="M14 3h7v7m0-7L10 14m0-9H3v16h16v-7" />,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

export default function DepositDialog() {
  const owner = useStore(s => s.owner);
  const account = useStore(s => s.account);
  const config = useStore(s => s.config);
  const offline = useStore(s => s.offline);
  const slot = owner?.toLowerCase() ?? "";
  const flow = useStore(s => s.depositFlows[slot]);
  const [method, setMethod] = useState<"wallet" | "transfer">("wallet");
  const [text, setText] = useState(flow?.stage === "error" ? depositAmount(flow.amount) : "");
  const [box, setBox] = useState<DepositAddress | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [watchError, setWatchError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [copy, setCopy] = useState<"idle" | "copied" | "error">("idle");
  const addressField = useRef<HTMLTextAreaElement>(null);
  const baseline = useRef<Transfer[] | null>(null);
  const submitLock = useRef(false);
  const id = useId();
  const byAddress = !PREVIEW && Boolean(config?.addresses.deposits);
  const busy = depositActive(flow?.stage);
  const noGas = byAddress && !!account && big(account.wallet.eth) === 0n;
  const amount = parseAmount(text);
  const max = big(account?.wallet.usdc);
  const minimum = noGas || !byAddress ? 1n : big(box?.minimum);

  // Capture receipts before starting the address watcher, so a fast collection is not missed.
  useEffect(() => {
    if (!byAddress || !owner) return;
    let alive = true;
    setAddressError(null);
    const open = async () => {
      const history = await get<History>(`/history/${owner}?limit=200`);
      if (!alive) return;
      baseline.current = history.transfers;
      const found = await depositAddress(owner);
      if (alive) setBox(found);
    };
    void open().catch(error => { if (alive) setAddressError(error instanceof Error ? error.message : "The deposit address could not be loaded."); });
    return () => { alive = false; };
  }, [byAddress, owner, retry]);

  // External transfers and a previously submitted deposit can finish after reopening this dialog.
  useEffect(() => {
    if (!byAddress || !owner || flow?.stage === "complete" || (method !== "transfer" && flow?.stage !== "pending")) return;
    let alive = true, checking = false;
    const check = async () => {
      if (!alive || checking || document.visibilityState !== "visible" || (baseline.current === null && flow?.stage !== "pending")) return;
      checking = true;
      try {
        const [found, history] = await Promise.all([depositAddress(owner), get<History>(`/history/${owner}?limit=200`)]);
        if (!alive) return;
        setBox(found); setWatchError(false);
        const previous = flow?.stage === "pending" ? flow.baseline : baseline.current ?? [];
        const credited = depositCreditSince(previous, history.transfers);
        if (credited > 0n && (!flow || !depositActive(flow.stage)) && (flow?.stage !== "pending" || credited >= big(flow.amount))) {
          baseline.current = history.transfers;
          await Promise.allSettled([loadAccount(), loadHistory()]);
          if (!alive) return;
          const next: DepositFlow = flow?.stage === "pending" ? { ...flow, stage: "complete", confirmed: true, error: undefined } : { id: Date.now(), owner, amount: credited.toString(), stage: "complete", bySignature: false, confirmed: true, baseline: history.transfers };
          setState(s => {
            const current = s.depositFlows[slot];
            if (depositActive(current?.stage) || (flow?.stage === "pending" && current?.id !== flow.id)) return {};
            return { depositFlows: { ...s.depositFlows, [slot]: next } };
          });
          toast("good", "Deposit received", `${usdExact(next.amount)} credited to your Tape account.`);
        }
      } catch { if (alive) setWatchError(true); }
      finally { checking = false; }
    };
    void check();
    const timer = setInterval(check, 5000);
    document.addEventListener("visibilitychange", check);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [byAddress, owner, method, flow?.id, flow?.stage, box?.address]);

  useEffect(() => {
    if (copy !== "copied") return;
    const timer = setTimeout(() => setCopy("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copy]);

  const reset = () => {
    setState(s => ({ depositFlows: { ...s.depositFlows, [slot]: undefined } }));
    setText(""); setMethod("wallet");
  };
  const close = () => { if (flow?.stage === "complete") reset(); setState({ dialog: null }); };
  const copyAddress = async () => {
    if (!box) return;
    try {
      if (!navigator.clipboard) throw Error("Clipboard unavailable");
      await navigator.clipboard.writeText(box.address); setCopy("copied");
    } catch { setCopy("error"); addressField.current?.focus(); addressField.current?.select(); }
  };
  const activeError = flow?.stage === "error" ? flow.error : null;
  const issue = !account ? "Loading your wallet balance…" : amount !== null && amount > max ? "This is more USDC than your wallet holds." : amount !== null && amount > 0n && amount < minimum ? `Add at least ${depositAmount(minimum)} USDC for automatic collection.` : null;
  const disabled = busy || !!offline || !account || !amount || amount > max || amount < minimum || (byAddress && !noGas && (!box || !!addressError));
  const pending = flow?.stage === "pending";
  const complete = flow?.stage === "complete";
  const progressIndex = flow?.stage === "preparing" || flow?.stage === "wallet" ? 0 : flow?.stage === "confirming" || flow?.stage === "submitting" || (pending && !flow.confirmed) ? 1 : 2;
  const steps = PREVIEW ? ["Practice wallet", "Trading balance"] : [noGas || flow?.bySignature ? "Wallet signature" : "Wallet transfer", "Ethereum confirmation", "Trading balance"];
  const progressTitle = flow?.stage === "preparing" ? "Getting your deposit ready." : flow?.stage === "wallet" ? "Confirm in your wallet." : flow?.stage === "submitting" ? "Submitting your deposit." : flow?.stage === "confirming" ? "Confirming on Ethereum." : pending ? flow.confirmed ? "Confirmed. Credit is pending." : "Checking your deposit." : "Adding your trading funds.";
  const network = PREVIEW ? "Practice funds" : config?.chainId === 1 ? "Ethereum" : "Local test network";

  return <Dialog title="Deposit USDC" className="deposit-dialog" onClose={close}>
    {complete ? <div className="deposit-complete" role="status" aria-live="polite">
      <div className="deposit-stamp"><Icon kind="check" /></div>
      <h3>Deposit received.</h3>
      <p className="deposit-received" data-long={depositAmount(flow.amount, true).length > 10}>{depositAmount(flow.amount, true)}<span>USDC</span></p>
      <p>{PREVIEW ? "Practice funds added to your Tape account." : "Your USDC has been credited to your Tape account."}</p>
      <button className="btn primary deposit-primary" onClick={() => { close(); navigate(PREVIEW ? "/trade?preview=1" : "/trade"); }}>Back to trading <Icon kind="arrow" /></button>
      <button className="deposit-text-button" onClick={reset}>Add more funds</button>
    </div> : busy || pending ? <section className="deposit-progress" aria-label="Deposit progress">
      <div className={`deposit-stamp ${pending ? "waiting" : "sending"}`}><img src="/img/usdc.png" width="40" height="40" alt="" /></div>
      <h3>{progressTitle}</h3>
      <p className="deposit-moving">{depositAmount(flow?.amount ?? "0")} USDC</p>
      <ol className="deposit-steps" aria-label="Deposit stages">{steps.map((step, index) => {
        const current = PREVIEW ? flow?.stage === "preparing" ? 0 : 1 : progressIndex;
        return <li key={step} className={index < current ? "done" : index === current ? "current" : ""} aria-current={index === current ? "step" : undefined}><span>{index < current ? <Icon kind="check" /> : <i />}</span>{step}</li>;
      })}</ol>
      <p className="deposit-help">{flow?.stage === "wallet" ? (flow.bySignature ? "Approve only the amount shown in the USDC permit. The relayer pays the gas." : "Review the USDC transfer in your wallet. No token approval is needed.") : pending ? flow.error ?? "Your transaction confirmed. The funds are still being collected into your trading balance. Keep this window open to check for the credit." : "Your balance updates once the deposit is credited. You can close this window and reopen it to check progress."}</p>
      {watchError && <p className="deposit-feedback" role="status">Status is temporarily unavailable. Checking again automatically.</p>}
      {flow?.tx && config?.chainId === 1 && <a className="deposit-transaction" href={`https://etherscan.io/tx/${flow.tx}`} target="_blank" rel="noreferrer">View transaction <Icon kind="external" /></a>}
      {pending && <button className="btn deposit-primary" onClick={close}>Close</button>}
    </section> : <>
      <div className="deposit-network"><span><img src="/img/usdc.png" width="28" height="28" alt="" /><strong>USDC</strong></span><span className="deposit-chain">{!PREVIEW && <img src="/img/eth.png" width="16" height="16" alt="" />}{network}</span></div>
      {byAddress && <div className="deposit-methods" role="tablist" aria-label="Deposit method">{(["wallet", "transfer"] as const).map(value => <button key={value} type="button" id={`${id}-${value}`} role="tab" aria-selected={method === value} aria-controls={`${id}-panel`} tabIndex={method === value ? 0 : -1} onClick={() => setMethod(value)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const next = event.key === "Home" ? "wallet" : event.key === "End" ? "transfer" : value === "wallet" ? "transfer" : "wallet";
        setMethod(next); document.getElementById(`${id}-${next}`)?.focus();
      }}><Icon kind={value} />{value === "wallet" ? "Connected wallet" : "Transfer USDC"}</button>)}</div>}
      <div id={`${id}-panel`} role={byAddress ? "tabpanel" : undefined} aria-labelledby={byAddress ? `${id}-${method}` : undefined} className="deposit-panel">
        {method === "wallet" ? <>
          <div className="deposit-wallet"><span>{PREVIEW ? "Practice wallet" : owner ? shortAddress(owner) : "Connected wallet"}</span><span>{account ? `${depositAmount(max)} USDC available` : "Loading balance…"}</span></div>
          <label className="deposit-amount" htmlFor={`${id}-amount`} data-long={text.length > 10}>
            <span>Amount to deposit</span><div><input id={`${id}-amount`} inputMode="decimal" autoComplete="off" autoFocus aria-label="Amount in USDC" aria-describedby={`${id}-amount-help`} aria-invalid={!!issue && !!text} placeholder="0.00" value={text} onChange={event => setText(amountTyped(text, event.target.value, event.nativeEvent as InputEvent))} /><span>USDC</span></div>
          </label>
          <div className="deposit-presets" aria-label="Quick deposit amounts">{[25, 50, 100].map(value => <button key={value} type="button" className={amount === BigInt(value) * 1_000_000n ? "selected" : ""} disabled={!account || max < BigInt(value) * 1_000_000n} onClick={() => setText(String(value))}>${value}</button>)}<button type="button" disabled={!account || max === 0n} className={amount !== null && amount === max && max > 0n ? "selected" : ""} onClick={() => setText(depositAmount(max))}>Max</button></div>
          <p id={`${id}-amount-help`} className={`deposit-amount-help ${issue && text ? "invalid" : ""}`} aria-live="polite">{issue ?? (byAddress && !noGas && box ? `${depositAmount(box.minimum)} USDC minimum for automatic collection.` : PREVIEW ? "Practice USDC. No real money moves." : "Sign the exact amount. The relayer pays the gas.")}</p>
          {addressError && !noGas && <div className="deposit-feedback" role="alert"><p>{addressError}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
          {activeError && <p className="deposit-feedback invalid" role="alert">{activeError}</p>}
          <dl className="deposit-receipt"><div><dt>Asset &amp; network</dt><dd>USDC · {network}</dd></div><div><dt>Network fee</dt><dd>{PREVIEW ? "None in practice" : noGas || !byAddress ? "Paid by the relayer" : "Paid in ETH"}</dd></div></dl>
          <button className="btn primary deposit-primary" disabled={disabled} onClick={async () => {
            if (disabled || !amount || submitLock.current) return;
            submitLock.current = true;
            try { await deposit(amount, noGas); } finally { submitLock.current = false; }
          }}>{offline ? "Reconnecting…" : !amount ? "Enter an amount" : "Deposit"}<Icon kind="arrow" /></button>
          <p className="deposit-help">{PREVIEW ? "Moves practice funds from your wallet to Tape." : noGas || !byAddress ? "A USDC permit lets the relayer deposit only the amount you enter. It does not enable one-click trading." : "One USDC transfer from your connected wallet. No approval or permit needed."}</p>
        </> : <>
          <div className="deposit-transfer-intro"><h3>Send from any wallet.</h3><p>Or withdraw from an exchange to your personal Tape deposit address.</p></div>
          {addressError ? <div className="deposit-feedback" role="alert"><p>{addressError}</p><button onClick={() => setRetry(value => value + 1)}>Try again</button></div> : !box ? <div className="deposit-address-loading" role="status">Verifying your deposit address…</div> : <>
            <div className="deposit-address-grid"><Suspense fallback={<div className="deposit-qr-placeholder" aria-label="Loading QR code" />}><DepositQR address={box.address} /></Suspense><div><span className="deposit-address-label">Your deposit address</span><textarea ref={addressField} className="deposit-address" rows={2} readOnly aria-label="Your deposit address" value={box.address} onClick={event => event.currentTarget.select()} /><button className={`deposit-copy ${copy === "copied" ? "copied" : ""}`} onClick={copyAddress}><Icon kind={copy === "copied" ? "check" : "copy"} />{copy === "copied" ? "Address copied" : "Copy address"}</button></div></div>
            {copy === "error" && <p className="deposit-feedback" role="status">Couldn’t copy automatically. The address is selected so you can copy it manually.</p>}
            <div className="deposit-network-note"><img src="/img/eth.png" width="20" height="20" alt="" /><p><strong>Only USDC on Ethereum.</strong><span>Select Ethereum in the sending wallet or exchange. Other assets or networks will not be credited.</span></p></div>
            <dl className="deposit-receipt"><div><dt>Minimum for collection</dt><dd>{depositAmount(box.minimum)} USDC</dd></div><div><dt>Credited to</dt><dd>{owner ? shortAddress(owner) : "This Tape account"}</dd></div></dl>
            <p className="deposit-watching" role="status"><i />{offline || watchError ? "Connection interrupted. Checking again…" : big(box.pending) > 0n ? `${depositAmount(box.pending)} USDC received. ${big(box.pending) < big(box.minimum) ? `Add ${depositAmount(big(box.minimum) - big(box.pending))} more for collection.` : "Waiting for collection."}` : "Watching for your transfer"}</p>
            <p className="deposit-help">Scan the address or copy it. Select USDC and Ethereum in the sending app. Your balance updates after confirmation and collection.</p>
          </>}
        </>}
      </div>
    </>}
  </Dialog>;
}
