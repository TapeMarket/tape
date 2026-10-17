import type { State } from "./store";
import type { Address, Hex, Intent } from "./types";

export const INTENT_STALE_AFTER = 75;
export interface OpenDetails {
  market: number;
  isLong: boolean;
  leverage: number;
  margin: string;
  useQueued: boolean;
}
export interface OpenSubmission {
  id: string;
  owner: Address;
  order: OpenDetails;
  stage: "sending" | "checking";
  intentId?: Hex;
}
export interface PendingOpen {
  id: string;
  submissionId?: string;
  order?: OpenDetails;
  stage: "sending" | "pricing" | "confirming" | "checking";
  pinTime?: number;
}

const RANK = { accepted: 0, filled: 1, confirmed: 2, failed: 2 };
/** The POST response can arrive after a newer stream event. Never move an order backwards. */
export function mergeIntent(previous: Intent | undefined, incoming: Intent): Intent {
  const newer = previous && RANK[previous.status] > RANK[incoming.status] ? previous : incoming;
  return { ...previous, ...incoming, ...newer, order: incoming.order ?? previous?.order };
}

/** Merge a full account response in one pass; do not copy its entire history per order. */
export function recordIntents(state: Pick<State, "intents" | "openSubmissions">, incoming: Intent[], submissionId?: string) {
  const intents = { ...state.intents };
  const submissions = { ...state.openSubmissions };
  for (const intent of incoming) {
    let order = intent.order;
    for (const [id, submission] of Object.entries(submissions)) {
      if (id !== submissionId && submission.intentId !== intent.id) continue;
      if (submission.owner.toLowerCase() !== intent.owner.toLowerCase()) continue;
      order ??= submission.order;
      delete submissions[id];
    }
    intents[intent.id] = mergeIntent(intents[intent.id], { ...intent, order });
  }
  return { intents, openSubmissions: submissions };
}

export function recordIntent(state: Pick<State, "intents" | "openSubmissions">, incoming: Intent, submissionId?: string) {
  return recordIntents(state, [incoming], submissionId);
}

export function withoutSubmissions(submissions: State["openSubmissions"], resolved: Set<string>) {
  return Object.fromEntries(Object.entries(submissions).filter(([, submission]) => !submission.intentId || !resolved.has(submission.intentId)));
}

/** Pending requests have no invented position, entry price, PnL or withdrawable balance. */
export function pendingOpens(state: Pick<State, "owner" | "account" | "history" | "intents" | "openSubmissions">, now: number): PendingOpen[] {
  if (!state.owner) return [];
  const owner = state.owner.toLowerCase();
  const resolved = new Set([...(state.account?.positions ?? []).map(p => p.id), ...state.history.trades.map(t => t.id)]);
  const held = new Set<string>();
  const orders: PendingOpen[] = [];
  for (const submission of Object.values(state.openSubmissions)) {
    if (submission.owner.toLowerCase() !== owner || (submission.intentId && resolved.has(submission.intentId))) continue;
    if (submission.intentId) held.add(submission.intentId);
    orders.push({ id: submission.id, submissionId: submission.id, order: submission.order, stage: submission.stage });
  }
  for (const intent of Object.values(state.intents)) {
    if (intent.owner.toLowerCase() !== owner || intent.kind !== "open" || !["accepted", "filled"].includes(intent.status)
      || now > intent.pinTime + INTENT_STALE_AFTER || resolved.has(intent.positionId) || held.has(intent.id)) continue;
    orders.push({ id: intent.id, order: intent.order, stage: intent.status === "filled" ? "confirming" : "pricing", pinTime: intent.pinTime });
  }
  return orders;
}
