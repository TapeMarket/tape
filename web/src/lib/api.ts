// The backend: JSON requests plus one event stream for everything live. In live mode that is the
// relayer; in preview mode it is an exchange running in this tab (see ./preview/engine.ts), which
// answers the same paths with the same shapes.

import { API_URL, PREVIEW } from "./mode";
import { EMPTY_HISTORY, getState, setState, toast, type Tick } from "./store";
import type { Account, Address, CoinPayload, Config, History, HousePayload, Intent, Leaderboard, Position, SeriesPoint, Status, TapeChip, Trade, Season, JackpotPayload } from "./types";
import { usd } from "./format";
import { recordIntent, recordIntents, withoutSubmissions } from "./open-orders";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export type StreamHandler = (type: string, data: unknown) => void;

export interface Backend {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  /** Opens the live stream. Returns a function that closes it. */
  stream(owner: Address | null, on: StreamHandler, online: (up: boolean) => void): () => void;
}

const encode = (body: unknown) => JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v));

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status}).`, res.status);
  return json;
}

const STREAM_EVENTS = ["hello", "tick", "reference", "intent", "position", "position-removed", "trigger", "jackpot", "closed", "balance", "trade", "tape", "house", "distribution", "recovery"];

const live: Backend = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: encode(body) }),
  stream(owner, on, online) {
    const url = `${API_URL}/stream${owner ? `?owner=${owner}` : ""}`;
    let source: EventSource | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let wait = 1000;
    const open = () => {
      if (stopped) return;
      source?.close();
      const s = (source = new EventSource(url));
      for (const type of STREAM_EVENTS) s.addEventListener(type, (e) => {
        if (stopped || source !== s) return;
        try {
          on(type, JSON.parse((e as MessageEvent).data));
        } catch {
          // A malformed event must not crash the account screen. Refresh its authoritative state.
          online(false);
          refreshAccountSoon();
        }
      });
      s.onopen = () => {
        wait = 1000;
        online(true);
      };
      s.onerror = () => {
        online(false);
        again();
      };
    };
    // A browser reconnects a dropped stream by itself, but not one that was ANSWERED with an error,
    // which is what a relayer that is restarting gives: then it stops for good, and the page would
    // say "retrying" until it was reloaded. So a stream that has stopped is opened again from here.
    const again = () => {
      if (stopped || retry || source?.readyState !== EventSource.CLOSED) return;
      retry = setTimeout(() => {
        retry = null;
        open();
      }, wait);
      wait = Math.min(wait * 2, 8000);
    };
    open();
    // And in case the stream stopped without saying so.
    const watch = setInterval(again, 5000);
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      clearInterval(watch);
      source?.close();
    };
  },
};

let loading: Promise<Backend> | null = null;
const backend = (): Promise<Backend> => (PREVIEW ? (loading ??= import("./preview/tabs").then((m) => m.createPreview())) : Promise.resolve(live));

// Share simultaneous public reads, never retained snapshots of balances, orders or sessions.
// The entry disappears on success and failure, so the next refresh always reaches the server.
const publicReads = new Map<string, Promise<unknown>>();
const shareable = new Set(["/config", "/house", "/coin", "/series", "/prices", "/leaderboard", "/status", "/season", "/jackpot"]);
export async function get<T>(path: string): Promise<T> {
  if (!shareable.has(path.split("?")[0])) return (await (await backend()).get(path)) as T;
  let pending = publicReads.get(path);
  if (!pending) {
    pending = backend().then(client => client.get(path)).finally(() => publicReads.delete(path));
    publicReads.set(path, pending);
  }
  return (await pending) as T;
}
export const post = async <T>(path: string, body: unknown): Promise<T> => (await (await backend()).post(path, body)) as T;

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

export async function loadConfig(): Promise<void> {
  try {
    const sent = Date.now();
    const received = await get<Config>("/config");
    // A new relayer's oldest sample is not a 24-hour reference. Live pages load the venue's
    // actual daily baseline independently, just as the practice feed does.
    const previous = getState().config;
    const config = PREVIEW ? received : { ...received, markets: received.markets.map((market) => {
      const known = previous?.markets.find(old => old.id === market.id && old.symbol === market.symbol && old.feedId === market.feedId);
      return { ...market, ref24h: known?.ref24h ?? null };
    }) };
    // Halve the round trip to estimate when the relayer read its clock.
    const clockOffset = config.time + (Date.now() - sent) / 2 - Date.now();
    const ticks: Record<number, Tick> = { ...getState().ticks };
    for (const m of config.markets) if (m.price && !ticks[m.id]) ticks[m.id] = { p: BigInt(m.price), t: Math.floor(config.time / 1000) };
    setState({ config, clockOffset, ticks, offline: null, tape: config.tape ?? [] });
  } catch (error) {
    setState({ offline: error instanceof Error ? error.message : "The relayer is unreachable." });
    throw error;
  }
}

let accountTimer: ReturnType<typeof setTimeout> | null = null;
let accountRead = 0;
let appliedAccountRead = 0;
let accountBalanceVersion = 0;

export async function loadAccount(): Promise<void> {
  const owner = getState().owner;
  if (!owner) return;
  const sequence = ++accountRead;
  const balanceVersion = accountBalanceVersion;
  const account = await get<Account>(`/account/${owner}`);
  if (getState().owner !== owner || sequence < appliedAccountRead) return;
  const current = getState().account;
  if (current?.blockNumber && (!account.blockNumber || BigInt(account.blockNumber) < BigInt(current.blockNumber))) return;
  if (current?.blockNumber && account.blockNumber === current.blockNumber && balanceVersion !== accountBalanceVersion) return;
  appliedAccountRead = sequence;
  // This snapshot may be older than what the stream has already said: an order only moves forward.
  const next = recordIntents(getState(), account.intents);
  const intents = next.intents;
  let openSubmissions = next.openSubmissions;
  // An HTTP snapshot can reach us before the indexer catches up, then arrive after its close event.
  const closed = new Set(getState().history.trades.map(trade => trade.id));
  openSubmissions = withoutSubmissions(openSubmissions, new Set([...closed, ...account.positions.map(p => p.id)]));
  setState({ account: { ...account, positions: account.positions.filter(position => !closed.has(position.id)) }, intents, openSubmissions });
}

/** Refetches the account shortly, coalescing bursts of events into one request. */
export function refreshAccountSoon(ms = 120): void {
  if (accountTimer) clearTimeout(accountTimer);
  accountTimer = setTimeout(() => {
    accountTimer = null;
    loadAccount().catch(() => {});
  }, ms);
}

export async function loadHistory(): Promise<void> {
  const owner = getState().owner;
  if (!owner) return setState({ history: EMPTY_HISTORY });
  const history = await get<History>(`/history/${owner}?limit=200`);
  if (getState().owner === owner) setState({ history });
}

export async function loadHouse(): Promise<void> {
  const house = await get<HousePayload>("/house");
  setState({ house, feed: house.feed });
}

export async function loadCoin(): Promise<void> {
  setState({ coin: await get<CoinPayload>("/coin") });
}

export async function loadSeries(): Promise<void> {
  const { points } = await get<{ points: SeriesPoint[] }>("/series?seconds=86400");
  setState({ series: points });
}

export const loadLeaderboard = (window: string) => get<Leaderboard>(`/leaderboard?window=${window}`);
export const loadSeason = (n?: number) => get<Season>(n ? `/season?n=${n}` : "/season");
export const loadJackpot = (owner?: string | null) => get<JackpotPayload>(owner ? `/jackpot?owner=${owner}` : "/jackpot");
export const loadStatus = () => get<Status>("/status");
export const loadPrices = (market: number, seconds: number) => get<{ market: number; points: { t: number; p: string }[] }>(`/prices?market=${market}&seconds=${seconds}`);

// ---------------------------------------------------------------------------------------------
// The live stream
// ---------------------------------------------------------------------------------------------

type TickListener = (market: number, tick: Tick) => void;
const tickListeners = new Set<TickListener>();

/** Raw ticks, for the chart. Everything else reads the latest tick from the store. */
export function onTick(listener: TickListener): () => void {
  tickListeners.add(listener);
  return () => tickListeners.delete(listener);
}

function upsertPosition(position: Position): void {
  setState((s) => {
    if (!s.account || s.account.address.toLowerCase() !== position.owner.toLowerCase()) return {};
    const prev = s.account.positions.find((p) => p.id === position.id);
    const rest = s.account.positions.filter((p) => p.id !== position.id);
    // The relayer's position events do not carry the take-profit and stop-loss: keep what is known.
    const kept = {
      takeProfit: "takeProfit" in position ? position.takeProfit : prev?.takeProfit,
      stopLoss: "stopLoss" in position ? position.stopLoss : prev?.stopLoss,
    };
    return { account: { ...s.account, positions: [...rest, { ...position, ...kept }] }, openSubmissions: withoutSubmissions(s.openSubmissions, new Set([position.id])) };
  });
}

function removePosition(id: string): void {
  setState((s) => (s.account ? { account: { ...s.account, positions: s.account.positions.filter((p) => p.id !== id) } } : {}));
}

function onClosed(trade: Trade): void {
  if (getState().owner?.toLowerCase() !== trade.owner.toLowerCase()) return;
  const duplicate = getState().history.trades.some(t => t.id === trade.id && t.tx === trade.tx);
  setState(s => {
    let account = s.account;
    if (account) {
      const snapshot = trade.accountBalance;
      const fresh = snapshot && snapshot.address.toLowerCase() === account.address.toLowerCase()
        && (!account.blockNumber || BigInt(snapshot.blockNumber) >= BigInt(account.blockNumber));
      if (fresh) accountBalanceVersion++;
      account = { ...account, ...(fresh ? { balance: snapshot.balance, queued: snapshot.queued, marginInUse: snapshot.marginInUse, blockNumber: snapshot.blockNumber, reserved: snapshot.reserved ?? account.reserved } : {}), positions: account.positions.filter(p => p.id !== trade.id) };
    }
    return { account, history: { ...s.history, trades: [trade, ...s.history.trades.filter(t => t.id !== trade.id)] }, openSubmissions: withoutSubmissions(s.openSubmissions, new Set([trade.id])) };
  });
  if (duplicate) return;
  const symbol = getState().config?.markets[trade.market]?.symbol ?? "";
  const coinSymbol = getState().config?.coin?.symbol;
  const pnl = BigInt(trade.pnl);
  if (trade.busted) toast("bust", "Liquidated", `${symbol} ${trade.leverage ?? ""}x. ${usd(-pnl)} margin gone.${coinSymbol ? ` ${coinSymbol} loss rewards are in your wallet.` : ""}${PREVIEW || getState().config?.addresses.jackpot ? ` ${usd(-pnl)} of tickets in this hour's jackpot.` : ""}`);
  else if (pnl > 0n) {
    const queued = BigInt(trade.queued);
    toast("good", `${symbol} closed ${usd(pnl, { sign: true })}`, queued > 0n ? `${usd(queued)} is queued: the vault pays it as losses come in.` : undefined);
  } else toast("info", `${symbol} closed ${usd(pnl, { sign: true })}`);
  refreshAccountSoon(0);
}

function handle(type: string, data: unknown): void {
  switch (type) {
    case "hello":
      // The first thing a stream says, each time it is opened. After a break, what happened in
      // between includes configuration changes (coin attachment, new pairs and pauses). EventSource
      // onopen already clears offline, so it cannot be used to decide whether to refresh.
      setState({ clockOffset: (data as { time: number }).time - Date.now(), offline: null });
      void loadConfig().then(() => {
        refreshAccountSoon(0);
        return loadCoin();
      }).catch(() => { /* Keep the visible connection error and retry on the next connection. */ });
      break;
    case "tick": {
      const { m, t, p } = data as { m: number; t: number; p: string };
      const tick = { p: BigInt(p), t: Number(t) };
      setState((s) => ({ ticks: { ...s.ticks, [m]: tick } }));
      for (const listener of tickListeners) listener(m, tick);
      break;
    }
    case "reference": {
      const { m, p } = data as { m: number; p: number };
      if (!Number.isInteger(m) || !Number.isFinite(p) || p <= 0) break;
      setState((s) => s.config && s.config.markets.find(market => market.id === m)?.ref24h !== p ? { config: { ...s.config, markets: s.config.markets.map((market) => market.id === m ? { ...market, ref24h: p } : market) } } : {});
      break;
    }
    case "intent": {
      const intent = data as Intent;
      if (getState().owner?.toLowerCase() !== intent.owner.toLowerCase()) break;
      setState(s => recordIntent(s, intent));
      if (intent.status === "failed") toast("bad", intent.kind === "open" ? "Order not filled" : "Close failed", intent.error ?? undefined);
      if (intent.status === "confirmed" || intent.status === "failed") refreshAccountSoon();
      break;
    }
    case "position":
      upsertPosition(data as Position);
      break;
    case "position-removed":
      removePosition((data as { id: string }).id);
      break;
    case "jackpot": {
      const draw = data as { winner: string; prize: string };
      const me = getState().owner;
      if (me && draw.winner.toLowerCase() === me.toLowerCase()) toast("good", "You won the Rekt Jackpot", `${usd(draw.prize)} is in your wallet.`);
      break;
    }
    case "trigger": {
      const { positionId, takeProfit, stopLoss } = data as { positionId: string; takeProfit: string | null; stopLoss: string | null };
      setState((s) =>
        s.account ? { account: { ...s.account, positions: s.account.positions.map((p) => (p.id === positionId ? { ...p, takeProfit, stopLoss } : p)) } } : {},
      );
      break;
    }
    case "closed":
      onClosed(data as Trade);
      break;
    case "balance":
      refreshAccountSoon();
      break;
    case "trade": {
      const trade = data as Trade;
      setState((s) => ({ feed: [trade, ...s.feed.filter((t) => t.id !== trade.id)].slice(0, 40) }));
      break;
    }
    case "tape": {
      const chip = data as TapeChip;
      setState((s) => ({ tape: [chip, ...s.tape].slice(0, 40) }));
      break;
    }
    case "recovery":
      setState(s => s.config ? { config: { ...s.config, recovery: data as Config["recovery"], opensPaused: true } } : {});
      void loadConfig();
      refreshAccountSoon(0);
      break;
    case "reload":
      // The preview was started over (possibly from another tab): begin again from nothing.
      location.reload();
      break;
    case "distribution":
      // Stakers were just paid: what this account can claim has changed.
      refreshAccountSoon();
      loadCoin().catch(() => {});
      break;
    case "house": {
      const house = data as HousePayload["house"];
      setState((s) => {
        const paused = s.config?.recovery && (!s.config.recovery.available || s.config.recovery.paused) ? true : house.opensPaused;
        return {
          ...(s.house ? { house: { ...s.house, house } } : {}),
          ...(s.config && s.config.opensPaused !== paused ? { config: { ...s.config, opensPaused: paused } } : {}),
        };
      });
      break;
    }
    default:
      break;
  }
}

let closeStream: (() => void) | null = null;
let streamOwner: Address | null | undefined;

export async function connectStream(): Promise<void> {
  const owner = getState().owner;
  if (closeStream && streamOwner === owner) return;
  closeStream?.();
  closeStream = null;
  streamOwner = owner;
  const b = await backend();
  // The wallet may have changed while the backend was loading.
  if (streamOwner !== owner || closeStream) return;
  closeStream = b.stream(owner, handle, (up) => setState({ offline: up ? null : "Connection to the relayer dropped. Retrying." }));
}
