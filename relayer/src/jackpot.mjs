/**
 * The Rekt Jackpot's keeper and its page.
 *
 * Every half minute it looks at the rounds that are over: one with tickets and no draw yet is
 * closed (which names the block whose hash will draw it), and drawn once that block exists.
 * Both calls are open to anyone on-chain; running them here means nobody waits. A draw it sees
 * is announced on the stream and handed to the feed.
 *
 *   GET /jackpot?owner=0x...    this round's pot, tickets and clock, this wallet's share, recent winners
 */
import { getAbiItem } from "viem";
import { lower, nowSeconds } from "./util.mjs";

const HISTORY = 12;
const MAX_STEPS = 8;

export function createJackpot({ chain, queue, hub, log, onDraw = () => {}, nameOf = () => null }) {
  const { addresses, read, publicClient, abis } = chain;
  if (!addresses.jackpot) return { start() {}, payload: async () => null };

  let start = null;
  let length = null;
  let payoutBps = null;
  const winners = [];
  let tending = false;
  const mine = new Map();
  let timer = null;

  async function setup() {
    if (start !== null) return;
    [start, length, payoutBps] = (await Promise.all([read("jackpot", "start"), read("jackpot", "roundLength"), read("jackpot", "payoutBps")])).map(Number);
    // The last few draws, from the chain, so the page has winners from the first moment.
    try {
      const logs = await publicClient.getContractEvents({ address: addresses.jackpot, abi: abis.jackpot, eventName: "Drawn", fromBlock: 0n });
      for (const l of logs.filter(l => l.args.tickets > 0n).slice(-HISTORY)) winners.unshift(drawOf(l.args));
    } catch (error) {
      log.warn(`jackpot: past draws not read (${error.shortMessage ?? error.message})`);
    }
  }

  const drawOf = (args) => ({ round: Number(args.round), winner: args.winner, prize: args.prize, tickets: args.tickets, time: start + (Number(args.round) + 1) * length });
  const roundAt = (time) => (time < start ? 0 : Math.floor((time - start) / length));

  async function tend() {
    if (tending) return;
    tending = true;
    try {
      await setup();
      // The chain's clock, which is the one the contract judges a round's end by.
      const latest = await publicClient.getBlock();
      const current = roundAt(Number(latest.timestamp));
      const block = latest.number;
      // Follow the on-chain settlement cursor, including empty rounds and outages over 48 hours.
      // Never let newer rounds bypass an older reservation or leave a rollover stranded.
      for (let step = 0; step < MAX_STEPS; step++) {
        const round = Number(await read("jackpot", "nextRound"));
        if (round >= current) break;
        const [drawBlock, drawn] = await read("jackpot", "rounds", [BigInt(round)]);
        if (drawn) break;
        const tickets = await read("jackpot", "tickets", [BigInt(round)]);
        if (drawBlock === 0n || block > drawBlock + 256n) {
          const result = await queue.push({ contract: "jackpot", label: `jackpot close ${round}`, functionName: "close", args: [BigInt(round)] });
          if (!result.ok) {
            log.warn(`jackpot: closing round ${round}: ${result.reason}`);
            break;
          }
          if (tickets !== 0n) break; // Its future draw block has not been mined yet.
        } else if (block > drawBlock) {
          const result = await queue.push({ contract: "jackpot", label: `jackpot draw ${round}`, functionName: "draw", args: [BigInt(round)] });
          if (!result.ok) {
            log.warn(`jackpot: drawing round ${round}: ${result.reason}`);
            break;
          }
          const [, , winner, prize] = await read("jackpot", "rounds", [BigInt(round)]);
          const draw = drawOf({ round, winner, prize, tickets });
          winners.unshift(draw);
          winners.splice(HISTORY);
          log.info(`jackpot: round ${round} won by ${winner}: ${Number(prize) / 1e6} USDC`);
          hub.publish("public", "jackpot", draw);
          onDraw(draw);
        } else break;
      }
    } catch (error) {
      log.warn(`jackpot: ${error.shortMessage ?? error.message}`);
    } finally {
      tending = false;
    }
  }

  /** This wallet's tickets in a round, from its entries: kept for a few seconds. */
  async function ticketsOf(owner, round) {
    const key = `${lower(owner)}:${round}`;
    const cached = mine.get(key);
    if (cached && Date.now() - cached.at < 5_000) return cached.usd;
    const event = getAbiItem({ abi: abis.jackpot, name: "Entered" });
    const logs = await publicClient.getLogs({ address: addresses.jackpot, event, args: { round: BigInt(round), user: owner }, fromBlock: "earliest" });
    const usd = logs.reduce((sum, l) => sum + l.args.usd, 0n);
    mine.set(key, { usd, at: Date.now() });
    return usd;
  }

  async function payload(owner) {
    await setup();
    const now = nowSeconds();
    const round = roundAt(now);
    const [pot, tickets] = await Promise.all([read("jackpot", "pot"), read("jackpot", "tickets", [BigInt(round)])]);
    const yours = owner ? await ticketsOf(owner, round).catch(() => 0n) : 0n;
    return {
      address: addresses.jackpot,
      round,
      start: start + round * length,
      end: start + (round + 1) * length,
      now,
      pot,
      prize: (pot * BigInt(payoutBps)) / 10_000n,
      tickets,
      mine: yours,
      winners,
      names: Object.fromEntries(winners.map((w) => [lower(w.winner), nameOf(w.winner)]).filter(([, n]) => n)),
    };
  }

  return {
    start() {
      if (timer) return;
      const initial = tend();
      timer = setInterval(tend, 30_000);
      return initial;
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    payload,
  };
}
