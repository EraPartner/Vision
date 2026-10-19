import plannedTransactionRepository from "../repositories/plannedTransactionRepository.ts";
import type { PlannedCommitmentRow } from "../repositories/plannedTransactionRepository.ts";
import {
  expandOccurrences,
  monthlyOccurrenceFactor,
} from "../lib/calculations/recurrence.ts";
import {
  addDaysYmd,
  firstOfMonthYmd,
  todayAppDateString,
} from "../lib/timezone.ts";
import { toWireDate } from "../lib/dateFormat.ts";
import {
  addAll,
  divide,
  multiply,
  roundMoney,
  toDecimal,
  type Decimal,
} from "../lib/money.ts";
import { listLatestStoredRates } from "./currency/currencyConversionService.ts";

// Same expansion cap as the commitment-aware cash estimate.
const MAX_EXPANDED_OCCURRENCES = 500;
// Planned rows never reach past this; used as "no horizon" for the monthly view.
const OPEN_HORIZON = "9999-12-31";

type RatesToEur = ReadonlyMap<string, Decimal>;

async function loadRatesToEur(): Promise<RatesToEur> {
  const { rows } = await listLatestStoredRates();
  const rates = new Map<string, Decimal>([["EUR", toDecimal(1)]]);
  for (const row of rows) {
    const rate = toDecimal(row.rate_to_eur);
    if (rate.isFinite() && rate.gt(0)) rates.set(row.currency_code, rate);
  }
  return rates;
}

/** Convert with the latest stored rates; undefined when a rate is missing. */
function convert(
  amount: Decimal,
  from: string,
  to: string,
  rates: RatesToEur,
): Decimal | undefined {
  if (from === to) return amount;
  const fromRate = rates.get(from);
  const toRate = rates.get(to);
  if (!fromRate || !toRate) return undefined;
  return divide(multiply(amount, fromRate), toRate);
}

function remainingOccurrences(row: PlannedCommitmentRow): number {
  if (row.max_occurrences == null) return MAX_EXPANDED_OCCURRENCES;
  const left = Math.max(0, row.max_occurrences - row.execution_count);
  return Math.min(left, MAX_EXPANDED_OCCURRENCES);
}

/** Occurrence dates of a row inside [fromYmd, toYmd], honouring its bounds. */
function occurrencesBetween(
  row: PlannedCommitmentRow,
  fromYmd: string,
  toYmd: string,
): string[] {
  const remaining = remainingOccurrences(row);
  if (remaining === 0) return [];
  const lastDate = toWireDate(row.recurrence_end_date);
  return expandOccurrences(row, toYmd, { maxOccurrences: remaining }).filter(
    (date) => date >= fromYmd && (!lastDate || date <= lastDate),
  );
}

function sourceCurrency(row: PlannedCommitmentRow): string {
  return (row.currency || "EUR").toUpperCase();
}

/**
 * Planned money still due from today to the end of the calendar month, every
 * recurring occurrence counted, converted to `currency` at the latest stored
 * rates. Rows without a rate are left out and counted in `unconvertedCount`.
 */
function restOfMonthTotals(
  rows: PlannedCommitmentRow[],
  today: string,
  currency: string,
  rates: RatesToEur,
) {
  const monthEnd = addDaysYmd(firstOfMonthYmd(today, 1), -1);
  const incoming: Decimal[] = [];
  const outgoing: Decimal[] = [];
  let unconvertedCount = 0;
  for (const row of rows) {
    const count = occurrencesBetween(row, today, monthEnd).length;
    if (count === 0) continue;
    const converted = convert(
      toDecimal(row.amount),
      sourceCurrency(row),
      currency,
      rates,
    );
    if (!converted) {
      unconvertedCount += 1;
      continue;
    }
    const total = multiply(converted, count);
    (total.isNegative() ? outgoing : incoming).push(total);
  }
  return {
    monthEnd,
    incoming: roundMoney(addAll(incoming)),
    outgoing: roundMoney(addAll(outgoing)),
    unconvertedCount,
  };
}

/**
 * Net monthly-equivalent amount of the active recurring rows, signed (income
 * positive). A cadence's monthly factor comes from the shared recurrence
 * grammar, so it matches the forecast's notion of a weekly or quarterly row.
 */
function monthlyEquivalent(
  rows: PlannedCommitmentRow[],
  currency: string,
  rates: RatesToEur,
) {
  const amounts: Decimal[] = [];
  let unconvertedCount = 0;
  for (const row of rows) {
    if (!row.is_recurring) continue;
    const factor = monthlyOccurrenceFactor(row.recurrence_pattern);
    if (!factor || remainingOccurrences(row) === 0) continue;
    const converted = convert(
      toDecimal(row.amount),
      sourceCurrency(row),
      currency,
      rates,
    );
    if (!converted) {
      unconvertedCount += 1;
      continue;
    }
    amounts.push(multiply(converted, factor));
  }
  return { total: roundMoney(addAll(amounts)), unconvertedCount };
}

export async function computePlannedTotals({
  currency = "EUR",
}: { currency?: string } = {}) {
  const target = currency.toUpperCase();
  const today = todayAppDateString();
  const [rows, rates] = await Promise.all([
    plannedTransactionRepository.getForCommitmentProjection(OPEN_HORIZON),
    loadRatesToEur(),
  ]);
  const restOfMonth = restOfMonthTotals(rows, today, target, rates);
  const monthly = monthlyEquivalent(rows, target, rates);
  return {
    currency: target,
    today,
    month_end: restOfMonth.monthEnd,
    rest_of_month: {
      incoming: restOfMonth.incoming,
      outgoing: restOfMonth.outgoing,
      unconverted_count: restOfMonth.unconvertedCount,
    },
    monthly_equivalent: {
      total: monthly.total,
      unconverted_count: monthly.unconvertedCount,
    },
  };
}
