/**
 * Honest numbers for a backtest. A return alone says little: these say how bumpy the path was
 * (Sharpe, Sortino), how deep it fell (Calmar), how wins compare with losses (profit factor),
 * how likely the edge is real rather than luck (probabilistic Sharpe), and how much of it
 * survives having tried several versions and kept the best (deflated Sharpe).
 *
 * Probabilistic and deflated Sharpe follow Bailey and López de Prado: the Sharpe ratio is
 * corrected for the number of observations, skewness and fat tails, and, for the deflated
 * version, for the best of N trials being expected to look good by chance alone.
 */

const EULER = 0.5772156649015329;

/** Standard normal cumulative distribution (Abramowitz–Stegun 7.1.26, error < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Inverse of the standard normal distribution (Acklam's rational approximation, error < 1.2e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

function moments(r: number[]) {
  const n = r.length;
  const mean = r.reduce((a, b) => a + b, 0) / n;
  const m2 = r.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(m2);
  const skew = sd > 0 ? r.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / n : 0;
  const kurt = sd > 0 ? r.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / n : 3;
  return { n, mean, sd, skew, kurt };
}

/**
 * Probability that the true Sharpe ratio (per period) is above `benchmark`, given the observed
 * one over n periods with the given skewness and kurtosis.
 */
export function probabilisticSharpe(sr: number, n: number, skew: number, kurt: number, benchmark = 0): number {
  if (n < 3) return 0.5;
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return normCdf(((sr - benchmark) * Math.sqrt(n - 1)) / denom);
}

/**
 * The Sharpe ratio (per period) the best of `trials` strategies would reach by luck alone, when
 * the trials' Sharpe ratios vary with variance `variance`.
 */
export function expectedMaxSharpe(trials: number, variance: number): number {
  if (trials <= 1 || variance <= 0) return 0;
  const sd = Math.sqrt(variance);
  return sd * ((1 - EULER) * normInv(1 - 1 / trials) + EULER * normInv(1 - 1 / (trials * Math.E)));
}

export interface Metrics {
  /** Annualized, from hourly returns. Null with too few hours or no movement. */
  sharpe: number | null;
  sortino: number | null;
  /** Annualized return over the deepest fall. */
  calmar: number | null;
  /** Gross profit over gross loss of closed trades; null without a losing trade. */
  profitFactor: number | null;
  /** Probability the true Sharpe is above zero (0..1). */
  probabilisticSharpe: number | null;
  /** Per-period Sharpe and its moments, kept for deflating across trials. */
  raw: { sr: number; n: number; skew: number; kurt: number } | null;
}

/**
 * Metrics from an hourly equity curve and the trades. `hoursPerYear` is how many replayed hours
 * a year holds for these markets (8760 for crypto, fewer for stocks that close).
 */
export function metricsOf(curve: ReadonlyArray<readonly [number, number]>, trades: ReadonlyArray<{ pnl: number }>, maxDrawdownPct: number, hoursPerYear: number): Metrics {
  const r: number[] = [];
  for (let i = 1; i < curve.length; i++) r.push(curve[i]![1] / curve[i - 1]![1] - 1);
  const wins = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const losses = -trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  const profitFactor = losses > 0 ? Math.round((wins / losses) * 100) / 100 : null;
  if (r.length < 24) return { sharpe: null, sortino: null, calmar: null, profitFactor, probabilisticSharpe: null, raw: null };
  const m = moments(r);
  if (m.sd === 0) return { sharpe: null, sortino: null, calmar: null, profitFactor, probabilisticSharpe: null, raw: null };
  const ann = Math.sqrt(hoursPerYear);
  const down = Math.sqrt(r.reduce((a, x) => a + Math.min(0, x) ** 2, 0) / r.length);
  const total = curve.at(-1)![1] / curve[0]![1] - 1;
  const years = r.length / hoursPerYear;
  const annualReturn = years > 0 ? Math.sign(1 + total) * Math.abs(1 + total) ** (1 / years) - 1 : 0;
  const sr = m.mean / m.sd;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    sharpe: r2(sr * ann),
    sortino: down > 0 ? r2((m.mean / down) * ann) : null,
    calmar: maxDrawdownPct > 0 ? r2((annualReturn * 100) / maxDrawdownPct) : null,
    profitFactor,
    probabilisticSharpe: Math.round(probabilisticSharpe(sr, m.n, m.skew, m.kurt) * 1000) / 1000,
    raw: { sr, n: m.n, skew: m.skew, kurt: m.kurt },
  };
}

/**
 * Deflated Sharpe: the probability that the chosen trial's edge is real after accounting for
 * all the trials it was chosen from. `all` are the per-period Sharpe ratios of every trial.
 */
export function deflatedSharpe(chosen: NonNullable<Metrics["raw"]>, all: number[]): number {
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const variance = all.length > 1 ? all.reduce((a, b) => a + (b - mean) ** 2, 0) / (all.length - 1) : 0;
  return Math.round(probabilisticSharpe(chosen.sr, chosen.n, chosen.skew, chosen.kurt, expectedMaxSharpe(all.length, variance)) * 1000) / 1000;
}
