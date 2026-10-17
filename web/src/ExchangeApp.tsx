import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { Banner, Dialogs, Toasts, TopBar } from "./components/Shell";
import { PAGE_LOADERS } from "./lib/route-preload";
import { connectStream, loadAccount, loadHistory } from "./lib/api";
import { restore } from "./lib/wallet";
import { syncSession } from "./lib/actions";
import { getState, setState, useStore } from "./lib/store";
import { loadDayOpen } from "./lib/preview/feed";
import { coinOf } from "./lib/hl";
import { LEGACY, PREVIEW } from "./lib/mode";
import { PreviousExchange } from "./components/PreviousExchange";

const ROUTES: Record<string, ComponentType> = {};
for (const [path, load] of Object.entries(PAGE_LOADERS)) ROUTES[path] = lazy(load);
let walletRestored = false;

export default function ExchangeApp() {
  const path = useStore((s) => s.path);
  const ready = useStore((s) => s.config !== null);
  const owner = useStore((s) => s.owner);
  const offline = useStore((s) => s.offline);

  useEffect(() => {
    if (!ready || PREVIEW) return;
    let active = true;
    const markets = getState().config!.markets;
    const refresh = () => Promise.allSettled(markets.map(async (market) => {
      const value = await loadDayOpen(coinOf(market));
      if (!active || value === null) return;
      setState((s) => {
        if (!s.config || s.config.markets.find(m => m.id === market.id)?.ref24h === value) return {};
        return { config: { ...s.config, markets: s.config.markets.map((m) => m.id === market.id ? { ...m, ref24h: value } : m) } };
      });
    }));
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [ready]);

  useEffect(() => {
    if (!ready || walletRestored) return;
    walletRestored = true;
    void restore().catch(() => { walletRestored = false; });
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    // Quotes start immediately; restoring a slow wallet does not hold the stream up.
    void connectStream();
    if (!LEGACY) syncSession();
    loadAccount().catch(() => {});
    loadHistory().catch(() => {});
  }, [owner, ready]);

  const Page = ROUTES[path] ?? ROUTES["/trade"];
  return <div className="app">
    <TopBar />
    <Banner />
    <PreviousExchange />
    <main className="page"><Suspense fallback={<div className="empty" role="status">Loading page…</div>}>
      {ready ? <Page /> : <div className="empty" role="status" style={{ minHeight: "50vh", display: "grid", placeContent: "center", gap: 16, textAlign: "center" }}>
        <span>{offline ? "The exchange is unreachable. Reconnecting…" : "Connecting to Tape…"}</span>
        {offline && <button className="btn" onClick={() => location.reload()}>Try again</button>}
      </div>}
    </Suspense></main>
    <Dialogs />
    <Toasts />
  </div>;
}
