/**
 * Who a finished weekly season pays, and how much: the list to send the prizes from the team's
 * half of the fees. Reads the relayer; sends nothing.
 *
 *   node tools/season-payouts.mjs --api https://api.tapemarket.io [--season N]
 *
 * Without --season it takes the season that ended last. It prints each winner's address and
 * prize, and a CSV of the same.
 */
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const api = arg("--api");
if (!api) throw new Error("--api is required: the relayer, such as https://api.tapemarket.io");
const get = async (path) => {
  const res = await fetch(`${api.replace(/\/$/, "")}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};

const current = await get("/season");
const n = arg("--season") ? Number(arg("--season")) : current.number - 1;
if (!(n >= 1)) throw new Error("No season has ended yet.");
const season = await get(`/season?n=${n}`);
if (season.live) throw new Error(`Season ${n} has not ended yet: it ends ${new Date(season.end * 1000).toISOString()}.`);

const usd = (v) => (Number(BigInt(v)) / 1e6).toFixed(2);
const winners = season.rows.filter((r) => BigInt(r.prize) > 0n);
console.log(`Season ${season.number}: ${new Date(season.start * 1000).toISOString().slice(0, 10)} to ${new Date(season.end * 1000).toISOString().slice(0, 10)}`);
console.log(`fees taken ${usd(season.fees)} USDC, prize pool ${usd(season.pool)} USDC (${season.prizeBps / 100}% of the fees)\n`);
let total = 0n;
for (const w of winners) {
  total += BigInt(w.prize);
  console.log(`#${String(w.rank).padEnd(3)} ${w.address}  ${usd(w.prize).padStart(10)} USDC   ${season.names[w.address.toLowerCase()] ?? ""}  (pnl ${usd(w.pnl)}, ${w.trades} trades)`);
}
console.log(`\ntotal ${usd(total)} USDC to ${winners.length} winners`);
console.log("\naddress,usdc");
for (const w of winners) console.log(`${w.address},${usd(w.prize)}`);
