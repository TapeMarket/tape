/** Small shared helpers: logging, JSON with bigints, and the event hub the HTTP streams read from. */
import { isAddress } from "viem";

/**
 * True for an address given as a string. Anything else in a request body (an array, an object) is
 * refused here: viem's own check coerces its argument to a string, so `["0x…"]` passes it once the
 * address is in its cache, and an object without a usable toString makes it throw.
 */
export const isAddr = (value) => typeof value === "string" && isAddress(value);

export function createLogger(scope = "relayer") {
  const stamp = () => new Date().toISOString().slice(11, 23);
  const line = (level, args) => {
    const text = args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : toJson(a))).join(" ");
    (level === "error" ? console.error : console.log)(`${stamp()} ${level.padEnd(5)} [${scope}] ${text}`);
  };
  return {
    info: (...args) => line("info", args),
    warn: (...args) => line("warn", args),
    error: (...args) => line("error", args),
  };
}

/** JSON.stringify that writes bigints as decimal strings. */
export function toJson(value) {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** A typed error the HTTP layer turns into a 4xx with a message the trader can read. */
export class Rejected extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Topic-based fan-out. Subscribers are HTTP event streams. */
export function createHub() {
  const subscribers = new Set();
  return {
    subscribe(topics, send) {
      const sub = { topics: new Set(topics), send };
      subscribers.add(sub);
      return () => subscribers.delete(sub);
    },
    publish(topic, type, data) {
      if (subscribers.size === 0) return;
      const payload = toJson(data);
      for (const sub of subscribers) if (sub.topics.has(topic)) sub.send(type, payload);
    },
    get size() {
      return subscribers.size;
    },
  };
}

export const acct = (address) => `acct:${address.toLowerCase()}`;
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const lower = (address) => address.toLowerCase();
