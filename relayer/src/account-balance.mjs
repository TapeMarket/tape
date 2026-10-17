/** Pin collateral to an explicit block so an older HTTP read cannot undo a settlement event. */
export async function readAccountSnapshot(chain, owner, blockNumber) {
  const block = blockNumber ?? await chain.publicClient.getBlockNumber({ cacheTime: 0 });
  const account = await chain.publicClient.readContract({
    address: chain.addresses.lens, abi: chain.abis.lens, functionName: "account", args: [owner], blockNumber: block,
  });
  return { ...account, blockNumber: block };
}

export function balanceSnapshot(owner, account) {
  return { address: owner, blockNumber: account.blockNumber, balance: account.balance, queued: account.queued, marginInUse: account.marginInUse };
}
