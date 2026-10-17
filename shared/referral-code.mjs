/** Custom links share the existing referral-link alphabet and are canonical lower case. */
export const REFERRAL_CODE_RULE = /^[a-z0-9_]{3,16}$/;

/** A claim cannot be replayed for another wallet, code, chain or exchange. */
export const referralCodeMessage = ({ code, owner, chainId, exchange }) =>
  `Tape: claim referral code "${code.toLowerCase()}"\nWallet: ${owner.toLowerCase()}\nChain: ${chainId}\nExchange: ${exchange.toLowerCase()}`;
