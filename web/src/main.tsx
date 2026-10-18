import { tx, restoreLocale, useLocale } from "./lib/i18n";
import { Component, lazy, StrictMode, Suspense, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { loadConfig } from "./lib/api";
import { reloadToRecover, setState, useStore } from "./lib/store";
import { Landing } from "./pages/Landing";
import { Support } from "./components/Support";
import { captureReferral } from "./lib/referral-capture";
import { loadExchange, PATHS, preloadRoute } from "./lib/route-preload";

// The link somebody came through, before anything else can change the address.
captureReferral();
restoreLocale();

const ExchangeApp = lazy(loadExchange);
// A direct link loads the shell and its requested screen in parallel, as hovering a link does.
preloadRoute(location.pathname);

function App() {
  useLocale();
  const path = useStore((s) => s.path);
  // Public setup is small. Wallets, trading charts and price subscriptions load with the exchange.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const boot = async () => {
      try {
        await loadConfig();
      } catch {
        if (active) timer = setTimeout(boot, 3000);
      }
    };
    boot();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  // One address per page. "/Vault/" is "/vault"; an address that is no page at all is the trade
  // page, and says so, instead of showing it under a made-up address.
  useEffect(() => {
    const tidy = path.toLowerCase().replace(/\/+$/, "") || "/";
    const real = PATHS.has(tidy) ? tidy : "/trade";
    if (real === path) return;
    history.replaceState(null, "", real + (PATHS.has(tidy) ? location.search : ""));
    setState({ path: real, search: location.search });
  }, [path]);

  // The front page is its own screen: none of the exchange's bars around it. It does not wait for
  // the exchange's configuration either, so it is there at once.
  if (path === "/") return <><Landing /><Support /></>;
  return <><Suspense fallback={<div className="empty" role="status">{tx("Opening exchange…")}</div>}><ExchangeApp /></Suspense><Support /></>;
}

/**
 * If the app throws while drawing, React removes all of it: a black, empty page. Nearly every time
 * the cause is this tab running an older build than the rest of the site, which a reload cures, so
 * it reloads by itself. If that did not help, it says so and offers the button.
 */
class Recover extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
    reloadToRecover();
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty" style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
        <span>{tx("The page stopped working in this tab.")}</span>
        <button className="btn primary" onClick={() => location.reload()}>{tx("Reload")}</button>
      </div>
    );
  }
}

// A script or style from a build that has since been replaced: this tab is out of date.
window.addEventListener("vite:preloadError", () => reloadToRecover());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Recover>
      <App />
    </Recover>
  </StrictMode>,
);
