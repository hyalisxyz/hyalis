/**
 * Tahap 1 of smarter agents: breakout, z-score, MACD and volatility rules; volatility-sized
 * positions by risk level; trailing and volatility stops; the drawdown limit. All pure, all run
 * by the same step() live trading and backtests use.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { checkBounds, maxLookback, Strategy, type Condition } from "../src/strategy/schema.ts";
import { decide, evalCondition } from "../src/strategy/evaluate.ts";
import { dailyVolPct, type HourClose } from "../src/strategy/series.ts";
import { sizePct, step } from "../src/engine/step.ts";
import { Policy } from "../src/guard/policy.ts";
import { H, strategy } from "./helpers.ts";

const series = (prices: number[], t0 = 0): HourClose[] => prices.map((price, i) => ({ hourEnd: t0 + (i + 1) * H, price, roundId: String(i + 1) }));
const flat = (n: number, p = 100) => Array.from({ length: n }, () => p);
/** A gentle zigzag: about 0.5% hourly moves around 100. */
const zigzag = (n: number) => Array.from({ length: n }, (_, i) => 100 * (1 + (i % 2 ? 0.005 : -0.005)));

test("breakout: above the highest close of the window before it", () => {
  const c: Condition = { type: "breakout", description: "new 24h high", lookbackHours: 24, direction: "up" };
  assert.equal(evalCondition(c, series(flat(10))).pass, false); // not enough history
  assert.equal(evalCondition(c, series([...flat(24), 100])).pass, false); // equal is not a break
  assert.equal(evalCondition(c, series([...flat(24), 101])).pass, true);
  assert.equal(evalCondition({ ...c, direction: "down" }, series([...flat(24), 99])).pass, true);
});

test("z-score: how stretched the price is from its average", () => {
  const c: Condition = { type: "zscore", description: "2 sd below", periodHours: 20, op: "lt", value: -2 };
  assert.equal(evalCondition(c, series(flat(20))).pass, false); // no movement: no reading
  const dip = evalCondition(c, series([...zigzag(19), 95]));
  assert.equal(dip.pass, true);
  assert.ok(dip.value! < -2);
});

test("MACD: bullish in a steady rise, bearish in a steady fall", () => {
  const up = Array.from({ length: 120 }, (_, i) => 100 + i * 0.5);
  const down = Array.from({ length: 120 }, (_, i) => 200 - i * 0.5);
  const c: Condition = { type: "macd", description: "momentum up", fastHours: 12, slowHours: 26, signalHours: 9, direction: "bullish" };
  assert.equal(evalCondition(c, series(up)).pass, true); // rising: MACD above signal
  assert.equal(evalCondition(c, series(down)).pass, false);
  assert.equal(evalCondition({ ...c, direction: "bearish" }, series(down)).pass, true);
  assert.equal(maxLookback(strategy({ entry: [c] })), 26 * 3 + 9);
});

test("volatility: daily volatility from hourly returns", () => {
  const calm = series(flat(49));
  const wild = series(Array.from({ length: 49 }, (_, i) => 100 * (1 + (i % 2 ? 0.03 : -0.03))));
  const c: Condition = { type: "volatility", description: "calm market", periodHours: 48, op: "lt", value: 4 };
  assert.equal(evalCondition(c, calm).pass, true);
  assert.equal(evalCondition(c, wild).pass, false);
  // 0.5% hourly swings are about 0.5% x 2 x sqrt(24) ≈ 4.9% a day.
  const v = dailyVolPct(zigzag(49), 48)!;
  assert.ok(v > 4 && v < 6, String(v));
});

test("risk levels size positions by volatility, capped by positionPct", () => {
  const closes = series(zigzag(60)); // ~4.9% daily volatility
  assert.deepEqual(sizePct(strategy({ positionPct: 50 }), closes), { pct: 50, note: null }); // no risk level: fixed
  const low = sizePct(strategy({ positionPct: 50, riskLevel: "low" }), closes).pct;
  const med = sizePct(strategy({ positionPct: 50, riskLevel: "medium" }), closes).pct;
  const high = sizePct(strategy({ positionPct: 50, riskLevel: "high" }), closes).pct;
  assert.ok(low < med && med < high, `${low} ${med} ${high}`);
  assert.ok(Math.abs(med - (0.5 / dailyVolPct(zigzag(60), 48)!) * 100) < 1e-9);
  // A calm market would allow more than the cap; the cap holds.
  assert.equal(sizePct(strategy({ positionPct: 20, riskLevel: "high" }), series(Array.from({ length: 60 }, (_, i) => 100 + (i % 2) * 0.01))).pct, 20);
  // Without history: half the cap.
  assert.equal(sizePct(strategy({ positionPct: 40, riskLevel: "low" }), series(flat(5))).pct, 20);
});

test("trailing and volatility stops follow the best price since entry", () => {
  const opened = 30 * H;
  const pos = [{ symbol: "NVDA", side: "long" as const, entryPrice: 100, openedAt: opened }];
  const path = [...flat(30), 104, 108, 112, 120, 117, 113];
  const closes = new Map([["NVDA", series(path)]]);
  const at = path.length * H;
  // Price 113 is 5.8% below the best close 120.
  assert.match(decide(strategy({ trailingStopPct: 5, stopLossPct: 50 }), closes, pos, at)[0]!.reason, /trailing stop/);
  assert.equal(decide(strategy({ trailingStopPct: 8, stopLossPct: 50 }), closes, pos, at).length, 0);
  // Average hourly move over 24h ≈ (4+4+4+8+3+4)/24 ≈ 1.125; 3x ≈ 3.4 below 120 is 116.6, and 113 is under it.
  assert.match(decide(strategy({ atrStopMultiple: 3, stopLossPct: 50 }), closes, pos, at)[0]!.reason, /volatility stop/);
  assert.equal(decide(strategy({ atrStopMultiple: 8, stopLossPct: 50 }), closes, pos, at).length, 0);
});

test("the drawdown limit stops new positions once equity falls far enough below its peak", () => {
  const now = 30 * H;
  const closes = new Map([["NVDA", series([...flat(25), 90], 0)]]);
  const base = {
    now,
    marketFor: () => ({ open: true, session: "regular" as const, reason: null }),
    assetClassOf: () => "equity" as const,
    policy: Policy.parse({}),
    active: true,
    closes,
    prices: new Map([["NVDA", 90]]),
    gateFor: () => ({ ok: true as const, price: 90, reason: null, secondPrice: null, gapBps: null }) as any,
  };
  const s = strategy({ maxDrawdownPct: 10 });
  const fresh = step({ account: { cash: 10_000, positions: [], peak: 10_000 }, day: 0, dayStartEquity: 10_000 }, { ...base, strategy: s });
  assert.equal(fresh.events.filter((e) => e.type === "decision" && e.outcome === "filled").length, 1);
  const down = step({ account: { cash: 8_500, positions: [], peak: 10_000 }, day: 0, dayStartEquity: 8_500 }, { ...base, strategy: s });
  const blocked = down.events.find((e) => e.type === "decision")!;
  assert.equal((blocked as any).why, "risk:drawdown_limit");
  assert.equal(down.state.account.peak, 10_000);
});

test("new fields: bounds, and the schema the brain fills still builds with them", () => {
  assert.deepEqual(checkBounds(strategy({ riskLevel: "low", trailingStopPct: 3, atrStopMultiple: 2, maxDrawdownPct: 15 }), new Set(["NVDA"])), []);
  assert.match(checkBounds(strategy({ trailingStopPct: 90 }), new Set(["NVDA"]))[0]!, /trailingStopPct/);
  assert.doesNotThrow(() => betaZodOutputFormat(Strategy));
  // Old stored strategies, without the new fields, still parse.
  assert.equal(Strategy.parse(strategy()).riskLevel, undefined);
});

test("the brain's flat conditions become the engine's conditions, and off-values become absent fields", async () => {
  const { fromBrain } = await import("../src/strategy/schema.ts");
  const flatC = (type: any, hours: number, hours2: number, hours3: number, op: "lt" | "gt", value: number) => ({ type, description: type, hours, hours2, hours3, op, value });
  const s = fromBrain({
    ...strategy(),
    entry: [
      flatC("change_pct", 24, 0, 0, "lt", -5),
      flatC("price_vs_sma", 48, 0, 0, "gt", 1.5),
      flatC("sma_cross", 12, 48, 0, "gt", 0),
      flatC("breakout", 48, 0, 0, "lt", 0),
      flatC("macd", 12, 26, 9, "gt", 0),
      flatC("volatility", 48, 0, 0, "lt", 5),
    ],
    exitConditions: [flatC("social_mood", 0, 0, 0, "lt", -0.3)],
    riskLevel: "none",
    trailingStopPct: 0,
    atrStopMultiple: 2,
    maxDrawdownPct: 0,
    endAfterMinutes: 2,
    endAtProfitPct: 0,
    endAtLossPct: -1.5,
  });
  assert.equal(s.endAfterMinutes, 2);
  assert.equal(s.endAtProfitPct, undefined);
  assert.equal(s.endAtLossPct, 1.5); // a loss written as a negative number still means 1.5%
  assert.deepEqual(s.entry.map((c) => c.type), ["change_pct", "price_vs_sma", "sma_cross", "breakout", "macd", "volatility"]);
  assert.deepEqual(s.entry[1], { type: "price_vs_sma", description: "price_vs_sma", periodHours: 48, op: "above", bandPct: 1.5 });
  assert.deepEqual(s.entry[2], { type: "sma_cross", description: "sma_cross", fastHours: 12, slowHours: 48, direction: "up" });
  assert.deepEqual(s.entry[3], { type: "breakout", description: "breakout", lookbackHours: 48, direction: "down" });
  assert.deepEqual(s.entry[4], { type: "macd", description: "macd", fastHours: 12, slowHours: 26, signalHours: 9, direction: "bullish" });
  assert.deepEqual(s.exitConditions[0], { type: "social_mood", description: "social_mood", op: "lt", value: -0.3 });
  assert.equal(s.riskLevel, undefined);
  assert.equal(s.trailingStopPct, undefined);
  assert.equal(s.atrStopMultiple, 2);
  assert.deepEqual(Strategy.parse(s), s); // a valid stored strategy
});
