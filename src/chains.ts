import { getAddress, type Address } from "viem";

/**
 * The chains real money trades on. Robinhood Chain is home: stocks, ETH, and every receipt
 * (sealed and anchored there, whatever chain a trade ran on). Arbitrum One adds the major
 * crypto that has no token on Robinhood Chain.
 *
 * Every address below was read back on its chain before use (2026-11-25): the Uniswap V3
 * factory, SwapRouter02 (whose factory() and WETH9() match) and QuoterV2; each token's symbol
 * and decimals; each Chainlink feed's description and a fresh answer.
 */

export type ChainKey = "robinhood" | "arbitrum";

export interface ChainToken {
  token: Address;
  decimals: number;
  /** Chainlink USD feed on this chain; the vault prices every swap with it. */
  feed: Address;
  /** Seconds after which the feed's answer counts as stale. */
  maxAge: number;
}

export interface TradeChain {
  key: ChainKey;
  id: number;
  name: string;
  rpcs: string[];
  explorer: string;
  uniswap: { factory: Address; router: Address; quoter: Address };
  weth: Address;
  /** The cash token a vault measures itself in. */
  base: { symbol: string; address: Address; decimals: number; feed: Address };
  /** Symbols tradable with real money on this chain (crypto only for Arbitrum). */
  tokens: Record<string, ChainToken>;
  /** Most intermediate hop worth trying for thin pairs: the chain's wrapped ETH. */
  hub: Address;
}

const A = (a: string) => getAddress(a.toLowerCase());

export const ARBITRUM: TradeChain = {
  key: "arbitrum",
  id: 42161,
  name: "Arbitrum One",
  rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
  explorer: "https://arbiscan.io",
  uniswap: { factory: A("0x1F98431c8aD98523631AE4a59f267346ea31F984"), router: A("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"), quoter: A("0x61fFE014bA17989E743c5F6cB21bF9697530B21e") },
  weth: A("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
  base: { symbol: "USDC", address: A("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"), decimals: 6, feed: A("0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3") },
  hub: A("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
  tokens: {
    ETH: { token: A("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"), decimals: 18, feed: A("0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"), maxAge: 86400 + 3600 },
    BTC: { token: A("0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f"), decimals: 8, feed: A("0x6ce185860a4963106506C203335A2910413708e9"), maxAge: 86400 + 3600 },
    ARB: { token: A("0x912CE59144191C1204E64559FE8253a0e49E6548"), decimals: 18, feed: A("0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6"), maxAge: 86400 + 3600 },
    LINK: { token: A("0xf97f4df75117a78c1A5a0DBb814Af92458539FB4"), decimals: 18, feed: A("0x86E53CF1B870786351Da77A57575e79CB55812CB"), maxAge: 86400 + 3600 },
    UNI: { token: A("0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0"), decimals: 18, feed: A("0x9C917083fDb403ab5ADbEC26Ee294f6EcAda2720"), maxAge: 86400 + 3600 },
    AAVE: { token: A("0xba5DdD1f9d7F570dc94a51479a000E3BCE967196"), decimals: 18, feed: A("0xaD1d5344AaDE45F43E596773Bcc4c423EAbdD034"), maxAge: 86400 + 3600 },
  },
};

/** The chain a real-money run on `symbol` uses: Robinhood Chain when it has the token, else Arbitrum. */
export function chainFor(symbol: string, robinhoodHasToken: boolean): ChainKey | null {
  if (robinhoodHasToken) return "robinhood";
  if (ARBITRUM.tokens[symbol]) return "arbitrum";
  return null;
}

/** Arbitrum One's Uniswap V3 for quotes and swaps: thin pairs also go through WETH (two pools). */
export const ARBITRUM_DEX = { quoter: ARBITRUM.uniswap.quoter, router: ARBITRUM.uniswap.router, hub: ARBITRUM.hub };

/** The tokens a vault on `chain` must allow, by symbol (Arbitrum only; Robinhood Chain reads them from the markets). */
export const arbitrumTokenOf = (symbol: string) => {
  const t = ARBITRUM.tokens[symbol];
  return t ? { token: t.token, decimals: t.decimals } : null;
};

export const CHAIN_NAMES: Record<ChainKey, string> = { robinhood: "Robinhood Chain", arbitrum: "Arbitrum One" };
