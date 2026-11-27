/**
 * Hourly closes built from Chainlink rounds. The close of an hour is the latest round whose
 * updatedAt is at or before the end of that hour. Each close keeps its round id, so every
 * number an agent saw can be traced to a round that anyone can re-read on chain.
 */

export interface RoundPoint {
  roundId: string;
  price: number;
  /** Unix seconds. */
  updatedAt: number;
}

export interface HourClose {
  /** Unix seconds at the end of the hour. */
  hourEnd: number;
  price: number;
  roundId: string;
}

export const HOUR = 3600;
export const hourFloor = (t: number) => t - (((t % HOUR) + HOUR) % HOUR);

/**
 * End times of the last `count` hours in which the market was open, oldest first. The hour
 * containing `now` counts when it is open. Closed hours (nights are open, weekends and
 * holidays are not) are skipped, so a 24-hour window always means 24 hours of trading.
 */
export function openHourEnds(now: number, count: number, isOpenHour: (hourEnd: number) => boolean): number[] {
  const ends: number[] = [];
  // Scan far enough back to cross a long weekend plus a holiday at the longest windows.
  const maxScan = count * 2 + 24 * 6;
  for (let end = hourFloor(now) + HOUR, i = 0; ends.length < count && i < maxScan; end -= HOUR, i++) {
    if (isOpenHour(end)) ends.push(end);
  }
  return ends.reverse();
}

/**
 * Close of each given hour: the latest round at or before the hour's end (or `now`, for the
 * hour still running). `rounds` must be sorted by updatedAt ascending. Hours before the first
 * round are left out.
 */
export function closesAt(rounds: readonly RoundPoint[], hourEnds: readonly number[], now: number): HourClose[] {
  const out: HourClose[] = [];
  let j = -1;
  for (const end of hourEnds) {
    const cutoff = Math.min(end, now);
    while (j + 1 < rounds.length && rounds[j + 1]!.updatedAt <= cutoff) j++;
    if (j >= 0) out.push({ hourEnd: end, price: rounds[j]!.price, roundId: rounds[j]!.roundId });
  }
  return out;
}

/** Every hour counted (no calendar). Kept for tests and for 24/7 assets. */
export function hourlyCloses(rounds: readonly RoundPoint[], now: number, hours: number): HourClose[] {
  return closesAt(rounds, openHourEnds(now, hours, () => true), now);
}

export function sma(values: readonly number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i]!;
  return s / period;
}

/**
 * RSI from simple averages of the last `period` gains and losses (Cutler's RSI, not
 * Wilder's smoothed version). It depends only on the window, so it is easy to recompute
 * from the rounds a receipt names. Needs period + 1 values.
 */
export function rsi(values: readonly number[], period: number): number | null {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  const rs = gain / period / (loss / period);
  return 100 - 100 / (1 + rs);
}

/** Exponential moving average over the whole series (seeded with the first value); null when too short. */
export function ema(values: readonly number[], period: number): number[] | null {
  if (period <= 0 || values.length < period) return null;
  const k = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

/** Sample standard deviation of the last `period` values; null when too short. */
export function stdev(values: readonly number[], period: number): number | null {
  if (period < 2 || values.length < period) return null;
  const w = values.slice(-period);
  const m = w.reduce((a, b) => a + b, 0) / period;
  return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (period - 1));
}

/**
 * Daily volatility in percent from the last `period` hourly returns: the standard deviation of
 * hourly log returns scaled by the square root of 24. The same measure for stocks and crypto,
 * so one threshold means one thing everywhere.
 */
export function dailyVolPct(values: readonly number[], period: number): number | null {
  if (values.length < period + 1) return null;
  const w = values.slice(-(period + 1));
  const r: number[] = [];
  for (let i = 1; i < w.length; i++) r.push(Math.log(w[i]! / w[i - 1]!));
  const s = stdev(r, r.length);
  return s === null ? null : s * Math.sqrt(24) * 100;
}

/** Average absolute hourly move over the last `period` hours (a close-only true range). */
export function atr(values: readonly number[], period: number): number | null {
  if (values.length < period + 1) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += Math.abs(values[i]! - values[i - 1]!);
  return sum / period;
}
