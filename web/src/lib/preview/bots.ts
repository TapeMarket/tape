// The simulated traders of preview mode.
//
// They exist so the preview has a house, a queue, a tape and a leaderboard to look at. They trade
// against the same books as the play account, at the same prices, under the same rules; they just
// do not think very hard. Mostly high leverage, mostly small, exactly the crowd a 1000x venue gets.

import { MARKETS } from "./engine";
import type { Engine } from "./engine";
import type { Address } from "../types";

const USD = 1_000_000n;

// Fixed, obviously made-up accounts.
const NAMES = [
  "degen_prime", "liq_me_daddy", "maxlev", "wick_hunter", "five_bips", "fomo_frank", "longonly", "shorty", "bagholder", "thousandx",
  "rektangle", "ser_bust", "margin_carl", "gm_gn", "stop_hunted", "apelord", "paperhand", "midcurve", "fat_finger", "nine_lives",
  "tick_sniper", "house_money", "send_it", "cope_trader",
];

export const BOTS: { address: Address; name: string }[] = NAMES.map((name, i) => ({
  address: `0x${(0xb075_0000 + i).toString(16).padStart(8, "0")}${"0".repeat(28)}${(i + 1).toString(16).padStart(4, "0")}` as Address,
  name,
}));

const LEVERAGES = [5, 10, 20, 25, 50, 75, 100, 150, 200, 250, 500, 750, 1000];
const LEVERAGE_WEIGHTS = [2, 4, 5, 5, 8, 4, 12, 5, 8, 6, 10, 4, 14];
const WEIGHT_TOTAL = LEVERAGE_WEIGHTS.reduce((a, b) => a + b, 0);

const OPENS_PER_SECOND = 0.22;
const MAX_OPEN = 36;

/** Most of the crowd trades BTC and ETH; the rest is spread over the other markets. */
function pickMarket(): number {
  const roll = Math.random();
  if (roll < 0.4) return 0;
  if (roll < 0.62) return 1;
  return 2 + Math.floor(Math.random() * (MARKETS.length - 2));
}

function pickLeverage(): number {
  let roll = Math.random() * WEIGHT_TOTAL;
  for (let i = 0; i < LEVERAGES.length; i++) {
    roll -= LEVERAGE_WEIGHTS[i];
    if (roll <= 0) return LEVERAGES[i];
  }
  return 100;
}

/** Between $10 and about $6,000, mostly small; one in forty swings big. */
function pickMargin(): bigint {
  const whale = Math.random() < 0.025;
  const dollars = whale ? 2_000 + Math.random() * 8_000 : Math.exp(Math.log(10) + Math.random() * Math.log(600));
  return BigInt(Math.round(dollars * 100)) * (USD / 100n);
}

// The exchange's limits, which the crowd trades under like anyone else.
const MIN_MARGIN = 10n * USD;
const MIN_NOTIONAL = 10_000n * USD;

export function createBots(engine: Engine) {
  let carry = 0;

  function openOne(): void {
    const bot = BOTS[Math.floor(Math.random() * BOTS.length)];
    const market = pickMarket();
    const spec = MARKETS[market];
    const leverage = Math.min(pickLeverage(), spec.maxLeverage);
    let margin = pickMargin();
    // A position is at least $10,000 and at most $10M, on at least $10 of margin.
    const floor = (MIN_NOTIONAL + BigInt(leverage) - 1n) / BigInt(leverage);
    const cap = spec.maxNotional / BigInt(leverage);
    if (margin < floor) margin = floor;
    if (margin < MIN_MARGIN) margin = MIN_MARGIN;
    if (margin > cap) margin = cap;
    if (engine.balanceOf(bot.address) < margin) engine.fund(bot.address, margin * 4n + 500n * USD);
    // High leverage is held for seconds, low leverage for minutes.
    const hold = leverage >= 500 ? 5 + Math.random() * 60 : leverage >= 100 ? 15 + Math.random() * 180 : 60 + Math.random() * 900;
    try {
      engine.open(bot.address, market, Math.random() < 0.53, leverage, margin, Math.random() < 0.3, engine.now() + Math.round(hold));
    } catch {
      // No price yet, or no balance. Next time.
    }
  }

  function manage(): void {
    const now = engine.now();
    let open = 0;
    for (const bot of BOTS) {
      for (const position of engine.positionsOf(bot.address)) {
        open += 1;
        if (position.closeAt !== undefined && now >= position.closeAt) engine.close(position);
      }
    }
    return void open;
  }

  /** What bots do with the coin their losses mined: most of them stake it and collect. */
  function tendCoin(): void {
    const bot = BOTS[Math.floor(Math.random() * BOTS.length)];
    try {
      const held = engine.coinWallet(bot.address);
      if (held > 0n && Math.random() < 0.7) engine.stake(bot.address, held);
      if (engine.pending(bot.address) > 5n * USD && Math.random() < 0.4) engine.claim(bot.address);
    } catch {
      // Nothing to do.
    }
  }

  return {
    /** Advances the crowd by `seconds`. */
    step(seconds: number): void {
      if (seconds <= 0) return;
      manage();
      let open = 0;
      for (const bot of BOTS) open += engine.positionsOf(bot.address).length;
      carry += seconds * OPENS_PER_SECOND;
      while (carry >= 1) {
        carry -= 1;
        if (open < MAX_OPEN) {
          openOne();
          open += 1;
        }
      }
      if (Math.random() < Math.min(1, seconds * 0.15)) tendCoin();
    },
  };
}
