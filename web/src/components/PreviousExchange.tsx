import { useEffect, useMemo, useState } from "react";
import { LEGACY, LEGACY_VERSION, PREVIEW } from "../lib/mode";
import { setState, useStore } from "../lib/store";
import { usdExact } from "../lib/format";
import type { PreviousDeployment } from "../lib/types";

interface PreviousBalance { deployment: PreviousDeployment; balance: bigint; queued: bigint; positions: number; failed: boolean }
export function RecoveryBanner() {
  const recovery = useStore(s => s.config?.recovery);
  const owner = useStore(s => s.owner);
  if (!recovery?.paused) return null;
  return <div className="banner" role="status"><b>{recovery.available ? "Trading is paused." : "Exchange status is unavailable."}</b>{" "}
    {recovery.available ? "You can withdraw available USDC to your wallet. Open positions and queued winnings stay recorded." : "Checking recovery status automatically."}{" "}
    {recovery.available && owner && <button className="btn" onClick={() => setState({ dialog: "withdraw" })}>Withdraw USDC</button>}
  </div>;
}
/** Every historical balance stays in its own contract until its owner withdraws it. */
export function PreviousExchange() {
  const config = useStore(s => s.config);
  const owner = useStore(s => s.owner);
  const previous = useMemo(() => config?.previousExchanges ?? (config?.previousExchange ? [config.previousExchange] : []), [config?.previousExchanges, config?.previousExchange]);
  const [state, setState] = useState<{ owner: string; rows: PreviousBalance[] } | null>(null);
  useEffect(() => {
    if (PREVIEW || LEGACY || !owner || !previous.length) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    void Promise.all(previous.map(async deployment => {
      try {
        const response = await fetch(deployment.apiUrl + "/account/" + owner, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw Error("Previous exchange unavailable");
        const result = await response.json();
        if (!/^\d+$/.test(result.balance ?? "") || !/^\d+$/.test(result.queued ?? "") || !Array.isArray(result.positions)) throw Error("Invalid previous exchange account");
        return { deployment, balance: BigInt(result.balance), queued: BigInt(result.queued), positions: result.positions.length, failed: false };
      } catch { return { deployment, balance: 0n, queued: 0n, positions: 0, failed: true }; }
    })).then(rows => { if (active) setState({ owner, rows }); }).finally(() => clearTimeout(timer));
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [owner, previous]);
  if (PREVIEW) return null;
  if (LEGACY) return <div className="banner"><b>Previous exchange{LEGACY_VERSION === "2" ? " (v2)" : ""}.</b> Withdraw your remaining USDC here. <a href="/trade">Trade on current Tape ?</a></div>;
  if (!owner || state?.owner !== owner) return null;
  return <>{state.rows.filter(row => row.failed || row.balance > 0n || row.queued > 0n || row.positions > 0).map(row =>
    <div className="banner" key={row.deployment.address}>
      <b>{row.failed ? "Previous exchange" : usdExact(row.balance) + " in the previous exchange."}</b>{" "}
      {previous.length > 1 && row.deployment.version ? "Version " + row.deployment.version + ". " : ""}
      {row.failed ? "Open it to check your remaining balance." : row.queued > 0n ? usdExact(row.queued) + " is also queued there." : "Your funds remain available there."}{" "}
      <a href={row.deployment.siteUrl}>Open previous exchange{previous.length > 1 && row.deployment.version ? " v" + row.deployment.version : ""} ?</a>
    </div>)}</>;
}
