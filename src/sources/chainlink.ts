import { createPublicClient, defineChain, fallback, http, type PublicClient } from "viem";
import { CHAIN_ID, type Market } from "../config.ts";

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

// Measured 2026-11-18: the public mirrors answer in ~0.5s; the official endpoint was slow
// and returned empty bodies from this network, so it is tried last.
export const PUBLIC_RPCS = [
  "https://robinhood-rpc.publicnode.com",
  "https://robinhood.drpc.org",
  "https://rpc.mainnet.chain.robinhood.com",
];

export function chainClient(rpcUrl?: string): PublicClient {
  const urls = [...(rpcUrl ? [rpcUrl] : []), ...PUBLIC_RPCS];
  return createPublicClient({
    chain: robinhoodChain,
    transport: fallback(urls.map((u) => http(u, { timeout: 10_000, retryCount: 1 }))),
    batch: { multicall: true },
  }) as PublicClient;
}

export const AGGREGATOR_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "_roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** One Chainlink answer, kept with the round id so anyone can re-read it on chain. */
export interface FeedRound {
  symbol: string;
  /** Chainlink proxy address, or "coingecko:<id>" for data-feed markets. */
  feed: string;
  roundId: string;
  /** Raw integer answer as a decimal string. */
  answer: string;
  decimals: number;
  /** Unix seconds. */
  updatedAt: number;
}

export const roundPrice = (r: FeedRound): number => Number(BigInt(r.answer)) / 10 ** r.decimals;

/** Reads the latest round of every market in one multicall. Failed reads are left out. */
export async function readLatestRounds(client: PublicClient, all: Market[]): Promise<FeedRound[]> {
  const markets = all.filter((m) => m.source === "chainlink");
  const res = await client.multicall({
    allowFailure: true,
    contracts: markets.map((m) => ({ address: m.feed as `0x${string}`, abi: AGGREGATOR_ABI, functionName: "latestRoundData" as const })),
  });
  const out: FeedRound[] = [];
  res.forEach((r, i) => {
    if (r.status !== "success") return;
    const m = markets[i]!;
    const [roundId, answer, , updatedAt] = r.result;
    out.push({
      symbol: m.symbol,
      feed: m.feed,
      roundId: roundId.toString(),
      answer: answer.toString(),
      decimals: m.decimals,
      updatedAt: Number(updatedAt),
    });
  });
  return out;
}

/** Re-reads one round by id. Used by the verifier to check a receipt's input price. */
export async function readRound(client: PublicClient, feed: `0x${string}`, roundId: string) {
  const [rid, answer, , updatedAt] = await client.readContract({
    address: feed,
    abi: AGGREGATOR_ABI,
    functionName: "getRoundData",
    args: [BigInt(roundId)],
  });
  return { roundId: rid.toString(), answer: answer.toString(), updatedAt: Number(updatedAt) };
}
