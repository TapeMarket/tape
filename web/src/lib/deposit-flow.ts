import type { Address, Hex, Transfer } from "./types";

export type DepositStage = "preparing" | "wallet" | "submitting" | "confirming" | "crediting" | "pending" | "complete" | "error";
export interface DepositFlow {
  id: number;
  owner: Address;
  amount: string;
  stage: DepositStage;
  bySignature: boolean;
  tx?: Hex;
  confirmed?: boolean;
  error?: string;
  baseline: Transfer[];
}

export const depositActive = (stage?: DepositStage) => !!stage && !["complete", "pending", "error"].includes(stage);

/** Exact USDC quantity for inputs and confirmations; never converts through a floating point. */
export function depositAmount(value: bigint | string, padCents = false): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  let fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (padCents) fraction = fraction.padEnd(2, "0");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Indexed deposit receipts, not PnL or a balance change, establish that money was credited.
 * Count duplicates rather than treating a transaction hash as a unique ledger entry.
 */
export function depositCreditSince(before: Transfer[], after: Transfer[]): bigint {
  const seen = new Map<string, number>();
  const key = (entry: Transfer) => `${entry.tx.toLowerCase()}:${entry.amount}:${entry.time}`;
  for (const entry of before) if (entry.type === "deposit") seen.set(key(entry), (seen.get(key(entry)) ?? 0) + 1);
  let credited = 0n;
  for (const entry of after) {
    if (entry.type !== "deposit") continue;
    const id = key(entry), count = seen.get(id) ?? 0;
    if (count) seen.set(id, count - 1);
    else credited += BigInt(entry.amount);
  }
  return credited;
}
