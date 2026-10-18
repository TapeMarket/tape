import { parseAbi } from "viem";
const CONTROLLER = parseAbi(["function emergencyPaused() view returns (bool)"]);
const RECOVERY = parseAbi(["function custodyVault() view returns (address)"]);

/** A failed status read blocks new writes until the controller is observable again. */
export async function refreshRecovery({ config, chain }) {
  const controller = config.deployment.upgradeController;
  if (!controller) return null;
  try {
    const paused = await chain.publicClient.readContract({ address: controller, abi: CONTROLLER, functionName: "emergencyPaused" });
    const custodyVault = paused ? await chain.publicClient.readContract({ address: chain.addresses.exchange, abi: RECOVERY, functionName: "custodyVault" }) : null;
    config.recoveryState = { controller, paused, available: true, custodyVault, checkedAt: Date.now() };
  } catch {
    config.recoveryState = { controller, paused: true, available: false, custodyVault: config.recoveryState?.custodyVault ?? null, checkedAt: Date.now() };
  }
  return config.recoveryState;
}
