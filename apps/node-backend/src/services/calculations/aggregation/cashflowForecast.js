/**
 * Cash flow forecast aggregation.
 *
 * Projects active, unexecuted planned transactions forward over a rolling
 * N-month window. Recurring transactions are expanded into individual
 * occurrences using the same date-advance logic as the execute-and-advance
 * endpoint. Non-recurring transactions are included once at their planned_date.
 *
 * Output shape per month:
 *   {
 *     month:    'YYYY-MM',
 *     income:   number,   // sum of positive amounts
 *     expenses: number,   // sum of negative amounts (negative value)
 *     net:      number,   // income + expenses
 *     items:    Array<ForecastItem>
 *   }
 *
 * Amounts are returned as-is in their stored currency (no FX conversion —
 * future rates are unknown and the forecast is inherently approximate).
 *
 * @module cashflowForecast
 */

import plannedTransactionRepository from '../../../repositories/plannedTransactionRepository.js';
import { calculateNextDate } from '../recurrence.js';
import { buildEnvelope } from './_envelope.js';

const MAX_MONTHS = 24;
const MAX_OCCURRENCES_PER_ITEM = 500; // guard against infinite-loop on tiny intervals

/**
 * @param {Date} d
 * @returns {string} 'YYYY-MM'
 */
function toMonthKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * @param {string} isoDateStr  e.g. '2026-05-15'
 * @returns {Date} UTC midnight
 */
function parseUtcDate(isoDateStr) {
  const [y, m, day] = String(isoDateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

/**
 * Build the ordered list of month keys for the forecast window.
 * Starts with the current month, runs for `months` months.
 *
 * @param {Date} today
 * @param {number} months
 * @returns {string[]}
 */
function buildMonthKeys(today, months) {
  const keys = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + i, 1));
    keys.push(toMonthKey(d));
  }
  return keys;
}

/**
 * Expand one planned-transaction row into forecast occurrences within [start, end].
 *
 * @param {object} row
 * @param {Date} start  inclusive
 * @param {Date} end    inclusive
 * @returns {Array<{date: Date, item: object}>}
 */
function expandOccurrences(row, start, end) {
  const amount = parseFloat(row.amount);
  const base = {
    id: row.id,
    currency: row.currency ?? 'EUR',
    amount,
    memo: row.memo ?? null,
    recipient_name: row.recipient_name ?? null,
    category_name: row.category_name ?? null,
    is_recurring: row.is_recurring,
    recurrence_pattern: row.recurrence_pattern ?? null,
  };

  const occurrences = [];

  if (!row.is_recurring || !row.recurrence_pattern) {
    // One-shot: include only if within window
    const d = parseUtcDate(row.planned_date);
    if (d >= start && d <= end) {
      occurrences.push({ date: d, item: { ...base, planned_date: d.toISOString().slice(0, 10) } });
    }
    return occurrences;
  }

  // Recurring: walk forward from the stored planned_date (first upcoming
  // occurrence), generating dates until we exceed the forecast horizon.
  let current = parseUtcDate(row.planned_date);
  let count = 0;

  while (current <= end && count < MAX_OCCURRENCES_PER_ITEM) {
    if (current >= start) {
      occurrences.push({
        date: current,
        item: { ...base, planned_date: current.toISOString().slice(0, 10) },
      });
    }
    const next = calculateNextDate(current, row.recurrence_pattern);
    if (!next || next <= current) break; // safety: no forward progress
    current = next;
    count++;
  }

  return occurrences;
}

/**
 * @param {{ months?: number }} opts
 * @returns {Promise<{ data: object[], meta: object }>}
 */
export async function computeCashflowForecast({ months = 3 } = {}) {
  const safeMonths = Math.max(1, Math.min(MAX_MONTHS, Math.round(months)));

  const today = new Date();
  const windowStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const windowEnd = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + safeMonths, 0) // last day of last month
  );

  const rows = await plannedTransactionRepository.getForForecast(safeMonths);

  // Build month buckets
  const monthKeys = buildMonthKeys(today, safeMonths);
  /** @type {Map<string, { income: number, expenses: number, net: number, items: object[] }>} */
  const buckets = new Map(
    monthKeys.map((k) => [k, { month: k, income: 0, expenses: 0, net: 0, items: [] }])
  );

  for (const row of rows) {
    const occurrences = expandOccurrences(row, windowStart, windowEnd);
    for (const { date, item } of occurrences) {
      const key = toMonthKey(date);
      const bucket = buckets.get(key);
      if (!bucket) continue; // outside window (shouldn't happen)

      const amt = item.amount;
      if (amt >= 0) {
        bucket.income += amt;
      } else {
        bucket.expenses += amt;
      }
      bucket.net += amt;
      bucket.items.push(item);
    }
  }

  // Round to 2dp and sort items within each bucket by date
  const data = monthKeys.map((k) => {
    const b = buckets.get(k);
    return {
      month: b.month,
      income: Math.round(b.income * 100) / 100,
      expenses: Math.round(b.expenses * 100) / 100,
      net: Math.round(b.net * 100) / 100,
      items: b.items.sort((a, z) => a.planned_date.localeCompare(z.planned_date)),
    };
  });

  return buildEnvelope(data, {
    source: 'live',
  });
}

export default { computeCashflowForecast };
