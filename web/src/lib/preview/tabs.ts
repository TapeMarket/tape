// One preview exchange per browser, however many tabs are open.
//
// The preview's whole world lives in this browser's storage. If every tab ran its own copy, two
// tabs would drift apart and then overwrite each other's trades. So exactly one tab runs the
// engine (whichever holds a browser lock); the others send it their requests and hear its events
// over a BroadcastChannel. When that tab closes, the next one takes the lock, starts the engine
// from what was saved, and carries on.
//
// Tabs only ever share an engine with tabs of the same kind. A deploy changes what the engine
// sends; a tab of the new build listening to an engine of the old one reads figures that are not
// there and dies with a blank page. So the lock and the channel carry a protocol number, tabs
// tell each other when their build was made and the older ones reload, and tabs left over from
// before any of this existed are made to reload the one way they understand.

import { ApiError, type Backend, type StreamHandler } from "../api";
import type { Address } from "../types";
import { reloadToRecover } from "../store";
import { createEngine } from "./engine";

/** Goes up whenever the engine's answers or its saved world change shape. */
const PROTOCOL = 4;
const LOCK = `tape:preview:engine:v${PROTOCOL}`;
const CHANNEL = `tape:preview:v${PROTOCOL}`;
/** What tabs used before the names carried a number. */
const LEGACY = { lock: "tape:preview:engine", channel: "tape:preview" };
const BUILD = typeof __BUILD__ === "number" ? __BUILD__ : 0;
const TIMEOUT_MS = 5_000;

type Ask = { kind: "get" | "post"; id: string; path: string; body?: unknown };
type Reply = { kind: "reply"; id: string; ok: boolean; data?: unknown; error?: { message: string; status: number } };
type Told = { kind: "event"; type: string; data: unknown; owner: string | null };
/** "My build was made at this time." A tab that hears of a newer one than its own reloads. */
type Build = { kind: "build"; build: number; leader: boolean };
type Message = Ask | Reply | Told | Build | { kind: "leader" };

/** A newer build than this tab's is running elsewhere: fetch it. */
function outdated(message: Message | undefined): boolean {
  return message?.kind === "build" && message.build > BUILD && reloadToRecover();
}

/**
 * Tabs from before the lock had a number hold the old lock and know nothing of builds. The one
 * request every one of them answers is "start over": it drops its (older, unreadable) world and
 * tells every tab on its channel to reload, which brings them all onto this build.
 */
async function evictLegacyTabs(): Promise<void> {
  try {
    const { held = [] } = await navigator.locks.query();
    if (!held.some((lock) => lock.name === LEGACY.lock)) return;
    const old = new BroadcastChannel(LEGACY.channel);
    old.postMessage({ kind: "post", id: `evict:${Date.now()}`, path: "/reset", body: {} });
    setTimeout(() => old.close(), 3_000);
  } catch {
    // Nothing to evict, or no way to ask. Either way this tab runs on its own channel.
  }
}

interface Listener {
  owner: string | null;
  on: StreamHandler;
  online: (up: boolean) => void;
  close?: () => void;
}

/** Runs the engine here and answers the other tabs. */
function lead(channel: BroadcastChannel): Promise<Backend> {
  const engine = createEngine((type, data, owner) => channel.postMessage({ kind: "event", type, data, owner } satisfies Told));
  // Requests that arrive while the engine is still starting wait for it rather than get lost.
  channel.onmessage = async (event: MessageEvent<Message>) => {
    const ask = event.data;
    if (ask?.kind === "build") {
      // A newer tab has opened: let it run the engine. An older one: tell it so.
      if (!outdated(ask) && ask.build < BUILD) channel.postMessage({ kind: "build", build: BUILD, leader: true } satisfies Build);
      return;
    }
    if (ask?.kind !== "get" && ask?.kind !== "post") return;
    try {
      const backend = await engine;
      const data = ask.kind === "get" ? await backend.get(ask.path) : await backend.post(ask.path, ask.body);
      channel.postMessage({ kind: "reply", id: ask.id, ok: true, data } satisfies Reply);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      const message = error instanceof Error ? error.message : "The request failed.";
      channel.postMessage({ kind: "reply", id: ask.id, ok: false, error: { message, status } } satisfies Reply);
    }
  };
  engine
    .then(() => {
      channel.postMessage({ kind: "leader" } satisfies Message);
      channel.postMessage({ kind: "build", build: BUILD, leader: true } satisfies Build);
    })
    .catch(() => {});
  return engine;
}

/** Talks to the tab that runs the engine, until this tab has to run it itself. */
function follow(channel: BroadcastChannel) {
  const waiting = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<Listener>();
  let own: Backend | null = null;
  let next = 0;

  channel.onmessage = (event: MessageEvent<Message>) => {
    const message = event.data;
    if (outdated(message)) return;
    if (message?.kind === "reply") {
      const call = waiting.get(message.id);
      if (!call) return;
      waiting.delete(message.id);
      clearTimeout(call.timer);
      if (message.ok) call.resolve(message.data);
      else call.reject(new ApiError(message.error?.message ?? "The request failed.", message.error?.status ?? 500));
    } else if (message?.kind === "event") {
      for (const listener of listeners) if (!message.owner || listener.owner === message.owner) listener.on(message.type, message.data);
    } else if (message?.kind === "leader") {
      // Another tab has taken over. Whatever this one shows may be a moment old: refresh it.
      for (const listener of listeners) {
        listener.online(true);
        listener.on("balance", { reason: "resync" });
      }
    }
  };

  function ask(kind: "get" | "post", path: string, body?: unknown): Promise<unknown> {
    if (own) return kind === "get" ? own.get(path) : own.post(path, body);
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}:${next++}`;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new ApiError("The preview is restarting in another tab. Try again in a moment.", 503));
      }, TIMEOUT_MS);
      waiting.set(id, { resolve, reject, timer });
      channel.postMessage({ kind, id, path, body } satisfies Ask);
    });
  }

  const backend: Backend = {
    get: (path) => ask("get", path),
    post: (path, body) => ask("post", path, body),
    stream(owner, on, online) {
      const listener: Listener = { owner: owner ? owner.toLowerCase() : null, on, online };
      listeners.add(listener);
      if (own) listener.close = own.stream(owner, on, online);
      else {
        online(true);
        on("hello", { time: Date.now() });
      }
      return () => {
        listeners.delete(listener);
        listener.close?.();
      };
    },
  };

  /** The tab that ran the engine is gone and this one holds the lock: run it here from now on. */
  async function promote(): Promise<void> {
    // Anything still waiting on the old tab will never be answered.
    for (const [id, call] of waiting) {
      clearTimeout(call.timer);
      call.reject(new ApiError("The preview moved to this tab. Try again.", 503));
      waiting.delete(id);
    }
    const engine = await lead(channel);
    own = engine;
    for (const listener of listeners) {
      listener.close = engine.stream(listener.owner as Address | null, listener.on, listener.online);
      listener.on("balance", { reason: "resync" });
    }
  }

  return { backend, promote };
}

export function createPreview(): Promise<Backend> {
  const supported = typeof navigator !== "undefined" && "locks" in navigator && typeof BroadcastChannel !== "undefined";
  if (!supported) return createEngine();

  evictLegacyTabs();
  const channel = new BroadcastChannel(CHANNEL);
  const forever = () => new Promise<never>(() => {});
  return new Promise<Backend>((resolve, reject) => {
    navigator.locks
      .request(LOCK, { ifAvailable: true }, (lock) => {
        if (lock) {
          // Nobody else is running it. Hold the lock for as long as this tab lives.
          lead(channel).then(resolve, reject);
          return forever();
        }
        const follower = follow(channel);
        // Say which build this is. The tab running the engine reloads if it is older, and says
        // so if it is newer.
        channel.postMessage({ kind: "build", build: BUILD, leader: false } satisfies Build);
        resolve(follower.backend);
        // Wait in line. The lock arrives when the tab that holds it closes.
        navigator.locks.request(LOCK, () => {
          follower.promote().catch(() => {});
          return forever();
        });
        return undefined;
      })
      .catch(() => createEngine().then(resolve, reject));
  });
}
