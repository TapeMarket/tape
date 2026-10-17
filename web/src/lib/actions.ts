// Everything a trader can do, as functions the interface calls.
//
// Trading runs on a session key: a keypair made in this browser, registered once with a wallet
// signature, that signs every open and close afterwards. It can trade and nothing else. Deposits
// and withdrawals are always signed by the wallet itself.
//
// In preview mode there is no chain and nothing to sign: the same requests go to the exchange
// running in this tab, unsigned.

import { getAddress, hashTypedData, parseSignature, type Abi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { domain as buildDomain, sessionDomain, types, permitTypes } from "@shared/eip712.mjs";
import { ApiError, get, loadAccount, loadCoin, loadHistory, post, refreshAccountSoon } from "./api";
import { PREVIEW } from "./mode";
import { getState, serverNow, setState, toast, subscribe } from "./store";
import { explainWalletError, getSigner } from "./wallet";
import { checkedDepositAddress } from "./deposits";
import { depositActive, depositCreditSince, type DepositFlow } from "./deposit-flow";
import { withdrawActive, type WithdrawFlow } from "./withdraw-flow";
import { INTENT_STALE_AFTER, recordIntent } from "./open-orders";
import { pendingReferral, referralMessage, settleReferral } from "./referral";
import { REFERRAL_CODE_RULE, referralCodeMessage } from "@shared/referral-code.mjs";
import type { Account, Address, Hex, History, Intent } from "./types";
import { coin as coinText, usdExact } from "./format";

import stakingAbi from "../../../abi/Staking.json";
import coinAbi from "../../../abi/Coin.json";

const SESSION_DAYS = 30;
const UNSIGNED: Hex = "0x";

interface StoredSession {
  privateKey: Hex;
  address: Address;
  /** The key signs for orders stamped from this second on: one slot after it was registered. */
  validFrom: number;
  validUntil: number;
}

function sessionSlot(owner: Address): string {
  const config = getState().config!;
  return `tape:session:${config.chainId}:${config.addresses.sessions}:${owner}`.toLowerCase();
}

function exchangeDomain() {
  const config = getState().config!;
  return buildDomain(config.name, config.chainId, config.addresses.exchange);
}

function loadSession(owner: Address): StoredSession | null {
  try {
    const stored = JSON.parse(localStorage.getItem(sessionSlot(owner)) ?? "null") as StoredSession | null;
    // Renew a little before expiry rather than fail mid-trade.
    return stored && stored.validUntil > serverNow() + 3600 ? stored : null;
  } catch {
    return null;
  }
}

/** Puts the connected wallet's stored session, if any, where the interface can see it. */
export function syncSession(): void {
  const owner = getState().owner;
  // The play account needs no key: it is always ready to trade.
  if (PREVIEW) return setState({ session: owner ? { validFrom: 0, validUntil: 2 ** 31 } : null });
  const stored = owner && getState().config ? loadSession(owner) : null;
  setState({ session: stored ? { validFrom: stored.validFrom, validUntil: stored.validUntil } : null });
  if (stored) void bindReferral();
}

let binding: string | null = null;

/**
 * Tells the relayer who sent this wallet here, if it came through a referral link. The trading key
 * signs it, so no wallet popup, and each wallet is asked about once: the relayer only takes a
 * wallet that has never traded here.
 */
async function bindReferral(): Promise<void> {
  const signer = getSigner();
  if (PREVIEW || !signer) return;
  const owner = signer.address;
  const code = pendingReferral(owner);
  const session = loadSession(owner);
  if (!code || !session || binding === owner) return;
  // The key starts signing one block-slot after it is registered.
  const wait = session.validFrom - serverNow();
  if (wait > 0) {
    setTimeout(() => void bindReferral(), wait * 1000 + 1500);
    return;
  }
  binding = owner;
  try {
    const signature = await privateKeyToAccount(session.privateKey).signMessage({ message: referralMessage(owner, code) });
    await post("/referral", { owner, referrer: code, signature });
    settleReferral(owner);
  } catch (error) {
    // Refused for good (its own link, already referred, traded before, a name nobody has): that
    // is this wallet's answer. Anything else (offline, too early) is tried again next time.
    if (error instanceof ApiError && [400, 404, 409, 422].includes(error.status)) settleReferral(owner);
  } finally {
    binding = null;
  }
}

function forgetSession(owner: Address): void {
  localStorage.removeItem(sessionSlot(owner));
  syncSession();
}

/**
 * Registers a trading key for the connected wallet: one signature, no gas. The key starts signing
 * one block-slot later; until then the ticket counts down.
 */
async function createSession(): Promise<StoredSession> {
  const signer = getSigner();
  const config = getState().config;
  if (!signer || !config) throw new Error("Connect a wallet first.");

  const privateKey = generatePrivateKey();
  const key = privateKeyToAccount(privateKey).address;
  const validUntil = serverNow() + SESSION_DAYS * 86_400;
  const { sessionNonce } = await get<Account>(`/account/${signer.address}`);
  const signature = await signer.signTypedData({
    domain: sessionDomain(config.name, config.chainId, config.addresses.sessions),
    types: { SessionKey: types.SessionKey },
    primaryType: "SessionKey",
    message: { owner: signer.address, key, validUntil: BigInt(validUntil), nonce: BigInt(sessionNonce) },
  });
  const registered = await post<{ validFrom: number; validUntil: number }>("/session", { owner: signer.address, key, validUntil, signature });

  const session = { privateKey, address: key, validFrom: registered.validFrom, validUntil: registered.validUntil };
  localStorage.setItem(sessionSlot(signer.address), JSON.stringify(session));
  syncSession();
  return session;
}

let creating: Promise<StoredSession> | null = null;

/** Returns this browser's trading key for the connected wallet, registering one if there is none. */
function ensureSession(): Promise<StoredSession> {
  const signer = getSigner();
  if (!signer) return Promise.reject(new Error("Connect a wallet first."));
  const existing = loadSession(signer.address);
  if (existing) return Promise.resolve(existing);
  creating ??= createSession().finally(() => {
    creating = null;
  });
  return creating;
}

/** Turns one-click trading on. Called from the ticket's button. */
export async function startSession(): Promise<boolean> {
  try {
    await ensureSession();
    return true;
  } catch (error) {
    report("Could not turn on one-click trading", error);
    return false;
  }
}

function report(title: string, error: unknown): void {
  if (error instanceof ApiError) toast("bad", title, error.message);
  else toast("bad", title, explainWalletError(error));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The second to stamp an order with. The relayer refuses a stamp from a second that has already
 * passed, so in the last quarter of a second the next one is used: a clock a little behind the
 * relayer's must not turn into a rejected order.
 */
const stamp = (): bigint => BigInt(Math.floor((Date.now() + getState().clockOffset) / 1000 + 0.25));

type SignTrade = (primaryType: "Open" | "Close" | "Trigger" | "CancelTrigger", message: Record<string, unknown>) => Promise<Hex>;

/**
 * Runs a session-signed request once the key is live. Registers a fresh key, once, if the relayer
 * no longer knows this one.
 */
async function withSession<T>(run: (sign: SignTrade) => Promise<T>): Promise<T> {
  if (PREVIEW) return run(() => Promise.resolve(UNSIGNED));
  const owner = getSigner()!.address;
  const attempt = async () => {
    const session = await ensureSession();
    const wait = session.validFrom - serverNow();
    // An order goes out when it is clicked or not at all. A key that is still seconds from
    // starting does not hold the order back and send it later, at a price nobody looked at.
    if (wait > 2) throw new ApiError(`Your trading key starts in ${wait}s. Place the order again then.`, 425);
    if (wait > 0) await sleep(wait * 1000 + 300);
    const key = privateKeyToAccount(session.privateKey);
    return run((primaryType, message) =>
      key.signTypedData({ domain: exchangeDomain(), types: { [primaryType]: types[primaryType] }, primaryType, message } as never),
    );
  };
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // 425: the key exists but its start is a moment away by the relayer's clock.
    if (error.status === 425) {
      await sleep(1500);
      return attempt();
    }
    if (error.status !== 401) throw error;
    // The relayer no longer accepts this key (revoked, or expired). Registering another takes a
    // signature and twelve seconds; the order is dropped and has to be placed again after that.
    forgetSession(owner);
    throw new ApiError("Your one-click trading key is no longer valid. Turn one-click trading on again, then place the order.", 401);
  }
}

// ---------------------------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------------------------

export interface OpenRequest {
  market: number;
  isLong: boolean;
  margin: bigint;
  leverage: number;
  useQueued: boolean;
  /** The most the position may be charged on for its size, in whole dollars. Zero for no limit. */
  impactLimit: number;
}

let openSubmissionId = 0;
/** Places an open. Resolves to the order's id, which is also the position's, or null. */
export async function openPosition(request: OpenRequest): Promise<Hex | null> {
  const signer = getSigner();
  if (!signer) return null;
  const owner = signer.address;
  if (Object.values(getState().openSubmissions).some(order => order.owner.toLowerCase() === owner.toLowerCase())) return null;
  const id = `open:${++openSubmissionId}`;
  const order = { market: request.market, isLong: request.isLong, leverage: request.leverage, margin: request.margin.toString(), useQueued: request.useQueued };
  let submitted = false;
  let intentId: Hex | undefined;
  // Paint the actual request before session signing or HTTP starts. This is not a filled position.
  setState(s => ({ openSubmissions: { ...s.openSubmissions, [id]: { id, owner, order, stage: "sending" } } }));
  const remove = () => setState(s => {
    const openSubmissions = { ...s.openSubmissions }; delete openSubmissions[id];
    return { openSubmissions };
  });
  try {
    const intent = await withSession(async (sign) => {
      submitted = false;
      const message = {
        owner: signer.address,
        market: request.market,
        isLong: request.isLong,
        useQueued: request.useQueued,
        leverage: request.leverage,
        margin: request.margin,
        priceLimit: 0n,
        impactLimit: request.impactLimit,
        timestamp: stamp(),
        salt: BigInt(Math.floor(Math.random() * 2 ** 48)),
      };
      intentId = hashTypedData({ domain: exchangeDomain(), types, primaryType: "Open", message });
      setState(s => ({ openSubmissions: { ...s.openSubmissions, [id]: { id, owner, order, stage: "sending", intentId } } }));
      const signature = await sign("Open", message);
      if (getState().owner?.toLowerCase() !== owner.toLowerCase() || getSigner()?.address.toLowerCase() !== owner.toLowerCase()) throw Error("Your wallet changed. Place the order from your connected wallet.");
      submitted = true;
      const response = post<Intent>("/open", { intent: message, signature });
      if (PREVIEW) return response;
      // The private stream can acknowledge acceptance before the HTTP response arrives.
      // Either answer is authoritative; stop listening when the first one settles.
      let stop = () => {};
      const streamed = new Promise<Intent>(resolve => {
        const check = () => {
          const known = intentId && getState().intents[intentId];
          if (known && known.owner.toLowerCase() === owner.toLowerCase()) resolve(known);
        };
        stop = subscribe(check); check();
      });
      try { return await Promise.race([response, streamed]); }
      finally { stop(); }
    });
    if (intent.kind !== "open" || intent.owner.toLowerCase() !== owner.toLowerCase() || (!PREVIEW && (intent.id !== intentId || intent.positionId !== intentId))) throw Error("The order response could not be matched to your signed order.");
    if (getState().owner?.toLowerCase() !== owner.toLowerCase()) { remove(); return null; }
    setState(s => recordIntent(s, { ...intent, order }, id));
    // The margin is spoken for from this moment; show the balance without it right away.
    refreshAccountSoon(0);
    if (getState().intents[intent.id]?.status === "failed") return null;
    return intent.id as Hex;
  } catch (error) {
    if (submitted && intentId && (!(error instanceof ApiError) || error.status >= 500)) {
      const known = getState().intents[intentId];
      if (known && known.owner.toLowerCase() === owner.toLowerCase()) {
        setState(s => recordIntent(s, { ...known, order }, id));
        return known.status === "failed" ? null : intentId;
      }
      setState(s => ({ openSubmissions: { ...s.openSubmissions, [id]: { id, owner, order, stage: "checking", intentId } } }));
      toast("info", "Checking your order", "The response was interrupted. Checking its status before another order is sent.");
      return null;
    }
    remove();
    report("Order not placed", error);
    return null;
  }
}

const checkingOpens = new Set<string>();
/** Read-only recovery of a submitted order; never re-signs or resends it. */
export async function checkOpenSubmission(id: string): Promise<void> {
  const submission = getState().openSubmissions[id];
  if (!submission?.intentId || checkingOpens.has(id) || getState().owner?.toLowerCase() !== submission.owner.toLowerCase()) return;
  checkingOpens.add(id);
  try {
    const intent = await get<Intent>(`/intent/${submission.intentId}`);
    if (intent.kind !== "open" || intent.id !== submission.intentId || intent.owner.toLowerCase() !== submission.owner.toLowerCase() || getState().owner?.toLowerCase() !== submission.owner.toLowerCase()) return;
    setState(s => recordIntent(s, { ...intent, order: submission.order }, id));
    refreshAccountSoon(0);
    if (intent.status === "failed") toast("bad", "Order not filled", intent.error ?? undefined);
  } catch { /* Keep it unresolved rather than encourage a duplicate order. */ }
  finally { checkingOpens.delete(id); }
}

/**
 * Sets a take-profit or a stop-loss: close the position once a price at or past `price` prints,
 * `above` it or below it. Signed once by the trading key, held by the relayer, checked on-chain.
 */
export async function setTrigger(positionId: Hex, price: bigint, above: boolean): Promise<boolean> {
  const signer = getSigner();
  if (!signer) return false;
  try {
    await withSession(async (sign) => {
      const message = { owner: signer.address, positionId, price, above, timestamp: stamp() };
      return post("/trigger", { intent: message, signature: await sign("Trigger", message) });
    });
    return true;
  } catch (error) {
    report(above ? "Trigger not set" : "Trigger not set", error);
    return false;
  }
}

/** Takes a take-profit or stop-loss off again. */
export async function cancelTrigger(positionId: Hex, above: boolean): Promise<boolean> {
  const signer = getSigner();
  if (!signer) return false;
  try {
    await withSession(async (sign) => {
      const message = { owner: signer.address, positionId, above, timestamp: stamp() };
      return post("/trigger/cancel", { intent: message, signature: await sign("CancelTrigger", message) });
    });
    return true;
  } catch (error) {
    report("Trigger not removed", error);
    return false;
  }
}

/**
 * Sets the take-profit and stop-loss of a position as soon as its open has filled: the relayer
 * knows a position from its fill, two seconds after the click. Gives up after half a minute.
 */
export function triggersOnFill(positionId: Hex, isLong: boolean, takeProfit: bigint | null, stopLoss: bigint | null): void {
  if (takeProfit === null && stopLoss === null) return;
  let done = false;
  const go = () => {
    if (done) return;
    const position = getState().account?.positions.find((p) => p.id === positionId);
    const intent = getState().intents[positionId];
    if (intent?.status === "failed") return finish();
    if (!position) return;
    finish();
    // A take-profit is on the winning side: above the price for a long.
    if (takeProfit !== null) void setTrigger(positionId, takeProfit, isLong);
    if (stopLoss !== null) void setTrigger(positionId, stopLoss, !isLong);
  };
  const stop = subscribe(go);
  const timer = setTimeout(() => finish(), 30_000);
  function finish() {
    done = true;
    stop();
    clearTimeout(timer);
  }
  go();
}

export async function closePosition(positionId: Hex): Promise<boolean> {
  const signer = getSigner();
  if (!signer) return false;
  try {
    const intent = await withSession(async (sign) => {
      const message = { owner: signer.address, positionId, timestamp: stamp() };
      return post<Intent>("/close", { intent: message, signature: await sign("Close", message) });
    });
    setState((s) => ({ intents: { ...s.intents, [intent.id]: intent } }));
    return true;
  } catch (error) {
    report("Close not sent", error);
    return false;
  }
}

/** Closes every open position that is not already closing. */
export async function closeAll(): Promise<void> {
  const account = getState().account;
  if (!account) return;
  const now = serverNow();
  const open = account.positions.filter((p) => p.status === "open" && !p.liquidating && !closingIntent(getState().intents, p.id, now));
  await Promise.all(open.map((p) => closePosition(p.id)));
}

// An order lives at most this long past its price time. After that it either landed or never will,
// so the interface stops showing it as in progress (the relayer may have restarted and lost it).
const STALE_AFTER = INTENT_STALE_AFTER;

export const isLive = (intent: Intent, now: number): boolean =>
  (intent.status === "accepted" || intent.status === "filled") && now <= intent.pinTime + STALE_AFTER;

/** The unsettled close for a position, if one is on its way. */
export function closingIntent(intents: Record<string, Intent>, positionId: string, now: number): Intent | null {
  for (const intent of Object.values(intents)) {
    if (intent.kind === "close" && intent.positionId === positionId && isLive(intent, now)) return intent;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Money in and out
// ---------------------------------------------------------------------------------------------

/** The wallet's own deposit address, and what is waiting there to be collected. */
export type DepositAddress = { address: Address; pending: string; minimum: string };
type DepositAnswer = { address: Address | null; pending: string; minimum: string; deposits: Address | null; box: Address | null };

const TRANSFER_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const satisfies Abi;

/**
 * The wallet's deposit address: what the relayer says, checked against what the chain's own rule
 * gives (lib/deposits.ts). It throws rather than return an address that does not check out.
 * Asking is also what has the relayer watch the address and collect what arrives.
 */
export async function depositAddress(owner: Address): Promise<DepositAddress> {
  const config = getState().config;
  if (!config) throw new Error("Not connected to the exchange.");
  const said = await get<DepositAnswer>(`/deposit-address/${owner}`);
  const address = checkedDepositAddress(config.chainId, owner, said, config.addresses.deposits);
  return { address, pending: said.pending, minimum: said.minimum };
}

/**
 * Deposits by sending USDC to the wallet's own deposit address: an ordinary transfer, which gives
 * nobody permission to move anything. The relayer collects it into the exchange balance a moment
 * later. `bySignature` is the other way in, for a wallet with no ETH to pay for a transfer: a
 * signed permit, which the relayer carries (wallets warn about permits to contracts they do not
 * know yet, which is why it is not the first choice).
 */
let depositId = 0;
const depositing = new Set<string>();
export async function deposit(amount: bigint, bySignature = false): Promise<boolean> {
  const signer = getSigner();
  const config = getState().config;
  if (!signer || !config || amount <= 0n) return false;
  const owner = signer.address, slot = owner.toLowerCase(), id = ++depositId;
  const existing = getState().depositFlows[slot];
  if (depositing.has(slot) || depositActive(existing?.stage) || existing?.stage === "pending") return false;
  depositing.add(slot);
  let tx: Hex | undefined;
  let confirmed = false;
  let permitSubmitted = false;
  const progress = (patch: Partial<DepositFlow>) => setState(s => s.depositFlows[slot]?.id === id ? { depositFlows: { ...s.depositFlows, [slot]: { ...s.depositFlows[slot]!, ...patch } } } : {});
  setState(s => ({ depositFlows: { ...s.depositFlows, [slot]: { id, owner, amount: amount.toString(), stage: "preparing", bySignature, baseline: [] } } }));
  try {
    const baseline = (await get<History>(`/history/${owner}?limit=200`)).transfers;
    progress({ baseline });
    const stillConnected = () => {
      if (getState().owner?.toLowerCase() !== slot || getSigner()?.address.toLowerCase() !== slot) throw new Error("Your connected wallet changed. Review the deposit with the current wallet.");
    };
    if (PREVIEW) {
      stillConnected();
      progress({ stage: "crediting" });
      await post("/deposit", { owner, amount });
      confirmed = true;
    } else if (config.addresses.deposits && !bySignature) {
      const { address, minimum } = await depositAddress(owner);
      if (amount < BigInt(minimum)) throw new Error(`Deposit at least ${usdExact(minimum)} for automatic collection.`);
      stillConnected();
      progress({ stage: "wallet" });
      tx = await signer.write({ address: config.addresses.usdc, abi: TRANSFER_ABI, functionName: "transfer", args: [address, amount] }, hash => {
        tx = hash;
        progress({ stage: "confirming", tx: hash });
      });
      confirmed = true;
    } else {
      const { wallet } = await get<Account>(`/account/${owner}`);
      const deadline = BigInt(serverNow() + 1800);
      stillConnected();
      progress({ stage: "wallet" });
      const signature = await signer.signTypedData({
        domain: { name: config.usdcPermit.name, version: config.usdcPermit.version, chainId: config.chainId, verifyingContract: config.addresses.usdc },
        types: permitTypes,
        primaryType: "Permit",
        message: { owner, spender: config.addresses.gateway, value: amount, nonce: BigInt(wallet.usdcNonce), deadline },
      });
      const { r, s, v, yParity } = parseSignature(signature);
      stillConnected();
      progress({ stage: "submitting" });
      permitSubmitted = true;
      const result = await post<{ tx?: Hex }>("/deposit", { owner, amount, deadline, v: Number(v ?? 27n + BigInt(yParity)), r, s });
      tx = result.tx;
      confirmed = true;
    }
    progress({ stage: "crediting", tx, confirmed });
    // A winning trade can also raise the balance. Only new indexed deposit receipts finish this.
    for (const until = Date.now() + (PREVIEW ? 5000 : 120_000); ; ) {
      if (!PREVIEW && config.addresses.deposits && !bySignature) await depositAddress(owner).catch(() => null);
      const history = await get<History>(`/history/${owner}?limit=200`).catch(() => null);
      if (history && depositCreditSince(baseline, history.transfers) >= amount) {
        await Promise.allSettled([loadAccount(), loadHistory()]);
        progress({ stage: "complete" });
        toast("good", `Deposited ${usdExact(amount)}`, "Your trading balance has been credited.");
        return true;
      }
      if (Date.now() >= until) break;
      await sleep(2500);
    }
    progress({ stage: "pending" });
    toast("info", "Deposit confirmation is taking longer", "Reopen Deposit to keep checking. Do not send the same amount again to retry it.");
    return true; // Submission succeeded; the UI deliberately keeps this separate from credited.
  } catch (error) {
    if ((tx && !(error as { transactionReverted?: boolean })?.transactionReverted) || (permitSubmitted && !(error instanceof ApiError))) {
      progress({ stage: "pending", tx, confirmed, error: tx ? "The transaction was sent, but its status could not be checked. View the transaction or reopen this window to check again." : "Your signed deposit was submitted, but the response was interrupted. Keep this window open to check for the credit before sending again." });
      toast("info", "Deposit status unavailable", "Check the submitted deposit before sending again.");
      return true;
    }
    progress({ stage: "error", tx, confirmed: false, error: error instanceof ApiError ? error.message : explainWalletError(error) });
    if (getState().dialog !== "deposit" || getState().owner?.toLowerCase() !== slot) report("Deposit failed", error);
    return false;
  } finally {
    depositing.delete(slot);
  }
}

const withdrawing = new Set<string>();
export async function withdraw(amount: bigint): Promise<boolean> {
  const signer = getSigner();
  if (!signer || amount <= 0n) return false;
  const owner = signer.address, slot = owner.toLowerCase();
  if (withdrawing.has(slot) || withdrawActive(getState().withdrawFlows[slot]?.stage)) return false;
  withdrawing.add(slot);
  const id = Date.now();
  let submitted = false;
  setState(s => ({ withdrawFlows: { ...s.withdrawFlows, [slot]: { id, owner, amount: amount.toString(), stage: "preparing", baseline: [] } } }));
  const progress = (patch: Partial<WithdrawFlow>) => setState(s => {
    const previous = s.withdrawFlows[slot];
    if (!previous || previous.id !== id) return {};
    return { withdrawFlows: { ...s.withdrawFlows, [slot]: { ...previous, ...patch } } };
  });
  const stillConnected = () => { if (getState().owner?.toLowerCase() !== slot || getSigner()?.address.toLowerCase() !== slot) throw Error("Your wallet changed. Reopen Withdraw for your connected wallet."); };
  try {
    const [fresh, history] = await Promise.all([get<Account>(`/account/${owner}`), get<History>(`/history/${owner}?limit=200`)]);
    stillConnected();
    if (amount > BigInt(fresh.balance) - BigInt(fresh.reserved)) throw Error("This is more than your available balance. Choose a smaller amount.");
    progress({ baseline: history.transfers });
    let result: { tx?: Hex };
    if (PREVIEW) {
      progress({ stage: "submitting" }); submitted = true;
      result = await post("/withdraw", { owner, to: owner, amount });
    }
    else {
      const deadline = BigInt(serverNow() + 600);
      progress({ stage: "wallet" });
      const signature = await signer.signTypedData({
        domain: exchangeDomain(),
        types: { Withdraw: types.Withdraw },
        primaryType: "Withdraw",
        message: { owner, to: owner, amount, nonce: BigInt(fresh.withdrawNonce), deadline },
      });
      stillConnected();
      progress({ stage: "submitting" }); submitted = true;
      result = await post("/withdraw", { owner, to: owner, amount, deadline, signature });
    }
    if (!PREVIEW && !result?.tx) throw Error("The relayer did not return a withdrawal receipt.");
    progress({ stage: "complete", tx: result?.tx });
    toast("good", `Withdrew ${usdExact(amount)}`, "It is in your wallet.");
    await Promise.allSettled([loadAccount(), loadHistory()]);
    return true;
  } catch (error) {
    const message = error instanceof ApiError ? error.message : explainWalletError(error);
    if (submitted && (!(error instanceof ApiError) || error.status >= 500)) {
      progress({ stage: "pending", error: "The response was interrupted. Checking your withdrawal before allowing another submission." });
      return false;
    }
    progress({ stage: "error", error: message });
    if (getState().dialog !== "withdraw" || getState().owner?.toLowerCase() !== slot) report("Withdrawal failed", error);
    return false;
  } finally {
    withdrawing.delete(slot);
  }
}

// ---------------------------------------------------------------------------------------------
// The coin. On a chain these are ordinary transactions from the wallet.
// ---------------------------------------------------------------------------------------------

async function coinAction(title: string, done: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    toast("good", done);
    refreshAccountSoon(0);
    loadCoin().catch(() => {});
    loadHistory().catch(() => {});
    return true;
  } catch (error) {
    report(title, error);
    return false;
  }
}

export function stake(amount: bigint): Promise<boolean> {
  const signer = getSigner();
  const config = getState().config;
  const account = getState().account;
  if (!signer || !config?.coin || !account?.coin) return Promise.resolve(false);
  const { address: coin, staking, symbol } = config.coin;
  return coinAction("Stake failed", `Staked ${coinText(amount)} ${symbol}`, async () => {
    if (PREVIEW) return post("/stake", { owner: signer.address, amount });
    if (BigInt(account.coin!.stakingAllowance) < amount) {
      await signer.write({ address: coin, abi: coinAbi as Abi, functionName: "approve", args: [staking, amount] });
    }
    return signer.write({ address: staking, abi: stakingAbi as Abi, functionName: "stake", args: [amount] });
  });
}

export function unstake(amount: bigint): Promise<boolean> {
  const signer = getSigner();
  const coin = getState().config?.coin;
  if (!signer || !coin) return Promise.resolve(false);
  return coinAction("Unstake failed", `Unstaked ${coinText(amount)} ${coin.symbol}`, () =>
    PREVIEW
      ? post("/unstake", { owner: signer.address, amount })
      : signer.write({ address: coin.staking, abi: stakingAbi as Abi, functionName: "unstake", args: [amount] }),
  );
}

/** Claims staking rewards. They land in the trading balance. */
export function claimRewards(): Promise<boolean> {
  const signer = getSigner();
  const coin = getState().config?.coin;
  if (!signer || !coin) return Promise.resolve(false);
  return coinAction("Claim failed", "Rewards claimed to your trading balance", () =>
    PREVIEW ? post("/claim", { owner: signer.address }) : signer.write({ address: coin.staking, abi: stakingAbi as Abi, functionName: "claim", args: [] }),
  );
}

// ---------------------------------------------------------------------------------------------
// Username
// ---------------------------------------------------------------------------------------------

/** Must match the relayer's `usernameMessage`. */
const usernameMessage = (name: string, owner: Address) => `Claim the username "${name}" for ${getAddress(owner)}`;

/** Claim one permanent custom link without changing this wallet's display name. */
export async function createReferralCode(value: string): Promise<string> {
  const signer = getSigner();
  const { config, owner } = getState();
  if (PREVIEW) throw new Error("Custom referral links are available on the live exchange.");
  if (!signer || !config || owner?.toLowerCase() !== signer.address.toLowerCase()) throw new Error("Connect your wallet to create a custom link.");
  const code = value.trim().toLowerCase();
  if (!REFERRAL_CODE_RULE.test(code)) throw new Error("Use 3 to 16 letters, numbers or underscores.");
  const signature = await signer.signMessage(referralCodeMessage({ code, owner: signer.address, chainId: config.chainId, exchange: config.addresses.exchange }));
  if (getState().owner?.toLowerCase() !== owner.toLowerCase()) throw new Error("Your connected wallet changed. Please try again.");
  const saved = await post<{ code: string }>("/referral-code", { owner: signer.address, code, signature });
  return saved.code;
}

export async function claimUsername(name: string): Promise<boolean> {
  const signer = getSigner();
  if (!signer) return false;
  try {
    const clean = name.trim().toLowerCase();
    const signature = PREVIEW ? UNSIGNED : await signer.signMessage(usernameMessage(clean, signer.address));
    await post("/username", { owner: signer.address, name: clean, signature });
    toast("good", `You are ${clean}`);
    await loadAccount();
    return true;
  } catch (error) {
    report("Username not claimed", error);
    return false;
  }
}
