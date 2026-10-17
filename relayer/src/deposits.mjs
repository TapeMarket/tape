/**
 * Deposit addresses: turns USDC that arrives at a wallet's own deposit address into its balance.
 *
 * The Deposits contract gives every wallet an address of its own. A trader sends USDC there with a
 * plain transfer, from any wallet or exchange, and anyone may then call `collect(wallet)`, which
 * deposits it for that wallet. This does the calling. It is a convenience and nothing more: the
 * money can only ever become that wallet's balance, whoever collects it, and a trader with gas can
 * collect their own.
 *
 * Nobody tells the chain "watch this address", so the relayer watches the wallets that ask: the
 * site asks for a wallet's deposit address whenever its deposit box is open, and that wallet is
 * then looked at every few seconds for a while. Money that arrives later (a slow withdrawal from
 * an exchange) is picked up the next time the wallet's owner opens the site, or by anyone's call.
 */
import { lower } from "./util.mjs";

/** How long a wallet is watched after it was last asked about. */
const WATCH_MS = 45 * 60_000;
const LOOK_EVERY_MS = 4_000;
/** The most wallets watched at once: each look is a chain read. */
const MAX_WATCHED = 500;
/**
 * After a collect is sent for a wallet, no other is for this long. Each one costs the relayer gas,
 * and somebody cycling the smallest amount through a wallet again and again would otherwise have
 * it pay for every round, and hold up the lane other people's deposits wait in.
 */
const COOLDOWN_MS = 20_000;

export function createDepositWatcher({ config, chain, queue, log, onCollected = () => {} }) {
  const { addresses, read } = chain;
  const enabled = Boolean(addresses.deposits);
  // Below this a collect is not worth its gas. Whoever is owed less can collect it themselves.
  const minimum = BigInt(Math.round(config.depositMinUsd * 1e6));
  /** wallet (lower case) => { owner, address, until } */
  const watched = new Map();
  const known = new Map();
  const collecting = new Set();
  /** wallet (lower case) => when a collect was last sent for it */
  const lastCollect = new Map();
  let timer = null;

  let box = null;
  /** The code every deposit address runs: fixed when the Deposits contract was deployed. */
  async function boxCode() {
    box ??= await read("deposits", "box");
    return box;
  }

  async function addressOf(owner) {
    const key = lower(owner);
    if (!known.has(key)) known.set(key, await read("deposits", "addressOf", [owner]));
    return known.get(key);
  }

  /** The wallet's deposit address and what is waiting there. Asking is what starts the watch. */
  async function lookUp(owner) {
    if (!enabled) return { address: null, pending: 0n, minimum, deposits: null, box: null };
    const address = await addressOf(owner);
    const key = lower(owner);
    if (watched.size >= MAX_WATCHED && !watched.has(key)) {
      // Make room for the newcomer by letting go of whoever was asked about longest ago.
      const oldest = [...watched].sort((a, b) => a[1].until - b[1].until)[0];
      if (oldest) watched.delete(oldest[0]);
    }
    watched.set(key, { owner, address, until: Date.now() + WATCH_MS });
    const pending = await read("deposits", "pending", [owner]);
    if (pending >= minimum) collect(owner);
    // The site works the address out again for itself, from the contract and its box code, and
    // sends nothing to an address that does not match (see web/src/lib/actions.ts).
    return { address, pending, minimum, deposits: addresses.deposits, box: await boxCode() };
  }

  function collect(owner) {
    const key = lower(owner);
    if (collecting.has(key) || Date.now() - (lastCollect.get(key) ?? 0) < COOLDOWN_MS) return;
    collecting.add(key);
    lastCollect.set(key, Date.now());
    if (lastCollect.size > 4 * MAX_WATCHED) for (const [k, at] of lastCollect) if (Date.now() - at > COOLDOWN_MS) lastCollect.delete(k);
    queue
      .push({ contract: "deposits", label: `collect ${owner.slice(0, 8)}`, functionName: "collect", args: [owner] })
      .then((result) => {
        if (result.ok) onCollected(owner);
        // Somebody else collected it between the look and the transaction: that is not a fault.
        else if (result.reason !== "NothingToCollect") log.warn(`collect ${owner.slice(0, 8)}: ${result.reason}`);
      })
      .catch((error) => log.warn(`collect ${owner.slice(0, 8)}: ${error.shortMessage ?? error.message}`))
      .finally(() => collecting.delete(key));
  }

  async function look() {
    const now = Date.now();
    for (const [key, entry] of watched) {
      if (now > entry.until) {
        watched.delete(key);
        continue;
      }
      if (collecting.has(key)) continue;
      try {
        if ((await read("deposits", "pending", [entry.owner])) >= minimum) collect(entry.owner);
      } catch (error) {
        log.warn(`deposit watch: ${error.shortMessage ?? error.message}`);
        return; // The RPC is not answering: try the rest at the next look.
      }
    }
  }

  return {
    enabled,
    minimum,
    lookUp,
    start() {
      if (!enabled) return;
      timer = setInterval(() => look().catch((error) => log.warn(`deposit watch: ${error.message}`)), LOOK_EVERY_MS);
    },
    stop() {
      clearInterval(timer);
    },
    watching: () => watched.size,
  };
}
