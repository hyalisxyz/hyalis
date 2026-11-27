/**
 * Creates the house (demo) agents on a deployed backend, chosen by scripts/research-agents.ts.
 * All use verified (Chainlink) markets only. Skips any agent whose name already exists.
 * Reads ADMIN_TOKEN from .env without printing it.
 *
 *   node scripts/create-house-agents.ts https://<domain>
 */
import { readFileSync } from "node:fs";
import type { Condition, Strategy } from "../src/strategy/schema.ts";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base.startsWith("https://") && !base.startsWith("http://127.0.0.1")) throw new Error("usage: node scripts/create-house-agents.ts https://<domain>");
const admin = /^ADMIN_TOKEN=(.+)$/m.exec(readFileSync(".env", "utf8"))?.[1]?.trim();
if (!admin) throw new Error("ADMIN_TOKEN missing in .env");

const aboveSma = (h: number, pct: number, d: string): Condition => ({ type: "price_vs_sma", description: d, periodHours: h, op: "above", bandPct: pct });
const belowSma = (h: number, pct: number, d: string): Condition => ({ type: "price_vs_sma", description: d, periodHours: h, op: "below", bandPct: pct });

const AGENTS: Array<{ strategy: Strategy; policy: Record<string, unknown> }> = [
  {
    strategy: {
      name: "Crypto Trend Long",
      summary: "Rides BTC and ETH uptrends: buys when price is clearly above its 48-hour average and rising, exits when it falls back below.",
      symbols: ["BTC", "ETH"],
      side: "long",
      entry: [aboveSma(48, 1.5, "Price at least 1.5% above its 48-hour average"), { type: "change_pct", description: "Up over the last 24 hours", lookbackHours: 24, op: "gt", value: 0 }],
      exitConditions: [belowSma(48, 0, "Price back below its 48-hour average")],
      stopLossPct: 4,
      takeProfitPct: 0,
      maxHoldHours: 0,
      positionPct: 25,
      maxOpenPositions: 2,
      leverage: 1,
      notes: ["Time-series momentum: the best-documented effect in crypto. Stays in cash when there is no uptrend."],
    },
    policy: { maxPositionPct: 25, allowShort: false, maxLeverageCrypto: 1 },
  },
  {
    strategy: {
      name: "Crypto Trend Short",
      summary: "The mirror of Trend Long: shorts BTC and ETH when price is clearly below its 72-hour average and falling, covers when it recovers.",
      symbols: ["BTC", "ETH"],
      side: "short",
      entry: [belowSma(72, 1.5, "Price at least 1.5% below its 72-hour average"), { type: "change_pct", description: "Down over the last 24 hours", lookbackHours: 24, op: "lt", value: 0 }],
      exitConditions: [aboveSma(72, 0, "Price back above its 72-hour average")],
      stopLossPct: 4,
      takeProfitPct: 0,
      maxHoldHours: 0,
      positionPct: 25,
      maxOpenPositions: 2,
      leverage: 1,
      notes: ["Unleveraged short (1x perp). Paired with Trend Long so one of them works in either direction."],
    },
    policy: { maxPositionPct: 25, allowShort: true, maxLeverage: 1, maxLeverageCrypto: 1 },
  },
  {
    strategy: {
      name: "Index Pullback",
      summary: "Buys short dips in SPY and QQQ only while the longer trend is up, and sells on the bounce back above the 24-hour average.",
      symbols: ["SPY", "QQQ"],
      side: "long",
      entry: [{ type: "rsi", description: "14-hour RSI below 30 (short-term oversold)", periodHours: 14, op: "lt", value: 30 }, aboveSma(120, 0, "Still above the 120-hour average (uptrend)")],
      exitConditions: [aboveSma(24, 0, "Back above the 24-hour average")],
      stopLossPct: 4,
      takeProfitPct: 0,
      maxHoldHours: 120,
      positionPct: 20,
      maxOpenPositions: 2,
      leverage: 1,
      notes: ["Short-term mean reversion with a trend filter, after Connors' RSI pullback rules for index ETFs."],
    },
    policy: { maxPositionPct: 25, allowShort: false },
  },
  {
    strategy: {
      name: "Megacap Pullback",
      summary: "Buys 2% dips below the 24-hour average in Apple, Microsoft, Nvidia, Alphabet, Amazon and Meta, only in an uptrend, and sells on the bounce.",
      symbols: ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META"],
      side: "long",
      entry: [belowSma(24, 2, "At least 2% below the 24-hour average"), aboveSma(120, 0, "Still above the 120-hour average (uptrend)")],
      exitConditions: [aboveSma(24, 0, "Back above the 24-hour average")],
      stopLossPct: 3,
      takeProfitPct: 0,
      maxHoldHours: 120,
      positionPct: 20,
      maxOpenPositions: 3,
      leverage: 1,
      notes: ["Same pullback logic as Index Pullback, spread over six large caps with a tighter stop."],
    },
    policy: { maxPositionPct: 25, allowShort: false },
  },
];

const existing = new Set(((await (await fetch(`${base}/v1/agents`)).json()) as Array<{ name: string }>).map((a) => a.name));
for (const a of AGENTS) {
  if (existing.has(a.strategy.name)) {
    console.log(`skip  ${a.strategy.name} (already exists)`);
    continue;
  }
  const res = await fetch(`${base}/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ name: a.strategy.name, strategy: a.strategy, policy: a.policy, backtestDays: 30 }),
  });
  const body = (await res.json()) as any;
  if (res.status !== 201) {
    console.log(`FAIL  ${a.strategy.name}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    continue;
  }
  const b = body.backtest;
  console.log(`made  ${a.strategy.name.padEnd(20)} ${body.agent.id}  30d backtest ${b.returnPct}% vs hold ${b.benchmarkReturnPct}%, dd ${b.maxDrawdownPct}%, trades ${b.trades.length}`);
}
