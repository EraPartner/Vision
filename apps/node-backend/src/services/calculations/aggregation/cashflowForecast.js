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
 * All date bucketing happens in APP_TIMEZONE wall-clock so it stays consistent
 * with `calculateNextDate` (which advances recurrences in APP_TIMEZONE). Mixing
 * UTC-midnight parsing with app-TZ advance previously let an occurrence land in
 * the wrong forecast month across a DST boundary.
 *
 * @module cashflowForecast
 */

import plannedTransactionRepository from '../../../repositories/plannedTransactionRepository.js';
import { calculateNextDate } from '../recurrence.js';
import { buildEnvelope } from './_envelope.js';
import { toAppTz, appDateStringToUtc, toAppDateString } from '../../../lib/timezone.js';
import { toDecimal, roundMoney } from '../../../lib/money.js';

const MAX_MONTHS = 24;
const MAX_OCCURRENCES_PER_ITEM = 500; // guard against infinite-loop on tiny intervals

/**
 * @param {Date} d  UTC Date
 * @returns {string} 'YYYY-MM' in APP_TIMEZONE
 */
function toMonthKey(d) {
  const { year, month } = toAppTz(d);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * @param {string|Date} value  e.g. '2026-05-15', or a pg-returned DATE column
 * @returns {Date} UTC Date for start-of-day in APP_TIMEZONE
 */
function parseDate(value) {
  // node-postgres parses DATE columns into a JS Date at server-local midnight
  // (no custom type parser is registered). `String(date)` then yields e.g.
  // 'Mon Jun 08 ...', which appDateStringToUtc rejects — crashing the forecast
  // whenever a planned transaction exists. Recover the stored calendar day with
  // local getters before re-parsing in APP_TIMEZONE.
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return appDateStringToUtc(`${y}-${m}-${d}`);
  }
  return appDateStringToUtc(String(value).slice(0, 10));
}

/**
 * Build the ordered list of month keys for the forecast window.
 * Starts with the current month, runs for `months` months.
 *
 * @param {{ year: number, month: number }} todayParts  APP_TIMEZONE components
 * @param {number} months
 * @returns {string[]}
 */
function buildMonthKeys(todayParts, months) {
  const keys = [];
  for (let i = 0; i < months; i++) {
    const monthIndex = todayParts.month - 1 + i;
    const year = todayParts.year + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    keys.push(`${year}-${String(month).padStart(2, '0')}`);
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
  const amount = toDecimal(row.amount).toNumber();
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
    const d = parseDate(row.planned_date);
    if (d >= start && d <= end) {
      occurrences.push({ date: d, item: { ...base, planned_date: toAppDateString(d) } });
    }
    return occurrences;
  }

  // Recurring: walk forward from the stored planned_date (first upcoming
  // occurrence), generating dates until we exceed the forecast horizon.
  let current = parseDate(row.planned_date);
  let count = 0;

  while (current <= end && count < MAX_OCCURRENCES_PER_ITEM) {
    if (current >= start) {
      occurrences.push({
        date: current,
        item: { ...base, planned_date: toAppDateString(current) },
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

  const todayParts = toAppTz(new Date());
  const monthKeys = buildMonthKeys(todayParts, safeMonths);
  const windowStart = appDateStringToUtc(`${monthKeys[0]}-01`);
  // Last day of the final window month = day 0 of the month after it.
  const lastKey = monthKeys[monthKeys.length - 1];
  const [lastYear, lastMonth] = lastKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(lastYear, lastMonth, 0)).getUTCDate();
  const windowEnd = appDateStringToUtc(`${lastKey}-${String(lastDay).padStart(2, '0')}`);

  const rows = await plannedTransactionRepository.getForForecast(safeMonths);

  // Build month buckets — income/expenses/net accumulate as Decimal so a long
  // window of many occurrences doesn't drift before the round-on-emit below.
  /** @type {Map<string, { month: string, income: import('decimal.js').default, expenses: import('decimal.js').default, net: import('decimal.js').default, items: any[] }>} */
  const buckets = new Map(
    monthKeys.map((k) => [
      k,
      { month: k, income: toDecimal(0), expenses: toDecimal(0), net: toDecimal(0), items: [] },
    ])
  );

  for (const row of rows) {
    const occurrences = expandOccurrences(row, windowStart, windowEnd);
    for (const { date, item } of occurrences) {
      const key = toMonthKey(date);
      const bucket = buckets.get(key);
      if (!bucket) continue; // outside window (shouldn't happen)

      const amt = toDecimal(item.amount);
      if (amt.gte(0)) {
        bucket.income = bucket.income.plus(amt);
      } else {
        bucket.expenses = bucket.expenses.plus(amt);
      }
      bucket.net = bucket.net.plus(amt);
      bucket.items.push(item);
    }
  }

  // Round to 2dp and sort items within each bucket by date
  const data = monthKeys.map((k) => {
    const b = buckets.get(k);
    return {
      month: b.month,
      income: roundMoney(b.income),
      expenses: roundMoney(b.expenses),
      net: roundMoney(b.net),
      items: b.items.sort((a, z) => a.planned_date.localeCompare(z.planned_date)),
    };
  });

  return buildEnvelope(data, {
    source: 'live',
  });
}

export default { computeCashflowForecast };
