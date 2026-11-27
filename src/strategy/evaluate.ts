import type { Condition, Strategy } from "./schema.ts";
import { atr, dailyVolPct, ema, rsi, sma, stdev, type HourClose } from "./series.ts";

/** "lt" and "gt" as words, for the reasons people read. */
const word = (op: "lt" | "gt") => (op === "lt" ? "below" : "above");

export interface ConditionResult {
  type: Condition["type"];
  pass: boolean;
  /** The measured value, null when there was not enough history. */
  value: number | null;
  detail: string;
  /** For social_mood: the sealed reading it was decided on. */
  reading?: { id: number; leaf: string; at: number };
}

/**
 * A sealed reading of the mood of recent posts about one symbol (signals/social.ts), as the
 * engine hands it to an agent: only readings recent enough to use, never one from the future.
 */
export interface MoodReading {
  id: number;
  /** Receipt leaf the reading was sealed under. */
  leaf: string;
  score: number;
  posts: number;
  at: number;
}
export type MoodOf = (symbol: string) => MoodReading | null;

/** Fewer posts than this say too little; the condition does not pass on them. */
export const MIN_MOOD_POSTS = 3;

/** Evaluates one condition on hourly closes (oldest first). Missing history never passes. */
export function evalCondition(c: Condition, closes: readonly HourClose[], mood: MoodReading | null = null): ConditionResult {
  const px = closes.map((x) => x.price);
  const last = px.at(-1);
  const miss = (detail: string): ConditionResult => ({ type: c.type, pass: false, value: null, detail });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (c.type === "social_mood") {
    if (!mood) return miss("no recent reading of posts on X");
    const reading = { id: mood.id, leaf: mood.leaf, at: mood.at };
    if (mood.posts < MIN_MOOD_POSTS) return { type: c.type, pass: false, value: null, detail: `only ${mood.posts} post(s) on X, too few to read a mood`, reading };
    const pass = c.op === "lt" ? mood.score < c.value : mood.score > c.value;
    return { type: c.type, pass, value: r2(mood.score), detail: `mood ${r2(mood.score)} from ${mood.posts} posts on X (needs ${word(c.op)} ${c.value})`, reading };
  }
  if (c.type === "now") return last === undefined ? miss("no price yet") : { type: c.type, pass: true, value: null, detail: "enter at the first check" };
  if (last === undefined) return miss("no prices");

  switch (c.type) {
    case "change_pct": {
      if (px.length < c.lookbackHours + 1) return miss(`need ${c.lookbackHours + 1}h of history`);
      const base = px[px.length - 1 - c.lookbackHours]!;
      const chg = ((last - base) / base) * 100;
      const pass = c.op === "lt" ? chg < c.value : chg > c.value;
      return { type: c.type, pass, value: r2(chg), detail: `${r2(chg)}% over ${c.lookbackHours}h (needs ${word(c.op)} ${c.value}%)` };
    }
    case "below_high_pct": {
      if (px.length < c.lookbackHours) return miss(`need ${c.lookbackHours}h of history`);
      const hi = Math.max(...px.slice(-c.lookbackHours));
      const below = ((hi - last) / hi) * 100;
      return { type: c.type, pass: below >= c.value, value: r2(below), detail: `${r2(below)}% below ${c.lookbackHours}h high (need ${c.value}%)` };
    }
    case "price_vs_sma": {
      const avg = sma(px, c.periodHours);
      if (avg === null) return miss(`need ${c.periodHours}h of history`);
      const dist = ((last - avg) / avg) * 100;
      const pass = c.op === "above" ? dist > c.bandPct : dist < -c.bandPct;
      return { type: c.type, pass, value: r2(dist), detail: `${r2(dist)}% vs ${c.periodHours}h average (needs ${c.op} ${c.bandPct}%)` };
    }
    case "sma_cross": {
      const prev = px.slice(0, -1);
      const f1 = sma(px, c.fastHours), s1 = sma(px, c.slowHours);
      const f0 = sma(prev, c.fastHours), s0 = sma(prev, c.slowHours);
      if (f1 === null || s1 === null || f0 === null || s0 === null) return miss(`need ${c.slowHours + 1}h of history`);
      const pass = c.direction === "up" ? f0 <= s0 && f1 > s1 : f0 >= s0 && f1 < s1;
      return { type: c.type, pass, value: r2(((f1 - s1) / s1) * 100), detail: `${c.fastHours}h/${c.slowHours}h average cross ${c.direction}` };
    }
    case "breakout": {
      if (px.length < c.lookbackHours + 1) return miss(`need ${c.lookbackHours + 1}h of history`);
      const prev = px.slice(-(c.lookbackHours + 1), -1);
      const level = c.direction === "up" ? Math.max(...prev) : Math.min(...prev);
      const pass = c.direction === "up" ? last > level : last < level;
      return { type: c.type, pass, value: r2(((last - level) / level) * 100), detail: `${r2(last)} vs ${c.lookbackHours}h ${c.direction === "up" ? "high" : "low"} ${r2(level)}` };
    }
    case "zscore": {
      const avg = sma(px, c.periodHours);
      const sd = stdev(px, c.periodHours);
      if (avg === null || sd === null) return miss(`need ${c.periodHours}h of history`);
      if (sd === 0) return miss("price did not move in the window");
      const z = (last - avg) / sd;
      const pass = c.op === "lt" ? z < c.value : z > c.value;
      return { type: c.type, pass, value: r2(z), detail: `${r2(z)} standard deviations from the ${c.periodHours}h average (needs ${word(c.op)} ${c.value})` };
    }
    case "macd": {
      const need = c.slowHours + c.signalHours;
      if (px.length < need) return miss(`need ${need}h of history`);
      const f = ema(px, c.fastHours)!;
      const sl = ema(px, c.slowHours)!;
      const line = f.map((v, i) => v - sl[i]!);
      const sig = ema(line, c.signalHours)!;
      const hist = line.at(-1)! - sig.at(-1)!;
      const pass = c.direction === "bullish" ? hist > 0 : hist < 0;
      return { type: c.type, pass, value: r2((hist / last) * 100), detail: `MACD ${hist >= 0 ? "above" : "below"} its signal (${c.fastHours}/${c.slowHours}/${c.signalHours})` };
    }
    case "volatility": {
      const v = dailyVolPct(px, c.periodHours);
      if (v === null) return miss(`need ${c.periodHours + 1}h of history`);
      const pass = c.op === "lt" ? v < c.value : v > c.value;
      return { type: c.type, pass, value: r2(v), detail: `daily volatility ${r2(v)}% over ${c.periodHours}h (needs ${word(c.op)} ${c.value}%)` };
    }
    case "rsi": {
      const v = rsi(px, c.periodHours);
      if (v === null) return miss(`need ${c.periodHours + 1}h of history`);
      const pass = c.op === "lt" ? v < c.value : v > c.value;
      return { type: c.type, pass, value: r2(v), detail: `RSI(${c.periodHours}h) ${r2(v)} (needs ${word(c.op)} ${c.value})` };
    }
  }
}

export interface OpenPosition {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  /** Unix seconds. */
  openedAt: number;
}

export type Signal =
  | { kind: "open"; symbol: string; side: "long" | "short"; reason: string; checks: ConditionResult[] }
  | { kind: "close"; symbol: string; reason: string; checks: ConditionResult[] };

/**
 * Pure decision step: given closes per symbol and current positions, which positions to
 * close and which to open. No I/O, so a decision can be replayed exactly from its inputs.
 */
export function decide(
  s: Strategy,
  closesBySymbol: ReadonlyMap<string, readonly HourClose[]>,
  positions: readonly OpenPosition[],
  now: number,
  /** Symbols that may not be opened this tick (re-entry cooldown). */
  noEntry: ReadonlySet<string> = new Set(),
  /** Mood readings per symbol, for social_mood conditions; none means they do not pass. */
  moodOf: MoodOf = () => null,
): Signal[] {
  const out: Signal[] = [];
  const held = new Map(positions.map((p) => [p.symbol, p]));

  for (const p of positions) {
    const closes = closesBySymbol.get(p.symbol) ?? [];
    const last = closes.at(-1)?.price;
    if (last === undefined) continue;
    const pnlPct = ((last - p.entryPrice) / p.entryPrice) * 100 * (p.side === "long" ? 1 : -1);
    if (pnlPct <= -s.stopLossPct) {
      out.push({ kind: "close", symbol: p.symbol, reason: `stop loss: ${pnlPct.toFixed(2)}%`, checks: [] });
      continue;
    }
    if (s.takeProfitPct > 0 && pnlPct >= s.takeProfitPct) {
      out.push({ kind: "close", symbol: p.symbol, reason: `take profit: ${pnlPct.toFixed(2)}%`, checks: [] });
      continue;
    }
    if (s.maxHoldHours > 0 && now - p.openedAt >= s.maxHoldHours * 3600) {
      out.push({ kind: "close", symbol: p.symbol, reason: `held ${s.maxHoldHours}h`, checks: [] });
      continue;
    }
    // Stops that follow the price: from the best close since entry (highest for a long).
    if (s.trailingStopPct || s.atrStopMultiple) {
      const since = closes.filter((c) => c.hourEnd > p.openedAt).map((c) => c.price);
      const long = p.side === "long";
      const best = long ? Math.max(p.entryPrice, last, ...since) : Math.min(p.entryPrice, last, ...since);
      if (s.trailingStopPct) {
        const from = (long ? (best - last) / best : (last - best) / best) * 100;
        if (from >= s.trailingStopPct) {
          out.push({ kind: "close", symbol: p.symbol, reason: `trailing stop: ${from.toFixed(2)}% from the best price ${best.toFixed(2)}`, checks: [] });
          continue;
        }
      }
      if (s.atrStopMultiple) {
        const a = atr(closes.map((c) => c.price), 24);
        if (a !== null && (long ? last <= best - s.atrStopMultiple * a : last >= best + s.atrStopMultiple * a)) {
          out.push({ kind: "close", symbol: p.symbol, reason: `volatility stop: ${s.atrStopMultiple} x average move (${a.toFixed(4)}) from the best price ${best.toFixed(2)}`, checks: [] });
          continue;
        }
      }
    }
    const exits = s.exitConditions.map((c) => evalCondition(c, closes, c.type === "social_mood" ? moodOf(p.symbol) : null));
    const hit = exits.find((r) => r.pass);
    if (hit) out.push({ kind: "close", symbol: p.symbol, reason: `exit rule: ${hit.detail}`, checks: exits });
  }

  const closing = new Set(out.map((o) => o.symbol));
  let open = positions.length - closing.size;
  for (const sym of s.symbols) {
    if (open >= s.maxOpenPositions) break;
    if (held.has(sym) || closing.has(sym) || noEntry.has(sym)) continue;
    const closes = closesBySymbol.get(sym) ?? [];
    const checks = s.entry.map((c) => evalCondition(c, closes, c.type === "social_mood" ? moodOf(sym) : null));
    if (checks.length > 0 && checks.every((r) => r.pass)) {
      out.push({ kind: "open", symbol: sym, side: s.side, reason: checks.map((r) => r.detail).join("; "), checks });
      open++;
    }
  }
  return out;
}
