/**
 * A wallet's deposit address, worked out in the browser.
 *
 * The relayer tells the site each wallet's deposit address, and a deposit is a plain transfer to
 * it: no wallet warns about a transfer, so a wrong address would cost the money with nothing to
 * stop it. The address is therefore never taken on the relayer's word. It is worked out again
 * here, from the Deposits contract and its box code by the rule the chain itself applies (CREATE2
 * of the standard minimal proxy, salted with the wallet), and nothing is shown or sent unless the
 * two agree. On Ethereum mainnet the contract and its box code are pinned into the build from
 * Tape's local deployment record, so even a relayer that lied about those would be caught.
 */
import { concatHex, getAddress, getContractAddress, pad } from "viem";
import type { Address } from "./types";

const MAINNET_PIN = __MAINNET_DEPOSITS__;

export class DepositAddressMismatch extends Error {}

/** The address `owner` deposits to, by the chain's own rule. */
export function depositAddressOf(deposits: Address, box: Address, owner: Address): Address {
  // EIP-1167: creation code of the minimal proxy that hands every call to `box`.
  const initcode = concatHex(["0x3d602d80600a3d3981f3363d3d373d3d3d363d73", getAddress(box), "0x5af43d82803e903d91602b57fd5bf3"]);
  return getContractAddress({ opcode: "CREATE2", from: getAddress(deposits), salt: pad(getAddress(owner), { size: 32 }), bytecode: initcode });
}

/**
 * Checks what the relayer said against what the rule gives, and returns the address to use.
 * @param said what the relayer answered: the address, and the contract and box code it says it is from
 * @param configured the Deposits contract the site was told about when it loaded
 */
export function checkedDepositAddress(
  chainId: number,
  owner: Address,
  said: { address: Address | null; deposits: Address | null; box: Address | null },
  configured: Address | null | undefined,
): Address {
  const refuse = (why: string) => new DepositAddressMismatch(`The deposit address could not be confirmed (${why}). Nothing was sent. Please tell us.`);
  if (!said.address || !said.deposits || !said.box || !configured) throw refuse("the server gave none");
  const fixed = chainId === 1 ? MAINNET_PIN : null;
  if (chainId === 1 && !fixed) throw refuse("the mainnet deployment is not configured");
  const deposits = fixed?.deposits ?? configured;
  const box = fixed?.box ?? said.box;
  if (getAddress(said.deposits) !== getAddress(deposits) || getAddress(configured) !== getAddress(deposits) || getAddress(said.box) !== getAddress(box)) {
    throw refuse("the server named another deposit contract");
  }
  const expected = depositAddressOf(deposits, box, owner);
  if (getAddress(said.address) !== expected) throw refuse("it is not this wallet's");
  return expected;
}
