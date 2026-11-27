/**
 * Price gate: decides whether a price is good enough to trade on. It fails closed, so a
 * missing, old, halted or disputed price blocks the fill rather than guessing.
 */

export interface GateInput {
  /** Chainlink answer in USD, or null when the read failed. */
  chainlinkPrice: number | null;
  /** Unix seconds of the Chainlink round. */
  chainlinkUpdatedAt: number | null;
  /** Feed heartbeat in seconds. */
  heartbeatSec: number;
  /** Second source (Plankton mark), when it lists the symbol and is fresh. */
  secondPrice: number | null;
  halted: boolean;
  /** From the trading calendar. Nothing fills while the market is closed. */
  marketOpen: boolean;
  marketReason?: string | null;
  now: number;
  /** Max age as a multiple of the heartbeat. Equity feeds go quiet outside market hours. */
  maxAgeFactor?: number;
  /** Max gap between the two sources, in basis points. */
  maxGapBps?: number;
  /** Which second source was used, recorded on the receipt. */
  secondSource?: string;
}

export type GateVerdict =
  | { ok: true; price: number; ageSec: number; gapBps: number | null; secondSource?: string }
  | { ok: false; reason: "market_closed" | "halted" | "no_price" | "bad_price" | "future_price" | "stale_price" | "sources_disagree"; detail: string };

export function gate(i: GateInput): GateVerdict {
  const maxAge = i.heartbeatSec * (i.maxAgeFactor ?? 1.1);
  const maxGap = i.maxGapBps ?? 150;
  if (!i.marketOpen) return { ok: false, reason: "market_closed", detail: i.marketReason ?? "market closed" };
  if (i.halted) return { ok: false, reason: "halted", detail: "venue reports a trading halt" };
  if (i.chainlinkPrice === null || i.chainlinkUpdatedAt === null) return { ok: false, reason: "no_price", detail: "no Chainlink round" };
  if (!(i.chainlinkPrice > 0)) return { ok: false, reason: "bad_price", detail: `price ${i.chainlinkPrice}` };
  const age = i.now - i.chainlinkUpdatedAt;
  if (age < -30) return { ok: false, reason: "future_price", detail: `round is ${-age}s in the future` };
  if (age > maxAge) return { ok: false, reason: "stale_price", detail: `round is ${age}s old, limit ${Math.round(maxAge)}s` };
  let gapBps: number | null = null;
  if (i.secondPrice !== null && i.secondPrice > 0) {
    gapBps = Math.ceil((Math.abs(i.secondPrice - i.chainlinkPrice) / i.chainlinkPrice) * 10_000);
    if (gapBps > maxGap) return { ok: false, reason: "sources_disagree", detail: `sources ${gapBps} bps apart, limit ${maxGap}` };
  }
  return { ok: true, price: i.chainlinkPrice, ageSec: Math.max(0, age), gapBps, ...(i.secondSource && gapBps !== null ? { secondSource: i.secondSource } : {}) };
}
