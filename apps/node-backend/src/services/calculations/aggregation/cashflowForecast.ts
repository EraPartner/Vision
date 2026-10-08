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

import plannedTransactionRepository from '../../../repositories/plannedTransactionRepository.ts';
import { expandOccurrences as expandRecurrence } from '../../../lib/calculations/recurrence.ts';
import { buildEnvelope } from './_envelope.ts';
import { assertNoNaN } from './_invariants.ts';
import { toAppTz, appDateStringToUtc, toAppDateString } from '../../../lib/timezone.ts';
import { toDecimal, roundMoney } from '../../../lib/money.ts';
import type Decimal from 'decimal.js';
import type { PlannedForecastRow } from '../../../types/rows.ts';

const MAX_MONTHS = 24;
const MAX_OCCURRENCES_PER_ITEM = 500; // guard against infinite-loop on tiny intervals

export interface ForecastItem {
  id: number;
  currency: string;
  amount: number;
  memo: string | null;
  recipient_name: string | null;
  category_name: string | null;
  is_recurring: boolean;
  recurrence_pattern: string | null;
  planned_date: string;
}

interface ForecastBucket {
  month: string;
  income: Decimal;
  expenses: Decimal;
  net: Decimal;
  items: ForecastItem[];
}

/**
 * @param d  UTC Date
 * @returns 'YYYY-MM' in APP_TIMEZONE
 */
function toMonthKey(d: Date): string {
  const { year, month } = toAppTz(d);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Build the ordered list of month keys for the forecast window.
 * Starts with the current month, runs for `months` months.
 *
 * @param todayParts  APP_TIMEZONE components
 */
function buildMonthKeys(
  todayParts: { year: number; month: number },
  months: number,
): string[] {
  const keys: string[] = [];
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
 * @param start  inclusive
 * @param end    inclusive
 */
function expandOccurrences(
  row: PlannedForecastRow,
  start: Date,
  end: Date,
): Array<{ date: Date; item: ForecastItem }> {
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

  // Shared app-tz-correct horizon expansion yields occurrence day-strings up to
  // and including the window end; apply this window's lower bound here (the
  // helper only takes an upper horizon). Day-granular string compare matches the
  // former Date compare since both are start-of-day in APP_TIMEZONE.
  const startYmd = toAppDateString(start);
  const horizonYmd = toAppDateString(end);

  const occurrences: Array<{ date: Date; item: ForecastItem }> = [];
  for (const ymd of expandRecurrence(row, horizonYmd, { maxOccurrences: MAX_OCCURRENCES_PER_ITEM })) {
    if (ymd < startYmd) continue;
    occurrences.push({ date: appDateStringToUtc(ymd), item: { ...base, planned_date: ymd } });
  }
  return occurrences;
}

export async function computeCashflowForecast({
  months = 3,
}: { months?: number } = {}) {
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
  const buckets = new Map<string, ForecastBucket>(
    monthKeys.map((k): [string, ForecastBucket] => [
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
    // Every month key was seeded into `buckets` above.
    const b = buckets.get(k)!;
    return {
      month: b.month,
      income: roundMoney(b.income),
      expenses: roundMoney(b.expenses),
      net: roundMoney(b.net),
      items: b.items.sort((a, z) => a.planned_date.localeCompare(z.planned_date)),
    };
  });

  assertNoNaN(data, 'computeCashflowForecast');
  return buildEnvelope(data, {
    source: 'live',
  });
}

export default { computeCashflowForecast };
