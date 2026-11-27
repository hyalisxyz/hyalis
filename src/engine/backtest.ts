import type { Strategy } from "../strategy/schema.ts";
import { maxLookback } from "../strategy/schema.ts";
import type { Policy } from "../guard/policy.ts";
import { gate } from "../guard/gate.ts";
import { hourWasOpen, marketState, type MarketState } from "../market/calendar.ts";
import { closesAt, hourFloor, HOUR, openHourEnds, type HourClose, type RoundPoint } from "../strategy/series.ts";
import { step, type StepEvent, type StepState } from "./step.ts";
import { usesSocial } from "../strategy/schema.ts";
import type { MoodOf } from "../strategy/evaluate.ts";
import { metricsOf, type Metrics } from "./metrics.ts";

/**
 * Replays a strategy over stored Chainlink rounds, one decision per market hour, through the
 * same step() the live agents use. Each decision at time t sees only rounds published at or
 * before t, so there is no look-ahead.
 *
 * Differences from live, stated in the result: decisions are hourly (live ticks every few
 * minutes), so stops trigger on hourly prices; there is no second price source or halt list.
 */

export interface BacktestInput {
  strategy: Strategy;
  policy: Policy;
  /** Rounds per symbol, sorted by updatedAt ascending. */
  rounds: ReadonlyMap<string, readonly RoundPoint[]>;
  heartbeatSec: ReadonlyMap<string, number>;
  /** Asset class per symbol; anything missing is treated as equity. */
  assetClass?: ReadonlyMap<string, "equity" | "crypto">;
  from: number;
  to: number;
  startEquity?: number;
  /** Equity calendar, replaceable in tests. Crypto is always open. */
  market?: (t: number) => MarketState;
  hourOpen?: (hourEnd: number) => boolean;
  /** Sealed mood readings as of a time, for social_mood rules; without it those rules never pass. */
  moodAt?: (symbol: string, t: number) => ReturnType<MoodOf>;
  /** When readings of posts on X began, for the caveat. */
  moodSince?: number | null;
}

export interface Trade {
  symbol: string;
  side: "long" | "short";
  openedAt: number;
  closedAt: number;
  entry: number;
  exit: number;
  pnl: number;
  returnPct: number;
  how: "close" | "liquidate";
  reason: string;
}

export interface BacktestResult {
  from: number;
  to: number;
  hours: number;
  decisions: number;
  startEquity: number;
  endEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  trades: Trade[];
  openPositions: number;
  winRatePct: number | null;
  fees: number;
  /** Share of market hours with at least one open position. */
  exposurePct: number;
  /** Equal-weight buy-and-hold of the strategy's symbols over the same hours. */
  benchmarkReturnPct: number | null;
  blocked: Record<string, number>;
  equityCurve: Array<[number, number]>;
  /** Sharpe, Sortino, Calmar, profit factor and the probability the edge is real. */
  metrics: Omit<Metrics, "raw">;
  /** Per-period Sharpe and moments, for deflating across several tried versions (not sent to clients). */
  raw?: Metrics["raw"];
  /**
   * The same run cut in two: the first 70% of the hours, where versions are compared and one is
   * chosen, and the last 30%, which the choice never looked at.
   */
  split: { cutAt: number; inSample: { returnPct: number; sharpe: number | null }; outOfSample: { returnPct: number; sharpe: number | null } } | null;
  caveats: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Latest round at or before t, by binary search. */
function roundAt(rounds: readonly RoundPoint[], t: number): RoundPoint | null {
  let lo = 0;
  let hi = rounds.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rounds[mid]!.updatedAt <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best >= 0 ? rounds[best]! : null;
}

export function runBacktest(i: BacktestInput): BacktestResult {
  const startEquity = i.startEquity ?? 10_000;
  const marketAt = i.market ?? marketState;
  // The calendar is called many times per hour; cache it.
  const openCache = new Map<number, boolean>();
  const baseOpen = i.hourOpen ?? hourWasOpen;
  const hourOpen = (end: number) => {
    let v = openCache.get(end);
    if (v === undefined) openCache.set(end, (v = baseOpen(end)));
    return v;
  };

  const s = i.strategy;
  const lookback = maxLookback(s) + 2;
  const ALWAYS: MarketState = { open: true, session: "always", reason: null };
  const assetOf = (sym: string) => i.assetClass?.get(sym) ?? "equity";
  const hourOpenFor = (sym: string) => (assetOf(sym) === "crypto" ? () => true : hourOpen);
  // An hour is replayed when any of the strategy's markets was open in it.
  const anyOpen = (end: number) => s.symbols.some((sym) => hourOpenFor(sym)(end));
  let state: StepState = { account: { cash: startEquity, positions: [] }, day: Math.floor(i.from / 86400), dayStartEquity: startEquity };
  const trades: Trade[] = [];
  const blocked: Record<string, number> = {};
  const curve: Array<[number, number]> = [];
  let fees = 0;
  let decisions = 0;
  let hoursExposed = 0;
  let peak = startEquity;
  let maxDd = 0;
  const firstPrice = new Map<string, number>();
  const lastPrice = new Map<string, number>();

  for (let end = hourFloor(i.from) + HOUR; end <= i.to; end += HOUR) {
    if (!anyOpen(end)) continue;
    // Decide in the last minute of the hour, the latest moment that still belongs to it.
    const t = end - 60;
    const equityMarket = marketAt(t);
    const marketFor = (sym: string) => (assetOf(sym) === "crypto" ? ALWAYS : equityMarket);
    const closes = new Map<string, HourClose[]>();
    const prices = new Map<string, number>();
    const latest = new Map<string, RoundPoint>();
    for (const [sym, rs] of i.rounds) {
      closes.set(sym, closesAt(rs, openHourEnds(t, lookback, hourOpenFor(sym)), t));
      const r = roundAt(rs, t);
      if (r) {
        latest.set(sym, r);
        prices.set(sym, r.price);
        if (s.symbols.includes(sym)) {
          if (!firstPrice.has(sym)) firstPrice.set(sym, r.price);
          lastPrice.set(sym, r.price);
        }
      }
    }

    const res = step(state, {
      now: t,
      marketFor,
      assetClassOf: assetOf,
      strategy: s,
      policy: i.policy,
      active: true,
      closes,
      prices,
      gateFor: (sym) => {
        const r = latest.get(sym);
        return gate({
          chainlinkPrice: r?.price ?? null,
          chainlinkUpdatedAt: r?.updatedAt ?? null,
          heartbeatSec: i.heartbeatSec.get(sym) ?? 86400,
          secondPrice: null,
          halted: false,
          marketOpen: marketFor(sym).open,
          marketReason: marketFor(sym).reason,
          now: t,
        });
      },
      moodOf: (sym) => i.moodAt?.(sym, t) ?? null,
    });

    const opened = new Map(state.account.positions.map((p) => [p.symbol, p]));
    for (const e of res.events) record(e, opened, t);
    state = res.state;
    if (s.symbols.some((sym) => marketFor(sym).open)) decisions++;
    if (state.account.positions.length > 0) hoursExposed++;
    curve.push([end, round2(res.equity)]);
    peak = Math.max(peak, res.equity);
    maxDd = Math.max(maxDd, ((peak - res.equity) / peak) * 100);
  }

  function record(e: StepEvent, openedBefore: Map<string, StepState["account"]["positions"][number]>, t: number) {
    if (e.type === "decision" && e.outcome !== "filled") {
      blocked[e.why] = (blocked[e.why] ?? 0) + 1;
      return;
    }
    const fill = e.fill!;
    fees += fill.fee;
    if (fill.action === "open") return;
    const pos = openedBefore.get(e.symbol);
    if (!pos) return;
    trades.push({
      symbol: e.symbol,
      side: pos.side,
      openedAt: pos.openedAt,
      closedAt: t,
      entry: pos.entryPrice,
      exit: fill.price,
      pnl: round2(fill.pnl),
      returnPct: round2((fill.pnl / pos.margin) * 100),
      how: fill.action === "liquidate" ? "liquidate" : "close",
      reason: e.type === "liquidation" ? "margin exhausted" : e.decision.reason,
    });
  }

  const endEquity = curve.at(-1)?.[1] ?? startEquity;
  // Replayed hours in a year for these markets: all of them for crypto, market hours for stocks.
  const years = Math.max(1e-9, (i.to - i.from) / (365 * 86400));
  const hoursPerYear = curve.length / years;
  const m = metricsOf(curve, trades, maxDd, hoursPerYear);
  const cut = Math.floor(curve.length * 0.7);
  const part = (c: Array<[number, number]>) => {
    const pm = metricsOf(c, [], 0, hoursPerYear);
    return { returnPct: c.length > 1 ? round2((c.at(-1)![1] / c[0]![1] - 1) * 100) : 0, sharpe: pm.sharpe };
  };
  const split = curve.length >= 48 ? { cutAt: curve[cut]![0], inSample: part(curve.slice(0, cut + 1)), outOfSample: part(curve.slice(cut)) } : null;
  const bench = [...firstPrice.keys()].map((sym) => lastPrice.get(sym)! / firstPrice.get(sym)! - 1);
  const wins = trades.filter((x) => x.pnl > 0).length;
  // Thin the curve for transport; keep the first and last points.
  const stride = Math.max(1, Math.ceil(curve.length / 200));
  const equityCurve = curve.filter((_, k) => k % stride === 0 || k === curve.length - 1);

  return {
    from: i.from,
    to: i.to,
    hours: curve.length,
    decisions,
    startEquity,
    endEquity,
    returnPct: round2(((endEquity - startEquity) / startEquity) * 100),
    maxDrawdownPct: round2(maxDd),
    trades,
    openPositions: state.account.positions.length,
    winRatePct: trades.length ? round2((wins / trades.length) * 100) : null,
    fees: round2(fees),
    exposurePct: curve.length ? round2((hoursExposed / curve.length) * 100) : 0,
    benchmarkReturnPct: bench.length ? round2((bench.reduce((a, b) => a + b, 0) / bench.length) * 100) : null,
    blocked,
    equityCurve,
    metrics: { sharpe: m.sharpe, sortino: m.sortino, calmar: m.calmar, profitFactor: m.profitFactor, probabilisticSharpe: m.probabilisticSharpe },
    raw: m.raw,
    split,
    caveats: [
      "Decisions are made once per market hour; live agents check every few minutes, so stops can fill at different prices.",
      "Prices come from Chainlink only; there is no second source, halt list, slippage or perp funding in this replay.",
      "Stocks are replayed on their 24/5 market hours and crypto on every hour, as live.",
      "Past results on a few days of data say little about future results.",
      ...(usesSocial(s)
        ? [
            i.moodSince
              ? `Mood rules use the sealed readings of posts on X, kept since ${new Date(i.moodSince * 1000).toISOString().slice(0, 10)} and only for symbols agents were reading; hours without a reading do not pass.`
              : "Mood rules need readings of posts on X, and none exist yet for this replay, so they never pass here; live, readings start once the agent runs.",
          ]
        : []),
    ],
  };
}
