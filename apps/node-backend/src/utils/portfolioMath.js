/**
 * Portfolio Math Utilities
 *
 * Pure functions for portfolio calculations. No I/O, no side effects.
 * Used by both backend services and imported as equivalent TypeScript
 * implementations in frontend hooks.
 */

import { toDecimal, toNumber, roundToCents, addAll } from '../lib/money.js';
import { appDateStringToUtc, toAppDateString } from '../lib/timezone.js';
import { formatDateToYmd } from '../lib/dateFormat.js';
import { calculateAccruedInterest as sharedCalculateAccruedInterest } from '@vision/shared-utils/portfolio';

// Cost-basis accounting and interest accrual live in the shared workspace
// package (@vision/shared-utils/portfolio) so the frontend hooks import the same
// implementation instead of a hand-mirrored copy (they drifted — see ADR on
// shared portfolio math). Import those from the package directly; the passthrough
// re-export block that used to live here had no live importer.

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Smooth isolated one-day value needles (e.g. kinesis price spikes) on an array
 * of rows, replacing a needle with the geometric mean of its neighbors. Pure —
 * lives here (not the repository layer) so route helpers can use it too.
 *
 * The single implementation behind both the route layer and the snapshot
 * pipeline (sanitizeSnapshotSpikes below): two copies previously coexisted
 * with drifted needle rules, so the same series smoothed differently per path.
 *
 * Detection runs on `field`. Needle detection is bridge-guarded: the two
 * neighbors must agree with each other (|log(next/prev)| small) so a genuine
 * sustained repricing is never smoothed away. When a needle is found, every
 * entry in `options.extraFields` is replaced with the mean of ITS neighbors
 * (geometric when both are positive, arithmetic fallback otherwise) and `field`
 * itself with the geometric mean of its neighbors. All replacements are rounded
 * to cents (money values).
 *
 * `options.sumFields` names an exact decomposition of `field` (Σ parts ==
 * total). When supplied AND the needle day and both neighbors actually satisfy
 * it in the input, `field` is instead reconciled to the post-smoothing sum of
 * those parts, so the row still decomposes afterwards. Parts listed in
 * `sumFields` but not in `extraFields` are carried through untouched — that is
 * how a ledger-derived leg (cash) survives smoothing: a needle in a total that
 * came from real cash movement is preserved rather than being smoothed into a
 * balance the user never held, while price-feed legs are still cleaned. Rows
 * that do not decompose in the input (legacy/partial series) keep the plain
 * geometric-mean rule.
 *
 * `options.parallelTotals` names totals that track `field` but are not part of
 * its decomposition — each `{ field, sharedFields }` is a total that carries the
 * same `sharedFields` legs verbatim and re-values the rest. Because
 * reconciliation moves `field` off its own geometric mean, a parallel total left
 * on its geometric mean would drift away from it and manufacture a difference
 * the two totals never had. Each is instead rebuilt from the reconciled total at
 * the ratio its neighbors show, so a series where the two totals are equal every
 * day stays exactly equal. Only applied when `field` itself was reconciled, and
 * skipped entirely (leaving the `extraFields` geometric mean) when the parallel
 * field is missing or non-finite on either neighbor — which is how a series
 * predating the column degrades to the old behaviour. A neighbor whose non-
 * shared part is empty contributes no ratio sample rather than voiding the
 * reconciliation, since it carries no information about the split.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} [field]
 * @param {{ extraFields?: string[], sumFields?: string[], parallelTotals?: Array<{field: string, sharedFields?: string[]}> }} [options]
 */
export function sanitizeIsolatedValueSpikes(rows, field = 'value', { extraFields = [], sumFields = [], parallelTotals = [] } = {}) {
  if (!Array.isArray(rows) || rows.length < 3) return Array.isArray(rows) ? rows : [];
  const out = rows.map((s) => ({ ...s }));
  const minJump = Math.log(1.18);
  const neighborTolerance = Math.log(1.12);
  const localNeedleRatio = 1.8;
  // Each leg and the total are rounded to cents independently upstream, so an
  // exact decomposition can still show a few cents of drift.
  const decompositionTolerance = 0.05;

  /**
   * @param {unknown} a
   * @param {unknown} b
   */
  const smoothedMean = (a, b) => {
    const va = Number(a) || 0;
    const vb = Number(b) || 0;
    const mean = va > 0 && vb > 0 ? Math.sqrt(va * vb) : (va + vb) / 2;
    return toNumber(roundToCents(mean));
  };

  /**
   * @param {Record<string, unknown>} row
   * @param {string[]} fields
   */
  const sumOf = (row, fields) => {
    const legs = [];
    for (const part of fields) {
      const leg = Number(row?.[part]);
      if (!Number.isFinite(leg)) return undefined;
      legs.push(leg);
    }
    return addAll(legs);
  };

  /** @param {Record<string, unknown>} row */
  const partsSum = (row) => sumOf(row, sumFields);

  /** @param {Record<string, unknown>} row */
  const decomposes = (row) => {
    const total = Number(row?.[field]);
    const parts = partsSum(row);
    if (parts === undefined || !Number.isFinite(total)) return false;
    return parts.minus(toDecimal(total)).abs().lte(decompositionTolerance);
  };

  for (let i = 1; i < out.length - 1; i += 1) {
    const prev = Number(out[i - 1]?.[field]);
    const current = Number(out[i]?.[field]);
    const next = Number(out[i + 1]?.[field]);
    if (!Number.isFinite(prev) || !Number.isFinite(current) || !Number.isFinite(next)) continue;
    if (prev <= 0 || current <= 0 || next <= 0) continue;
    const jump = Math.log(current / prev);
    const revert = Math.log(next / current);
    const bridge = Math.log(next / prev);
    const oppositeDirections = (jump > 0 && revert < 0) || (jump < 0 && revert > 0);
    const largeMove = Math.abs(jump) >= minJump && Math.abs(revert) >= minJump;
    const bridgeLooksNormal = Math.abs(bridge) <= neighborTolerance;
    const maxNeighbor = Math.max(prev, next);
    const minNeighbor = Math.min(prev, next);
    const localNeedlePeak = current >= maxNeighbor * localNeedleRatio && bridgeLooksNormal;
    const localNeedleTrough = current * localNeedleRatio <= minNeighbor && bridgeLooksNormal;
    if ((oppositeDirections && largeMove && bridgeLooksNormal) || localNeedlePeak || localNeedleTrough) {
      const reconcilable = sumFields.length > 0
        && decomposes(out[i - 1]) && decomposes(out[i]) && decomposes(out[i + 1]);
      for (const extra of extraFields) {
        out[i][extra] = smoothedMean(out[i - 1]?.[extra], out[i + 1]?.[extra]);
      }
      const reconciled = reconcilable ? partsSum(out[i]) : undefined;
      out[i][field] = toNumber(roundToCents(reconciled ?? Math.sqrt(prev * next)));

      if (reconciled === undefined) continue;
      for (const { field: parallelField, sharedFields = [] } of parallelTotals) {
        const shared = sumOf(out[i], sharedFields);
        const prevShared = sumOf(out[i - 1], sharedFields);
        const nextShared = sumOf(out[i + 1], sharedFields);
        if (shared === undefined || prevShared === undefined || nextShared === undefined) continue;
        const prevParallel = Number(out[i - 1]?.[parallelField]);
        const nextParallel = Number(out[i + 1]?.[parallelField]);
        if (!Number.isFinite(prevParallel) || !Number.isFinite(nextParallel)) continue;
        const ratios = [];
        for (const [parallelTotal, mainTotal, rowShared] of /** @type {const} */ ([
          [prevParallel, prev, prevShared],
          [nextParallel, next, nextShared],
        ])) {
          const exclusive = toDecimal(mainTotal).minus(rowShared);
          if (!exclusive.gt(0)) continue;
          const rowRatio = toDecimal(parallelTotal).minus(rowShared).div(exclusive).toNumber();
          if (Number.isFinite(rowRatio) && rowRatio > 0) ratios.push(rowRatio);
        }
        // A neighbor holding nothing outside the shared legs carries no ratio.
        // With neither neighbor usable the exclusive part is degenerate — it
        // reconciles to zero — so the factor it is multiplied by is moot, and 1
        // keeps a shared-only total (an all-cash portfolio) exactly on `field`.
        const ratio = ratios.length === 2 ? Math.sqrt(ratios[0] * ratios[1]) : (ratios[0] ?? 1);
        out[i][parallelField] = toNumber(roundToCents(reconciled.minus(shared).times(ratio).plus(shared)));
      }
    }
  }
  return out;
}

/**
 * Normalise a date-ish value to a `YYYY-MM-DD` string. Accepts a plain
 * date string (snapshot/txn rows) or a JS `Date` — the `pg` driver returns
 * `DATE` columns as a Date at local midnight, so the local getters recover
 * the exact calendar day.
 *
 * @param {string|Date} value
 * @returns {string}
 */
export function toYmd(value) {
  if (value instanceof Date) return formatDateToYmd(value);
  return String(value).slice(0, 10);
}

/**
 * Whole-day count between two calendar dates, evaluated in APP_TIMEZONE
 * (ADR-009). Both endpoints are normalised to start-of-day in the app zone
 * so the result is an exact integer, never a TZ-skewed fraction.
 *
 * @param {string|Date} from
 * @param {string|Date} to
 * @returns {number}
 */
export function calendarDaysBetween(from, to) {
  const fromUtc = appDateStringToUtc(toYmd(from));
  const toUtc = appDateStringToUtc(toYmd(to));
  return Math.round((toUtc.getTime() - fromUtc.getTime()) / MS_PER_DAY);
}

/**
 * Calculate accrued simple interest for fixed-income assets (shared
 * implementation), evaluated against "today" in APP_TIMEZONE (ADR-009).
 *
 * @param {Array<{type: string, date: string}>} txns
 * @param {number} principal - Current invested principal
 * @param {number} interestRate - Annual rate as a percentage (e.g. 3.5 for 3.5%)
 * @returns {number} Accrued interest amount
 */
export function calculateAccruedInterest(txns, principal, interestRate) {
  return sharedCalculateAccruedInterest(txns, principal, interestRate, toAppDateString(new Date()));
}

/**
 * Compute annualized return (CAGR) from total return and holding period.
 *
 * @param {number} currentValue
 * @param {number} totalInvested
 * @param {number} days - Holding period in days
 * @returns {number} Annualized return as a percentage
 */
export function annualizedReturn(currentValue, totalInvested, days) {
  if (totalInvested <= 0 || days <= 0 || currentValue <= 0) return 0;
  const years = days / 365.25;
  const result = (Math.pow(currentValue / totalInvested, 1 / years) - 1) * 100;
  return Number.isFinite(result) ? result : 0;
}

/**
 * Compute contribution-adjusted monthly return.
 * Isolates investment performance from cash flow effects (deposits/withdrawals).
 *
 * Formula: ((currValue/currInvested) / (prevValue/prevInvested) - 1) * 100
 *
 * @param {number} currValue
 * @param {number} currInvested
 * @param {number} prevValue
 * @param {number} prevInvested
 * @returns {number|null} Monthly return percentage, or null when inputs are invalid
 */
export function contributionAdjustedMonthlyReturn(currValue, currInvested, prevValue, prevInvested) {
  if (prevInvested <= 0 || currInvested <= 0 || prevValue <= 0) return null;
  return ((currValue / currInvested) / (prevValue / prevInvested) - 1) * 100;
}

/**
 * Compute overall portfolio metrics from the full snapshot array.
 * Ported from PerformancePage.tsx overallMetrics useMemo.
 *
 * @param {Array<{snapshot_date: string, invested: string|number, value: string|number, gain_loss: string|number, inflation_adjusted_value: string|number}>} snapshots
 * @returns {object|null}
 */
export function computeMetrics(snapshots) {
  if (!snapshots || snapshots.length < 1) return null;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];

  const days = Math.max(1, calendarDaysBetween(first.snapshot_date, last.snapshot_date));

  const totalInvested = toNumber(toDecimal(last.invested));
  const currentValue = toNumber(toDecimal(last.value));
  const totalGainLoss = toNumber(toDecimal(last.gain_loss));
  const inflationAdjustedValue = toNumber(toDecimal(last.inflation_adjusted_value));

  const totalReturnPct = totalInvested > 0
    ? (totalGainLoss / totalInvested) * 100
    : 0;

  const cagr = annualizedReturn(currentValue, totalInvested, days);

  const realReturnPct = totalInvested > 0
    ? ((inflationAdjustedValue - totalInvested) / totalInvested) * 100
    : 0;

  const cumulativeInflation = currentValue > 0 && inflationAdjustedValue > 0
    ? ((currentValue / inflationAdjustedValue) - 1) * 100
    : 0;

  /** @param {number} v */
  const round2 = (v) => Math.round(v * 100) / 100;

  return {
    currentValue: round2(currentValue),
    totalInvested: round2(totalInvested),
    totalGainLoss: round2(totalGainLoss),
    totalReturnPct: round2(totalReturnPct),
    annualizedReturn: round2(cagr),
    realReturnPct: round2(realReturnPct),
    cumulativeInflation: Math.round(cumulativeInflation * 10) / 10,
  };
}

/**
 * Compute monthly returns heatmap from the full snapshot array.
 * Uses contribution-adjusted formula to isolate performance from cash flows.
 *
 * @param {Array<{snapshot_date: string, value: string|number, invested: string|number}>} snapshots
 * @returns {{ years: number[], data: Record<number, (number|null)[]>, maxAbsPct: number }}
 */
export function computeHeatmap(snapshots) {
  if (!snapshots || snapshots.length < 2) {
    return { years: [], data: {}, maxAbsPct: 0 };
  }

  // Normalise each snapshot's date to a YYYY-MM-DD string, then sort
  // ascending — the input order is not guaranteed, and "last snapshot of the
  // month" only holds if we iterate in date order.
  const withDate = snapshots.map((s) => ({
    snap: s,
    // toYmd uses local getters for pg's local-midnight Date — toISOString() here
    // shifted every date back a day in UTC+ zones, mis-bucketing the "last
    // snapshot of month M" into month M+1.
    dateStr: toYmd(s.snapshot_date),
  }));
  withDate.sort((a, b) => a.dateStr.localeCompare(b.dateStr));

  // Group by month — take the last (latest-dated) snapshot of each month.
  /** @type {Map<string, { snapshot_date: string|Date, value: string|number, invested: string|number }>} */
  const byMonth = new Map();
  for (const { snap, dateStr } of withDate) {
    byMonth.set(dateStr.slice(0, 7), snap);
  }

  const monthKeys = [...byMonth.keys()].sort();
  const years = [...new Set(monthKeys.map(k => parseInt(k.slice(0, 4))))].sort();
  /** @type {Record<number, (number|null)[]>} */
  const data = {};
  const monthlyReturns = [];

  for (const year of years) {
    data[year] = Array(12).fill(null);
  }

  for (let i = 1; i < monthKeys.length; i++) {
    // Only compute a monthly return between *consecutive* calendar months.
    // monthKeys skips months with no snapshot, so a Jan→Mar pair would
    // otherwise be charted as March's one-month return when it spans two.
    const [py, pm] = monthKeys[i - 1].split('-').map(Number);
    const [cy, cm] = monthKeys[i].split('-').map(Number);
    if (cy * 12 + cm !== py * 12 + pm + 1) continue;

    const prev = byMonth.get(monthKeys[i - 1]);
    const curr = byMonth.get(monthKeys[i]);
    const year = parseInt(monthKeys[i].slice(0, 4));
    const monthIdx = parseInt(monthKeys[i].slice(5, 7)) - 1;

    const monthlyReturn = contributionAdjustedMonthlyReturn(
      toNumber(toDecimal(curr.value)),
      toNumber(toDecimal(curr.invested)),
      toNumber(toDecimal(prev.value)),
      toNumber(toDecimal(prev.invested)),
    );

    const rounded = monthlyReturn !== null ? Math.round(monthlyReturn * 100) / 100 : null;
    data[year][monthIdx] = rounded;
    if (rounded !== null) {
      monthlyReturns.push(Math.abs(rounded));
    }
  }

  return {
    years,
    data,
    maxAbsPct: monthlyReturns.length > 0 ? Math.max(...monthlyReturns) : 0,
  };
}

/**
 * Sanitize isolated daily value spikes in portfolio snapshots.
 *
 * Thin wrapper over sanitizeIsolatedValueSpikes so the snapshot pipeline and
 * the route layer share one needle rule — this used to be an independent copy
 * whose needle detection lacked the bridge guard, so the same series smoothed
 * differently depending on the code path.
 *
 * The snapshot day walk builds every row so that
 * `value == stocks_etfs_value + crypto_value + metals_value + cash_value`
 * (unit-priced legs plus the non-unit savings/bond/real-estate bucket), and
 * `sumFields` keeps that true through smoothing. `cash_value` is deliberately
 * absent from `extraFields`: it is replayed from the ledger plus deterministic
 * interest accrual rather than from a daily price series, so it does not carry
 * price-feed needles — smoothing it would invent a balance, and a total-value
 * needle caused by a genuine one-day cash transit now passes through instead of
 * persisting a loss that never happened. (It is not wholly price-independent: a
 * non-unit investment with no transactions at all falls back to `current_price`
 * at the day's FX rate, and `investmentRepository.updatePrice` has no
 * `asset_class` filter, so that fallback can be moved by a provider refresh.
 * That is a single re-valuation, not a per-day series, and smoothing it would
 * still invent a balance.)
 *
 * `value_fx_neutral` is not a leg of the sum — it is the same portfolio valued
 * at purchase-date FX, sharing the identical `cash_value` figure
 * (snapshotBuilder adds `fixedIncomeValue` to both totals). It is passed as a
 * parallel total so it follows the reconciled `value` at the neighbors' FX
 * ratio: an all-EUR portfolio has the two totals equal on every day, and they
 * must stay equal, or the performance page shows a currency effect to a user
 * with no foreign-currency holdings.
 *
 * @param {Array<{value: number|string, stocks_etfs_value?: number|string, crypto_value?: number|string, metals_value?: number|string, cash_value?: number|string}>} snapshots
 * @returns {Array<any>} Sanitized copy (no mutation of input) — same element
 *   shape as `snapshots` plus the extra fields sanitizeIsolatedValueSpikes
 *   smooths (`value_fx_neutral`, …). Untyped so callers (e.g.
 *   services/portfolio/snapshotBuilder.js) can annotate their own
 *   caller-specific row type over the result, as they already do.
 */
export function sanitizeSnapshotSpikes(snapshots) {
  return sanitizeIsolatedValueSpikes(snapshots, 'value', {
    extraFields: ['stocks_etfs_value', 'crypto_value', 'metals_value', 'value_fx_neutral'],
    sumFields: ['stocks_etfs_value', 'crypto_value', 'metals_value', 'cash_value'],
    parallelTotals: [{ field: 'value_fx_neutral', sharedFields: ['cash_value'] }],
  });
}
