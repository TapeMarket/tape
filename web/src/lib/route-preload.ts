// Only import a screen when it is opened or its link is hovered/focused. Import promises are
// shared with React.lazy so preloading and navigation cannot fetch a screen twice.
import type { ComponentType } from "react";

type PageModule = { default: ComponentType };
const held = new Map<string, Promise<PageModule>>();
const once = (path: string, load: () => Promise<PageModule>) => () => {
  let pending = held.get(path);
  if (!pending) {
    pending = load().catch((error) => { held.delete(path); throw error; });
    held.set(path, pending);
  }
  return pending;
};

export const PAGE_LOADERS = {
  "/support": once("/support", () => import("../pages/SupportInbox").then(m => ({ default: m.SupportInbox }))),
  "/trade": once("/trade", () => import("../pages/Trade").then(m => ({ default: m.Trade }))),
  "/portfolio": once("/portfolio", () => import("../pages/Portfolio").then(m => ({ default: m.Portfolio }))),
  "/vault": once("/vault", () => import("../pages/Vault").then(m => ({ default: m.Vault }))),
  "/jackpot": once("/jackpot", () => import("../pages/Jackpot").then(m => ({ default: m.Jackpot }))),
  "/staking": once("/staking", () => import("../pages/Staking").then(m => ({ default: m.Staking }))),
  "/leaderboard": once("/leaderboard", () => import("../pages/Leaderboard").then(m => ({ default: m.Leaderboard }))),
  "/dashboard": once("/dashboard", () => import("../pages/Dashboard").then(m => ({ default: m.Dashboard }))),
  "/stats": once("/stats", () => import("../pages/Stats").then(m => ({ default: m.Stats }))),
  "/status": once("/status", () => import("../pages/Status").then(m => ({ default: m.StatusPage }))),
  "/docs": once("/docs", () => import("../pages/Docs").then(m => ({ default: m.Docs }))),
  "/referrals": once("/referrals", () => import("../pages/Referrals").then(m => ({ default: m.Referrals }))),
};
export const PATHS = new Set(["/", ...Object.keys(PAGE_LOADERS)]);

let exchange: Promise<typeof import("../ExchangeApp")> | null = null;
export function loadExchange() {
  return exchange ??= import("../ExchangeApp").catch(error => { exchange = null; throw error; });
}

export function preloadRoute(to: string): void {
  const path = to.split(/[?#]/)[0].toLowerCase().replace(/\/+$/, "") || "/";
  if (path === "/" || !PATHS.has(path)) return;
  void loadExchange().catch(() => {});
  const load = PAGE_LOADERS[path as keyof typeof PAGE_LOADERS];
  if (load) void load().catch(() => {});
}
