import type { Strategy } from "../strategy/schema.ts";
import type { Policy } from "../guard/policy.ts";
import type { GateVerdict } from "../guard/gate.ts";
import type { MarketState } from "../market/calendar.ts";
import type { HourClose } from "../strategy/series.ts";
import { dailyVolPct, HOUR } from "../strategy/series.ts";
import { decide, type ConditionResult, type MoodOf } from "../strategy/evaluate.ts";
import { checkOrder, type PolicyResult } from "../guard/policy.ts";
import { closePosition, equity, liquidatable, openPosition, venueFor, type Account, type Fill } from "../paper/broker.ts";

/**
 * One decision step for one agent: liquidations, then strategy signals through the gate,
 * the policy and the paper broker. Pure: no database, no network, no clock. The live
 * ticker and the backtester both call this, so a backtest runs exactly the logic that
 * trades live.
 */

export interface StepState {
  account: Account;
  /** UTC day number of `dayStartEquity`. */
  day: number;
  dayStartEquity: number;
}

export interface StepInput {
  now: number;
  /** Market state per symbol: stocks follow the 24/5 calendar, crypto is always open. */
  marketFor: (symbol: string) => MarketState;
  assetClassOf: (symbol: string) => "equity" | "crypto";
  strategy: Strategy;
  policy: Policy;
  active: boolean;
  closes: ReadonlyMap<string, readonly HourClose[]>;
  /** Latest known price per symbol, for marking positions. */
  prices: ReadonlyMap<string, number>;
  gateFor: (symbol: string) => GateVerdict;
  /**
   * Executable spot price for a buy or a sell, when a live quote exists (Uniswap). It already
   * includes spread, venue fees and price impact, so no extra fee is charged on top.
   * Perps and symbols without a quote fill at the gate's price plus the modelled fee.
   */
  execPrice?: (symbol: string, side: "buy" | "sell") => Execution | null;
  /** Sealed mood readings for social_mood conditions (live: the latest usable; backtest: as of then). */
  moodOf?: MoodOf;
}

export interface Execution {
  price: number;
  source: string;
  venues: string[];
  quotedAt: number;
}

export type StepEvent =
  | { type: "liquidation"; symbol: string; gate: GateVerdict; fill: Fill }
  | {
      type: "decision";
      symbol: string;
      decision: { kind: "open" | "close"; symbol: string; side?: "long" | "short"; reason: string; checks: ConditionResult[] };
      gate: GateVerdict;
      policy: PolicyResult | null;
      outcome: "filled" | "blocked" | "rejected";
      /** Short machine-readable cause, used to group repeated outcomes. */
      why: string;
      fill: Fill | null;
      execution?: Execution;
      error?: string;
    };

export interface StepResult {
  state: StepState;
  events: StepEvent[];
  equity: number;
}

/** Share of equity a position may risk on a typical day, by risk level. */
export const RISK_PER_DAY_PCT = { low: 0.25, medium: 0.5, high: 1 } as const;

/**
 * The position size for an order, in percent of equity. With a risk level, it is sized so a
 * typical day's move (the last 48 hours' daily volatility) costs about that level's share of
 * equity, never more than the strategy's positionPct; without enough history it uses half.
 */
export function sizePct(s: Strategy, closes: readonly HourClose[]): { pct: number; note: string | null } {
  if (!s.riskLevel) return { pct: s.positionPct, note: null };
  const vol = dailyVolPct(closes.map((c) => c.price), 48);
  if (vol === null || vol <= 0) return { pct: s.positionPct / 2, note: `size ${(s.positionPct / 2).toFixed(1)}% (${s.riskLevel} risk, volatility not known yet)` };
  const pct = Math.min(s.positionPct, ((RISK_PER_DAY_PCT[s.riskLevel] / vol) * 100) / Math.max(1, s.leverage));
  return { pct, note: `size ${pct.toFixed(1)}% (${s.riskLevel} risk, daily volatility ${vol.toFixed(2)}%)` };
}

export function step(state: StepState, i: StepInput): StepResult {
  let account = state.account;
  let { day, dayStartEquity } = state;
  const events: StepEvent[] = [];

  const today = Math.floor(i.now / 86400);
  if (day !== today) {
    day = today;
    dayStartEquity = equity(account, i.prices);
  }

  // Nothing trades in a symbol whose market is closed; its price does not move then, so nothing
  // is missed. Other symbols (crypto on a weekend) carry on.
  const open = (sym: string) => i.marketFor(sym).open;
  {
    // 1. Liquidations come first and skip the strategy: the margin is already gone. They
    //    still need a usable price, so a halted or stale symbol waits.
    for (const sym of liquidatable(account, i.prices)) {
      if (!open(sym)) continue;
      const g = i.gateFor(sym);
      if (!g.ok) continue;
      const res = closePosition(account, sym, g.price, i.now, "liquidate");
      if ("error" in res) continue;
      account = res.account;
      events.push({ type: "liquidation", symbol: sym, gate: g, fill: res.fill });
    }

    // 2. Strategy decisions. A paused agent is still liquidated but makes no new decisions.
    if (i.active) {
      const cooldownSec = i.policy.reentryCooldownHours * HOUR;
      const noEntry = new Set(Object.entries(account.lastExit ?? {}).filter(([, at]) => i.now - at < cooldownSec).map(([sym]) => sym));
      const positions = account.positions.map((p) => ({ symbol: p.symbol, side: p.side, entryPrice: p.entryPrice, openedAt: p.openedAt }));

      // The highest equity seen, and whether the drawdown limit now stops new positions.
      const eqStart = equity(account, i.prices);
      account = { ...account, peak: Math.max(account.peak ?? eqStart, eqStart) };
      const ddHit = Boolean(i.strategy.maxDrawdownPct && eqStart < account.peak! * (1 - i.strategy.maxDrawdownPct / 100));

      for (const sig of decide(i.strategy, i.closes, positions, i.now, noEntry, i.moodOf)) {
        // A closed market is not a decision: no receipt, no blocked count.
        if (!open(sig.symbol)) continue;
        const g = i.gateFor(sig.symbol);
        const decision = sig.kind === "open"
          ? { kind: sig.kind, symbol: sig.symbol, side: sig.side, reason: sig.reason, checks: sig.checks }
          : { kind: sig.kind, symbol: sig.symbol, reason: sig.reason, checks: sig.checks };
        const push = (outcome: "filled" | "blocked" | "rejected", why: string, policy: PolicyResult | null, fill: Fill | null, error?: string, execution?: Execution | null) =>
          events.push({ type: "decision", symbol: sig.symbol, decision, gate: g, policy, outcome, why, fill, ...(error ? { error } : {}), ...(execution ? { execution } : {}) });

        if (!g.ok) {
          push("blocked", `gate:${g.reason}`, null, null);
          continue;
        }

        if (sig.kind === "close") {
          const pos = account.positions.find((p) => p.symbol === sig.symbol);
          const ex = pos?.venue === "spot" ? i.execPrice?.(sig.symbol, "sell") ?? null : null;
          const res = closePosition(account, sig.symbol, ex?.price ?? g.price, i.now, "close", ex ? 0 : undefined);
          if ("error" in res) {
            push("rejected", "broker", null, null, res.error);
            continue;
          }
          account = res.account;
          push("filled", "ok", null, res.fill, undefined, ex);
          continue;
        }

        if (ddHit) {
          push("blocked", "risk:drawdown_limit", null, null);
          continue;
        }
        const eqNow = equity(account, i.prices);
        const size = sizePct(i.strategy, i.closes.get(sig.symbol) ?? []);
        if (size.note) decision.reason = `${decision.reason}; ${size.note}`;
        const order = { symbol: sig.symbol, side: sig.side, leverage: i.strategy.leverage, positionPct: size.pct, assetClass: i.assetClassOf(sig.symbol) };
        const pol = checkOrder(i.policy, order, { equity: eqNow, dayStartEquity, openPositions: account.positions.length });
        if (!pol.ok) {
          push("rejected", `policy:${pol.reason}`, pol, null);
          continue;
        }
        const spot = venueFor(order.side, order.leverage) === "spot";
        const ex = spot ? i.execPrice?.(sig.symbol, "buy") ?? null : null;
        const res = openPosition(account, { ...order, price: ex?.price ?? g.price, now: i.now, ...(ex ? { feeBps: 0 } : {}) }, eqNow);
        if ("error" in res) {
          push("rejected", "broker", pol, null, res.error);
          continue;
        }
        account = res.account;
        push("filled", "ok", pol, res.fill, undefined, ex);
      }
    }
  }

  return { state: { account, day, dayStartEquity }, events, equity: equity(account, i.prices) };
}
