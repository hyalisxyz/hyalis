import type { EIP1193Provider } from "viem";

/** The browser wallet (EIP-1193), if there is one. Kept apart from the viem clients so every page can use it cheaply. */
export function browserWallet(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { ethereum?: EIP1193Provider }).ethereum as EIP1193Provider | undefined) ?? null;
}
