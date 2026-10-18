import { tx, Localized } from "../lib/i18n";
import { LEGACY, LEGACY_VERSION, PREVIEW } from "../lib/mode";
import { setState, useStore } from "../lib/store";

export function RecoveryBanner() {
  const recovery = useStore(s => s.config?.recovery);
  const owner = useStore(s => s.owner);
  if (!recovery?.paused) return null;
  return <div className="banner" role="status"><b>{recovery.available ? tx("Trading is paused.") : tx("Exchange status is unavailable.")}</b>{" "}
    {recovery.available ? tx("You can withdraw available USDC to your wallet. Open positions and queued winnings stay recorded.") : tx("Checking recovery status automatically.")}{" "}
    {recovery.available && owner && <button className="btn" onClick={() => setState({ dialog: "withdraw" })}>{tx("Withdraw USDC")}</button>}
  </div>;
}
/** Identify an explicitly opened historical exchange. Manual withdrawal links live in More. */
export function PreviousExchange() {
  if (PREVIEW || !LEGACY) return null;
  return <div className="banner"><Localized message={"<0>Previous exchange{0}.</0> Withdraw your remaining USDC here. <1>Trade on current Tape →</1>"} values={[LEGACY_VERSION === "2" ? " (v2)" : ""]} components={[<b />, <a href="/trade" />]} /></div>;
}
