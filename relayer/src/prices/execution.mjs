import { open, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { encodeAbiParameters, hashTypedData } from "viem";
import { sign } from "viem/accounts";
import { createPrintSigner, printDomain } from "./signer.mjs";

export const FILL_TYPES = { Fill: [
  { name: "feedId", type: "bytes32" }, { name: "orderId", type: "bytes32" },
  { name: "price", type: "uint64" }, { name: "conf", type: "uint64" },
  { name: "publishTime", type: "uint64" }, { name: "observedAt", type: "uint64" },
] };
export const TICK_TYPES = { Tick: [
  { name: "feedId", type: "bytes32" }, { name: "price", type: "uint64" }, { name: "conf", type: "uint64" },
  { name: "publishTime", type: "uint64" }, { name: "prevPublishTime", type: "uint64" },
  { name: "observedAt", type: "uint64" }, { name: "prevObservedAt", type: "uint64" },
] };
const U64 = 2n ** 64n;
const values = (price, conf) => { if (typeof price !== "bigint" || price <= 0n || price >= U64 || typeof conf !== "bigint" || conf < 0n || conf >= U64) throw Error("Invalid execution price"); };
const time = n => { if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid execution time"); return BigInt(n); };

export function createExecutionSigner(options) {
  const base = createPrintSigner(options);
  const domain = printDomain(options.chainId, options.oracle);
  async function signed(types, primaryType, message, words) {
    const signature = await sign({ hash: hashTypedData({ domain, types, primaryType, message }), privateKey: options.privateKey });
    return encodeAbiParameters([...words.map(v => ({ type: v[0] })), { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
      [...words.map(v => v[1]), 27 + signature.yParity, signature.r, signature.s]);
  }
  return {
    address: base.address,
    async sign(feedId, print) {
      values(print.price, print.conf);
      const observedAt = time(print.observedAt), prevObservedAt = time(print.prevObservedAt);
      if (observedAt <= prevObservedAt || Number(observedAt / 1000n) !== print.time || Number(prevObservedAt / 1000n) !== print.prev) throw Error("Tick times disagree");
      const message = { feedId, price: print.price, conf: print.conf, publishTime: time(print.time), prevPublishTime: time(print.prev), observedAt, prevObservedAt };
      return signed(TICK_TYPES, "Tick", message, [["bytes32", feedId], ["uint64", message.price], ["uint64", message.conf], ["uint64", message.publishTime], ["uint64", message.prevPublishTime], ["uint64", observedAt], ["uint64", prevObservedAt]]);
    },
    async fill(feedId, orderId, print) {
      values(print.price, print.conf);
      const observedAt = time(print.observedAt);
      if (!/^0x[a-f0-9]{64}$/i.test(orderId) || /^0x0+$/.test(orderId)) throw Error("Invalid execution order digest");
      const message = { feedId, orderId, price: print.price, conf: print.conf, publishTime: observedAt / 1000n, observedAt };
      return signed(FILL_TYPES, "Fill", message, [["bytes32", feedId], ["bytes32", orderId], ["uint64", message.price], ["uint64", message.conf], ["uint64", message.publishTime], ["uint64", observedAt]]);
    },
  };
}

/** One persisted execution per full order digest. A retry/restart can only reuse that first price. */
export async function createExecutions({ dir, chainId, oracle, signer, source, now = Date.now }) {
  const stem = `executions-${chainId}-${oracle.toLowerCase()}-`;
  const records = new Map(), waiting = new Map();
  let poisoned = false;
  let writes = Promise.resolve();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of await readdir(dir)) {
    if (!name.startsWith(stem) || !/^\d+\.jsonl$/.test(name.slice(stem.length))) continue;
    const hour = Number(name.slice(stem.length, -6));
    if (hour < Math.floor(now() / 3_600_000) - 1) { await unlink(join(dir, name)); continue; }
    for (const line of (await readFile(join(dir, name), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      // A corrupt journal fails closed. It cannot silently issue a different price on a retry.
      const record = JSON.parse(line);
      if (!/^0x[a-f0-9]{64}$/i.test(record.id) || !Number.isSafeInteger(record.observedAt) || !/^0x[a-f0-9]{576}$/i.test(record.blob)) throw Error("Invalid execution journal record");
      const prior = records.get(record.id);
      if (prior && prior.blob !== record.blob) throw Error("Conflicting execution journal records");
      records.set(record.id, { ...record, price: BigInt(record.price), conf: BigInt(record.conf), time: Math.floor(record.observedAt / 1000) });
    }
  }
  function append(record) {
    const write = writes.then(async () => {
      const file = join(dir, `${stem}${Math.floor(now() / 3_600_000)}.jsonl`);
      const handle = await open(file, "a", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record, (_, v) => typeof v === "bigint" ? v.toString() : v)}\n`); await handle.sync(); }
      finally { await handle.close(); }
    });
    writes = write.catch(() => { poisoned = true; });
    return write;
  }
  return {
    has: id => records.has(id) || waiting.has(id),
    async price({ id, market, timestamp, receivedAt, afterMs = 0 }) {
      if (poisoned) throw Error("Execution storage unavailable. No new price can be issued.");
      const cached = records.get(id);
      if (cached) {
        if (cached.market !== market.id || cached.feedId !== market.feedId || cached.timestamp !== timestamp || cached.observedAt <= afterMs) throw Error("Execution replay does not match its original order");
        return cached;
      }
      if (waiting.has(id)) return waiting.get(id);
      const promise = (async () => {
        const print = await source.execution(market.id, receivedAt, timestamp, afterMs);
        if (!Number.isSafeInteger(print.observedAt) || print.observedAt <= Math.max(receivedAt, afterMs) || Math.floor(print.observedAt / 1000) < timestamp || Math.floor(print.observedAt / 1000) > timestamp + 10) throw Error("Source returned a stale execution price");
        const blob = await signer.fill(market.feedId, id, print);
        const record = { id, market: market.id, feedId: market.feedId, timestamp, price: print.price, conf: print.conf, time: Math.floor(print.observedAt / 1000), observedAt: print.observedAt, blob };
        await append(record);
        records.set(id, record);
        // Keep only records for intents which could still be valid. Disk retention covers restarts.
        for (const [key, value] of records) if (value.timestamp < Math.floor(now() / 1000) - 120) records.delete(key);
        return record;
      })();
      waiting.set(id, promise);
      try { return await promise; } finally { waiting.delete(id); }
    },
  };
}
