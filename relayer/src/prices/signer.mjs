/**
 * The price signer: turns a price into a print the SignedOracle contract accepts.
 *
 * A print is EIP-712 typed data, signed for one feed, one chain and one oracle contract, so it
 * cannot be replayed for another market or deployment. The blob is exactly what the contract
 * decodes: abi.encode(feedId, price, conf, publishTime, prevPublishTime, v, r, s).
 *
 * THE KEY IS THE PRICE. Whoever holds it can sign any price and the Exchange will fill, close and
 * bust at it. It never sends a transaction and needs no ETH. Keep it out of logs, out of git, and
 * on this machine only; if it may have leaked, the Exchange's owner replaces it with
 * SignedOracle.setSigner and every print the old key signed stops counting.
 */
import { encodeAbiParameters, getAddress, hashTypedData, parseAbi } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";

export const PRINT_TYPES = {
  Print: [
    { name: "feedId", type: "bytes32" },
    { name: "price", type: "uint64" },
    { name: "conf", type: "uint64" },
    { name: "publishTime", type: "uint64" },
    { name: "prevPublishTime", type: "uint64" },
  ],
};

export const SIGNED_ORACLE_ABI = parseAbi([
  "function signer() view returns (address)",
  "function exchange() view returns (address)",
  "function read(bytes32 feedId, bytes[] update) view returns (uint64 price, uint64 conf, uint64 publishTime, uint64 prevPublishTime)",
]);

const BLOB = [
  { type: "bytes32" },
  { type: "uint64" },
  { type: "uint64" },
  { type: "uint64" },
  { type: "uint64" },
  { type: "uint8" },
  { type: "bytes32" },
  { type: "bytes32" },
];

const U64 = 2n ** 64n;

export function printDomain(chainId, oracle) {
  return { name: "SignedOracle", version: "1", chainId, verifyingContract: getAddress(oracle) };
}

/**
 * @param {{ privateKey: `0x${string}`, chainId: number, oracle: `0x${string}` }} options
 */
export function createPrintSigner({ privateKey, chainId, oracle }) {
  const account = privateKeyToAccount(privateKey);
  const domain = printDomain(chainId, oracle);

  return {
    address: account.address,
    /**
     * @param {`0x${string}`} feedId the market's feed id, as the Exchange holds it
     * @param {{ price: bigint, conf: bigint, time: number, prev: number }} print price and conf
     *        scaled to 1e8, times in unix seconds
     * @returns {Promise<`0x${string}`>} the update the contract takes
     */
    async sign(feedId, { price, conf, time, prev }) {
      // The contract would refuse each of these. Better never to have signed them.
      if (typeof price !== "bigint" || price <= 0n || price >= U64) throw new Error(`price out of range: ${price}`);
      if (typeof conf !== "bigint" || conf < 0n || conf >= U64) throw new Error(`conf out of range: ${conf}`);
      if (!Number.isSafeInteger(time) || !Number.isSafeInteger(prev) || prev < 0 || prev > time) {
        throw new Error(`bad print times: ${prev} -> ${time}`);
      }
      const message = { feedId, price, conf, publishTime: BigInt(time), prevPublishTime: BigInt(prev) };
      const hash = hashTypedData({ domain, types: PRINT_TYPES, primaryType: "Print", message });
      const signature = await sign({ hash, privateKey });
      const v = 27 + Number(signature.yParity ?? Number(signature.v) - 27);
      return encodeAbiParameters(BLOB, [feedId, price, conf, BigInt(time), BigInt(prev), v, signature.r, signature.s]);
    },
  };
}
