import { useEffect, useState } from "react";
import { LEGACY, PREVIEW } from "../lib/mode";
import { useStore } from "../lib/store";
import { usdExact } from "../lib/format";

/** An old balance stays in its original contract until its owner withdraws it. */
export function PreviousExchange() {
  const previous = useStore(s => s.config?.previousExchange);
  const owner = useStore(s => s.owner);
  const [state, setState] = useState<{ owner: string; balance: bigint; queued: bigint; positions: number; failed: boolean } | null>(null);
  useEffect(() => {
    if (PREVIEW || LEGACY || !owner || !previous) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    fetch(`${previous.apiUrl}/account/${owner}`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw Error("Previous exchange unavailable");
      const result = await response.json();
      if (!/^\d+$/.test(result.balance ?? "") || !/^\d+$/.test(result.queued ?? "") || !Array.isArray(result.positions)) throw Error("Invalid previous exchange account");
      if (active) setState({ owner, balance: BigInt(result.balance), queued: BigInt(result.queued), positions: result.positions.length, failed: false });
    }).catch(() => { if (active) setState({ owner, balance: 0n, queued: 0n, positions: 0, failed: true }); }).finally(() => clearTimeout(timer));
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [owner, previous]);
  if (PREVIEW) return null;
  if (LEGACY) return <div className="banner"><b>Previous exchange.</b> Withdraw your remaining USDC here. <a href="/trade">Trade on current Tape ↗</a></div>;
  if (!previous || !owner || state?.owner !== owner || (!state.failed && state.balance === 0n && state.queued === 0n && state.positions === 0)) return null;
  return <div className="banner"><b>{state.failed ? "Previous exchange" : `${usdExact(state.balance)} in the previous exchange.`}</b> {state.failed ? "Open it to check your remaining balance." : state.queued > 0n ? `${usdExact(state.queued)} is also queued there.` : "Your funds remain available there."} <a href={previous.siteUrl}>Open previous exchange ↗</a></div>;
}
