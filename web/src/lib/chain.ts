import { createPublicClient, createWalletClient, custom, defineChain, fallback, http, numberToHex } from "viem";
import { browserWallet } from "./wallet";

export { browserWallet };

/** Robinhood Chain mainnet. The public mirrors are used because some networks block the official RPC. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/** Reads (simulations, receipts) go to the public RPCs, never through the wallet. */
export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: fallback(robinhoodChain.rpcUrls.default.http.map((u) => http(u, { timeout: 20_000 }))),
});

/** A viem wallet client over the browser wallet, for one account. */
export function walletClient(account: `0x${string}`) {
  const provider = browserWallet();
  if (!provider) throw new Error("No browser wallet found.");
  return createWalletClient({ account, chain: robinhoodChain, transport: custom(provider) });
}

/** Asks the wallet to switch to Robinhood Chain, adding it first if the wallet does not know it. */
export async function switchToRobinhood(): Promise<void> {
  const provider = browserWallet();
  if (!provider) throw new Error("No browser wallet found.");
  const chainId = numberToHex(robinhoodChain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    // 4902: the wallet has no such chain yet.
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: robinhoodChain.name,
          nativeCurrency: robinhoodChain.nativeCurrency,
          rpcUrls: [...robinhoodChain.rpcUrls.default.http],
          blockExplorerUrls: [robinhoodChain.blockExplorers.default.url],
        },
      ],
    });
  }
}

/** Arbitrum One: major crypto with no token on Robinhood Chain is traded in vaults there. */
export const arbitrumChain = defineChain({
  id: 42161,
  name: "Arbitrum One",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"] } },
  blockExplorers: { default: { name: "Arbiscan", url: "https://arbiscan.io" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export type TradeChain = typeof robinhoodChain | typeof arbitrumChain;
export const chainById = (id: number): TradeChain => (id === arbitrumChain.id ? arbitrumChain : robinhoodChain);

const arbitrumClient = createPublicClient({
  chain: arbitrumChain,
  transport: fallback(arbitrumChain.rpcUrls.default.http.map((u) => http(u, { timeout: 20_000 }))),
});

/** Public reads on a given chain. */
export const publicClientOn = (chain: TradeChain) => (chain.id === arbitrumChain.id ? arbitrumClient : publicClient) as typeof publicClient;

/** A wallet client on a given chain. */
export function walletClientOn(account: `0x${string}`, chain: TradeChain) {
  const provider = browserWallet();
  if (!provider) throw new Error("No browser wallet found.");
  return createWalletClient({ account, chain, transport: custom(provider) });
}

/** Asks the wallet to switch to `chain`, adding it first if the wallet does not know it. */
export async function switchTo(chain: TradeChain): Promise<void> {
  if (chain.id === robinhoodChain.id) return switchToRobinhood();
  const provider = browserWallet();
  if (!provider) throw new Error("No browser wallet found.");
  const chainId = numberToHex(chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [...chain.rpcUrls.default.http], blockExplorerUrls: [chain.blockExplorers.default.url] }],
    });
  }
}

/** Explorer links on the chain a transaction or address is on. */
export const explorerOn = (chainId: number | null | undefined) => (chainId === arbitrumChain.id ? arbitrumChain : robinhoodChain).blockExplorers.default.url;
export const txUrlOn = (chainId: number | null | undefined, tx: string) => `${explorerOn(chainId)}/tx/${tx}`;
export const addressUrlOn = (chainId: number | null | undefined, a: string) => `${explorerOn(chainId)}/address/${a}`;
