import { z } from "zod";

/**
 * Guardrails the owner sets for an agent. The engine checks every order against them, and
 * in phase 2 the same limits are enforced by the vault contract, so a wrong model output
 * can be refused twice.
 */
export const PLATFORM_LIMITS = { maxLeverage: 3 } as const;

export const Policy = z.object({
  maxLeverage: z.number().min(1).max(PLATFORM_LIMITS.maxLeverage).default(2),
  /** Crypto moves more than stocks, so it has its own, lower default cap. */
  maxLeverageCrypto: z.number().min(1).max(PLATFORM_LIMITS.maxLeverage).default(1.5),
  maxPositionPct: z.number().min(1).max(100).default(20),
  maxOpenPositions: z.number().int().min(1).max(10).default(5),
  /** Stop opening new positions after losing this percent of equity since the UTC day began. */
  dailyLossPct: z.number().min(0.5).max(50).default(5),
  allowShort: z.boolean().default(true),
  /** After a position in a symbol closes, wait this many hours before opening it again. */
  reentryCooldownHours: z.number().min(0).max(24 * 30).default(6),
  /** Empty means any listed market. */
  allowedSymbols: z.array(z.string()).default([]),
});
export type Policy = z.infer<typeof Policy>;

export interface OrderRequest {
  symbol: string;
  side: "long" | "short";
  leverage: number;
  assetClass?: "equity" | "crypto";
  /** Notional as a percent of current equity. */
  positionPct: number;
}

export interface AccountView {
  equity: number;
  dayStartEquity: number;
  openPositions: number;
}

/**
 * Does a strategy fit its owner's policy at all? Checked once when an agent is created, so
 * a strategy that could never place an order is refused up front instead of failing quietly.
 * Used by both the brain path and the direct-rules path.
 */
export function strategyPolicyErrors(
  s: { symbols: string[]; side: "long" | "short"; leverage: number; positionPct: number; maxOpenPositions: number },
  p: Policy,
  assetOf: (symbol: string) => "equity" | "crypto",
): string[] {
  const errs: string[] = [];
  if (s.side === "short" && !p.allowShort) errs.push("the strategy shorts, but the policy does not allow shorting");
  if (s.leverage > p.maxLeverage) errs.push(`leverage ${s.leverage} is above the policy limit ${p.maxLeverage}`);
  const crypto = s.symbols.filter((sym) => assetOf(sym) === "crypto");
  const cryptoCap = Math.min(p.maxLeverage, p.maxLeverageCrypto);
  if (crypto.length && s.leverage > cryptoCap) errs.push(`leverage ${s.leverage} is above the crypto limit ${cryptoCap} (${crypto.join(", ")})`);
  if (s.positionPct > p.maxPositionPct) errs.push(`position ${s.positionPct}% is above the policy limit ${p.maxPositionPct}%`);
  if (p.allowedSymbols.length) {
    const outside = s.symbols.filter((sym) => !p.allowedSymbols.includes(sym));
    if (outside.length) errs.push(`symbols not allowed by the policy: ${outside.join(", ")}`);
  }
  return errs;
}

export type PolicyResult ={ ok: true } | { ok: false; reason: string };

export function checkOrder(p: Policy, o: OrderRequest, a: AccountView): PolicyResult {
  if (p.allowedSymbols.length > 0 && !p.allowedSymbols.includes(o.symbol)) return { ok: false, reason: `${o.symbol} is not allowed` };
  if (o.side === "short" && !p.allowShort) return { ok: false, reason: "shorting is not allowed" };
  const cap = o.assetClass === "crypto" ? Math.min(p.maxLeverage, p.maxLeverageCrypto) : p.maxLeverage;
  if (o.leverage > cap) return { ok: false, reason: `leverage ${o.leverage} above ${o.assetClass === "crypto" ? "crypto " : ""}limit ${cap}` };
  if (o.positionPct > p.maxPositionPct) return { ok: false, reason: `position ${o.positionPct}% above limit ${p.maxPositionPct}%` };
  if (a.openPositions >= p.maxOpenPositions) return { ok: false, reason: `already ${a.openPositions} open positions` };
  if (a.equity <= 0) return { ok: false, reason: "no equity" };
  const dayLoss = ((a.dayStartEquity - a.equity) / a.dayStartEquity) * 100;
  if (dayLoss >= p.dailyLossPct) return { ok: false, reason: `daily loss ${dayLoss.toFixed(2)}% reached limit ${p.dailyLossPct}%` };
  return { ok: true };
}
