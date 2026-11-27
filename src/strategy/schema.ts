import { z } from "zod";

/**
 * The rules language an agent runs. A written strategy is compiled into this by the brain;
 * the engine only ever executes this structure, never free text.
 * All lookbacks are in hours and are computed on hourly closes built from Chainlink rounds.
 */

export const Condition = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("change_pct"),
    description: z.string().describe("Plain-language meaning of this condition"),
    lookbackHours: z.number().describe("Window in hours, e.g. 24 for one day"),
    op: z.enum(["lt", "gt"]),
    value: z.number().describe("Percent change, e.g. -5 for a 5% drop"),
  }),
  z.object({
    type: z.literal("below_high_pct"),
    description: z.string(),
    lookbackHours: z.number(),
    value: z.number().describe("Price is at least this many percent below the window high, e.g. 5"),
  }),
  z.object({
    type: z.literal("price_vs_sma"),
    description: z.string(),
    periodHours: z.number(),
    op: z.enum(["above", "below"]),
    bandPct: z.number().describe("Distance from the average in percent; 0 means just above or below"),
  }),
  z.object({
    type: z.literal("sma_cross"),
    description: z.string(),
    fastHours: z.number(),
    slowHours: z.number(),
    direction: z.enum(["up", "down"]).describe("up: fast average crossed above slow in the last hour"),
  }),
  z.object({
    type: z.literal("rsi"),
    description: z.string(),
    periodHours: z.number(),
    op: z.enum(["lt", "gt"]),
    value: z.number(),
  }),
  z.object({
    type: z.literal("now"),
    description: z.string().describe("Enter at the first check, without waiting for a price condition"),
  }),
  z.object({
    type: z.literal("breakout"),
    description: z.string(),
    lookbackHours: z.number().describe("Window of the high or low that must be broken, e.g. 48"),
    direction: z.enum(["up", "down"]).describe("up: price above the highest close of the window before it; down: below the lowest"),
  }),
  z.object({
    type: z.literal("zscore"),
    description: z.string(),
    periodHours: z.number(),
    op: z.enum(["lt", "gt"]),
    value: z.number().describe("Standard deviations from the moving average, e.g. -2 for a stretched dip (Bollinger lower band)"),
  }),
  z.object({
    type: z.literal("macd"),
    description: z.string(),
    fastHours: z.number().describe("Usually 12"),
    slowHours: z.number().describe("Usually 26"),
    signalHours: z.number().describe("Usually 9"),
    direction: z.enum(["bullish", "bearish"]).describe("bullish: MACD above its signal line; bearish: below"),
  }),
  z.object({
    type: z.literal("volatility"),
    description: z.string(),
    periodHours: z.number().describe("Window of hourly returns, e.g. 48"),
    op: z.enum(["lt", "gt"]),
    value: z.number().describe("Daily volatility in percent, e.g. 4 (calm crypto is about 2 to 3, wild is above 5; large stocks about 1 to 2)"),
  }),
  z.object({
    type: z.literal("social_mood"),
    description: z.string(),
    op: z.enum(["lt", "gt"]),
    value: z
      .number()
      .describe("Mood of recent posts about the symbol on X, from -1 (very negative) to 1 (very positive); 0 is neutral. Read about every 6 hours over the last 24 hours."),
  }),
]);
export type Condition = z.infer<typeof Condition>;

export const Strategy = z.object({
  name: z.string().describe("Short name for the agent"),
  summary: z.string().describe("One sentence restating what the user asked for"),
  symbols: z.array(z.string()).describe("Tickers to trade, only from the allowed list"),
  side: z.enum(["long", "short"]).describe("short needs the perp venue"),
  entry: z.array(Condition).describe("All must hold to open a position"),
  exitConditions: z.array(Condition).describe("Any one closes the position; may be empty"),
  stopLossPct: z.number().describe("Close when the position loses this percent of entry price"),
  takeProfitPct: z.number().describe("Close when the position gains this percent; 0 for none"),
  maxHoldHours: z.number().describe("Close after this many hours; 0 for no limit"),
  positionPct: z.number().describe("Percent of equity per position"),
  maxOpenPositions: z.number(),
  leverage: z.number().describe("1 for spot; above 1 uses perps"),
  riskLevel: z
    .enum(["low", "medium", "high"])
    .optional()
    .describe("Sizes each position by the market's volatility so it risks about 0.25% (low), 0.5% (medium) or 1% (high) of equity on a typical day; positionPct is then the most it may use. Leave out for a fixed size."),
  trailingStopPct: z.number().optional().describe("Closes when price falls this many percent from its best since entry (for a long); leave out for none"),
  atrStopMultiple: z.number().optional().describe("Closes when price falls this many times its average hourly move (24h) below its best since entry; adapts the stop to volatility; leave out for none"),
  maxDrawdownPct: z.number().optional().describe("Stops opening new positions once equity is this many percent below its highest point; leave out for none"),
  endAfterMinutes: z.number().optional().describe("Ends the run this many minutes after it starts: closes every position and stops (money agents hand the funds back)"),
  endAtProfitPct: z.number().optional().describe("Ends the run once the total return reaches this many percent"),
  endAtLossPct: z.number().optional().describe("Ends the run once the total loss reaches this many percent"),
  notes: z.array(z.string()).describe("Anything in the request that could not be expressed, or was changed to fit limits"),
});
export type Strategy = z.infer<typeof Strategy>;

/**
 * The shape the brain fills. The API compiles the output schema into a grammar, and ten
 * differently shaped condition types (used twice) plus optional fields make it too large. So
 * the brain writes every condition in one flat shape and every strategy field as required,
 * with "none" or 0 for off; fromBrain() turns that into the stored Strategy above.
 */
const CONDITION_TYPES = ["now", "change_pct", "below_high_pct", "price_vs_sma", "sma_cross", "rsi", "breakout", "zscore", "macd", "volatility", "social_mood"] as const;
export const BrainCondition = z.object({
  type: z.enum(CONDITION_TYPES),
  description: z.string().describe("Plain-language meaning of this condition"),
  hours: z
    .number()
    .describe(
      "Window in hours: lookback for change_pct, below_high_pct and breakout; period for price_vs_sma, rsi, zscore and volatility; the fast average for sma_cross and macd; 0 for now and social_mood",
    ),
  hours2: z.number().describe("The slow average for sma_cross and macd (e.g. 26); 0 otherwise"),
  hours3: z.number().describe("The signal line for macd (e.g. 9); 0 otherwise"),
  op: z
    .enum(["lt", "gt"])
    .describe(
      "lt or gt for change_pct, rsi, zscore, volatility and social_mood. price_vs_sma: gt above, lt below. sma_cross: gt crossed up, lt crossed down. breakout: gt new high, lt new low. macd: gt bullish, lt bearish. below_high_pct: gt",
    ),
  value: z
    .number()
    .describe(
      "Threshold: percent for change_pct (e.g. -5) and below_high_pct (e.g. 5); band percent for price_vs_sma (0 means just above or below); RSI level; standard deviations for zscore (e.g. -2); daily volatility percent for volatility; -1 to 1 for social_mood; 0 for sma_cross, breakout and macd",
    ),
});
export type BrainCondition = z.infer<typeof BrainCondition>;

export const BrainStrategy = Strategy.extend({
  entry: z.array(BrainCondition).describe("All must hold to open a position"),
  exitConditions: z.array(BrainCondition).describe("Any one closes the position; may be empty"),
  riskLevel: z
    .enum(["none", "low", "medium", "high"])
    .describe("none: fixed size. low, medium, high: each position sized by volatility to risk about 0.25%, 0.5% or 1% of equity on a typical day, with positionPct as the cap"),
  trailingStopPct: z.number().describe("Closes when price falls this many percent from its best since entry; 0 for none"),
  atrStopMultiple: z.number().describe("Closes when price falls this many average hourly moves below its best since entry; 0 for none"),
  maxDrawdownPct: z.number().describe("Stops opening positions once equity is this many percent below its peak; 0 for none"),
  endAfterMinutes: z.number().describe("Ends the whole run this many minutes after it starts (closes positions, stops); 0 for no time limit"),
  endAtProfitPct: z.number().describe("Ends the whole run once the total return reaches this percent; 0 for none"),
  endAtLossPct: z.number().describe("Ends the whole run once the total loss reaches this percent (a positive number); 0 for none"),
});
export type BrainStrategy = z.infer<typeof BrainStrategy>;

/** One flat condition from the brain as the engine's condition. */
export function conditionFromBrain(c: BrainCondition): Condition {
  const d = c.description;
  switch (c.type) {
    case "now":
      return { type: c.type, description: d };
    case "change_pct":
      return { type: c.type, description: d, lookbackHours: c.hours, op: c.op, value: c.value };
    case "below_high_pct":
      return { type: c.type, description: d, lookbackHours: c.hours, value: c.value };
    case "price_vs_sma":
      return { type: c.type, description: d, periodHours: c.hours, op: c.op === "gt" ? "above" : "below", bandPct: Math.abs(c.value) };
    case "sma_cross":
      return { type: c.type, description: d, fastHours: c.hours, slowHours: c.hours2, direction: c.op === "gt" ? "up" : "down" };
    case "rsi":
      return { type: c.type, description: d, periodHours: c.hours, op: c.op, value: c.value };
    case "breakout":
      return { type: c.type, description: d, lookbackHours: c.hours, direction: c.op === "gt" ? "up" : "down" };
    case "zscore":
      return { type: c.type, description: d, periodHours: c.hours, op: c.op, value: c.value };
    case "macd":
      return { type: c.type, description: d, fastHours: c.hours, slowHours: c.hours2, signalHours: c.hours3, direction: c.op === "gt" ? "bullish" : "bearish" };
    case "volatility":
      return { type: c.type, description: d, periodHours: c.hours, op: c.op, value: c.value };
    case "social_mood":
      return { type: c.type, description: d, op: c.op, value: c.value };
  }
}

export function fromBrain(b: BrainStrategy): Strategy {
  const { riskLevel, trailingStopPct, atrStopMultiple, maxDrawdownPct, endAfterMinutes, endAtProfitPct, endAtLossPct, entry, exitConditions, ...rest } = b;
  return {
    ...rest,
    entry: entry.map(conditionFromBrain),
    exitConditions: exitConditions.map(conditionFromBrain),
    ...(riskLevel !== "none" ? { riskLevel } : {}),
    ...(trailingStopPct > 0 ? { trailingStopPct } : {}),
    ...(atrStopMultiple > 0 ? { atrStopMultiple } : {}),
    ...(maxDrawdownPct > 0 ? { maxDrawdownPct } : {}),
    ...(endAfterMinutes > 0 ? { endAfterMinutes } : {}),
    ...(endAtProfitPct > 0 ? { endAtProfitPct } : {}),
    ...(endAtLossPct !== 0 ? { endAtLossPct: Math.abs(endAtLossPct) } : {}),
  };
}

/** Hard bounds, checked after parsing. Kept separate from the schema sent to the model. */
/** Condition types that read posts on X instead of prices; held to the tiers that include them. */
export const usesSocial = (s: Pick<Strategy, "entry" | "exitConditions">) => [...s.entry, ...s.exitConditions].some((c) => c.type === "social_mood");

export const BOUNDS = {
  lookbackHours: [1, 24 * 30],
  symbols: [1, 10],
  conditions: [1, 6],
  stopLossPct: [0.5, 50],
  takeProfitPct: [0, 500],
  maxHoldHours: [0, 24 * 90],
  positionPct: [1, 100],
  maxOpenPositions: [1, 10],
  leverage: [1, 10],
  trailingStopPct: [0.5, 50],
  atrStopMultiple: [0.5, 10],
  maxDrawdownPct: [1, 80],
  endAfterMinutes: [1, 60 * 24 * 90],
  endAtProfitPct: [0.1, 1000],
  endAtLossPct: [0.1, 100],
} as const;

export function checkBounds(s: Strategy, allowedSymbols: ReadonlySet<string>): string[] {
  const errs: string[] = [];
  const within = (name: string, v: number, [lo, hi]: readonly [number, number]) => {
    if (!(v >= lo && v <= hi)) errs.push(`${name} must be between ${lo} and ${hi} (got ${v})`);
  };
  within("symbols count", s.symbols.length, BOUNDS.symbols);
  within("entry conditions", s.entry.length, BOUNDS.conditions);
  for (const sym of s.symbols) if (!allowedSymbols.has(sym)) errs.push(`unknown symbol ${sym}`);
  within("stopLossPct", s.stopLossPct, BOUNDS.stopLossPct);
  within("takeProfitPct", s.takeProfitPct, BOUNDS.takeProfitPct);
  within("maxHoldHours", s.maxHoldHours, BOUNDS.maxHoldHours);
  within("positionPct", s.positionPct, BOUNDS.positionPct);
  within("maxOpenPositions", s.maxOpenPositions, BOUNDS.maxOpenPositions);
  within("leverage", s.leverage, BOUNDS.leverage);
  if (s.trailingStopPct !== undefined) within("trailingStopPct", s.trailingStopPct, BOUNDS.trailingStopPct);
  if (s.atrStopMultiple !== undefined) within("atrStopMultiple", s.atrStopMultiple, BOUNDS.atrStopMultiple);
  if (s.maxDrawdownPct !== undefined) within("maxDrawdownPct", s.maxDrawdownPct, BOUNDS.maxDrawdownPct);
  if (s.endAfterMinutes !== undefined) within("endAfterMinutes", s.endAfterMinutes, BOUNDS.endAfterMinutes);
  if (s.endAtProfitPct !== undefined) within("endAtProfitPct", s.endAtProfitPct, BOUNDS.endAtProfitPct);
  if (s.endAtLossPct !== undefined) within("endAtLossPct", s.endAtLossPct, BOUNDS.endAtLossPct);
  for (const c of [...s.entry, ...s.exitConditions]) {
    if (c.type === "now") continue;
    if (c.type === "social_mood") {
      within("social_mood value", c.value, [-1, 1]);
      continue;
    }
    const hours =
      c.type === "price_vs_sma" || c.type === "rsi" || c.type === "zscore" || c.type === "volatility"
        ? [c.periodHours]
        : c.type === "sma_cross"
          ? [c.fastHours, c.slowHours]
          : c.type === "macd"
            ? [c.fastHours, c.slowHours, c.signalHours]
            : [c.lookbackHours];
    for (const h of hours) within(`${c.type} window`, h, BOUNDS.lookbackHours);
    if (c.type === "sma_cross" && c.fastHours >= c.slowHours) errs.push("sma_cross fastHours must be less than slowHours");
    if (c.type === "macd" && c.fastHours >= c.slowHours) errs.push("macd fastHours must be less than slowHours");
    if (c.type === "zscore" && c.periodHours < 2) errs.push("zscore needs a window of at least 2 hours");
    if (c.type === "volatility" && c.periodHours < 2) errs.push("volatility needs a window of at least 2 hours");
  }
  return errs;
}

/** Longest window any condition needs, used to decide how much history to load. */
export function maxLookback(s: Strategy): number {
  // Volatility sizing and the volatility stop read the last 48 and 24 hourly moves.
  let m = s.riskLevel ? 49 : s.atrStopMultiple ? 25 : 1;
  for (const c of [...s.entry, ...s.exitConditions]) {
    if (c.type === "breakout") m = Math.max(m, c.lookbackHours + 1);
    if (c.type === "zscore") m = Math.max(m, c.periodHours);
    if (c.type === "volatility") m = Math.max(m, c.periodHours + 1);
    // EMAs need a few times their length to settle.
    if (c.type === "macd") m = Math.max(m, c.slowHours * 3 + c.signalHours);
    if (c.type === "change_pct" || c.type === "below_high_pct") m = Math.max(m, c.lookbackHours);
    if (c.type === "price_vs_sma") m = Math.max(m, c.periodHours);
    if (c.type === "rsi") m = Math.max(m, c.periodHours + 1);
    if (c.type === "sma_cross") m = Math.max(m, c.slowHours + 1);
  }
  return m;
}
