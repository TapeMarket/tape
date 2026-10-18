/**
 * Copies the ABIs the off-chain code needs out of Foundry's build output into abi/.
 * Run after `forge build` whenever a contract interface changes.
 *
 *   node tools/export-abi.mjs
 *
 * Reads Foundry's output folder: `out`, or wherever FOUNDRY_OUT points, as forge itself does.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const CONTRACTS = ["Exchange", "FastExchange", "ExecutionOracle", "ExchangeBootstrap", "HybridExchangeProxy", "HybridUpgradeController", "EmergencyExchange", "EmergencyCustodyVault", "Sessions", "Lens", "Gateway", "Deposits", "Batcher", "Sweeper", "SignedSweeper", "Staking", "LossMining", "Jackpot", "Coin", "PythOracle", "SignedOracle"];
const OUT = (process.env.FOUNDRY_OUT ?? "out").replace(/\/+$/, "");

mkdirSync(new URL("../abi/", import.meta.url), { recursive: true });
for (const name of CONTRACTS) {
  const artifact = JSON.parse(readFileSync(new URL(`../${OUT}/${name}.sol/${name}.json`, import.meta.url), "utf8"));
  writeFileSync(new URL(`../abi/${name}.json`, import.meta.url), JSON.stringify(artifact.abi));
  console.log(`${name}: ${artifact.abi.length} entries`);
}
