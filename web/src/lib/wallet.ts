// Wallet connection. Browser wallets are discovered through EIP-6963 (with window.ethereum as the
// fallback). On a local chain only, a built-in test wallet using anvil's public keys is offered so
// the whole product can be clicked through without installing anything. In preview mode there is no
// chain at all, so the only "wallet" is a play account made in this browser.

import { createPublicClient, createWalletClient, custom, defineChain, http, type Abi, type Chain } from "viem";
import { mainnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PREVIEW } from "./mode";
import { EMPTY_HISTORY, getState, setState, toast } from "./store";
import type { Address, Hex } from "./types";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

export interface WalletOption {
  id: string;
  name: string;
  icon: string | null;
  note?: string;
  provider?: Eip1193;
  localKey?: Hex;
}

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface Signer {
  address: Address;
  name: string;
  signTypedData(data: TypedData): Promise<Hex>;
  signMessage(message: string): Promise<Hex>;
  /** Sends a transaction from the wallet and waits for it to be mined. */
  write(call: { address: Address; abi: Abi; functionName: string; args: unknown[] }, onSubmitted?: (hash: Hex) => void): Promise<Hex>;
}

// anvil's well-known accounts 2 to 5: public test keys, worthless anywhere but a local chain.
// They are only compiled into development builds and builds made for local testing
// (VITE_TEST_WALLETS=1). The site that is published carries no keys at all.
const TEST_WALLETS: boolean = import.meta.env.DEV || import.meta.env.VITE_TEST_WALLETS === "1";
const LOCAL_KEYS: Hex[] = TEST_WALLETS
  ? [
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
      "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    ]
  : [];
const LOCAL_CHAIN_ID = 31337;
const LOCAL_RPC: string = (import.meta.env.VITE_RPC_URL as string | undefined) ?? "http://127.0.0.1:8545";
const REMEMBER = "tape:wallet";
const PREVIEW_KEY = "tape:preview:key";

/** The play account's key: random, made once per browser, worth nothing. */
function previewKey(): Hex {
  let key = localStorage.getItem(PREVIEW_KEY) as Hex | null;
  if (!key || !/^0x[0-9a-f]{64}$/i.test(key)) {
    key = generatePrivateKey();
    localStorage.setItem(PREVIEW_KEY, key);
  }
  return key;
}

const discovered = new Map<string, WalletOption>();
let signer: Signer | null = null;
let detach: (() => void) | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", ((event: CustomEvent) => {
    const { info, provider } = event.detail ?? {};
    if (info?.uuid && provider) discovered.set(info.rdns ?? info.uuid, { id: info.rdns ?? info.uuid, name: info.name, icon: info.icon ?? null, provider });
  }) as EventListener);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

function chainFor(chainId: number): Chain {
  if (chainId === 1) return mainnet;
  return defineChain({
    id: chainId,
    name: chainId === LOCAL_CHAIN_ID ? "Local test chain" : `Chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [LOCAL_RPC] } },
  });
}

export function walletOptions(): WalletOption[] {
  if (PREVIEW) return [{ id: "preview", name: "Start trading", icon: null, note: "$10,000 to start", localKey: previewKey() }];
  const options = [...discovered.values()];
  const legacy = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (options.length === 0 && legacy) options.push({ id: "injected", name: "Browser wallet", icon: null, provider: legacy });
  if (getState().config?.chainId === LOCAL_CHAIN_ID) {
    LOCAL_KEYS.forEach((localKey, i) =>
      options.push({ id: `local:${i}`, name: `Test wallet ${i + 1}`, icon: null, note: "local chain only", localKey }),
    );
  }
  return options;
}

async function ensureChain(provider: Eip1193, chain: Chain): Promise<void> {
  const hexId = `0x${chain.id.toString(16)}`;
  const current = (await provider.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() === hexId) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hexId, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: chain.rpcUrls.default.http }],
    });
  }
}

function injectedSigner(option: WalletOption, address: Address, chain: Chain): Signer {
  const provider = option.provider!;
  const wallet = createWalletClient({ account: address, chain, transport: custom(provider) });
  const reader = createPublicClient({ chain, transport: custom(provider) });
  return {
    address,
    name: option.name,
    async signTypedData(data) {
      await ensureChain(provider, chain);
      return wallet.signTypedData(data as never);
    },
    signMessage: (message) => wallet.signMessage({ account: address, message }),
    async write(call, onSubmitted) {
      await ensureChain(provider, chain);
      const hash = await wallet.writeContract({ ...call, chain, account: address } as never);
      onSubmitted?.(hash);
      const receipt = await reader.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw Object.assign(new Error("The transaction reverted. The requested action did not complete."), { transactionReverted: true });
      return hash;
    },
  };
}

function localSigner(option: WalletOption, chain: Chain): Signer {
  const account = privateKeyToAccount(option.localKey!);
  if (PREVIEW) {
    return {
      address: account.address,
      name: option.name,
      signTypedData: (data) => account.signTypedData(data as never),
      signMessage: (message) => account.signMessage({ message }),
      write: () => Promise.reject(new Error("There is no chain in preview mode.")),
    };
  }
  const wallet = createWalletClient({ account, chain, transport: http(LOCAL_RPC) });
  const reader = createPublicClient({ chain, transport: http(LOCAL_RPC) });
  return {
    address: account.address,
    name: option.name,
    signTypedData: (data) => account.signTypedData(data as never),
    signMessage: (message) => account.signMessage({ message }),
    async write(call, onSubmitted) {
      const hash = await wallet.writeContract({ ...call, chain, account } as never);
      onSubmitted?.(hash);
      const receipt = await reader.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw Object.assign(new Error("The transaction reverted. The requested action did not complete."), { transactionReverted: true });
      return hash;
    },
  };
}

export const getSigner = (): Signer | null => signer;

export function disconnect(): void {
  detach?.();
  detach = null;
  signer = null;
  localStorage.removeItem(REMEMBER);
  setState({ owner: null, walletName: null, account: null, history: EMPTY_HISTORY, intents: {} });
}

/** Connects `option`. With `silent`, never opens a wallet popup: used to restore a session on load. */
export async function connect(option: WalletOption, silent = false): Promise<void> {
  const config = getState().config;
  if (!config) throw new Error("Not connected to the relayer yet.");
  const chain = chainFor(config.chainId);

  detach?.();
  detach = null;

  if (option.localKey) {
    signer = localSigner(option, chain);
  } else {
    const provider = option.provider!;
    const accounts = (await provider.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" })) as Address[];
    if (!accounts?.length) {
      if (silent) return;
      throw new Error("The wallet returned no account.");
    }
    signer = injectedSigner(option, accounts[0], chain);

    const onAccounts = ((next: Address[]) => {
      if (!next?.length) return disconnect();
      signer = injectedSigner(option, next[0], chain);
      setState({ owner: next[0], account: null, history: EMPTY_HISTORY, intents: {} });
    }) as (...args: never[]) => void;
    provider.on?.("accountsChanged", onAccounts);
    detach = () => provider.removeListener?.("accountsChanged", onAccounts);
  }

  localStorage.setItem(REMEMBER, option.id);
  setState({ owner: signer.address, walletName: signer.name, dialog: null, account: null, history: EMPTY_HISTORY, intents: {} });
}

/** Reconnects the wallet used last time, if it is still authorised. Never prompts. */
export async function restore(): Promise<void> {
  const remembered = localStorage.getItem(REMEMBER);
  if (!remembered) return;
  // Wallets announce themselves asynchronously; give them a moment.
  await new Promise((r) => setTimeout(r, 60));
  const option = walletOptions().find((o) => o.id === remembered);
  if (!option) return;
  try {
    await connect(option, true);
  } catch {
    // Not authorised any more. The person can connect again.
  }
}

export function explainWalletError(error: unknown): string {
  const e = error as { code?: number; shortMessage?: string; message?: string };
  if (e?.code === 4001 || /rejected|denied/i.test(e?.message ?? "")) return "You declined the request in your wallet.";
  return e?.shortMessage ?? e?.message ?? "The wallet request failed.";
}

export async function connectWith(option: WalletOption): Promise<void> {
  try {
    await connect(option);
  } catch (error) {
    toast("bad", "Could not connect", explainWalletError(error));
  }
}
