/**
 * Recurring Transaction Detection Service.
 *
 * Analyses transaction history to detect recurring patterns:
 * - Groups transactions by recipient
 * - Detects regular intervals (weekly, monthly, quarterly, yearly)
 * - Flags amount changes
 * - Returns suggestions for planned transactions
 */

import { queryOne, queryRows } from "../database/rowContracts.ts";
import {
  plannedRecipientIdRowSchema,
  recurringCandidateRowSchema,
  tableExistsRowSchema,
} from "../database/rows/ledger.ts";
import type { RecurringCandidateRow } from "../database/rows/ledger.ts";
import { normalizeDateLikeToYmd, toWireDate } from "../lib/dateFormat.ts";
import { addDaysYmd, differenceInCalendarDaysYmd } from "../lib/timezone.ts";
import { logger } from "../config/logger.ts";
import { addAll, divide, roundMoney, toDecimal } from "../lib/money.ts";
import { median } from "../lib/math.ts";

/**
 * The bespoke projection `detectRecurringPatterns`' query selects — not a
 * plain `SELECT t.*`, so distinct from `TransactionRow` in types/rows.ts.
 * Derived from its row schema.
 */
export type { RecurringCandidateRow };

export interface RecurringGroup {
  recipientId: number|null;
  recipientName: string;
  direction: 'income'|'expense';
  transactions: RecurringCandidateRow[];
}

export interface RecurringAmountChange {
  date: Date;
  previousAmount: number;
  newAmount: number;
  percentChange: number;
  direction: 'increased'|'decreased';
}

/**
 * One entry of `detectRecurringPatterns`'s result — a detected recurring
 * pattern for one (recipient, direction) group.
 */
export interface RecurringPattern {
  recipientId: number|null;
  recipientName: string;
  direction: 'income'|'expense';
  detectedPattern: string;
  intervalDays: number;
  consistency: number;
  occurrences: number;
  averageAmount: number;
  latestAmount: number;
  currency: string;
  categoryId: number|null;
  categoryName: string|null;
  bankAccount: string|null;
  accountId: number|null;
  /** 'YYYY-MM-DD' */
  firstSeen: string|null;
  /** 'YYYY-MM-DD' */
  lastSeen: string|null;
  /** 'YYYY-MM-DD' */
  predictedNext: string;
  amountChanges: RecurringAmountChange[];
  isAlreadyPlanned: boolean;
  confidence: number;
}

export interface RecurringDetectionResult {
  patterns: RecurringPattern[];
  total: number;
}

interface IntervalDetection {
  pattern: string;
  avgDays: number;
  medianDays: number;
  consistency: number;
  customIntervalDays?: number;
}

const MIN_OCCURRENCES = 3; // Minimum transactions to consider a pattern

/** `[items[i - 1], items[i]]` for every i >= 1, in order. */
function consecutivePairs<T>(items: readonly T[]): Array<[T, T]> {
  // i < items.length - 1, so items[i + 1] is in bounds.
  return items.slice(0, -1).map((prev, i) => [prev, items[i + 1]!]);
}
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
let recurringCache: {
  value: RecurringDetectionResult;
  expiresAt: number;
} | null = null;

/** Test-only: drop the cached recurring-patterns result. */
export function __clearRecurringCacheForTests() {
  recurringCache = null;
}

// Known interval patterns (in days)
const INTERVAL_PATTERNS = [
  { name: "weekly", days: 7, tolerance: 2 },
  { name: "biweekly", days: 14, tolerance: 3 },
  { name: "monthly", days: 30, tolerance: 5 },
  { name: "quarterly", days: 91, tolerance: 10 },
  { name: "yearly", days: 365, tolerance: 20 },
];

/** Detect the most likely recurrence pattern from a series of intervals. */
function detectInterval(intervals: number[]): IntervalDetection | null {
  if (intervals.length === 0) return null;

  const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const medianInterval = median(intervals);
  // Unreachable: `median` is undefined only for an empty array.
  if (medianInterval === undefined) return null;

  // Try to match against known patterns using median (more robust to outliers)
  for (const pattern of INTERVAL_PATTERNS) {
    if (Math.abs(medianInterval - pattern.days) <= pattern.tolerance) {
      // Verify consistency: most intervals should be within tolerance
      const matching = intervals.filter(
        (i) => Math.abs(i - pattern.days) <= pattern.tolerance,
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
    intervals.reduce((s, v) => s + Math.pow(v - avgInterval, 2), 0) /
      intervals.length,
  );
  const cv = stdDev / avgInterval; // Coefficient of variation

  if (cv < INTERVAL_TOLERANCE && avgInterval >= 5) {
    return {
      pattern: "custom",
      avgDays: Math.round(avgInterval),
      medianDays: Math.round(medianInterval),
      consistency: Math.round((1 - cv) * 100),
      customIntervalDays: Math.round(medianInterval),
    };
  }

  return null;
}

/** Detect amount changes in a recurring pattern. */
function detectAmountChanges(
  transactions: RecurringCandidateRow[],
): RecurringAmountChange[] {
  if (transactions.length < 2) return [];

  const changes: RecurringAmountChange[] = [];
  const sorted = [...transactions].sort((a, b) => {
    const aTime = new Date(a?.date).getTime();
    const bTime = new Date(b?.date).getTime();

    if (Number.isNaN(aTime) && Number.isNaN(bTime)) {
      return Number(a?.id ?? 0) - Number(b?.id ?? 0);
    }
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return aTime - bTime || Number(a?.id ?? 0) - Number(b?.id ?? 0);
  });

  // Compare recent charges with the immediately preceding chronological
  // charge. This keeps `previousAmount` literal and avoids describing an
  // all-history median as the prior price.
  // The last (up to) three consecutive pairs.
  for (const [previous, current] of consecutivePairs(sorted).slice(-3)) {
    const previousAmount = toDecimal(previous.amount).abs().toNumber();
    if (!Number.isFinite(previousAmount) || previousAmount === 0) continue;

    const amt = toDecimal(current.amount).abs().toNumber();
    const pctChange = ((amt - previousAmount) / previousAmount) * 100;

    if (Math.abs(pctChange) > 5) {
      // More than 5% change from the preceding charge.
      changes.push({
        date: current.date,
        previousAmount,
        newAmount: amt,
        percentChange: Math.round(pctChange * 100) / 100,
        direction: pctChange > 0 ? "increased" : "decreased",
      });
    }
  }

  return changes;
}

/**
 * Main detection function - analyses all transactions and returns recurring patterns.
 */
export async function detectRecurringPatterns(): Promise<RecurringDetectionResult> {
  if (recurringCache && Date.now() < recurringCache.expiresAt) {
    return recurringCache.value;
  }
  try {
    // Get transactions grouped by recipient, ordered by date. Bounded to the
    // last ~3 years: recurrence is detected from interval cadence, so older
    // history adds scan cost without changing the result. Without the bound
    // this was a full-table scan on every call (including via the aiChat
    // getRecurringDetected tool).
    // Effective category is the canonical 3-level resolution (own → recipient
    // default → PRIMARY recipient's default), matching transactionRepository —
    // a row recorded under an alias whose PRIMARY carries the default category
    // must not report a null category_name here while the transactions list
    // shows it categorised.
    const rows = await queryRows(
      recurringCandidateRowSchema,
      `
      SELECT t.id, t.date, t.amount, t.currency, t.memo, t.account_id,
             acct.name AS bank_account,
             COALESCE(r.primary_recipient_id, t.recipient_id) AS recipient_id,
             COALESCE(pr.name, r.name) AS recipient_name,
             COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS effective_category_id,
             c.path_name AS category_name
      FROM transactions t
      LEFT JOIN accounts acct ON t.account_id = acct.id
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id
      WHERE t.is_active = true
        AND t.recipient_id IS NOT NULL
        AND t.date >= CURRENT_DATE - INTERVAL '3 years'
      ORDER BY COALESCE(r.primary_recipient_id, t.recipient_id), t.date
    `,
    );

    if (rows.length === 0) {
      const empty: RecurringDetectionResult = { patterns: [], total: 0 };
      recurringCache = {
        value: empty,
        expiresAt: Date.now() + RECURRING_CACHE_TTL_MS,
      };
      return empty;
    }

    // planned_transactions may not exist in partially initialized environments.
    const plannedTableCheck = await queryOne(
      tableExistsRowSchema,
      `SELECT to_regclass('public.planned_transactions') IS NOT NULL AS exists`,
    );
    const plannedTableAvailable = Boolean(plannedTableCheck?.exists);

    // Group by recipient AND flow direction. Bucketing on recipient alone
    // blended income and expense from the same recipient (e.g. an employer
    // that is also occasionally reimbursed) into one averaged "pattern" that
    // matched neither real flow — amounts go through .abs() below, so the
    // sign distinction would otherwise be lost entirely.
    const byRecipient: Record<string, RecurringGroup> = {};
    for (const row of rows) {
      const direction = Number(row.amount) < 0 ? "expense" : "income";
      const key = `${row.recipient_id}:${direction}`;
      if (!byRecipient[key]) {
        byRecipient[key] = {
          recipientId: row.recipient_id,
          recipientName: row.recipient_name || "Unknown",
          direction,
          transactions: [],
        };
      }
      byRecipient[key].transactions.push(row);
    }

    // Batch-fetch all planned recipient IDs in one query (avoids N+1).
    // Keys are now "recipientId:direction" composites — read the id from the
    // group, not the key.
    const allRecipientIds = [
      ...new Set(
        Object.values(byRecipient)
          .map((g) => g.recipientId)
          .filter(Boolean),
      ),
    ];
    const plannedRecipientIds = new Set<number | null>();
    if (plannedTableAvailable && allRecipientIds.length > 0) {
      const plannedRows = await queryRows(
        plannedRecipientIdRowSchema,
        `SELECT DISTINCT COALESCE(r.primary_recipient_id, pt.recipient_id) AS recipient_id
           FROM planned_transactions pt
           LEFT JOIN recipients r ON pt.recipient_id = r.id
          WHERE COALESCE(r.primary_recipient_id, pt.recipient_id) = ANY($1)
            AND pt.is_active = true`,
        [allRecipientIds],
      );
      for (const row of plannedRows) plannedRecipientIds.add(row.recipient_id);
    }

    const patterns: RecurringPattern[] = [];

    for (const group of Object.values(byRecipient)) {
      const txns = group.transactions;
      const [first] = txns;
      const latest = txns.at(-1);

      if (txns.length < MIN_OCCURRENCES || !first || !latest) continue;

      // Calculate intervals between consecutive transactions (in days)
      const intervals: number[] = [];
      for (const [previous, current] of consecutivePairs(txns)) {
        const d1 = normalizeDateLikeToYmd(previous.date);
        const d2 = normalizeDateLikeToYmd(current.date);
        if (!d1 || !d2) {
          continue;
        }
        const daysDiff = differenceInCalendarDaysYmd(d1, d2);
        if (daysDiff > 0) intervals.push(daysDiff);
      }

      if (intervals.length < MIN_OCCURRENCES - 1) continue;

      const detected = detectInterval(intervals);
      if (!detected) continue;

      // Get amounts info — accumulated as Decimals per the monetary-arithmetic rule
      const amounts = txns.map((t) => toDecimal(t.amount).abs());
      const avgAmount = divide(addAll(amounts), amounts.length);
      const latestAmount = toDecimal(latest.amount).abs();
      const currency = first.currency || "EUR";

      // Check for amount changes
      const amountChanges = detectAmountChanges(txns);

      // Predict next occurrence. Advance in UTC so it stays consistent with
      // the interval calc above — mixing UTC interval math with local
      // getDate/setDate shifted predictedNext by a day across a DST boundary.
      const lastDate = normalizeDateLikeToYmd(latest.date);
      if (!lastDate) {
        continue;
      }
      const nextDate = addDaysYmd(lastDate, detected.medianDays);

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
        categoryId: latest.effective_category_id,
        categoryName: latest.category_name,
        bankAccount: latest.bank_account,
        accountId: latest.account_id,
        // DATE columns: calendar-day strings, not raw pg Dates (which
        // toJSON to the previous day's ISO timestamp east of UTC).
        firstSeen: toWireDate(first.date),
        lastSeen: toWireDate(latest.date),
        predictedNext: nextDate,
        amountChanges,
        isAlreadyPlanned,
        // Confidence score (0-100)
        confidence: Math.min(
          100,
          Math.round(
            detected.consistency * 0.5 +
              (Math.min(txns.length, 12) / 12) * 30 +
              (amountChanges.length === 0 ? 20 : 10),
          ),
        ),
      });
    }

    // Sort by confidence descending
    patterns.sort((a, b) => b.confidence - a.confidence);

    const value = { patterns, total: patterns.length };
    recurringCache = { value, expiresAt: Date.now() + RECURRING_CACHE_TTL_MS };
    return value;
  } catch (err) {
    logger.error("Error detecting recurring patterns", {
      error: err instanceof Error ? err.message : undefined,
    });
    throw err;
  }
}
