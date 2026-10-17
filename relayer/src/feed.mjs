/**
 * The feed: big wins and big liquidations, posted to a Telegram channel and to X as they settle.
 *
 * Off unless configured. Telegram needs a bot token (in a file) and the channel; X needs the four
 * keys of an app with write access (in a file, as JSON). FEED_DRY=1 writes the posts to the log
 * instead of sending them, to see what it would say.
 *
 *   FEED_TELEGRAM_TOKEN_FILE   file holding the bot token from @BotFather
 *   FEED_TELEGRAM_CHAT         the channel: @name, or its numeric id (the bot must be an admin)
 *   FEED_X_KEYS_FILE           file holding {"apiKey","apiSecret","accessToken","accessSecret"}
 *   FEED_MIN_WIN_USD           smallest win that is posted, in dollars                    250
 *   FEED_MIN_LIQ_USD           smallest liquidated position (size) that is posted, dollars 250000
 *   FEED_X_PER_DAY             most posts to X in a day (X's free tier allows about 15)  15
 *   FEED_DRY                   1: log the posts, send nothing
 *   FEED_SITE                  the link under each post                                 https://tapemarket.io
 *
 * Only trades that settle after the relayer starts are posted: the replay of history at start is
 * not news.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { nowSeconds } from "./util.mjs";

const usdText = (v, sign = false) => {
  const n = Number(v) / 1e6;
  const body = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign ? (n >= 0 ? "+" : "-") : n < 0 ? "-" : ""}$${body}`;
};
const priceText = (p) => (Number(p) / 1e8).toLocaleString("en-US", Number(p) / 1e8 < 10 ? { maximumFractionDigits: 5 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The words of a post, or null if this trade is not one to post. */
export function postFor(trade, { symbol, name, minWinUsd, minLiqUsd, site }) {
  if (trade.margin === null || trade.leverage === null) return null;
  const margin = BigInt(trade.margin);
  const notional = margin * BigInt(trade.leverage);
  const side = trade.isLong ? "long" : "short";
  const who = name ? `${name}: ` : "";
  if (trade.busted) {
    if (notional < BigInt(minLiqUsd) * 1_000_000n) return null;
    return `Liquidated. ${who}${symbol} ${side} at ${trade.leverage}x, ${usdText(notional)} position, ${usdText(margin)} margin gone at $${priceText(trade.exitPrice)}.\n${site}/trade`;
  }
  const pnl = BigInt(trade.pnl);
  if (pnl < BigInt(minWinUsd) * 1_000_000n) return null;
  const roi = margin > 0n ? (Number(pnl) / Number(margin)) * 100 : 0;
  const roiText = `${roi >= 0 ? "+" : ""}${Math.abs(roi) >= 1000 ? Math.round(roi).toLocaleString("en-US") : roi.toFixed(1)}%`;
  return `${who}${usdText(pnl, true)} (${roiText}) on a ${trade.leverage}x ${symbol} ${side}. In at $${priceText(trade.entryPrice)}, out at $${priceText(trade.exitPrice)}.\n${site}/trade`;
}

const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** An OAuth 1.0a header for X's API, signed with HMAC-SHA1 (user context, no query string). */
export function oauthHeader(method, url, keys, nonce = randomBytes(16).toString("hex"), timestamp = String(nowSeconds())) {
  const params = {
    oauth_consumer_key: keys.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: keys.accessToken,
    oauth_version: "1.0",
  };
  const base = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");
  const signingBase = `${method.toUpperCase()}&${pct(url)}&${pct(base)}`;
  const signature = createHmac("sha1", `${pct(keys.apiSecret)}&${pct(keys.accessSecret)}`).update(signingBase).digest("base64");
  return `OAuth ${Object.entries({ ...params, oauth_signature: signature })
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
    .join(", ")}`;
}

export function createFeed({ config, store, log, nameOf = () => null, fetchImpl = fetch }) {
  const env = process.env;
  const read = (file) => readFileSync(file, "utf8").trim();
  const telegram = env.FEED_TELEGRAM_TOKEN_FILE && env.FEED_TELEGRAM_CHAT ? { token: read(env.FEED_TELEGRAM_TOKEN_FILE), chat: env.FEED_TELEGRAM_CHAT } : null;
  const x = env.FEED_X_KEYS_FILE ? JSON.parse(read(env.FEED_X_KEYS_FILE)) : null;
  const dry = env.FEED_DRY === "1";
  const options = {
    minWinUsd: Number(env.FEED_MIN_WIN_USD ?? 250),
    minLiqUsd: Number(env.FEED_MIN_LIQ_USD ?? 250_000),
    site: (env.FEED_SITE ?? "https://tapemarket.io").replace(/\/$/, ""),
  };
  const xPerDay = Number(env.FEED_X_PER_DAY ?? 15);
  const startedAt = nowSeconds();
  const xSent = [];
  let telegramChain = Promise.resolve();
  const on = Boolean(telegram || x || dry);

  if (on) log.info(`feed: posting wins from ${usdText(options.minWinUsd * 1e6)} and liquidations from ${usdText(options.minLiqUsd * 1e6)} to ${[telegram && "Telegram", x && "X", dry && "the log (dry run)"].filter(Boolean).join(", ")}`);

  async function toTelegram(text) {
    const res = await fetchImpl(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: telegram.chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async function toX(text) {
    const day = Date.now() - 86_400_000;
    while (xSent.length && xSent[0] < day) xSent.shift();
    if (xSent.length >= xPerDay) return log.info("feed: X's daily allowance is used up; skipping a post");
    xSent.push(Date.now());
    const url = "https://api.x.com/2/tweets";
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: oauthHeader("POST", url, x) },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`x ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  function onTrade(trade) {
    if (!on || trade.time < startedAt) return;
    const market = store.markets[trade.market];
    const name = nameOf(trade.owner);
    const text = postFor(trade, { ...options, symbol: market?.symbol ?? "?", name });
    if (!text) return;
    if (dry) return log.info(`feed (dry): ${text.replace(/\n/g, " | ")}`);
    // One Telegram message at a time, in order; Telegram limits a bot to about one a second per chat.
    if (telegram) telegramChain = telegramChain.then(() => toTelegram(text)).catch((error) => log.warn(`feed: ${error.message}`));
    if (x) toX(text).catch((error) => log.warn(`feed: ${error.message}`));
  }

  /** A jackpot draw: who won, and how much. */
  function onJackpot(draw) {
    if (!on || !draw.winner || draw.winner === "0x0000000000000000000000000000000000000000" || BigInt(draw.prize) === 0n) return;
    const who = nameOf(draw.winner) ?? `${draw.winner.slice(0, 6)}…${draw.winner.slice(-4)}`;
    const text = `Rekt Jackpot: ${who} won ${usdText(draw.prize)}. Every dollar lost on Tape is a ticket in the hour's draw.\n${options.site}/jackpot`;
    if (dry) return log.info(`feed (dry): ${text.replace(/\n/g, " | ")}`);
    if (telegram) telegramChain = telegramChain.then(() => toTelegram(text)).catch((error) => log.warn(`feed: ${error.message}`));
    if (x) toX(text).catch((error) => log.warn(`feed: ${error.message}`));
  }

  /** A warning for whoever runs the exchange: to FEED_ALERT_CHAT on Telegram, if it is set. */
  const alertChat = env.FEED_ALERT_CHAT;
  function alert(text) {
    if (!telegram || !alertChat) return;
    fetchImpl(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: alertChat, text: `Tape relayer: ${text}` }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error) => log.warn(`alert: ${error.message}`));
  }

  return { onTrade, onJackpot, alert };
}
