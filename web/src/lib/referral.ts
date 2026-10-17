/**
 * Referral links: <site>/?ref=NAME (a username or a wallet address).
 *
 * The link's name is kept in this browser from the first visit. When a wallet that has never
 * traded here turns on one-click trading, its trading key tells the relayer who sent it
 * (lib/actions.ts, `bindReferral`): no wallet popup, and it is asked once per wallet.
 */
import { getAddress } from "viem";
import type { Address } from "./types";

const SLOT = "tape:ref";
const DONE = "tape:ref-done:";
export { captureReferral } from "./referral-capture";

/** The name on the link this browser came through, for a wallet that has not been asked about yet. */
export function pendingReferral(owner: Address): string | null {
  try {
    const code = localStorage.getItem(SLOT);
    if (!code || localStorage.getItem(DONE + owner.toLowerCase())) return null;
    return code;
  } catch {
    return null;
  }
}

/** This wallet has its answer, yes or no: it is not asked about again. */
export function settleReferral(owner: Address): void {
  try {
    localStorage.setItem(DONE + owner.toLowerCase(), "1");
  } catch {
    // Nothing to remember it in.
  }
}

/** Must match the relayer's `referralMessage` (relayer/src/referrals.mjs). */
export const referralMessage = (owner: Address, code: string) => `Tape: ${getAddress(owner)} was referred by ${code.toLowerCase()}`;
