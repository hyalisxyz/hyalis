import type { PublicClient } from "viem";
import type { Market } from "../src/config.ts";
import type { Strategy } from "../src/strategy/schema.ts";

export const H = 3600;
const PH = 1n << 64n;

/** Unix seconds for a New York wall-clock time, given its UTC offset in hours (-5 EST, -4 EDT). */
export const et = (iso: string, offset: number) => Math.floor(Date.parse(`${iso}Z`) / 1000) - offset * H;

/**
 * Fake chain with one or more feeds, each a list of [updatedAt, price] rounds. Only rounds
 * at or before `clock()` are visible. Round ids use phase 1 like real Chainlink proxies.
 * `failRoundReads` makes getRoundData calls throw, to simulate a dropped connection.
 */
export function fakeChain(feeds: Record<string, Array<[number, number]>>, clock: () => number, opts: { failRoundReads?: () => boolean } = {}): PublicClient {
  const visible = (addr: string) => feeds[addr.toLowerCase()]!.filter(([t]) => t <= clock());
  const asRound = (i: number, [t, p]: [number, number]) => [PH + BigInt(i + 1), BigInt(Math.round(p * 1e8)), BigInt(t), BigInt(t), PH + BigInt(i + 1)] as const;
  return {
    async multicall({ contracts }: any) {
      if (contracts.some((c: any) => c.functionName === "getRoundData") && opts.failRoundReads?.()) throw new Error("connection dropped");
      return contracts.map((c: any) => {
        const rs = visible(c.address);
        if (c.functionName === "latestRoundData") return { status: "success", result: asRound(rs.length - 1, rs.at(-1)!) };
        const idx = Number(c.args[0] - PH) - 1;
        return idx >= 0 && idx < rs.length ? { status: "success", result: asRound(idx, rs[idx]!) } : { status: "failure", error: new Error("no round") };
      });
    },
  } as unknown as PublicClient;
}

export const FEED = "0x00000000000000000000000000000000000000aa";
export const MARKETS: Market[] = [{ symbol: "NVDA", assetClass: "equity", source: "chainlink", feed: FEED, decimals: 8, heartbeatSec: 86400, deviationPct: 0.5 }];

export function strategy(over: Partial<Strategy> = {}): Strategy {
  return {
    name: "dip",
    summary: "buy a 5% daily drop",
    symbols: ["NVDA"],
    side: "long",
    entry: [{ type: "change_pct", description: "down 5% in 24h", lookbackHours: 24, op: "lt", value: -5 }],
    exitConditions: [],
    stopLossPct: 8,
    takeProfitPct: 0,
    maxHoldHours: 0,
    positionPct: 10,
    maxOpenPositions: 1,
    leverage: 1,
    notes: [],
    ...over,
  };
}

export const ALWAYS_OPEN = {
  market: () => ({ open: true, session: "regular" as const, reason: null }),
  hourOpen: () => true,
};
