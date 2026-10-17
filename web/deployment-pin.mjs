import { getAddress, getContractAddress, zeroAddress } from "viem";

// This is a local deployment record, never a value supplied by the public API.
export function depositPinFrom(deployment) {
  if (!deployment) return null;
  if (deployment.chainId !== 1 || deployment.name !== "Tape") throw Error("The mainnet deployment record must name Tape on Ethereum chain 1.");
  if (!deployment.deposits) return null;
  const deposits = getAddress(deployment.deposits);
  if (deposits === zeroAddress) throw Error("The mainnet Deposits address is zero.");
  // Deposits creates its immutable DepositBox as its first CREATE, in its constructor.
  return { deposits, box: getContractAddress({ from: deposits, nonce: 1n }) };
}
