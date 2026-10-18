import { LEGACY, LEGACY_VERSION, PREVIEW } from "../lib/mode";
import { setState, useStore } from "../lib/store";

export function RecoveryBanner() {
  const recovery = useStore(s => s.config?.recovery);
  const owner = useStore(s => s.owner);
  if (!recovery?.paused) return null;
  return <div className="banner" role="status"><b>{recovery.available ? "Trading is paused." : "Exchange status is unavailable."}</b>{" "}
    {recovery.available ? "You can withdraw available USDC to your wallet. Open positions and queued winnings stay recorded." : "Checking recovery status automatically."}{" "}
    {recovery.available && owner && <button className="btn" onClick={() => setState({ dialog: "withdraw" })}>Withdraw USDC</button>}
  </div>;
}
/** Identify an explicitly opened historical exchange. Manual withdrawal links live in More. */
export function PreviousExchange() {
  if (PREVIEW || !LEGACY) return null;
  return <div className="banner"><b>Previous exchange{LEGACY_VERSION === "2" ? " (v2)" : ""}.</b> Withdraw your remaining USDC here. <a href="/trade">Trade on current Tape →</a></div>;
}
