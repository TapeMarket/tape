/**
 * The typed data traders sign, mirrored from src/base/Intents.sol. Shared by the site (which signs)
 * and the relayer (which checks before spending gas).
 */

export const EXEC_DELAY = 2;
export const PIN_WINDOW = 10;
export const INTENT_TTL = 60;
export const DIRECT_DELAY = 24;
export const WITHDRAW_DELAY = 15 * 60;
export const MAX_SESSION_DURATION = 90 * 24 * 60 * 60;
/** One slot. A change to an account or a key bites this long after the block it lands in. */
export const GRACE = 12;
/** A direct close request lapses if nobody executed it within this long. */
export const REQUEST_EXPIRY = 10 * 60;

export function domain(name, chainId, exchange) {
  return { name, version: "1", chainId, verifyingContract: exchange };
}

/** Session keys are registered with the Sessions contract, under its own domain. */
export function sessionDomain(name, chainId, sessions) {
  return { name, version: "1", chainId, verifyingContract: sessions };
}

export const types = {
  Open: [
    { name: "owner", type: "address" },
    { name: "market", type: "uint16" },
    { name: "isLong", type: "bool" },
    { name: "useQueued", type: "bool" },
    { name: "leverage", type: "uint16" },
    { name: "margin", type: "uint96" },
    { name: "priceLimit", type: "uint64" },
    // The most the position may be charged on for its size, in whole dollars. 0 is no limit.
    { name: "impactLimit", type: "uint32" },
    { name: "timestamp", type: "uint64" },
    { name: "salt", type: "uint64" },
  ],
  Close: [
    { name: "owner", type: "address" },
    { name: "positionId", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
  // A take-profit or a stop-loss: close once a price at or past `price` prints, from `timestamp` on.
  Trigger: [
    { name: "owner", type: "address" },
    { name: "positionId", type: "bytes32" },
    { name: "price", type: "uint64" },
    { name: "above", type: "bool" },
    { name: "timestamp", type: "uint64" },
  ],
  // Taking one off again. Only the relayer reads this: no contract function accepts it.
  CancelTrigger: [
    { name: "owner", type: "address" },
    { name: "positionId", type: "bytes32" },
    { name: "above", type: "bool" },
    { name: "timestamp", type: "uint64" },
  ],
  SessionKey: [
    { name: "owner", type: "address" },
    { name: "key", type: "address" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
  Withdraw: [
    { name: "owner", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

/** EIP-2612 permit, as USDC implements it. */
export const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
