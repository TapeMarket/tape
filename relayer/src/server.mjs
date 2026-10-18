/**
 * The HTTP API the site talks to. Plain node:http: a handful of JSON routes and one event stream.
 *
 *   GET  /health
 *   GET  /config                     chain, addresses, markets, timing constants
 *   GET  /stream?owner=0x…           server-sent events: ticks, the public trade feed, the house,
 *                                    and (with owner) that account's intents and positions
 *   GET  /prices?market=0&seconds=900
 *   GET  /account/:address
 *   GET  /history/:address           trades, transfers, staking, queue and coin history
 *   GET  /leaderboard?window=24h|7d|30d|all
 *   GET  /season?n=<number>            a weekly season: its board, its prize pool, the last winners
 *   GET  /jackpot?owner=<address>      the Rekt Jackpot: this hour's pot and tickets, the wallet's share, recent winners
 *   GET  /house
 *   GET  /coin
 *   GET  /series?seconds=86400       a day of minute samples for the charts
 *   GET  /status
 *   GET  /intent/:id
 *   POST /open /close                signed trading intents
 *   POST /session /deposit /withdraw wallet-signed account actions
 *   POST /username                   claim a display name, signed by the wallet
 *   POST /dev/nudge                  local chain only: move a simulated price, for tests
 */
import { MIN_TRADES, PRIZE_SPLIT_BPS, WEEK, season, seasonNumber, weekOf } from "../../shared/seasons.mjs";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAddress, isHex, getAddress, erc20Abi } from "viem";
import { liveClaims } from "./indexer.mjs";
import { sweepable } from "./keeper.mjs";
import { ReferralRefused } from "./referrals.mjs";
import { createReferralCodes } from "./referral-codes.mjs";
import { readAccountSnapshot } from "./account-balance.mjs";
import { createSupport } from "./support.mjs";
import { refreshRecovery } from "./recovery.mjs";
import { EXEC_DELAY, PIN_WINDOW, INTENT_TTL, DIRECT_DELAY, WITHDRAW_DELAY, GRACE, REQUEST_EXPIRY } from "../../shared/eip712.mjs";
import { Rejected, toJson, acct, lower, nowSeconds, isAddr } from "./util.mjs";

const MAX_BODY = 32 * 1024;
// A body over the limit is read to its end (and thrown away) up to this size, so that the 413 can
// actually be delivered. Past it the connection is cut.
const MAX_DISCARD = 2 * 1024 * 1024;
// Per client address: writes per minute, and event streams held open at once.
// An account may hold 200 positions, and Close All sends a close for each of them at once.
const POSTS_PER_MINUTE = 400;
// How long an answer that is the same for everyone is reused. Most of them cost several RPC calls.
const SHARED_FOR_MS = { "/house": 1_000, "/coin": 1_500, "/status": 2_000 };
const STREAMS_PER_CLIENT = 12;
const MAX_STREAMS = 20_000;
const WINDOWS = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400, all: Infinity };
const NONCES_ABI = [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

const NAME_RULE = /^[a-z0-9_]{3,16}$/;
const MAX_HOUSE_POSITIONS = 3_000;

/** The text a wallet signs to claim a display name. */
export const usernameMessage = (name, owner) => `Claim the username "${name}" for ${getAddress(owner)}`;

/** Browsers accept one allowed origin per response, never a comma-separated header value. */
export function corsFor(allowed, origin) {
  if (allowed === "*") return { "access-control-allow-origin": "*" };
  const origins = String(allowed).split(",").map((value) => value.trim()).filter(Boolean);
  return { vary: "Origin", ...(typeof origin === "string" && origins.includes(origin) ? { "access-control-allow-origin": origin } : {}) };
}

export function createApi({ config, chain, book, store, engine, indexer, hub, source, sampler, deposits, referrals, jackpot, queue, log }) {
  const { publicClient, addresses, abis, read } = chain;
  const d = config.deployment;
  const erc20 = (address, functionName, args) => publicClient.readContract({ address, abi: erc20Abi, functionName, args });
  const startedAt = Date.now();

  // ---------------------------------------------------------------------------------------
  // Usernames: display names for the leaderboard. Off-chain, first come first served.
  // ---------------------------------------------------------------------------------------

  const dataDir = config.dataDir ?? join(config.root, "relayer", "data");
  const namesFile = join(dataDir, `names-${config.chainId}.json`);
  const support = config.supportAdmins?.length ? createSupport({
    dir: config.supportDataDir ?? join(dataDir, "support"),
    admins: config.supportAdmins,
    verifyMessage: args => publicClient.verifyMessage(args),
    log,
  }).catch(error => { log.error("support: inbox unavailable", error); return null; }) : Promise.resolve(null);
  /** address (lower) -> name */
  const names = new Map();
  /** name -> address (lower) */
  const taken = new Map();
  try {
    if (existsSync(namesFile)) {
      for (const [address, name] of Object.entries(JSON.parse(readFileSync(namesFile, "utf8")))) {
        names.set(address, name);
        taken.set(name, address);
      }
    }
  } catch (error) {
    log.warn(`usernames: could not read ${namesFile}: ${error.message}`);
  }

  const referralCodes = createReferralCodes({ config, chain, log, addressOfName: name => taken.get(name) });

  function checkNameHolder(name, owner) {
    const holder = taken.get(name) ?? referralCodes.addressOf(name);
    if (holder && holder !== owner) throw new Rejected("That username is taken.", 409);
  }

  async function claimUsername(body) {
    const { owner, signature } = body ?? {};
    const name = typeof body?.name === "string" ? body.name.toLowerCase() : "";
    if (!isAddr(owner) || !isHex(signature)) throw new Rejected("Malformed request.");
    if (!NAME_RULE.test(name)) throw new Rejected("Use 3 to 16 letters, numbers or underscores.");
    const key = lower(owner);
    checkNameHolder(name, key);
    // Works for contract wallets too.
    const valid = await publicClient.verifyMessage({ address: getAddress(owner), message: usernameMessage(name, owner), signature }).catch(() => false);
    if (!valid) throw new Rejected("That signature does not match. Try again.", 401);
    checkNameHolder(name, key);
    const previous = names.get(key);
    if (previous) taken.delete(previous);
    names.set(key, name);
    taken.set(name, key);
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(namesFile, JSON.stringify(Object.fromEntries(names)));
    } catch (error) {
      log.warn(`usernames: could not save: ${error.message}`);
    }
    return { ok: true, name };
  }

  // ---------------------------------------------------------------------------------------
  // Referrals (relayer/src/referrals.mjs keeps the books; this is the door to them)
  // ---------------------------------------------------------------------------------------

  async function bindReferral(body) {
    try {
      return await referrals.bind(body ?? {});
    } catch (error) {
      if (error instanceof ReferralRefused) throw new Rejected(error.message, error.status);
      throw error;
    }
  }

  function referralPayload(owner) {
    const mine = referrals.payload(owner);
    return {
      ...mine,
      code: referralCodes.codeOf(owner) ?? names.get(lower(owner)) ?? getAddress(owner),
      customCode: referralCodes.codeOf(owner),
      names: namesOf([...mine.referred.map((r) => r.address), ...(mine.referrer ? [mine.referrer] : [])]),
    };
  }

  /** The display names of whichever of `addresses` have one. */
  function namesOf(list) {
    const out = {};
    for (const address of list) {
      const name = names.get(lower(address));
      if (name) out[lower(address)] = name;
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // Payloads
  // ---------------------------------------------------------------------------------------

  function configPayload() {
    return {
      name: d.name,
      chainId: config.chainId,
      time: Date.now(),
      priceSource: source.name,
      ...(d.previousExchange ? { previousExchange: d.previousExchange } : {}),
      ...(d.previousExchanges ? { previousExchanges: d.previousExchanges } : {}),
      ...(config.recoveryState ? { recovery: config.recoveryState } : {}),
      addresses,
      usdcPermit: { name: d.usdcPermitName ?? "USD Coin", version: d.usdcPermitVersion ?? "2" },
      timing: {
        execDelay: config.executionMode === "order-bound" ? 0 : EXEC_DELAY,
        pinWindow: PIN_WINDOW,
        intentTtl: INTENT_TTL,
        directDelay: DIRECT_DELAY,
        withdrawDelay: WITHDRAW_DELAY,
        grace: GRACE,
        requestExpiry: REQUEST_EXPIRY,
      },
      markets: store.markets.map((m) => ({ ...m, price: book.latest(m.id)?.price ?? null, ref24h: sampler.reference(m.id) })),
      minMargin: store.house?.minMargin ?? 0n,
      minNotional: store.house?.minNotional ?? 0n,
      opensPaused: config.readOnlyOpens || config.recoveryState?.paused || (store.house?.opensPaused ?? false),
      coin: addresses.coin ? { address: addresses.coin, staking: addresses.staking, lossMining: addresses.lossMining, symbol: d.coinSymbol ?? "COIN" } : null,
      tape: store.tape.slice(0, 40),
    };
  }

  const byPnl = (x, y) => (y.pnl > x.pnl ? 1 : y.pnl < x.pnl ? -1 : 0);

  function accountsBoard(since) {
    const byAccount = new Map();
    for (const t of store.trades) {
      if (t.time < since) continue;
      const row = byAccount.get(lower(t.owner)) ?? { address: t.owner, pnl: 0n, volume: 0n, trades: 0, wins: 0, busts: 0 };
      row.pnl += t.pnl;
      if (t.margin !== null) row.volume += t.margin * BigInt(t.leverage);
      row.trades += 1;
      if (t.pnl > 0n) row.wins += 1;
      if (t.busted) row.busts += 1;
      byAccount.set(lower(t.owner), row);
    }
    return [...byAccount.values()].sort(byPnl);
  }

  /** Where this account stands in each window, for the ones where it makes the top ten. */
  function badgesOf(owner) {
    const out = [];
    for (const [window, span] of Object.entries(WINDOWS)) {
      const since = span === Infinity ? 0 : nowSeconds() - span;
      const rank = accountsBoard(since).findIndex((row) => lower(row.address) === lower(owner) && row.pnl > 0n);
      if (rank >= 0 && rank < 10) out.push({ window, rank: rank + 1 });
    }
    return out;
  }

  async function accountPayload(address) {
    const owner = getAddress(address);
    const st = (functionName, args) => publicClient.readContract({ address: addresses.staking, abi: abis.staking, functionName, args });
    const coinReads = addresses.coin
      ? [erc20(addresses.coin, "balanceOf", [owner]), st("staked", [owner]), st("pendingReward", [owner]), erc20(addresses.coin, "allowance", [owner, addresses.staking])]
      : [];
    const [account, ahead, usdcWallet, usdcNonce, eth, ...coin] = await Promise.all([
      readAccountSnapshot(chain, owner),
      read("lens", "queueAhead", [owner, 300n]),
      erc20(addresses.usdc, "balanceOf", [owner]),
      publicClient.readContract({ address: addresses.usdc, abi: NONCES_ABI, functionName: "nonces", args: [owner] }),
      publicClient.getBalance({ address: owner }),
      ...coinReads,
    ]);
    const stats = store.users.get(lower(owner));
    return {
      address: owner,
      name: names.get(lower(owner)) ?? null,
      blockNumber: account.blockNumber,
      balance: account.balance,
      queued: account.queued,
      queueAhead: ahead[1] ? ahead[0] : null,
      claims: liveClaims(store).filter((c) => lower(c.user) === lower(owner)),
      reserved: engine.reservedOf(owner),
      marginInUse: account.marginInUse,
      sessionNonce: account.sessionNonce,
      withdrawNonce: account.withdrawNonce,
      withdrawRequest:
        account.withdrawRequestedAt === 0n
          ? null
          : { amount: account.withdrawAmount, requestedAt: account.withdrawRequestedAt, executableAt: account.withdrawRequestedAt + BigInt(WITHDRAW_DELAY) },
      positions: [...store.positions.values()].filter((p) => lower(p.owner) === lower(owner)).map((p) => ({ ...p, ...engine.triggersOf(p.id) })),
      intents: engine.intentsOf(owner),
      wallet: { usdc: usdcWallet, usdcNonce, eth },
      coin: addresses.coin
        ? { wallet: coin[0], staked: coin[1], pending: coin[2] + (await streamedSinceTheLastBlock(coin[1])), stakingAllowance: coin[3], claimed: stats?.rewards ?? 0n }
        : null,
      // Who referred this wallet, if anybody: the site asks once and then stops asking.
      referrer: referrals.referrerOf(owner),
      stats: stats ? { ...stats } : { address: owner, volume: 0n, pnl: 0n, trades: 0, wins: 0, busts: 0, mined: 0n, rewards: 0n },
      badges: badgesOf(owner),
    };
  }

  function historyPayload(address, limit) {
    const owner = lower(address);
    const trades = [];
    for (let i = store.trades.length - 1; i >= 0 && trades.length < limit; i--) {
      if (lower(store.trades[i].owner) === owner) trades.push(store.trades[i]);
    }
    const ledger = store.ledgers.get(owner);
    return {
      trades,
      transfers: ledger?.transfers.slice(0, limit) ?? [],
      staking: ledger?.staking.slice(0, limit) ?? [],
      queue: ledger?.queue.slice(0, limit) ?? [],
      emissions: ledger?.emissions.slice(0, limit) ?? [],
    };
  }

  /** A weekly season: the current one, or season `n`, with the last few winners. */
  function seasonPayload(n) {
    const now = nowSeconds();
    const first = store.trades.length ? store.trades[0].time : now;
    const current = weekOf(now);
    const firstStart = weekOf(first);
    let start = current;
    if (n !== null && Number.isInteger(n) && n >= 1) start = Math.min(current, firstStart + (n - 1) * WEEK);
    const shown = season(store.trades, start, config.seasonPrizeBps);
    const rows = shown.rows.slice(0, 100);
    const past = [];
    for (let s = start - WEEK; s >= firstStart && past.length < 6; s -= WEEK) {
      const old = season(store.trades, s, config.seasonPrizeBps);
      past.push({ number: seasonNumber(s, first), start: s, pool: old.pool, winners: old.rows.filter((r) => r.prize > 0n).slice(0, 3) });
    }
    return {
      number: seasonNumber(start, first),
      start,
      end: shown.end,
      now,
      live: start === current,
      fees: shown.fees,
      pool: shown.pool,
      prizeBps: shown.prizeBps,
      minTrades: MIN_TRADES,
      split: PRIZE_SPLIT_BPS,
      rows,
      past,
      names: namesOf([...rows.map((r) => r.address), ...past.flatMap((p) => p.winners.map((w) => w.address))]),
    };
  }

  function leaderboardPayload(window) {
    // Own keys only: "constructor" and "__proto__" are not windows.
    if (!Object.hasOwn(WINDOWS, window)) window = "24h";
    const span = WINDOWS[window];
    const since = span === Infinity ? 0 : nowSeconds() - span;
    const positions = store.trades
      .filter((t) => t.time >= since && t.pnl > 0n)
      .sort(byPnl)
      .slice(0, 100);
    const accounts = accountsBoard(since).slice(0, 100);
    return {
      window,
      positions,
      accounts,
      names: namesOf([...positions.map((t) => t.owner), ...accounts.map((row) => row.address)]),
    };
  }

  async function housePayload() {
    const [front] = await Promise.all([read("lens", "queueFront", [25n, 300n]), indexer.freshHouse()]);
    const day = nowSeconds() - 86_400;
    let volume24h = 0n;
    let trades24h = 0;
    const volume24hByMarket = store.markets.map(() => 0n);
    for (let i = store.trades.length - 1; i >= 0 && store.trades[i].time >= day; i--) {
      const t = store.trades[i];
      if (t.margin !== null) {
        const notional = t.margin * BigInt(t.leverage);
        volume24h += notional;
        volume24hByMarket[t.market] = (volume24hByMarket[t.market] ?? 0n) + notional;
      }
      trades24h += 1;
    }
    const claims = liveClaims(store);
    let largest = 0n;
    for (const claim of claims) if (claim.amount > largest) largest = claim.amount;
    const open = [];
    let openMargin = 0n;
    for (const p of store.positions.values()) {
      if (p.status !== "open") continue;
      openMargin += p.margin;
      // Enough for the site to draw the house's exposure, without naming anybody.
      if (open.length < MAX_HOUSE_POSITIONS) open.push({ m: p.market, l: p.isLong, g: p.margin, x: p.leverage, e: p.entryPrice, b: p.bust, i: p.impactNotional });
    }
    return {
      house: store.house,
      queue: front.map((c) => ({ id: c.id, user: c.user, amount: c.amount })),
      queueStats: { entries: claims.length, largest, front: claims[0]?.amount ?? 0n },
      markets: store.markets,
      totals: { ...store.totals, traders: store.users.size, openPositions: store.positions.size, openMargin, volume24h, volume24hByMarket, trades24h },
      feed: store.feed.slice(0, 30),
      positions: open,
    };
  }

  /**
   * What the staking stream has added to a stake of `staked` since the latest block. The contract
   * answers as of that block, and the stream pays by the second: on Ethereum the figure would move
   * in twelve-second steps, and on a quiet local chain not at all. A claim lands in a later block
   * still, so it pays at least this much.
   *
   * Call it AFTER reading what the contract says is pending. The block it counts from is read
   * here and now, never remembered: counted from an older block than the pending figure was read
   * at, the seconds in between would be counted twice, and the page would show more than a claim
   * pays. A newer block only leaves a moment out, which errs the safe way.
   */
  async function streamedSinceTheLastBlock(staked) {
    if (!addresses.staking || staked === 0n) return 0n;
    // The stream's terms change only when it is paid or someone stakes: those can be shared for a moment.
    const stream = await share("stream", 2_000, async () => {
      const st = (functionName) => publicClient.readContract({ address: addresses.staking, abi: abis.staking, functionName });
      const [rate, finish, total] = await Promise.all([st("rewardRate"), st("periodFinish"), st("totalStaked")]);
      return { rate, finish: Number(finish), total };
    });
    const at = Number((await publicClient.getBlock()).timestamp);
    const until = Math.min(nowSeconds(), stream.finish);
    if (stream.total === 0n || until <= at) return 0n;
    return (staked * stream.rate * BigInt(until - at)) / (10n ** 18n * stream.total);
  }

  async function coinPayload() {
    if (!addresses.coin) return { attached: false };
    await indexer.freshHouse();
    const lm = (functionName, args = []) => publicClient.readContract({ address: addresses.lossMining, abi: abis.lossMining, functionName, args });
    const st = (functionName, args = []) => publicClient.readContract({ address: addresses.staking, abi: abis.staking, functionName, args });
    const [reserve, cumulativeLossUsd, scaleUsd, perDollar, mined, totalStaked, rewardRate, periodFinish, unstreamed, waiting, totalReceived, totalClaimed, supply, symbol, name] =
      await Promise.all([
        lm("reserve"),
        lm("cumulativeLossUsd"),
        lm("scaleUsd"),
        lm("quote", [1_000_000n]),
        lm("totalMined"),
        st("totalStaked"),
        st("rewardRate"),
        st("periodFinish"),
        st("unstreamed"),
        st("waiting"),
        st("totalReceived"),
        st("totalClaimed"),
        erc20(addresses.coin, "totalSupply"),
        erc20(addresses.coin, "symbol"),
        erc20(addresses.coin, "name"),
      ]);
    const house = store.house;
    return {
      attached: true,
      address: addresses.coin,
      staking: addresses.staking,
      lossMining: addresses.lossMining,
      name,
      symbol,
      supply,
      mining: { reserve, cumulativeLossUsd, scaleUsd, perDollar, mined },
      stakingState: {
        totalStaked,
        // The stream: USDC per second scaled by 1e18, when it ends, and what it has left to pay.
        streamRate: nowSeconds() < Number(periodFinish) ? rewardRate : 0n,
        streamEnds: Number(periodFinish),
        unstreamed,
        waiting,
        totalReceived,
        totalClaimed,
        lastDistributionAt: store.coin.lastPaymentAt,
        lastDistributionAmount: store.coin.lastPaymentAmount,
      },
      // Still inside the exchange, on its way to stakers: accrued fees, and house cash above the
      // cap that the open positions leave spare at current prices.
      pendingFees: (house?.stakerFees ?? 0n) + (sweepable(house, store.markets, (m) => book.latest(m.id)?.price ?? null) ?? 0n),
      // Stakers' share of settled PnL right now: nothing while winners are queued, half the 2% fee
      // normally, and everything but the dev's 1% once the house is over its cap.
      rewardRate: house?.totalQueued > 0n ? 0 : house?.excess > 0n ? 99 : 1,
      events: store.coin.events.slice(0, 25),
      daily: [...store.coin.daily].slice(-30).map(([t, amount]) => ({ t, amount })),
    };
  }

  let balances = { at: 0, oracle: 0n, operator: 0n };
  /** The last few blocks, newest last: how full each was and what gas cost. */
  let blocks = [];

  async function recentBlocks() {
    const head = await publicClient.getBlockNumber();
    if (blocks.length && blocks[blocks.length - 1].number === head) return blocks;
    const known = new Map(blocks.map((b) => [b.number, b]));
    const wanted = [];
    for (let n = head; n > head - 6n && n >= 0n; n--) wanted.unshift(n);
    blocks = await Promise.all(
      wanted.map(async (number) => {
        if (known.has(number)) return known.get(number);
        const block = await publicClient.getBlock({ blockNumber: number });
        return { number, time: Number(block.timestamp), gasUsed: block.gasUsed, gasLimit: block.gasLimit, baseFee: block.baseFeePerGas ?? 0n, txs: block.transactions.length };
      }),
    );
    return blocks;
  }

  async function statusPayload() {
    if (Date.now() - balances.at > 30_000) {
      const [oracle, operator] = await Promise.all([
        // Only a Pyth oracle keeps a float, for Pyth's fees.
        config.oracleKind === "signed" ? 0n : publicClient.getBalance({ address: addresses.oracle }),
        publicClient.getBalance({ address: chain.account.address }),
      ]);
      balances = { at: Date.now(), oracle, operator };
    }
    return {
      ok: true,
      time: Date.now(),
      startedAt,
      chainId: config.chainId,
      block: store.block,
      source: source.name,
      opensPaused: store.house?.opensPaused ?? false,
      feeds: store.markets.map((m) => {
        const last = book.latest(m.id);
        return { market: m.id, symbol: m.symbol, retired: Boolean(m.retired), time: last?.time ?? null, price: last?.price ?? null };
      }),
      operator: chain.account.address,
      operatorEth: balances.operator,
      // Every operator wallet: the main one and its backups, which one is sending, and its ETH.
      gasWallets: typeof queue?.gasReport === "function" ? await queue.gasReport() : null,
      cashLimit: engine.cashRoom() === Infinity ? null : engine.cashRoom(),
      oracleKind: config.oracleKind,
      priceSigner: d.priceSigner ?? null,
      // Per feed: whether a price is being signed, and why not if none is.
      priceHealth: typeof source.health === "function" ? source.health() : null,
      oracleFloat: config.oracleKind === "signed" ? null : balances.oracle,
      streams: hub.size,
      openPositions: store.positions.size,
      queue: liveClaims(store)
        .slice(0, 10)
        .map(({ id, user, amount, time }) => ({ id, user, amount, time })),
      blocks: await recentBlocks().catch(() => []),
    };
  }

  // ---------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------

  const posted = new Map();
  const streams = new Map();
  /** How far each market's simulated price has been nudged from the real one, as a factor. */
  const nudged = new Map();

  /**
   * The caller's address. Behind reverse proxies (TRUST_PROXY=n, for n of them) it is read from
   * X-Forwarded-For, counting from the right: each proxy appends the address it saw, so only the
   * last n entries are ours. Everything before them is whatever the sender chose to write. Taking
   * the first entry, as this did, let one sender dodge the limits with a made-up address on each
   * request, and use up anybody else's allowance by writing theirs.
   */
  function clientOf(req) {
    const hops = config.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",").map((hop) => hop.trim()).filter(Boolean) : [];
    return hops[hops.length - Number(config.trustProxy)] ?? req.socket.remoteAddress ?? "unknown";
  }

  const got = new Map();
  /** Reads are counted per caller in one-minute windows: cheap to keep, and enough to stop a flood. */
  function limitGets(client) {
    const now = Date.now();
    let window = got.get(client);
    if (!window || now - window.since >= 60_000) {
      window = { since: now, count: 0 };
      got.set(client, window);
      if (got.size > 50_000) got.clear();
    }
    if (++window.count > config.readLimit) throw new Rejected("Too many requests.", 429);
  }

  const shared = new Map();
  /**
   * One answer for everybody who asks within `ms`, and one computation for everybody who asks
   * while it is being worked out. With `ms` of zero only the second part applies.
   */
  function share(key, ms, produce) {
    const held = shared.get(key);
    if (held && (held.pending || Date.now() - held.at < ms)) return held.value;
    const entry = { at: Date.now(), pending: true, value: null };
    entry.value = Promise.resolve()
      .then(produce)
      .finally(() => {
        entry.pending = false;
        entry.at = Date.now();
        // Nothing is kept for answers that are not reused, or that failed.
        if (ms === 0) shared.delete(key);
      });
    entry.value.catch(() => shared.delete(key));
    shared.set(key, entry);
    if (shared.size > 20_000) shared.clear();
    return entry.value;
  }

  function limitPosts(client) {
    const cutoff = Date.now() - 60_000;
    const recent = (posted.get(client) ?? []).filter((t) => t > cutoff);
    if (recent.length >= POSTS_PER_MINUTE) throw new Rejected("Too many requests.", 429);
    recent.push(Date.now());
    posted.set(client, recent);
    if (posted.size > 50_000) posted.clear();
  }

  const cors = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
  };

  function send(res, status, body) {
    const text = toJson(body);
    res.writeHead(status, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
    res.end(text);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size <= MAX_BODY) chunks.push(chunk);
        else {
          // Keep none of it. Cutting the connection here meant the 413 was never seen: the
          // sender got a reset instead. So let it finish, within reason, and answer then.
          chunks.length = 0;
          if (size > MAX_DISCARD) req.destroy();
        }
      });
      req.on("end", () => {
        if (size > MAX_BODY) return reject(new Rejected("Request too large.", 413));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch {
          reject(new Rejected("Body is not valid JSON."));
        }
      });
      // A sender that goes away mid-request is its own problem, not an error of ours to log.
      const cut = () => reject(new Rejected("The request was cut short."));
      req.on("error", cut);
      req.on("close", cut);
    });
  }

  function stream(req, res, url) {
    const client = clientOf(req);
    const held = streams.get(client) ?? 0;
    if (held >= STREAMS_PER_CLIENT || hub.size >= MAX_STREAMS) throw new Rejected("Too many open connections.", 429);
    streams.set(client, held + 1);
    req.on("close", () => {
      const left = (streams.get(client) ?? 1) - 1;
      if (left > 0) streams.set(client, left);
      else streams.delete(client);
    });

    const owner = url.searchParams.get("owner");
    const topics = ["tick", "public", "house"];
    if (owner && isAddress(owner)) topics.push(acct(owner));
    res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const write = (type, payload) => res.write(`event: ${type}\ndata: ${payload}\n\n`);
    write("hello", toJson({ time: Date.now() }));
    for (const m of store.markets) {
      const last = book.latest(m.id);
      if (last) write("tick", toJson({ m: m.id, t: last.time, p: last.price }));
    }
    const unsubscribe = hub.subscribe(topics, write);
    const beat = setInterval(() => res.write(`: ${Date.now()}\n\n`), 15_000);
    req.on("close", () => {
      clearInterval(beat);
      unsubscribe();
    });
  }

  const posts = {
    "/open": engine.open,
    "/close": engine.close,
    "/trigger": engine.setTrigger,
    "/trigger/cancel": engine.cancelTrigger,
    "/session": engine.session,
    "/deposit": engine.deposit,
    "/withdraw": engine.withdraw,
    "/username": claimUsername,
    "/referral": bindReferral,
    "/referral-code": referralCodes.claim,
  };

  async function route(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://relayer");
    } catch {
      // "//", "/\", "http://": request targets that are not a URL at all.
      throw new Rejected("Not found.", 404);
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }

    if (req.method === "POST") limitPosts(clientOf(req));

    if (path.startsWith("/support/")) {
      const inbox = await support;
      if (!inbox) throw new Rejected("Support is temporarily unavailable. Please try again shortly.", 503);
      return inbox.handle({ req, res, path, url, client: clientOf(req), send,
        body: req.method === "POST" ? await readBody(req) : undefined });
    }

    // Test hook: only the unsigned dev price source has it, and that only runs on a local chain.
    if (req.method === "POST" && path === "/dev/nudge") {
      if (typeof source.nudge !== "function") throw new Rejected("Not found.", 404);
      const body = (await readBody(req)) ?? {};
      // Numbers, or numbers written as strings. Anything else (null, an object) is not a move.
      const number = (value) => (typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : NaN);
      const market = number(body.market);
      const bps = number(body.bps);
      if (!Number.isFinite(bps) || Math.abs(bps) > 500) throw new Rejected("bps must be within 500.");
      // Nudges add up. Left unbounded, three hundred of them push the simulated price past what
      // the oracle's integer holds, the price timer throws, and the process ends. So the price
      // stays within a factor of two of the real one; bps 0 puts it back.
      const moved = bps === 0 ? 1 : (nudged.get(market) ?? 1) * (1 + bps / 10_000);
      if (moved > 2 || moved < 0.5) throw new Rejected("That is further than the simulated price may move. Send bps 0 to reset it.");
      const ok = source.nudge(market, bps);
      if (ok) nudged.set(market, moved);
      return send(res, 200, { ok });
    }

    if (req.method === "POST") {
      const handler = posts[path];
      if (!handler) throw new Rejected("Not found.", 404);
      if (config.recoveryState?.paused && ["/open", "/close", "/trigger", "/trigger/cancel", "/session", "/deposit", "/withdraw"].includes(path)) {
        throw new Rejected("Emergency recovery is active. Withdraw available USDC directly from your wallet.", 409);
      }
      return send(res, 200, await handler(await readBody(req)));
    }
    if (req.method !== "GET") throw new Rejected("Method not allowed.", 405);

    // Monitoring asks this one, often, and it costs nothing.
    if (path === "/health") return send(res, 200, { ok: true, block: store.block, source: source.name, time: Date.now() });
    limitGets(clientOf(req));
    if (path === "/config") return send(res, 200, configPayload());
    if (path === "/stream") return stream(req, res, url);
    if (path === "/house") return send(res, 200, await share(path, SHARED_FOR_MS[path], housePayload));
    if (path === "/coin") return send(res, 200, await share(path, SHARED_FOR_MS[path], coinPayload));
    if (path === "/status") return send(res, 200, await share(path, SHARED_FOR_MS[path], statusPayload));
    if (path === "/series") {
      const seconds = Math.min(Math.max(Number(url.searchParams.get("seconds") ?? 86_400) || 86_400, 600), 86_400);
      return send(res, 200, { points: sampler.recent(seconds) });
    }
    if (path === "/leaderboard") return send(res, 200, leaderboardPayload(url.searchParams.get("window") ?? "24h"));
    if (path === "/season") return send(res, 200, seasonPayload(url.searchParams.has("n") ? Number(url.searchParams.get("n")) : null));
    if (path === "/jackpot") {
      const owner = url.searchParams.get("owner");
      return send(res, 200, (await jackpot?.payload(owner && isAddr(owner) ? owner : null)) ?? { address: null });
    }
    // The signed update an order pinned at `time` fills at (or the latest, with no time): what
    // anyone needs to execute a direct close or a liquidation themselves, without the operator.
    if (path === "/print") {
      const market = Number(url.searchParams.get("market") ?? 0);
      const time = Number(url.searchParams.get("time") ?? 0);
      const print = Number.isInteger(time) && time > 0 ? book.firstAt(market, time) : book.latest(market);
      if (!print) throw new Rejected("No such print.", 404);
      return send(res, 200, { market, time: print.time, prev: print.prev, price: print.price, conf: print.conf, update: print.blob });
    }
    if (path === "/prices") {
      const market = Number(url.searchParams.get("market") ?? 0);
      const seconds = Math.min(Number(url.searchParams.get("seconds") ?? 900), 1800);
      return send(res, 200, { market, points: book.history(market, seconds) });
    }

    const [, section, arg] = path.split("/");
    // An account is never served stale: a trader looks at it right after acting. Identical
    // requests that arrive together still share the one set of chain reads.
    if (section === "account" && isAddress(arg ?? "")) return send(res, 200, await share(`account:${lower(arg)}`, 0, () => accountPayload(arg)));
    // One account's referrals, and (for the payout tool) every referrer with something earned.
    if (section === "referrals" && isAddress(arg ?? "")) return send(res, 200, referralPayload(getAddress(arg)));
    if (path === "/referrals") return send(res, 200, { payer: referrals.payer, shareOfFeeBps: Number(referrals.shareBps / 2n), lookedTo: referrals.lookedTo(), referrers: referrals.all() });
    // The wallet's own deposit address, and what is waiting there. Asking also has the relayer
    // watch the address for a while and collect what arrives.
    if (section === "deposit-address" && isAddress(arg ?? "")) {
      if (!deposits?.enabled) throw new Rejected("Deposit addresses are not available on this deployment.", 404);
      return send(res, 200, await share(`deposit-address:${lower(arg)}`, 1_500, () => deposits.lookUp(getAddress(arg))));
    }
    if (section === "history" && isAddress(arg ?? "")) {
      return send(res, 200, historyPayload(arg, Math.min(Number(url.searchParams.get("limit") ?? 100), 500)));
    }
    if (section === "intent" && arg) {
      const found = engine.intent(arg);
      if (!found) throw new Rejected("Unknown intent.", 404);
      return send(res, 200, found);
    }
    throw new Rejected("Not found.", 404);
  }

  const server = createServer((req, res) => {
    for (const [name, value] of Object.entries(corsFor(config.corsOrigin, req.headers.origin))) res.setHeader(name, value);
    route(req, res).catch((error) => {
      if (res.headersSent) return res.end();
      if (error instanceof Rejected) return send(res, error.status, { error: error.message });
      log.error(`${req.method} ${req.url}`, error);
      send(res, 500, { error: "Something went wrong on our side." });
    });
  });

  // Ticks are the one high-rate topic: publish each print as it arrives.
  book.onTick((marketId, print) => hub.publish("tick", "tick", { m: marketId, t: print.time, p: print.price }));

  let checkingRecovery = false;
  const recoveryTimer = d.upgradeController ? setInterval(async () => {
    if (checkingRecovery) return;
    checkingRecovery = true;
    try {
      const previous = config.recoveryState;
      const current = await refreshRecovery({ config, chain });
      if (current && (previous?.paused !== current.paused || previous?.available !== current.available || previous?.custodyVault !== current.custodyVault)) {
        hub.publish("public", "recovery", current);
      }
    } finally { checkingRecovery = false; }
  }, 2500) : null;
  recoveryTimer?.unref?.();

  return {
    /** A custom code or username's wallet, lower case. */
    addressOfName: (name) => referralCodes.addressOf(name) ?? taken.get(name),
    /** A wallet's username, if it has one. */
    nameOf: (address) => names.get(lower(address)) ?? null,
    listen: () =>
      new Promise((resolve) => {
        // HOST unset: every interface, for a server behind its proxy. 127.0.0.1: this machine only.
        server.listen(config.port, config.host, () => {
          log.info(`api: listening on ${config.host ?? ""}:${config.port}`);
          resolve(server.address());
        });
      }),
    // Every visitor holds an event stream open, and close() alone waits for all of them to leave.
    close: () =>
      new Promise((resolve) => {
        if (recoveryTimer) clearInterval(recoveryTimer);
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
}
