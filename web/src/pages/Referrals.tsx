import { Hero } from "../components/Hero";
import { useEffect, useRef, useState } from "react";
import { Panel } from "../components/Panels";
import { PageSection } from "../components/PageSection";
import { CustomReferral } from "../components/CustomReferral";
import { Table } from "../components/Tables";
import { get } from "../lib/api";
import { big, shortAddress, usd, usdCompact } from "../lib/format";
import { PREVIEW } from "../lib/mode";
import { getState, setState, useStore } from "../lib/store";
import type { ReferralPage } from "../lib/types";

/** Your link, who came through it, and what that has earned. */
export function Referrals() {
  const owner = useStore((s) => s.owner);
  const name = useStore((s) => s.account?.name);
  const [page, setPage] = useState<ReferralPage | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [retry, setRetry] = useState(0);
  const justCreated = useRef<{ owner: string; code: string } | null>(null);

  useEffect(() => {
    setPage(null);
    setError(false);
    justCreated.current = null;
    if (!owner || PREVIEW) return;
    let live = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const found = await get<ReferralPage>(`/referrals/${owner}`);
        if (live) {
          const saved = justCreated.current;
          setPage(saved?.owner === owner ? { ...found, code: saved.code, customCode: saved.code } : found);
          setError(false);
        }
      } catch { if (live) setError(true); }
      finally { busy = false; }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [owner, retry]);

  useEffect(() => {
    setCopied(false);
    setCopyError(false);
  }, [owner, name, page?.code]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  // A quarter of every fee unless the relayer says otherwise.
  const share = (page?.shareOfFeeBps ?? 2500) / 100;
  const code = page?.code ?? name ?? owner;
  const link = code ? `${location.origin}/?ref=${encodeURIComponent(code)}` : null;
  const nameOf = (address: string) => page?.names[address.toLowerCase()] ?? shortAddress(address);
  const referred = page?.referred ?? [];
  const volume = referred.reduce((sum, r) => sum + big(r.volume), 0n);
  const figures: [string, string][] = [
    ["Traders referred", page ? String(referred.length) : "–"],
    ["Their volume", page ? usdCompact(volume) : "–"],
    ["Earned", page ? usd(page.earned) : "–"],
    ["Paid", page ? usd(page.paid) : "–"],
  ];

  return (
    <div className="sheet work-page refs referrals-page">
      <Hero
        title="Referrals"
        lede={
          <>
            Send traders your link. You earn <b>{share}% of every fee</b> the exchange takes on their trades, in USDC, for as long as they trade.
          </>
        }
        figures={figures.map(([label, value]) => ({ label, value }))}
      />

      <section className="referral-share" aria-labelledby="referral-link-title">
        <div className="referral-share-main">
          <h2 id="referral-link-title">Your next trader starts here.</h2>
          <p>One link. Every referred trade, tracked in one place.</p>
          {PREVIEW ? (
            <p className="referral-preview">You’re in practice mode. Referral tracking is available on the live exchange.</p>
          ) : link ? (
            <div className="refs-link">
              <input className="referral-url" aria-label="Your referral link" value={link} readOnly onFocus={(e) => e.target.select()} />
              <button
                className="btn primary"
                onClick={async () => {
                  try { await navigator.clipboard.writeText(link); setCopied(true); setCopyError(false); }
                  catch { setCopyError(true); }
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          ) : (
            <div className="refs-link">
              <span className="soft">Connect your wallet to create your personal referral link.</span>
              <button className="btn primary" onClick={() => setState({ dialog: "connect" })}>
                Connect wallet
              </button>
            </div>
          )}
          {copyError && <p className="note" role="status">Couldn’t copy automatically. Select the link above and copy it.</p>}
          {owner && !PREVIEW && (page ? <CustomReferral key={owner} saved={page.customCode ?? null} onCreated={code => {
            if (getState().owner !== owner) return;
            justCreated.current = { owner, code };
            setPage(last => last ? { ...last, code, customCode: code } : last);
          }} /> : <p className="note">{error ? "Custom link settings are unavailable. Retry below." : "Loading custom link settings…"}</p>)}
          {page?.referrer && <p className="note">You were referred by {nameOf(page.referrer)}.</p>}
        </div>
        <dl className="referral-terms">
          <div><dt>Your share of their fees</dt><dd>{share}%</dd></div>
          <div><dt>Paid to your wallet in</dt><dd>USDC</dd></div>
          <div><dt>Extra fees for your traders</dt><dd>$0</dd></div>
        </dl>
      </section>

      <PageSection title="Your referral network" detail="Volume, fees and earnings from traders who joined through your link.">
      {error && <div className="page-feedback" role="alert"><span>Couldn’t refresh referrals.{page ? " Showing the last available totals." : " Your totals are unavailable."}</span><button className="btn small" onClick={() => setRetry((n) => n + 1)}>Retry</button></div>}
      <Panel title="Traders you referred" tools={<span className="soft">{page ? `${referred.length} trader${referred.length === 1 ? "" : "s"}` : owner && !PREVIEW && !error ? "Loading…" : "USDC rewards"}</span>}>
        <Table
          head={["Trader", ["Trades", "r"], ["Volume", "r"], ["Fees paid", "r"], ["You earned", "r"]]}
          empty={error && !page ? "Referral data is unavailable. Retry above." : PREVIEW ? "Referrals are tracked on the live exchange, outside practice mode." : !owner ? "Connect a wallet to see who came through your link." : !page ? "Loading your referral network…" : "Nobody yet. Share your link to bring your first trader to Tape."}
        >
          {referred.map((r) => (
            <tr key={r.address}>
              <td>{nameOf(r.address)}</td>
              <td className="r">{r.trades}</td>
              <td className="r">{usdCompact(r.volume)}</td>
              <td className="r soft">{usd(r.fees)}</td>
              <td className="r">
                <b>{usd(r.reward)}</b>
              </td>
            </tr>
          ))}
        </Table>
      </Panel>
      </PageSection>

      <PageSection title="How referrals work">
      <dl className="referral-rules">
        <div><dt>Who counts</dt><dd>Somebody who opens the site through your link and then turns on one-click trading with a wallet that has not traded here
          before. A wallet has one referrer, for good, and cannot refer itself.
        </dd></div>
        <div><dt>What you earn</dt><dd>{share}% of each fee on their trades: half of the team's share of it. The stakers' half is not touched, and the trader
          pays nothing extra.
        </dd></div>
        <div><dt>How it is paid</dt><dd>What you earn adds up here as their trades close. The team sends it in USDC to this wallet, and what has been sent shows
          as Paid.
        </dd></div>
      </dl>
      </PageSection>
    </div>
  );
}
