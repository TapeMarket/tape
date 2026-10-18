// Number formatting. Everything on screen goes through here so figures line up and read the same.
import { getLocale } from "./i18n";

const usdFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export type Amount = bigint | string | null | undefined;

const big = (v: Amount): bigint => (v === null || v === undefined || v === "" ? 0n : typeof v === "bigint" ? v : BigInt(v));

/** A 6-decimal USDC amount as a plain number. */
export const usdNumber = (v: Amount): number => Number(big(v)) / 1e6;

/** "$1,204.33" */
export function usd(v: Amount, { sign = false, cents = true }: { sign?: boolean; cents?: boolean } = {}): string {
  const n = usdNumber(v);
  const body = cents ? usdFmt.format(Math.abs(n)) : intFmt.format(Math.abs(n));
  // An amount that rounds to zero carries no sign: "-$0.00" reads like an error.
  const isZero = !/[1-9]/.test(body);
  const prefix = isZero ? "" : n < 0 ? "-" : sign && n > 0 ? "+" : "";
  return `${prefix}$${body}`;
}

/**
 * Money someone can spend, to the cent and never rounded up: showing $4,041.55 for a balance of
 * 4041.548878 invites an order the balance cannot cover.
 */
export function usdDown(v: Amount): string {
  const amount = big(v);
  return usd(amount > 0n ? (amount / 10_000n) * 10_000n : amount);
}

/** "$1.2M", "$48.5K", "$912" */
export function usdCompact(v: Amount): string {
  const n = usdNumber(v);
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  // Past a quadrillion there is nothing to say but "too much": never an exponent on screen.
  if (a >= 1e15) return `${sign}>$999T`;
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${intFmt.format(a)}`;
}

/** An amount that just moved, in full: "$250.00", and "0.000001 USDC" rather than "$0.00". */
export function usdExact(v: Amount): string {
  const amount = big(v);
  if (amount % 10_000n === 0n) return usd(amount);
  const frac = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${intFmt.format(amount / 1_000_000n)}.${frac} USDC`;
}

/**
 * What a money field holds after an edit. Digits and a point are kept, and so is an amount pasted
 * with its "$" and commas ("$1,250.50" is 1250.50). Anything else is no amount: one typed
 * character of it is simply not taken, and a paste is refused whole, so that "1e9" never becomes
 * 19 and "-250" never becomes 250.
 */
export function amountTyped(previous: string, next: string, edit?: { inputType?: string; data?: string | null }): string {
  const clean = next.replace(/[$,\s]/g, "");
  if (/^[\d.]*$/.test(clean)) return clean.slice(0, 40);
  const oneKey = edit?.inputType === "insertText" && (edit.data ?? "").length === 1;
  return oneKey ? previous : "";
}

/** An 8-decimal price: "82,806.25" */
export function price(v: Amount): string {
  const n = Number(big(v)) / 1e8;
  if (n === 0) return "0.00";
  const digits = n >= 100 ? 2 : n >= 1 ? 3 : 5;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const priceNumber = (v: Amount): number => Number(big(v)) / 1e8;

/** An 18-decimal coin amount: "4,016", "1.2M" */
export function coin(v: Amount): string {
  const n = Number(big(v)) / 1e18;
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (a >= 100) return intFmt.format(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function percent(fraction: number, digits = 2, sign = false): string {
  const v = fraction * 100;
  return `${sign && v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** Basis points with one decimal: "4.6 bps" */
export function bps(fraction: number): string {
  return `${(fraction * 10_000).toFixed(1)} bps`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** "12s", "4m", "3h", "2d" */
export function ago(unixSeconds: number, now: number): string {
  const s = Math.max(0, now - unixSeconds);
  const units = timeUnits();
  if (s < 60) return `${s}${units[0]}`;
  if (s < 3600) return `${Math.floor(s / 60)}${units[1]}`;
  if (s < 86400) return `${Math.floor(s / 3600)}${units[2]}`;
  return `${Math.floor(s / 86400)}${units[3]}`;
}
const TIME_UNITS = { en: ["s", "m", "h", "d"], "zh-CN": ["秒", "分", "小时", "天"], ru: ["с", "мин", "ч", "д"], ko: ["초", "분", "시간", "일"], ja: ["秒", "分", "時間", "日"] };
const timeUnits = () => TIME_UNITS[getLocale()];

/** How long something lasted: "8s", "3m 12s", "2h 05m", "3d 4h" */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const units = timeUnits();
  if (s < 60) return `${s}${units[0]}`;
  if (s < 3600) return `${Math.floor(s / 60)}${units[1]} ${String(s % 60).padStart(2, "0")}${units[0]}`;
  if (s < 86400) return `${Math.floor(s / 3600)}${units[2]} ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}${units[1]}`;
  return `${Math.floor(s / 86400)}${units[3]} ${Math.floor((s % 86400) / 3600)}${units[2]}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** "10 Oct 2026 20:06:52", in the reader's own time zone. */
export function dateTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (getLocale() !== "en") return new Intl.DateTimeFormat(getLocale(), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** "20:06" */
export function clock(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** A plain dollar figure, already a number: "$1.2M", "$48.5K", "$912", "-$3.10" */
export function dollars(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  if (a >= 100 || a === 0) return `${sign}$${intFmt.format(a)}`;
  return `${sign}$${a.toFixed(2)}`;
}

/** A plain count: "3.11B", "12.0K", "912" */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return intFmt.format(n);
}

/** An 18-decimal coin amount in full: "3,057,528,846.6" */
export function coinFull(v: Amount): string {
  const n = Number(big(v) / 10n ** 14n) / 1e4;
  return n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Parses what a person typed into a 6-decimal amount. Returns null if it is not a number. */
export function parseUsd(text: string): bigint | null {
  const clean = text.replace(/[,\s$]/g, "");
  if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") return null;
  const [whole, frac = ""] = clean.split(".");
  return BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

/** Parses a coin amount with 18 decimals. */
export function parseCoin(text: string): bigint | null {
  const clean = text.replace(/[,\s]/g, "");
  if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") return null;
  const [whole, frac = ""] = clean.split(".");
  return BigInt(whole || "0") * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
}

/** A 6-decimal amount as an editable string: "1204.33" */
export function usdInput(v: Amount): string {
  const n = big(v);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return frac === "00" ? whole.toString() : `${whole}.${frac}`;
}

export { big };
