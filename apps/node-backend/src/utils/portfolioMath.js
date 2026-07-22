/**
 * Portfolio Math Utilities
 *
 * Pure functions for portfolio calculations. No I/O, no side effects.
 * Used by both backend services and imported as equivalent TypeScript
 * implementations in frontend hooks.
 */

import { toDecimal, toNumber, roundToCents } from '../lib/money.js';
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
 * sustained repricing is never smoothed away. When a needle is found, `field`
 * is replaced with the geometric mean of its neighbors and every entry in
 * `options.extraFields` is replaced with the mean of ITS neighbors (geometric
 * when both are positive, arithmetic fallback otherwise). All replacements are
 * rounded to cents (money values).
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} [field]
 * @param {{ extraFields?: string[] }} [options]
 */
export function sanitizeIsolatedValueSpikes(rows, field = 'value', { extraFields = [] } = {}) {
  if (!Array.isArray(rows) || rows.length < 3) return Array.isArray(rows) ? rows : [];
  const out = rows.map((s) => ({ ...s }));
  const minJump = Math.log(1.18);
  const neighborTolerance = Math.log(1.12);
  const localNeedleRatio = 1.8;

  const smoothedMean = (a, b) => {
    const va = Number(a) || 0;
    const vb = Number(b) || 0;
    const mean = va > 0 && vb > 0 ? Math.sqrt(va * vb) : (va + vb) / 2;
    return toNumber(roundToCents(mean));
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
      out[i][field] = toNumber(roundToCents(Math.sqrt(prev * next)));
      for (const extra of extraFields) {
        out[i][extra] = smoothedMean(out[i - 1]?.[extra], out[i + 1]?.[extra]);
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
 * @param {Array<{value: number|string, stocks_etfs_value?: number|string, crypto_value?: number|string, metals_value?: number|string}>} snapshots
 * @returns {Array} Sanitized copy (no mutation of input)
 */
export function sanitizeSnapshotSpikes(snapshots) {
  return sanitizeIsolatedValueSpikes(snapshots, 'value', {
    extraFields: ['stocks_etfs_value', 'crypto_value', 'metals_value', 'value_fx_neutral'],
  });
}
