// One small global store. Components subscribe with a selector and re-render only when the slice
// they selected changes. Selectors must return a primitive or an existing reference.

import { useSyncExternalStore } from "react";
import type { Account, Address, CoinPayload, Config, History, HousePayload, Intent, SeriesPoint, TapeChip, Trade } from "./types";

export interface Tick {
  /** Price, 8 decimals. */
  p: bigint;
  /** Publish time, unix seconds. */
  t: number;
}

export interface Toast {
  id: number;
  kind: "good" | "bad" | "bust" | "info";
  title: string;
  body?: string;
}

export const EMPTY_HISTORY: History = { trades: [], transfers: [], staking: [], queue: [], emissions: [] };

export interface State {
  /** In-flight funding survives closing the dialog; each connected wallet has its own result. */
  depositFlows: Record<string, import("./deposit-flow").DepositFlow | undefined>;
  config: Config | null;
  /** Why the relayer could not be reached, if it could not. */
  offline: string | null;
  /** Relayer clock minus local clock, in ms. Intents are stamped with the relayer's time. */
  clockOffset: number;
  marketId: number;
  ticks: Record<number, Tick>;
  owner: Address | null;
  walletName: string | null;
  account: Account | null;
  intents: Record<string, Intent>;
  history: History;
  feed: Trade[];
  tape: TapeChip[];
  house: HousePayload | null;
  coin: CoinPayload | null;
  /** A day of minute samples, for the charts. */
  series: SeriesPoint[];
  toasts: Toast[];
  dialog: null | "connect" | "deposit" | "withdraw" | "username" | "share";
  /** The trade the share dialog draws. */
  share: import("../components/Share").ShareData | null;
  path: string;
  /** The address's query string ("?tab=history"), which a page may read. */
  search: string;
  /** This browser's trading key for the connected wallet: when it starts and stops signing. */
  session: { validFrom: number; validUntil: number } | null;
  /** What the order ticket is set to, so the chart can preview where that position would bust. */
  ticket: { isLong: boolean; leverage: number };
}

let state: State = {
  depositFlows: {},
  config: null,
  offline: null,
  clockOffset: 0,
  marketId: 0,
  ticks: {},
  owner: null,
  walletName: null,
  account: null,
  intents: {},
  history: EMPTY_HISTORY,
  feed: [],
  tape: [],
  house: null,
  coin: null,
  series: [],
  toasts: [],
  dialog: null,
  share: null,
  path: typeof location === "undefined" ? "/" : location.pathname,
  search: typeof location === "undefined" ? "" : location.search,
  session: null,
  ticket: { isLong: true, leverage: 1000 },
};

const listeners = new Set<() => void>();

export const getState = (): State => state;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  if (!(Object.keys(next) as (keyof State)[]).some((key) => !Object.is(state[key], next[key]))) return;
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** Calls `listener` after every change to the state. Returns a function that stops it. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/** The relayer's idea of the current second. */
export const serverNow = (): number => Math.floor((Date.now() + state.clockOffset) / 1000);

let toastId = 0;
export function toast(kind: Toast["kind"], title: string, body?: string): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, title, body }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "bust" ? 7000 : 4500);
}

/** Moves to `to`, which may carry a query string. Routing only looks at the path. */
export function navigate(to: string): void {
  const [path] = to.split("?");
  if (to === location.pathname + location.search) return;
  const changedPage = path !== state.path;
  history.pushState(null, "", to);
  setState({ path, search: location.search });
  if (changedPage) document.querySelector(".page")?.scrollTo(0, 0);
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => setState({ path: location.pathname, search: location.search }));
}

/**
 * Reloads the page to recover from something a reload fixes (an older build still open in this
 * tab, a file from a build that is gone). At most twice a minute, so a fault a reload does not fix
 * cannot turn into a loop. Returns whether it reloaded.
 */
export function reloadToRecover(): boolean {
  try {
    const now = Date.now();
    const recent = (JSON.parse(sessionStorage.getItem("tape:reloads") ?? "[]") as number[]).filter((t) => now - t < 60_000);
    if (recent.length >= 2) return false;
    sessionStorage.setItem("tape:reloads", JSON.stringify([...recent, now]));
  } catch {
    // No session storage: reload anyway, once is better than a dead page.
  }
  location.reload();
  return true;
}
