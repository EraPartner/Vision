/**
 * Technical-indicator math for the Research chart builder (ADR-081).
 *
 * Pure functions over numeric close series. Each returns an array aligned to the
 * input length with `null` during the warm-up period (so it overlays a price
 * series 1:1 by index). Computed client-side from already-fetched chart points —
 * no extra provider quota.
 */

/** Simple moving average. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` points. */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface BollingerBands {
  middle: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
}

/** Bollinger Bands: SMA(period) ± mult × population stdev over the same window. */
export function bollinger(values: number[], period = 20, mult = 2): BollingerBands {
  const middle = sma(values, period);
  const upper: (number | null)[] = new Array(values.length).fill(null);
  const lower: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const mid = middle[i];
    if (mid == null) continue;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - mid) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = mid + mult * sd;
    lower[i] = mid - mult * sd;
  }
  return { middle, upper, lower };
}

/** Wilder's Relative Strength Index (0–100). */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface Macd {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

/** MACD line (EMAfast − EMAslow), signal (EMA of MACD), and histogram. */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine: (number | null)[] = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? (emaFast[i] as number) - (emaSlow[i] as number) : null,
  );

  const signal: (number | null)[] = new Array(values.length).fill(null);
  const firstValid = macdLine.findIndex((v) => v != null);
  if (firstValid >= 0 && values.length - firstValid >= signalPeriod) {
    const k = 2 / (signalPeriod + 1);
    let seed = 0;
    for (let i = firstValid; i < firstValid + signalPeriod; i++) seed += macdLine[i] as number;
    let prev = seed / signalPeriod;
    signal[firstValid + signalPeriod - 1] = prev;
    for (let i = firstValid + signalPeriod; i < values.length; i++) {
      prev = (macdLine[i] as number) * k + prev * (1 - k);
      signal[i] = prev;
    }
  }

  const histogram: (number | null)[] = values.map((_, i) =>
    macdLine[i] != null && signal[i] != null ? (macdLine[i] as number) - (signal[i] as number) : null,
  );
  return { macd: macdLine, signal, histogram };
}

/** Rebase a series so the first valid positive point is 100 (overlay alignment). */
export function rebase(values: number[], base = 100): (number | null)[] {
  const first = values.find((v) => Number.isFinite(v) && v > 0);
  if (first == null) return values.map(() => null);
  return values.map((v) => (Number.isFinite(v) && v > 0 ? (v / first) * base : null));
}
