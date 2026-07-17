/**
 * Recurring Transaction Detection Service.
 *
 * Analyses transaction history to detect recurring patterns:
 * - Groups transactions by recipient
 * - Detects regular intervals (weekly, monthly, quarterly, yearly)
 * - Flags amount changes
 * - Returns suggestions for planned transactions
 */

import { query } from '../database/connection.js';
import { toWireDate } from '../lib/dateFormat.js';
import { logger } from '../config/logger.js';
import { addAll, divide, roundMoney, toDecimal } from '../lib/money.js';
import { median } from '../lib/math.js';

const MIN_OCCURRENCES = 3; // Minimum transactions to consider a pattern
const INTERVAL_TOLERANCE = 0.25; // 25% tolerance for interval matching

// Short-TTL in-process cache for detectRecurringPatterns. The detection runs a
// 3-year scan plus group/sort/interval work synchronously on the event loop, and
// is hit by both GET /api/info/recurring-patterns and the aiChat
// getRecurringDetected tool — often repeatedly in a session. There is no
// pub/sub invalidation reachable from this service (scheduleAggregationRefresh
// clears specific downstream caches directly rather than broadcasting), so a
// short TTL is used: results are eventually consistent within RECURRING_CACHE_TTL_MS
// of a transaction change, which is acceptable for a suggestion feature.
const RECURRING_CACHE_TTL_MS = 3 * 60_000; // 3 minutes
/** @type {{ value: { patterns: any[], total: number }, expiresAt: number } | null} */
let recurringCache = null;

/** Test-only: drop the cached recurring-patterns result. */
export function __clearRecurringCacheForTests() {
  recurringCache = null;
}

// Known interval patterns (in days)
const INTERVAL_PATTERNS = [
  { name: 'weekly', days: 7, tolerance: 2 },
  { name: 'biweekly', days: 14, tolerance: 3 },
  { name: 'monthly', days: 30, tolerance: 5 },
  { name: 'quarterly', days: 91, tolerance: 10 },
  { name: 'yearly', days: 365, tolerance: 20 },
];

/**
 * Detect the most likely recurrence pattern from a series of intervals.
 */
function detectInterval(intervals) {
  if (intervals.length === 0) return null;

  const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const medianInterval = median(intervals);

  // Try to match against known patterns using median (more robust to outliers)
  for (const pattern of INTERVAL_PATTERNS) {
    if (Math.abs(medianInterval - pattern.days) <= pattern.tolerance) {
      // Verify consistency: most intervals should be within tolerance
      const matching = intervals.filter(
        (i) => Math.abs(i - pattern.days) <= pattern.tolerance
      );
      const consistency = matching.length / intervals.length;
      if (consistency >= 0.6) {
        return {
          pattern: pattern.name,
          avgDays: Math.round(avgInterval),
          medianDays: Math.round(medianInterval),
          consistency: Math.round(consistency * 100),
        };
      }
    }
  }

  // Check for custom regular interval
  const stdDev = Math.sqrt(
    intervals.reduce((s, v) => s + Math.pow(v - avgInterval, 2), 0) / intervals.length
  );
  const cv = stdDev / avgInterval; // Coefficient of variation

  if (cv < INTERVAL_TOLERANCE && avgInterval >= 5) {
    return {
      pattern: 'custom',
      avgDays: Math.round(avgInterval),
      medianDays: Math.round(medianInterval),
      consistency: Math.round((1 - cv) * 100),
      customIntervalDays: Math.round(medianInterval),
    };
  }

  return null;
}

/**
 * Detect amount changes in a recurring pattern.
 */
function detectAmountChanges(transactions) {
  if (transactions.length < 2) return [];

  const changes = [];
  const sorted = [...transactions].sort((a, b) => {
    const aTime = new Date(a?.date).getTime();
    const bTime = new Date(b?.date).getTime();

    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return aTime - bTime;
  });

  // Calculate baseline (median of all amounts)
  const amounts = sorted.map((t) => toDecimal(t.amount).abs().toNumber());
  const medianAmount = median(amounts);
  if (!Number.isFinite(medianAmount) || medianAmount === 0) {
    return [];
  }

  // Check last few transactions for changes
  for (let i = Math.max(0, sorted.length - 3); i < sorted.length; i++) {
    const amt = toDecimal(sorted[i].amount).abs().toNumber();
    const pctChange = ((amt - medianAmount) / medianAmount) * 100;

    if (Math.abs(pctChange) > 5) {
      // More than 5% change from median
      changes.push({
        date: sorted[i].date,
        previousAmount: medianAmount,
        newAmount: amt,
        percentChange: Math.round(pctChange * 100) / 100,
        direction: pctChange > 0 ? 'increased' : 'decreased',
      });
    }
  }

  return changes;
}

/**
 * Main detection function - analyses all transactions and returns recurring patterns.
 */
export async function detectRecurringPatterns() {
  if (recurringCache && Date.now() < recurringCache.expiresAt) {
    return recurringCache.value;
  }
  try {
    // Get transactions grouped by recipient, ordered by date. Bounded to the
    // last ~3 years: recurrence is detected from interval cadence, so older
    // history adds scan cost without changing the result. Without the bound
    // this was a full-table scan on every call (including via the aiChat
    // getRecurringDetected tool).
    const result = await query(`
      SELECT t.id, t.date, t.amount, t.currency, t.memo, t.bank_account,
             t.recipient_id, r.name AS recipient_name,
             t.category_id,
             COALESCE(c.general || ':' || c.detail, NULL) AS category_name
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
      WHERE t.is_active = true
        AND t.recipient_id IS NOT NULL
        AND t.date >= CURRENT_DATE - INTERVAL '3 years'
      ORDER BY t.recipient_id, t.date
    `);

    if (result.rows.length === 0) {
      const empty = { patterns: [], total: 0 };
      recurringCache = { value: empty, expiresAt: Date.now() + RECURRING_CACHE_TTL_MS };
      return empty;
    }

    // planned_transactions may not exist in partially initialized environments.
    const plannedTableCheck = await query(
      `SELECT to_regclass('public.planned_transactions') IS NOT NULL AS exists`
    );
    const plannedTableAvailable = Boolean(plannedTableCheck.rows[0]?.exists);

    // Group by recipient AND flow direction. Bucketing on recipient alone
    // blended income and expense from the same recipient (e.g. an employer
    // that is also occasionally reimbursed) into one averaged "pattern" that
    // matched neither real flow — amounts go through .abs() below, so the
    // sign distinction would otherwise be lost entirely.
    const byRecipient = {};
    for (const row of result.rows) {
      const direction = Number(row.amount) < 0 ? 'expense' : 'income';
      const key = `${row.recipient_id}:${direction}`;
      if (!byRecipient[key]) {
        byRecipient[key] = {
          recipientId: row.recipient_id,
          recipientName: row.recipient_name || 'Unknown',
          direction,
          transactions: [],
        };
      }
      byRecipient[key].transactions.push(row);
    }

    // Batch-fetch all planned recipient IDs in one query (avoids N+1).
    // Keys are now "recipientId:direction" composites — read the id from the
    // group, not the key.
    const allRecipientIds = [...new Set(
      Object.values(byRecipient).map((g) => g.recipientId).filter(Boolean),
    )];
    const plannedRecipientIds = new Set();
    if (plannedTableAvailable && allRecipientIds.length > 0) {
      const plannedResult = await query(
        `SELECT DISTINCT recipient_id FROM planned_transactions
         WHERE recipient_id = ANY($1) AND is_active = true`,
        [allRecipientIds]
      );
      for (const row of plannedResult.rows) plannedRecipientIds.add(row.recipient_id);
    }

    const patterns = [];

    for (const group of Object.values(byRecipient)) {
      const txns = group.transactions;

      if (txns.length < MIN_OCCURRENCES) continue;

      // Calculate intervals between consecutive transactions (in days)
      const intervals = [];
      for (let i = 1; i < txns.length; i++) {
        const d1 = new Date(txns[i - 1].date);
        const d2 = new Date(txns[i].date);
        if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) {
          continue;
        }
        // Use UTC dates to avoid DST off-by-one on 23/25-hour days
        const utc1 = Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate());
        const utc2 = Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate());
        const daysDiff = Math.round((utc2 - utc1) / (1000 * 60 * 60 * 24));
        if (daysDiff > 0) intervals.push(daysDiff);
      }

      if (intervals.length < MIN_OCCURRENCES - 1) continue;

      const detected = detectInterval(intervals);
      if (!detected) continue;

      // Get amounts info — accumulated as Decimals per the monetary-arithmetic rule
      const amounts = txns.map((t) => toDecimal(t.amount).abs());
      const avgAmount = divide(addAll(amounts), amounts.length);
      const latestAmount = amounts[amounts.length - 1];
      const currency = txns[0].currency || 'EUR';

      // Check for amount changes
      const amountChanges = detectAmountChanges(txns);

      // Predict next occurrence. Advance in UTC so it stays consistent with
      // the interval calc above — mixing UTC interval math with local
      // getDate/setDate shifted predictedNext by a day across a DST boundary.
      const lastDate = new Date(txns[txns.length - 1].date);
      if (Number.isNaN(lastDate.getTime())) {
        continue;
      }
      const lastUtcMidnight = Date.UTC(
        lastDate.getFullYear(),
        lastDate.getMonth(),
        lastDate.getDate(),
      );
      const nextDate = new Date(lastUtcMidnight + detected.medianDays * 24 * 60 * 60 * 1000);

      const isAlreadyPlanned = plannedRecipientIds.has(group.recipientId);

      patterns.push({
        recipientId: group.recipientId,
        recipientName: group.recipientName,
        direction: group.direction,
        detectedPattern: detected.pattern,
        intervalDays: detected.medianDays,
        consistency: detected.consistency,
        occurrences: txns.length,
        averageAmount: roundMoney(avgAmount),
        latestAmount: roundMoney(latestAmount),
        currency,
        categoryId: txns[txns.length - 1].category_id,
        categoryName: txns[txns.length - 1].category_name,
        bankAccount: txns[txns.length - 1].bank_account,
        // DATE columns: calendar-day strings, not raw pg Dates (which
        // toJSON to the previous day's ISO timestamp east of UTC).
        firstSeen: toWireDate(txns[0].date),
        lastSeen: toWireDate(txns[txns.length - 1].date),
        predictedNext: nextDate.toISOString().split('T')[0],
        amountChanges,
        isAlreadyPlanned,
        // Confidence score (0-100)
        confidence: Math.min(
          100,
          Math.round(
            detected.consistency * 0.5 +
            Math.min(txns.length, 12) / 12 * 30 +
            (amountChanges.length === 0 ? 20 : 10)
          )
        ),
      });
    }

    // Sort by confidence descending
    patterns.sort((a, b) => b.confidence - a.confidence);

    const value = { patterns, total: patterns.length };
    recurringCache = { value, expiresAt: Date.now() + RECURRING_CACHE_TTL_MS };
    return value;
  } catch (err) {
    logger.error('Error detecting recurring patterns', { error: err.message });
    throw err;
  }
}
