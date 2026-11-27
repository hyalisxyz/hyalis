import type { DatabaseSync } from "node:sqlite";
import type { Strategy } from "../strategy/schema.ts";
import { getAccount, type AgentRow } from "./agents.ts";
import { addReceipt, epochOf } from "./epochs.ts";

/**
 * The end of a run: a time limit, a profit target or a loss limit the user gave (often in the
 * same sentence as the strategy, "for 2 minutes, stop at +3% or -2%"), or the owner pressing
 * Stop. The agent stops deciding at once and is sealed as ended; its positions are closed
 * (paper at once, real money through the trader), and a vault agent's funds then go back to
 * the owner's wallet.
 */

export const hasEnd = (s: Strategy) => Boolean(s.endAfterMinutes || s.endAtProfitPct || s.endAtLossPct);

/** When the run's clock runs out, or null without a time limit. */
export const endAt = (a: Pick<AgentRow, "createdAt" | "strategy">) => (a.strategy.endAfterMinutes ? a.createdAt + Math.round(a.strategy.endAfterMinutes * 60) : null);

/** Why the run should end now, or null. `returnPct` is the total return so far. */
export function endReason(a: Pick<AgentRow, "createdAt" | "strategy">, returnPct: number, now: number): string | null {
  const s = a.strategy;
  const t = endAt(a);
  if (t !== null && now >= t) return `time: ${s.endAfterMinutes} minute${s.endAfterMinutes === 1 ? "" : "s"} are up`;
  if (s.endAtProfitPct && returnPct >= s.endAtProfitPct) return `profit target: ${returnPct.toFixed(2)}% reached ${s.endAtProfitPct}%`;
  if (s.endAtLossPct && returnPct <= -s.endAtLossPct) return `loss limit: ${returnPct.toFixed(2)}% reached -${s.endAtLossPct}%`;
  return null;
}

/**
 * Marks the run ended and seals why. Returns false when it had already ended. Closing the
 * positions is up to the caller (the ticker for paper, the trader for real money).
 */
export function markEnded(db: DatabaseSync, a: AgentRow, reason: string, equity: number, epochSec: number, now: number): boolean {
  const r = db
    .prepare("UPDATE agents SET status = 'paused', pause_reason = 'ended', ended_at = ?, ended_reason = ?, stop_state = CASE WHEN vault IS NOT NULL THEN 'closing' ELSE stop_state END WHERE id = ? AND ended_at IS NULL")
    .run(now, reason, a.id);
  if (!r.changes) return false;
  const row = getAccount(db, a.id);
  addReceipt(db, a.id, epochOf(now, epochSec), "end", {
    agentId: a.id,
    at: now,
    reason,
    equity: Math.round(equity * 1e6) / 1e6,
    startEquity: row.startEquity,
    returnPct: row.startEquity > 0 ? Math.round(((equity - row.startEquity) / row.startEquity) * 10_000) / 100 : 0,
    openPositions: row.account.positions.map((p) => p.symbol),
  }, now);
  return true;
}
