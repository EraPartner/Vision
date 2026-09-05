/**
 * Category-level Spend-Outlier Detection Service.
 *
 * Analyses recent expense history per category to detect months where a
 * category's spending is a statistical outlier vs. its own recent baseline:
 * - Buckets expenses by category and calendar month
 * - Compares like-for-like windows (day 1..N of each month, N = today's
 *   day-of-month) so a partial current month is never compared to full months
 * - Baseline = median + MAD (median absolute deviation) of prior-month windows
 * - Flags overspend via the modified z-score (0.6745 * (x - median) / MAD)
 *
 * Only OVERSPEND is surfaced ("spend creep"); underspend is deliberately
 * skipped. Dismiss suppression is applied as a pure post-filter — persistence
 * of dismiss records lives elsewhere (UI layer owns it).
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';
import { addAll, roundMoney, toDecimal } from '../lib/money.js';
import { median } from '../lib/math.js';

// Modified z-score constant (Iglewicz & Hoaglin): scales MAD so the score is
// comparable to a standard z-score under normality.
const MODIFIED_Z_SCALE = 0.6745;
// A category is flagged when its modified z-score exceeds this threshold.
const OUTLIER_Z_THRESHOLD = 3.5;
// How many calendar months before the current one are considered for the baseline.
const PRIOR_MONTHS_CONSIDERED = 6;
// At least this many of the prior months must have windowed spend before the
// baseline is trusted; sparser categories are skipped entirely.
const MIN_POPULATED_PRIOR_MONTHS = 4;
// A MAD at or below this (in EUR) is treated as degenerate ("flat" spending):
// the z-score denominator would explode, so an absolute floor takes over.
const NEAR_ZERO_MAD_EUR = 1;
// With a near-zero MAD, only flag when the overspend vs. the median exceeds
// this absolute amount (EUR). Keeps €100.00-every-month categories from being
// flagged over a €10 blip just because their history is perfectly stable.
const FLAT_BASELINE_OVERSPEND_FLOOR_EUR = 50;
// A dismissal suppresses re-alerts for the same {categoryId, monthKey} for
// this long...
const DISMISS_SUPPRESSION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
// ...unless the deviation has visibly worsened since dismissal: re-alert when
// the current modified z-score exceeds deviationAtDismiss by this margin.
const REALERT_DEVIATION_MARGIN = 0.5;

// Short-TTL in-process cache for the raw (pre-suppression) findings, mirroring
// recurringDetectionService. Detection scans ~7 months of expenses and does
// bucket/median/MAD work synchronously on the event loop, and may be hit
// repeatedly in a session. There is no pub/sub invalidation reachable from
// this service, so a short TTL is used: results are eventually consistent
// within CATEGORY_OUTLIER_CACHE_TTL_MS of a transaction change, which is
// acceptable for an insight feature. Only the RAW findings are cached — they
// do not depend on dismiss records, so suppression is applied on every call
// and the cache stays valid regardless of dismiss input.
const CATEGORY_OUTLIER_CACHE_TTL_MS = 3 * 60_000; // 3 minutes
/** @type {{ value: any[], expiresAt: number } | null} */
let outlierCache = null;

/** Test-only: drop the cached raw category-outlier findings. */
export function __clearCategoryOutlierCacheForTests() {
  outlierCache = null;
}

/**
 * Extract calendar {year, month, day} from a transaction date.
 *
 * pg reads DATE columns as local-midnight Date objects (see lib/dateFormat.js),
 * so Date instances use LOCAL getters. Plain 'YYYY-MM-DD...' strings are
 * sliced directly to avoid any timezone-dependent parsing.
 *
 * @param {Date|string|null|undefined} value
 * @returns {{ year: number, month: number, day: number } | null}
 */
function toCalendarParts(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() };
  }
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }
  return null;
}

/**
 * 'YYYY-MM' month key for calendar parts.
 *
 * @param {number} year
 * @param {number} month 1-based month
 * @returns {string}
 */
function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * The `count` month keys immediately before the given month, most recent first.
 *
 * @param {number} year
 * @param {number} month 1-based month
 * @param {number} count
 * @returns {string[]}
 */
function priorMonthKeys(year, month, count) {
  const keys = [];
  let y = year;
  let m = month;
  for (let i = 0; i < count; i++) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
    keys.push(monthKey(y, m));
  }
  return keys;
}

/**
 * Pure computation: bucket expense rows by category/month, apply like-for-like
 * day-1..N windowing, and return overspend outlier findings.
 *
 * The current month is partial, so every month — current AND prior — is
 * truncated to days 1..N where N is today's day-of-month. Comparing a full
 * prior month against a partial current month would systematically understate
 * the current month and is never done.
 *
 * @param {Array<{ date: Date|string, amount: string|number, category_id: number, category_name: string|null }>} rows
 * @param {Date} today Reference "now" — determines the current month and window size N.
 * @returns {any[]} findings sorted by deviation descending
 */
function computeOutliers(rows, today) {
  const windowDay = today.getDate(); // N: compare day 1..N in every month
  const currentKey = monthKey(today.getFullYear(), today.getMonth() + 1);
  const priorKeys = priorMonthKeys(
    today.getFullYear(),
    today.getMonth() + 1,
    PRIOR_MONTHS_CONSIDERED
  );
  const consideredKeys = new Set([currentKey, ...priorKeys]);

  // categoryId → { categoryName, months: Map<monthKey, Decimal windowed spend> }
  const byCategory = new Map();
  for (const row of rows) {
    const parts = toCalendarParts(row.date);
    if (!parts) continue;
    if (parts.day > windowDay) continue; // outside the like-for-like window
    const key = monthKey(parts.year, parts.month);
    if (!consideredKeys.has(key)) continue;

    let group = byCategory.get(row.category_id);
    if (!group) {
      group = { categoryName: row.category_name || 'Unknown', months: new Map() };
      byCategory.set(row.category_id, group);
    }
    // Expense amounts are negative NUMERIC strings — accumulate as Decimals
    // per the monetary-arithmetic rule, absolute value = spend.
    const spend = toDecimal(row.amount).abs();
    group.months.set(key, addAll([group.months.get(key) ?? 0, spend]));
  }

  const findings = [];
  for (const [categoryId, group] of byCategory) {
    // Baseline sample: windowed spend of populated prior months. A month is
    // "populated" when it has at least one expense inside the day-1..N window;
    // months without windowed spend contribute nothing (they would otherwise
    // drag the median toward zero for e.g. mid-month-only billers).
    const priorWindowValues = priorKeys
      .map((k) => group.months.get(k))
      .filter(Boolean)
      .map((d) => d.toNumber());
    if (priorWindowValues.length < MIN_POPULATED_PRIOR_MONTHS) continue;

    const currentSpend = group.months.get(currentKey);
    if (!currentSpend) continue; // nothing spent this month → nothing to flag

    const currentValue = currentSpend.toNumber();
    const baselineMedian = median(priorWindowValues);
    const mad = median(priorWindowValues.map((v) => Math.abs(v - baselineMedian)));

    const diff = currentValue - baselineMedian;
    if (diff <= 0) continue; // only OVERSPEND ("creep") is surfaced

    let deviation;
    if (mad <= NEAR_ZERO_MAD_EUR) {
      // Degenerate (near-flat) baseline: the z-score denominator is
      // meaningless, so require an absolute overspend floor instead, and
      // compute the reported score against the floored MAD to stay finite.
      if (diff <= FLAT_BASELINE_OVERSPEND_FLOOR_EUR) continue;
      deviation = (MODIFIED_Z_SCALE * diff) / NEAR_ZERO_MAD_EUR;
    } else {
      deviation = (MODIFIED_Z_SCALE * diff) / mad;
      if (deviation <= OUTLIER_Z_THRESHOLD) continue;
    }

    findings.push({
      categoryId,
      categoryName: group.categoryName,
      monthKey: currentKey,
      currentAmount: roundMoney(currentSpend),
      baselineMedian: roundMoney(baselineMedian),
      deviation: roundMoney(deviation, 2),
      direction: 'increased',
    });
  }

  // Sort by deviation descending
  findings.sort((a, b) => b.deviation - a.deviation);
  return findings;
}

/**
 * Pure dismiss-suppression filter.
 *
 * Suppresses a finding when a dismiss record exists for the same
 * {categoryId, monthKey} AND the dismissal happened within the last 14 days —
 * UNLESS the finding's deviation has visibly worsened since dismissal
 * (current deviation ≥ deviationAtDismiss + REALERT_DEVIATION_MARGIN), in
 * which case it re-alerts. When several records target the same key, the most
 * recent dismissal wins.
 *
 * @param {any[]} findings Findings from {@link computeOutliers}.
 * @param {Array<{ categoryId: number, monthKey: string, dismissedAt: string|Date, deviationAtDismiss: number }>} [dismissRecords]
 * @param {Date} [now] Injectable clock for tests; defaults to the current time.
 * @returns {any[]} the findings that remain visible
 */
 function filterDismissedFindings(findings, dismissRecords = [], now = new Date()) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  if (!Array.isArray(dismissRecords) || dismissRecords.length === 0) return [...findings];

  const nowMs = now.getTime();
  // Latest dismissal per {categoryId, monthKey}
  const latestByKey = new Map();
  for (const rec of dismissRecords) {
    if (!rec) continue;
    const dismissedMs = new Date(rec.dismissedAt).getTime();
    if (Number.isNaN(dismissedMs)) continue;
    const key = `${rec.categoryId}:${rec.monthKey}`;
    const prev = latestByKey.get(key);
    if (!prev || dismissedMs > prev.dismissedMs) {
      latestByKey.set(key, { dismissedMs, deviationAtDismiss: rec.deviationAtDismiss });
    }
  }

  return findings.filter((finding) => {
    const rec = latestByKey.get(`${finding.categoryId}:${finding.monthKey}`);
    if (!rec) return true;
    if (nowMs - rec.dismissedMs > DISMISS_SUPPRESSION_MS) return true; // dismissal aged out
    const dismissedDeviation = Number(rec.deviationAtDismiss);
    if (
      Number.isFinite(dismissedDeviation) &&
      finding.deviation >= dismissedDeviation + REALERT_DEVIATION_MARGIN
    ) {
      return true; // visibly worsened since dismissal → re-alert
    }
    return false; // suppressed
  });
}

/**
 * Fetch expense rows and compute the raw (pre-suppression) outlier findings,
 * memoised in the short-TTL cache.
 *
 * @returns {Promise<any[]>}
 */
async function getRawFindings() {
  if (outlierCache && Date.now() < outlierCache.expiresAt) {
    return outlierCache.value;
  }
  try {
    // Expenses of the last ~7 calendar months: the current (partial) month
    // plus 6 full prior months for the baseline. Bounded so the scan cost
    // stays flat regardless of total history size.
    const result = await query(`
      SELECT t.date, t.amount, t.category_id,
             c.general || ':' || c.detail AS category_name
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.is_active = true
        AND t.category_id IS NOT NULL
        AND t.amount < 0
        AND t.date >= CURRENT_DATE - INTERVAL '7 months'
      ORDER BY t.category_id, t.date
    `);

    const findings = computeOutliers(result.rows, new Date());
    outlierCache = { value: findings, expiresAt: Date.now() + CATEGORY_OUTLIER_CACHE_TTL_MS };
    return findings;
  } catch (err) {
    logger.error('Error detecting category spend outliers', { error: err.message });
    throw err;
  }
}

/**
 * Main detection function — returns the categories whose current-month
 * spending is an overspend outlier vs. their own recent history, minus any
 * findings suppressed by fresh dismiss records.
 *
 * Findings are JSON-serializable plain objects:
 * `{ categoryId, categoryName, monthKey, currentAmount, baselineMedian,
 *    deviation, direction: 'increased' }`, sorted by deviation descending.
 *
 * @param {{ dismissRecords?: Array<{ categoryId: number, monthKey: string, dismissedAt: string|Date, deviationAtDismiss: number }> }} [options]
 * @returns {Promise<any[]>}
 */
export async function detectCategoryOutliers({ dismissRecords = [] } = {}) {
  const raw = await getRawFindings();
  return filterDismissedFindings(raw, dismissRecords);
}

export { filterDismissedFindings as __filterDismissedFindings };
