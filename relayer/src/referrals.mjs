/**
 * Referrals: who brought whom, and what that has earned.
 *
 * A trader is bound to one referrer, once, before their first trade closes. From then on a share
 * of the TEAM's half of every fee the exchange takes on that trader's trades is the referrer's.
 * The other half of every fee is the stakers' and is not touched, and nothing here is paid by the
 * contracts: this keeps the books, and the team pays what the books say, in USDC, from the wallet
 * its fees are claimed to.
 *
 * What is kept on disk is only what the chain does not know: the bindings, and how far the search
 * for payouts has got. Everything earned is added up again from the chain's own record of trades
 * each time the relayer starts (the indexer replays it), so it cannot drift from what happened.
 *
 * Because a referrer never earns more than the team took from the trader, referring yourself
 * (from a second wallet) gives back part of your own fees and nothing more.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress, parseAbiItem, recoverMessageAddress } from "viem";
import { isAddr, lower, nowSeconds } from "./util.mjs";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
/** How many blocks one search for payouts covers, and how many searches one look may make. */
const PAYOUT_STEP = 500n;
const PAYOUT_STEPS_A_LOOK = 20;
const PAYOUT_LOOK_MS = 60_000;

/**
 * The text a trader's session key (or wallet) signs to say who referred them. `code` is the name on
 * the link as it was typed, a username or an address: the browser does not know a username's wallet.
 */
export const referralMessage = (owner, code) => `Tape: ${getAddress(owner)} was referred by ${String(code).toLowerCase()}`;

export class ReferralRefused extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {object} deps
 * @param {(owner: string) => number} deps.tradesOf        closed trades of an account so far
 * @param {(owner: string, key: string) => Promise<boolean>} deps.isSessionKey   is `key` signing for `owner` right now
 * @param {(name: string) => string | undefined} deps.addressOfName             a username's wallet (lower case)
 * @param {string | null} [deps.payer]                      the wallet payouts are sent from
 * @param {string | null} [deps.file]                       where bindings are kept; null keeps nothing (tests)
 */
export function createReferrals({ config, chain, log, tradesOf, isSessionKey, addressOfName, payer = null, file = undefined }) {
  const shareBps = BigInt(config.referralShareBps ?? 5000);
  const path = file === undefined ? join(config.dataDir ?? join(config.root, "relayer", "data"), `referrals-${config.chainId}.json`) : file;

  /** referee (lower) -> { referrer, time } */
  const bindings = new Map();
  /** referrer (lower) -> USDC already sent to it by the payer */
  const paid = new Map();
  let payoutBlock = null;
  try {
    if (path && existsSync(path)) {
      const kept = JSON.parse(readFileSync(path, "utf8"));
      for (const [referee, b] of Object.entries(kept.bindings ?? {})) bindings.set(referee, { referrer: getAddress(b.referrer), time: Number(b.time) });
      for (const [referrer, amount] of Object.entries(kept.paid ?? {})) paid.set(referrer, BigInt(amount));
      if (kept.payoutBlock) payoutBlock = BigInt(kept.payoutBlock);
    }
  } catch (error) {
    log.warn(`referrals: could not read ${path}: ${error.message}`);
  }

  function save(nextBindings = bindings, required = false) {
    if (!path) return;
    try {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(
        `${path}.tmp`,
        JSON.stringify({
          bindings: Object.fromEntries(nextBindings),
          paid: Object.fromEntries([...paid].map(([k, v]) => [k, v.toString()])),
          payoutBlock: payoutBlock?.toString() ?? null,
        }),
        { mode: 0o600 },
      );
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      log.warn(`referrals: could not save: ${error.message}`);
      if (required) throw new ReferralRefused("Couldn’t save this referral. Please try again.", 503);
    }
  }

  // What has been earned: rebuilt from the chain's trades every start, never stored.
  /** referee (lower) -> { trades, volume, fees, reward } */
  const byReferee = new Map();
  /** referrer (lower) -> earned */
  const earned = new Map();

  /** The referrer's cut of one fee: `shareBps` of the team's half. */
  const rewardOf = (fee) => ((fee - fee / 2n) * shareBps) / 10_000n;

  /** Every closed trade passes through here, in order, exactly once per start. */
  function onTrade(trade) {
    const binding = bindings.get(lower(trade.owner));
    if (!binding || trade.time < binding.time) return;
    const fee = BigInt(trade.fee ?? 0n);
    const reward = rewardOf(fee);
    const row = byReferee.get(lower(trade.owner)) ?? { trades: 0, volume: 0n, fees: 0n, reward: 0n };
    row.trades += 1;
    if (trade.margin !== null && trade.margin !== undefined) row.volume += BigInt(trade.margin) * BigInt(trade.leverage);
    row.fees += fee;
    row.reward += reward;
    byReferee.set(lower(trade.owner), row);
    const key = lower(binding.referrer);
    earned.set(key, (earned.get(key) ?? 0n) + reward);
  }

  /** `said` is a wallet address or a username. */
  function resolve(said) {
    if (typeof said !== "string") return null;
    if (isAddress(said)) return getAddress(said);
    const found = addressOfName(said.toLowerCase());
    return found ? getAddress(found) : null;
  }

  /**
   * Binds `owner` to a referrer. The signature is the owner's own, or that of a session key
   * signing for the owner right now, over `referralMessage`.
   */
  function checkBinding(owner, referrer) {
    if (lower(referrer) === lower(owner)) throw new ReferralRefused("A wallet cannot refer itself.", 422);
    const existing = bindings.get(lower(owner));
    if (existing) throw new ReferralRefused("This wallet already has a referrer.", 409);
    // Only a newcomer: a wallet that has already traded here was not brought by this link.
    if (tradesOf(owner) > 0) throw new ReferralRefused("This wallet has traded here before.", 422);
    // Two wallets naming each other would each earn on the other: one direction only.
    if (lower(bindings.get(lower(referrer))?.referrer ?? "") === lower(owner)) throw new ReferralRefused("That wallet was referred by this one.", 422);
  }

  async function bind({ owner, referrer: said, signature }) {
    if (!isAddr(owner) || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new ReferralRefused("Malformed request.");
    const referrer = resolve(said);
    if (!referrer) throw new ReferralRefused("That referral link names nobody we know.", 404);
    checkBinding(owner, referrer);

    let signer;
    try {
      signer = await recoverMessageAddress({ message: referralMessage(owner, said), signature });
    } catch {
      throw new ReferralRefused("Malformed signature.");
    }
    let allowed = lower(signer) === lower(owner) || (await isSessionKey(owner, signer));
    // A contract wallet signing for itself.
    if (!allowed) allowed = await chain.publicClient.verifyMessage({ address: getAddress(owner), message: referralMessage(owner, said), signature }).catch(() => false);
    if (!allowed) throw new ReferralRefused("Not signed by this wallet or its trading key.", 401);

    // Authentication can yield to another binding or a newly settled trade. Recheck all rules
    // immediately before saving, with no await between this point and the in-memory commit.
    checkBinding(owner, referrer);
    const next = new Map(bindings).set(lower(owner), { referrer, time: nowSeconds() });
    save(next, true);
    bindings.set(lower(owner), next.get(lower(owner)));
    log.info(`referral: ${owner.slice(0, 8)} was referred by ${referrer.slice(0, 8)}`);
    return { ok: true, referrer };
  }

  /** What an account's referral page shows. */
  function payload(owner) {
    const key = lower(owner);
    const referred = [];
    for (const [referee, binding] of bindings) {
      if (lower(binding.referrer) !== key) continue;
      const row = byReferee.get(referee) ?? { trades: 0, volume: 0n, fees: 0n, reward: 0n };
      referred.push({ address: getAddress(referee), since: binding.time, trades: row.trades, volume: row.volume, fees: row.fees, reward: row.reward });
    }
    referred.sort((a, b) => (b.reward > a.reward ? 1 : b.reward < a.reward ? -1 : b.since - a.since));
    const total = earned.get(key) ?? 0n;
    const sent = paid.get(key) ?? 0n;
    return {
      address: getAddress(owner),
      referrer: bindings.get(key)?.referrer ?? null,
      // Of every fee: the referrer's share of the team's half.
      shareOfFeeBps: Number(shareBps / 2n),
      referred,
      earned: total,
      paid: sent,
      owed: total > sent ? total - sent : 0n,
    };
  }

  /** Every referrer with something earned: what the payout tool reads. */
  function all() {
    return [...earned.keys()].map((key) => payload(key)).map(({ address, earned: e, paid: p, owed, referred }) => ({ address, earned: e, paid: p, owed, referred: referred.length }));
  }

  // Payouts are whatever USDC the payer has sent a referrer: read from the chain, so nobody has
  // to tell the relayer that somebody was paid.
  let timer = null;
  let looking = false;
  async function lookForPayouts() {
    if (looking || !payer || earned.size === 0) return;
    looking = true;
    try {
      const head = await chain.publicClient.getBlockNumber();
      // The first time, start from now: nothing was a payout before there was anything to pay.
      if (payoutBlock === null) {
        payoutBlock = head;
        save();
        return;
      }
      let changed = false;
      for (let step = 0; step < PAYOUT_STEPS_A_LOOK && payoutBlock < head; step++) {
        const to = payoutBlock + PAYOUT_STEP > head ? head : payoutBlock + PAYOUT_STEP;
        const logs = await chain.publicClient.getLogs({ address: chain.addresses.usdc, event: TRANSFER, args: { from: payer }, fromBlock: payoutBlock + 1n, toBlock: to });
        for (const entry of logs) {
          const receiver = lower(entry.args.to);
          if (!earned.has(receiver)) continue;
          paid.set(receiver, (paid.get(receiver) ?? 0n) + entry.args.value);
        }
        payoutBlock = to;
        changed = true;
      }
      if (changed) save();
    } catch (error) {
      log.warn(`referrals: looking for payouts: ${error.shortMessage ?? error.message}`);
    } finally {
      looking = false;
    }
  }

  return {
    shareBps,
    payer,
    bind,
    onTrade,
    payload,
    all,
    referrerOf: (owner) => bindings.get(lower(owner))?.referrer ?? null,
    /** The last block searched for payouts: a payment after it is not in anybody's "paid" yet. */
    lookedTo: () => payoutBlock,
    lookForPayouts,
    start() {
      timer = setInterval(() => lookForPayouts(), PAYOUT_LOOK_MS);
      lookForPayouts();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
