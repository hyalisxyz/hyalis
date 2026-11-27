/**
 * Picks the house agents by walk-forward testing, not by fitting the whole history:
 *  - each strategy family has a small parameter grid, built from published ideas;
 *  - parameters are chosen on the first half of the stored history (train);
 *  - the chosen version is then scored on the second half, which it never saw (test).
 * Families and sources:
 *  - pullback in an uptrend (Connors-style short-term mean reversion with a trend filter) on
 *    index ETFs and megacaps;
 *  - time-series momentum on BTC/ETH, long and short (strongest evidence in crypto; buying
 *    crypto dips loses money in most studies, so that is tested only as a control);
 *  - breakout momentum on high-beta stocks.
 *
 *   node scripts/research-agents.ts [days]
 */
import { openDb } from "../src/store/db.ts";
import { loadConfig, loadMarkets } from "../src/config.ts";
import { loadRounds } from "../src/engine/ingest.ts";
import { runBacktest, type BacktestResult } from "../src/engine/backtest.ts";
import { Policy } from "../src/guard/policy.ts";
import { maxLookback, type Condition, type Strategy } from "../src/strategy/schema.ts";

const days = Number(process.argv[2] ?? 30);
const db = openDb(loadConfig().DB_PATH);
const markets = loadMarkets();
const heartbeatSec = new Map(markets.map((m) => [m.symbol, m.heartbeatSec]));
const assetClass = new Map(markets.map((m) => [m.symbol, m.assetClass]));
const policy = Policy.parse({ maxLeverage: 2, maxLeverageCrypto: 1.5, allowShort: true, maxPositionPct: 25, reentryCooldownHours: 6 });
const now = Math.floor(Date.now() / 1000);
const start = now - days * 86400;
const mid = start + Math.floor((now - start) / 2);

const base = (o: Partial<Strategy> & Pick<Strategy, "name" | "symbols" | "entry">): Strategy => ({
  summary: o.name,
  side: "long",
  exitConditions: [],
  stopLossPct: 5,
  takeProfitPct: 0,
  maxHoldHours: 0,
  positionPct: 20,
  maxOpenPositions: 3,
  leverage: 1,
  notes: [],
  ...o,
});

const c = {
  belowSma: (h: number, pct: number): Condition => ({ type: "price_vs_sma", description: `${pct}% below ${h}h average`, periodHours: h, op: "below", bandPct: pct }),
  aboveSma: (h: number, pct: number): Condition => ({ type: "price_vs_sma", description: `${pct}% above ${h}h average`, periodHours: h, op: "above", bandPct: pct }),
  rsiBelow: (h: number, v: number): Condition => ({ type: "rsi", description: `RSI(${h}h) below ${v}`, periodHours: h, op: "lt", value: v }),
  rsiAbove: (h: number, v: number): Condition => ({ type: "rsi", description: `RSI(${h}h) above ${v}`, periodHours: h, op: "gt", value: v }),
  up: (h: number, pct: number): Condition => ({ type: "change_pct", description: `up more than ${pct}% over ${h}h`, lookbackHours: h, op: "gt", value: pct }),
  down: (h: number, pct: number): Condition => ({ type: "change_pct", description: `down more than ${pct}% over ${h}h`, lookbackHours: h, op: "lt", value: -pct }),
};

type Family = { family: string; variants: Strategy[] };
const families: Family[] = [];

// 1. Pullback in an uptrend, index ETFs and megacaps.
for (const universe of [["SPY", "QQQ"], ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META"]] as const) {
  const variants: Strategy[] = [];
  for (const dip of [0.5, 1, 2]) for (const trend of [72, 120]) for (const sl of [3, 5])
    variants.push(base({ name: `pullback ${universe[0]} dip${dip} trend${trend} sl${sl}`, symbols: [...universe], entry: [c.belowSma(24, dip), c.aboveSma(trend, 0)], exitConditions: [c.aboveSma(24, 0)], stopLossPct: sl, maxHoldHours: 120, positionPct: 20 }));
  for (const r of [25, 30, 35])
    variants.push(base({ name: `rsi-dip ${universe[0]} rsi${r}`, symbols: [...universe], entry: [c.rsiBelow(14, r), c.aboveSma(120, 0)], exitConditions: [c.aboveSma(24, 0)], stopLossPct: 4, maxHoldHours: 120, positionPct: 20 }));
  families.push({ family: `pullback-in-uptrend ${universe.join("/")}`, variants });
}

// 2. Time-series momentum, BTC/ETH, long and short.
for (const side of ["long", "short"] as const) {
  const variants: Strategy[] = [];
  for (const h of [48, 72, 120]) for (const band of [0.5, 1.5]) for (const sl of [4, 7])
    variants.push(
      base({
        name: `trend-${side} crypto sma${h} band${band} sl${sl}`,
        symbols: ["BTC", "ETH"],
        side,
        entry: side === "long" ? [c.aboveSma(h, band), c.up(24, 0)] : [c.belowSma(h, band), c.down(24, 0)],
        exitConditions: side === "long" ? [c.belowSma(h, 0)] : [c.aboveSma(h, 0)],
        stopLossPct: sl,
        positionPct: 25,
        maxOpenPositions: 2,
      }),
    );
  families.push({ family: `crypto-trend-${side} BTC/ETH`, variants });
}

// Control: buying crypto dips, which the literature says tends to lose.
families.push({
  family: "control: crypto dip-buying BTC/ETH",
  variants: [3, 5, 8].map((d) => base({ name: `crypto-dip ${d}`, symbols: ["BTC", "ETH"], entry: [c.down(24, d)], takeProfitPct: d, stopLossPct: d, positionPct: 25, maxOpenPositions: 2 })),
});

// 3. Breakout momentum, high-beta stocks.
{
  const variants: Strategy[] = [];
  for (const brk of [1, 2, 3]) for (const exitH of [24, 48]) for (const sl of [4, 6])
    variants.push(base({ name: `breakout brk${brk} exit${exitH} sl${sl}`, symbols: ["TSLA", "PLTR", "COIN", "MSTR", "AMD"], entry: [c.aboveSma(48, brk), c.up(24, 2)], exitConditions: [c.belowSma(exitH, 0)], stopLossPct: sl, positionPct: 15, maxOpenPositions: 3 }));
  families.push({ family: "breakout high-beta TSLA/PLTR/COIN/MSTR/AMD", variants });
}

function run(s: Strategy, from: number, to: number): BacktestResult {
  const since = from - (maxLookback(s) * 2 + 24 * 6) * 3600;
  const rounds = new Map(s.symbols.map((sym) => [sym, loadRounds(db, sym, since)]));
  return runBacktest({ strategy: s, policy, rounds, heartbeatSec, assetClass, from, to });
}

/** Return per unit of risk, and a strategy that barely trades cannot win on luck. */
const score = (r: BacktestResult) => (r.trades.length < 2 ? -Infinity : r.returnPct - 0.5 * r.maxDrawdownPct);
const f = (n: number | null) => (n === null ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);

console.log(`history ${days}d; train ${new Date(start * 1000).toISOString().slice(0, 10)}..${new Date(mid * 1000).toISOString().slice(0, 10)}, test ..${new Date(now * 1000).toISOString().slice(0, 10)}\n`);
const picks: Array<{ family: string; s: Strategy; train: BacktestResult; test: BacktestResult; full: BacktestResult }> = [];
for (const fam of families) {
  const trained = fam.variants.map((s) => ({ s, r: run(s, start, mid) })).sort((a, b) => score(b.r) - score(a.r));
  const best = trained[0]!;
  const test = run(best.s, mid, now);
  const full = run(best.s, start, now);
  picks.push({ family: fam.family, s: best.s, train: best.r, test, full });
  const median = trained[Math.floor(trained.length / 2)]!.r;
  console.log(`${fam.family}  (${fam.variants.length} variants)`);
  console.log(`  chosen on train: ${best.s.name}`);
  console.log(`  train ${f(best.r.returnPct)} dd ${best.r.maxDrawdownPct}% trades ${best.r.trades.length} | median variant on train ${f(median.returnPct)}`);
  console.log(`  TEST  ${f(test.returnPct)} vs hold ${f(test.benchmarkReturnPct)} dd ${test.maxDrawdownPct}% trades ${test.trades.length} win ${test.winRatePct ?? "-"}%`);
  console.log(`  full  ${f(full.returnPct)} vs hold ${f(full.benchmarkReturnPct)} dd ${full.maxDrawdownPct}% trades ${full.trades.length}\n`);
}
console.log(JSON.stringify(picks.map((p) => ({ family: p.family, strategy: p.s, test: { returnPct: p.test.returnPct, benchmark: p.test.benchmarkReturnPct, dd: p.test.maxDrawdownPct, trades: p.test.trades.length } }))));
