#!/usr/bin/env node
// Inspect or prepare unsigned, simulated recovery/upgrade transactions. This tool never signs.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../relayer/package.json", import.meta.url));
const { createPublicClient, http, getAddress, encodeFunctionData, parseUnits, zeroAddress } = require("viem");
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const command = args[0] ?? "inspect";
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const json = name => JSON.parse(readFileSync(resolve(root, name), "utf8"));
const deployment = json(option("deployment") ?? "deployments/1-hybrid-candidate.json");
if (!deployment.upgradeController) throw Error("This deployment is immutable; recovery controls require a hybrid deployment.");
const client = createPublicClient({ transport: http(process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com") });
const chainId = await client.getChainId();
if (chainId !== deployment.chainId) throw Error("RPC chain does not match deployment");
const exchange = getAddress(deployment.exchange);
const controller = getAddress(deployment.upgradeController);
const controllerAbi = json("deployable/hybrid/HybridUpgradeController.json").abi;
const recoveryAbi = json("deployable/hybrid/EmergencyExchange.json").abi;
const tokenAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] }];
const read = (address, abi, functionName, params = []) => client.readContract({ address, abi, functionName, args: params });
const code = await client.getCode({ address: exchange });
if (!code || code === "0x") throw Error("Candidate proxy is not deployed. Simulated candidate files do not prove deployment.");
const paused = await read(controller, controllerAbi, "emergencyPaused");
if (command === "inspect") {
  const [upgradeOwner, guardian, exchangeOwner, balances, margin, debtMargin, queued, treasury, actual] = await Promise.all([
    read(controller, controllerAbi, "owner"), read(controller, controllerAbi, "guardian"), read(exchange, recoveryAbi, "owner"),
    read(exchange, recoveryAbi, "totalBalances"), read(exchange, recoveryAbi, "totalCashMargin"),
    read(exchange, recoveryAbi, "debtMarginOpen"), read(exchange, recoveryAbi, "totalQueued"),
    read(exchange, recoveryAbi, "treasury"), read(deployment.usdc, tokenAbi, "balanceOf", [exchange]),
  ]);
  console.log(JSON.stringify({ chainId, exchange, controller, paused, upgradeOwner, guardian, exchangeOwner,
    balances, margin, debtMargin, queued, treasury, actual,
    migrationTarget: paused ? await read(exchange, recoveryAbi, "migrationTarget") : null,
    custodyVault: paused ? await read(exchange, recoveryAbi, "custodyVault") : null,
  }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
} else {
  const from = getAddress(option("from") ?? (() => { throw Error("--from is required; transactions are simulated for that wallet"); })());
  let address = exchange, abi = recoveryAbi, functionName, params;
  const amount = () => {
    const raw = option("amount");
    if (!raw || !/^\d+(?:\.\d{1,6})?$/.test(raw)) throw Error("--amount must be a positive USDC amount with at most 6 decimals");
    const value = parseUnits(raw, 6);
    if (value <= 0n) throw Error("Amount must be positive");
    return value;
  };
  if (command === "pause") { address = controller; abi = controllerAbi; functionName = "emergencyPause"; params = []; }
  else if (command === "upgrade") {
    address = controller; abi = controllerAbi; functionName = "upgrade";
    params = [getAddress(option("implementation")), "0x"];
  } else {
    if (!paused) throw Error("Activate emergency recovery before preparing migration or emergency withdrawal");
    if (command === "evacuate") { functionName = "evacuateToVault"; params = []; }
    else if (command === "target") { functionName = "setMigrationTarget"; params = [getAddress(option("target") ?? zeroAddress)]; }
    else if (command === "migrate") { functionName = "migrateBalance"; params = [getAddress(option("user")), amount()]; }
    else if (command === "withdraw") { functionName = "emergencyWithdraw"; params = [amount()]; }
    else if (command === "house") { functionName = "migrateHouse"; params = [amount()]; }
    else throw Error("Commands: inspect, pause, evacuate, upgrade, target, migrate, withdraw, house");
  }
  if (command === "upgrade") {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, ["tools/hybrid-layout.mjs"], { cwd: root, stdio: "inherit", windowsHide: true });
    if (result.error || result.status !== 0) throw Error("Upgrade storage compatibility check failed");
    const local = json("deployable/hybrid/FastExchange.json");
    // Runtime embeds constructor immutables. The actual candidate must also be verified and
    // rehearsed against a fork; a layout check cannot attest arbitrary deployed bytecode.
    if (!local.storageLayout) throw Error("Rebuild reviewed hybrid artifacts before preparing an upgrade");
  }
  await client.simulateContract({ address, abi, functionName, args: params, account: from });
  const data = encodeFunctionData({ abi, functionName, args: params });
  const gas = await client.estimateGas({ account: from, to: address, data });
  const transaction = { chainId, from, to: address, data, value: "0", estimatedGas: gas.toString(),
    action: command, simulatedAt: new Date().toISOString(), exchange, warning: "Unsigned. Recheck live state and review before signing." };
  const output = resolve(root, option("out") ?? `deployments/hybrid-${command}-transaction.json`);
  writeFileSync(output, JSON.stringify(transaction, null, 2) + "\n");
  console.log(`Simulated ${command}; unsigned transaction written to ${output}.`);
}
