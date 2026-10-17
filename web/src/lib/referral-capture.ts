const SLOT = "tape:ref";
const RULE = /^(0x[0-9a-fA-F]{40}|[a-z0-9_]{3,16})$/i;

/** Keep referral capture on the first paint without loading the wallet/signature library. */
export function captureReferral(): void {
  try {
    const said = new URLSearchParams(location.search).get("ref")?.trim();
    if (!said || !RULE.test(said)) return;
    if (!localStorage.getItem(SLOT)) localStorage.setItem(SLOT, said.toLowerCase());
  } catch {
    // Storage may be unavailable in a private window.
  }
}
