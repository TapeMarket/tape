import { useEffect, useRef, useState } from "react";
import { REFERRAL_CODE_RULE } from "@shared/referral-code.mjs";
import { createReferralCode } from "../lib/actions";
import { explainWalletError } from "../lib/wallet";

export function CustomReferral({ saved, onCreated }: { saved: string | null; onCreated: (code: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const code = text.trim().toLowerCase();
  const valid = REFERRAL_CODE_RULE.test(code);

  if (saved) return <div className="referral-custom">
    <p className="referral-custom-title">Your custom code <strong>{saved}</strong></p>
    <p>This code is reserved for your wallet. Your username stays the same.</p>
  </div>;

  return <form className="referral-custom" onSubmit={async event => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await createReferralCode(code);
      if (mounted.current) onCreated(saved);
    } catch (reason) { if (mounted.current) setError(explainWalletError(reason)); }
    finally { if (mounted.current) setBusy(false); }
  }}>
    <label htmlFor="custom-referral-code">Create a custom referral code</label>
    <div className="referral-custom-controls">
      <input id="custom-referral-code" className="input left" value={text} onChange={event => { setText(event.target.value.toLowerCase()); setError(null); }} placeholder="your_code" maxLength={16} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} aria-describedby="custom-referral-help custom-referral-feedback" aria-invalid={text.length > 0 && !valid} />
      <button type="submit" className="btn primary" disabled={!valid || busy}>{busy ? "Confirm in wallet…" : "Create custom link"}</button>
    </div>
    <p id="custom-referral-help">3–16 letters, numbers or underscores. One permanent code per wallet. Your username stays the same.</p>
    <p id="custom-referral-feedback" role={error ? "alert" : "status"}>{error ?? (valid ? `${location.origin}/?ref=${code}` : "Sign a free message to reserve your code. No transaction or funds required.")}</p>
  </form>;
}
