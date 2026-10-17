/**
 * Builds a fork-test fixture from Pyth updates that are already public on Ethereum.
 *
 * Every transaction that made Pyth store a price carried the guardian-signed update in its
 * calldata. This script finds the most recent ones for BTC/USD and ETH/USD through Pyth's own
 * PriceFeedUpdate events, lifts the updates out of the calldata, and writes them to
 * test/fixtures/pyth-onchain.json. The fork test replays them through
 * PythOracle against the real Pyth contract, so the adapter is exercised with real signatures and
 * real payloads without needing a Hermes key.
 *
 * Pyth's guardian set rotates, so an old update only verifies at a block from its own era. The
 * fork test therefore forks at the block of the update it replays, which needs an archive RPC.
 *
 *   node tools/fetch-onchain-fixture.mjs [path-to-etherscan-key-file]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PYTH = "0x4305FB66699C3B2702D4d05CF36551390A4c69C6";
const FEEDS = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};
// keccak256("PriceFeedUpdate(bytes32,uint64,int64,uint64)"), emitted when Pyth stores a newer price.
const PRICE_FEED_UPDATE = "0xd06a6b7f4918494b3719217d1802786c1f5112a6c1d88fe2cfec00b4584f6aec";
const FROM_BLOCK = 24_500_000;
const KEEP = 6; // most recent stored updates per feed

const keyFile = process.argv[2] || join(homedir(), "keys", "etherscan-api.key");
const apiKey = readFileSync(keyFile, "utf8").trim();

async function etherscan(params) {
  const url = `https://api.etherscan.io/v2/api?chainid=1&${params}&apikey=${apiKey}`;
  const json = await (await fetch(url, { signal: AbortSignal.timeout(20_000) })).json();
  if (json.result === undefined) throw new Error(`Etherscan: ${JSON.stringify(json).slice(0, 160)}`);
  return json.result;
}

/** Transactions in which Pyth stored a new price for `feedId`, newest last. */
async function storedUpdates(feedId) {
  const logs = await etherscan(
    `module=logs&action=getLogs&address=${PYTH}&topic0=${PRICE_FEED_UPDATE}&topic0_1_opr=and&topic1=0x${feedId}` +
      `&fromBlock=${FROM_BLOCK}&toBlock=latest&page=1&offset=1000`,
  );
  if (!Array.isArray(logs)) throw new Error(`Etherscan logs: ${String(logs).slice(0, 160)}`);
  return [...new Set(logs.map((l) => l.transactionHash))];
}

/**
 * Walks a Pyth accumulator update ("PNAU") starting at `offset` of `buf`.
 * Returns the price messages inside it and where the update ends.
 */
function readUpdate(buf, offset) {
  let o = offset + 6; // magic, major, minor
  o += 1 + buf.readUInt8(o); // trailing header
  o += 1; // update type
  // The Wormhole VAA: version, then the index of the guardian set that signed it. Sets rotate,
  // and an old one stops verifying a day after it is replaced.
  const guardianSet = buf.readUInt32BE(o + 3);
  o += 2 + buf.readUInt16BE(o);
  const count = buf.readUInt8(o);
  o += 1;
  const messages = [];
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt16BE(o);
    o += 2;
    const m = buf.subarray(o, o + size);
    o += size;
    o += 1 + buf.readUInt8(o) * 20; // merkle proof
    if (m.readUInt8(0) !== 0) continue; // not a price feed message
    messages.push({
      feed: m.subarray(1, 33).toString("hex"),
      price: m.readBigInt64BE(33).toString(),
      conf: m.readBigUInt64BE(41).toString(),
      expo: m.readInt32BE(49),
      time: Number(m.readBigUInt64BE(53)),
      prev: Number(m.readBigUInt64BE(61)),
      guardianSet,
    });
  }
  return { messages, end: o };
}

/** Every Pyth update embedded anywhere in a transaction's calldata, whoever the call was made to. */
function updatesIn(input) {
  const buf = Buffer.from(input.slice(2), "hex");
  const out = [];
  for (let at = buf.indexOf("504e4155", 0, "hex"); at !== -1; at = buf.indexOf("504e4155", at + 4, "hex")) {
    try {
      const { messages, end } = readUpdate(buf, at);
      if (end <= buf.length && messages.length) out.push({ messages, blob: buf.subarray(at, end).toString("hex") });
    } catch {
      // Not a real update at this offset.
    }
  }
  return out;
}

const found = [];
for (const [symbol, feedId] of Object.entries(FEEDS)) {
  const hashes = (await storedUpdates(feedId)).slice(-KEEP);
  console.log(`${symbol}: ${hashes.length} recent transactions stored a price`);
  for (const hash of hashes) {
    await new Promise((r) => setTimeout(r, 250));
    const tx = await etherscan(`module=proxy&action=eth_getTransactionByHash&txhash=${hash}`);
    if (!tx?.input) continue;
    for (const { messages, blob } of updatesIn(tx.input)) {
      for (const message of messages) {
        if (message.feed !== feedId) continue;
        found.push({ symbol, ...message, feed: `0x${feedId}`, block: Number(tx.blockNumber), tx: hash, update: `0x${blob}` });
      }
    }
  }
}

if (found.length === 0) throw new Error("no BTC or ETH updates found in recent Pyth transactions");

// Distinct publish times per feed, oldest first.
const unique = [...new Map(found.map((u) => [`${u.symbol}:${u.time}`, u])).values()].sort((a, b) => a.time - b.time);
for (const u of unique) {
  console.log(`${u.symbol} t=${u.time} prev=${u.prev} price=${u.price}e${u.expo} conf=${u.conf} block=${u.block} set=${u.guardianSet}`);
}

mkdirSync(new URL("../test/fixtures/", import.meta.url), { recursive: true });
writeFileSync(new URL("../test/fixtures/pyth-onchain.json", import.meta.url), JSON.stringify({ pyth: PYTH, updates: unique }, null, 2));
console.log(`wrote ${unique.length} updates to test/fixtures/pyth-onchain.json`);
