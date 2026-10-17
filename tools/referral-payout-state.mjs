/** A payout cannot rely on books that have never observed the chain's payment history. */
export function payoutScanStart(lookedTo, head) {
  if (lookedTo === null || lookedTo === undefined) throw new Error("Referral payout tracking is not initialized. Wait for the relayer to check the chain before paying.");
  const cursor = BigInt(lookedTo);
  if (cursor < 0n || cursor > head) throw new Error("Referral payout checkpoint is invalid for this chain head. No payments sent.");
  if (head - cursor > 2_000n) throw new Error(`The referral payout checkpoint is ${head - cursor} blocks behind. Wait for the relayer to catch up before paying.`);
  return cursor + 1n;
}
