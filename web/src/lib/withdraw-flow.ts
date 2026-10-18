import type { Address, Hex, Transfer } from "./types";

export interface WithdrawFlow {
  id: number;
  owner: Address;
  amount: string;
  stage: "preparing" | "wallet" | "submitting" | "confirming" | "pending" | "complete" | "error";
  tx?: Hex;
  error?: string;
  baseline: Transfer[];
}
export const withdrawActive = (stage?: WithdrawFlow["stage"]) => !!stage && stage !== "complete" && stage !== "error";

/** Only a new indexed withdrawal to this wallet can resolve an interrupted submission. */
export function withdrawalSince(flow: WithdrawFlow, transfers: Transfer[]): Transfer | undefined {
  const key = (t: Transfer) => `${t.tx.toLowerCase()}:${t.amount}:${t.to?.toLowerCase()}:${t.time}`;
  const before = new Map<string, number>();
  for (const t of flow.baseline) if (t.type === "withdraw") before.set(key(t), (before.get(key(t)) ?? 0) + 1);
  for (const t of transfers) {
    if (t.type !== "withdraw") continue;
    const id = key(t), count = before.get(id) ?? 0;
    if (count) { before.set(id, count - 1); continue; }
    if (t.amount === flow.amount && t.to?.toLowerCase() === flow.owner.toLowerCase()) return t;
  }
}
