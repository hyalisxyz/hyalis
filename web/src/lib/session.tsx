import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getAddress } from "viem";
import { api } from "./api";
import { browserWallet } from "./wallet";

/**
 * Wallet connection plus a signed-in session, straight on the browser wallet (EIP-1193) with
 * viem. Connecting shows balance and tier at once (public data); signing a message (no gas) is
 * needed only to create or manage agents. The session token is kept in this browser only.
 *
 * "Disconnect" is remembered in this browser: a wallet cannot be made to forget a site, so the
 * site stops reconnecting on its own until the user connects again.
 */

interface Session {
  address: string | null;
  /** The wallet's current chain, or null when not connected. */
  chainId: number | null;
  connected: boolean;
  token: string | null;
  connecting: boolean;
  signingIn: boolean;
  error: string | null;
  connect: () => Promise<void>;
  signIn: () => Promise<string | null>;
  disconnect: () => void;
  hasWallet: boolean;
}

const Ctx = createContext<Session | null>(null);
const KEY = "au.session";
const DISCONNECTED = "au.disconnected";

const storage = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage unavailable: this visit only */
    }
  },
};

function load(address: string | null): string | null {
  if (!address) return null;
  try {
    const s = JSON.parse(storage.get(KEY) ?? "null") as { address: string; token: string; expiresAt: number } | null;
    if (s && s.address.toLowerCase() === address.toLowerCase() && s.expiresAt * 1000 > Date.now()) return s.token;
  } catch {
    /* unreadable: no session */
  }
  return null;
}

const firstMessage = (e: unknown, fallback: string) => ((e as Error)?.message ?? "").split("\n")[0] || fallback;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasWallet = browserWallet() !== null;

  useEffect(() => setToken(load(address)), [address]);

  // Follow the wallet: restore a connection the user did not end, and track account and chain changes.
  useEffect(() => {
    const w = browserWallet();
    if (!w) return;
    const onAccounts = (accounts: unknown) => {
      const a = Array.isArray(accounts) && typeof accounts[0] === "string" ? getAddress(accounts[0]) : null;
      setAddress(storage.get(DISCONNECTED) ? null : a);
    };
    const onChain = (id: unknown) => setChainId(typeof id === "string" ? Number.parseInt(id, 16) : null);
    if (!storage.get(DISCONNECTED)) {
      w.request({ method: "eth_accounts" }).then(onAccounts).catch(() => {});
      w.request({ method: "eth_chainId" }).then(onChain).catch(() => {});
    }
    w.on?.("accountsChanged", onAccounts);
    w.on?.("chainChanged", onChain);
    return () => {
      w.removeListener?.("accountsChanged", onAccounts);
      w.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    const w = browserWallet();
    if (!w) {
      setError("No browser wallet found. Install MetaMask or Rabby, then reload this page.");
      return;
    }
    setConnecting(true);
    try {
      const accounts = (await w.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts[0]) throw new Error("The wallet shared no account.");
      storage.set(DISCONNECTED, null);
      setAddress(getAddress(accounts[0]));
      setChainId(Number.parseInt((await w.request({ method: "eth_chainId" })) as string, 16));
    } catch (e) {
      setError(firstMessage(e, "Connection was cancelled."));
    } finally {
      setConnecting(false);
    }
  }, []);

  const signIn = useCallback(async () => {
    if (!address) return null;
    setError(null);
    setSigningIn(true);
    try {
      const n = await api.nonce(address);
      // The viem wallet client loads only when someone signs in.
      const { walletClient } = await import("./chain");
      const signature = await walletClient(address as `0x${string}`).signMessage({ account: address as `0x${string}`, message: n.message });
      const v = await api.verify(address, n.nonce, signature);
      storage.set(KEY, JSON.stringify(v));
      setToken(v.token);
      return v.token;
    } catch (e) {
      setError(firstMessage(e, "Sign-in was cancelled."));
      return null;
    } finally {
      setSigningIn(false);
    }
  }, [address]);

  const disconnect = useCallback(() => {
    if (token) api.logout(token).catch(() => {});
    storage.set(KEY, null);
    storage.set(DISCONNECTED, "1");
    setToken(null);
    setAddress(null);
    setChainId(null);
    // Wallets that support it also drop the site's permission; others simply stay quiet.
    browserWallet()?.request({ method: "wallet_revokePermissions" as never, params: [{ eth_accounts: {} }] as never }).catch(() => {});
  }, [token]);

  const value = useMemo<Session>(
    () => ({ address, chainId, connected: address !== null, token, connecting, signingIn, error, connect, signIn, disconnect, hasWallet }),
    [address, chainId, token, connecting, signingIn, error, connect, signIn, disconnect, hasWallet],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
