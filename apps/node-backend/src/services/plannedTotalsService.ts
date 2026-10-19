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
import type { CurrencyCode } from "@vision/types/brands";
import {
  money,
  multiply,
  roundMoney,
  sumMoney,
  type DecimalInput,
  type Money,
} from "../lib/money.ts";
import { EUR } from "../lib/currencyCode.ts";
import {
  convertAtLatestRates as convert,
  currencyCode,
  loadLatestRatesToEur,
  type LatestRatesToEur as RatesToEur,
} from "./currency/latestRateConversion.ts";

// Same expansion cap as the commitment-aware cash estimate.
const MAX_EXPANDED_OCCURRENCES = 500;
// Planned rows never reach past this; used as "no horizon" for the monthly view.
const OPEN_HORIZON = "9999-12-31";
// The planned page's day strip: today plus the seven days after it.
const NEXT_DAYS_WINDOW = 8;

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

function plannedAmount(row: PlannedCommitmentRow): Money {
  return money(row.amount, currencyCode(row.currency));
}

/** `value` repeated `times`, in its own currency. */
function times(value: Money, factor: DecimalInput): Money {
  return money(multiply(value.amount, factor), value.currency);
}

/** Rounded sum of Money already converted to `currency`. */
function roundedSum(values: readonly Money[], currency: CurrencyCode): number {
  return roundMoney(sumMoney(values, currency).amount);
}

/**
 * Planned money still due from today to the end of the calendar month, every
 * recurring occurrence counted, converted to `currency` at the latest stored
 * rates. Rows without a rate are left out and counted in `unconvertedCount`.
 */
function restOfMonthTotals(
  rows: PlannedCommitmentRow[],
  today: string,
  currency: CurrencyCode,
  rates: RatesToEur,
) {
  const monthEnd = addDaysYmd(firstOfMonthYmd(today, 1), -1);
  const incoming: Money[] = [];
  const outgoing: Money[] = [];
  let unconvertedCount = 0;
  for (const row of rows) {
    const count = occurrencesBetween(row, today, monthEnd).length;
    if (count === 0) continue;
    const converted = convert(plannedAmount(row), currency, rates);
    if (!converted) {
      unconvertedCount += 1;
      continue;
    }
    const total = times(converted, count);
    (total.amount.isNegative() ? outgoing : incoming).push(total);
  }
  return {
    monthEnd,
    incoming: roundedSum(incoming, currency),
    outgoing: roundedSum(outgoing, currency),
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
  currency: CurrencyCode,
  rates: RatesToEur,
) {
  const amounts: Money[] = [];
  let unconvertedCount = 0;
  for (const row of rows) {
    if (!row.is_recurring) continue;
    const factor = monthlyOccurrenceFactor(row.recurrence_pattern);
    if (!factor || remainingOccurrences(row) === 0) continue;
    const converted = convert(plannedAmount(row), currency, rates);
    if (!converted) {
      unconvertedCount += 1;
      continue;
    }
    amounts.push(times(converted, factor));
  }
  return { total: roundedSum(amounts, currency), unconvertedCount };
}

/**
 * Planned money per day for today and the seven days after it, every
 * recurring occurrence counted on its own day, converted to `currency` at the
 * latest stored rates. A row without a rate is left out and counted on each
 * day it falls on; the window total counts it once, like `rest_of_month`.
 */
function nextDaysTotals(
  rows: PlannedCommitmentRow[],
  today: string,
  currency: CurrencyCode,
  rates: RatesToEur,
) {
  const dates = Array.from({ length: NEXT_DAYS_WINDOW }, (_, offset) =>
    addDaysYmd(today, offset),
  );
  const lastDate = addDaysYmd(today, NEXT_DAYS_WINDOW - 1);
  const days = new Map(
    dates.map((date) => [
      date,
      { incoming: [] as Money[], outgoing: [] as Money[], unconverted: 0 },
    ]),
  );
  const unconvertedRows = new Set<number>();
  for (const row of rows) {
    const occurrences = occurrencesBetween(row, today, lastDate);
    if (occurrences.length === 0) continue;
    const converted = convert(plannedAmount(row), currency, rates);
    if (!converted) unconvertedRows.add(row.id);
    for (const date of occurrences) {
      const day = days.get(date);
      if (!day) continue;
      if (!converted) day.unconverted += 1;
      else
        (converted.amount.isNegative() ? day.outgoing : day.incoming).push(
          converted,
        );
    }
  }
  const buckets = [...days.values()];
  const incoming = sumMoney(
    buckets.flatMap((day) => day.incoming),
    currency,
  ).amount;
  const outgoing = sumMoney(
    buckets.flatMap((day) => day.outgoing),
    currency,
  ).amount;
  return {
    days: dates.map((date) => {
      const day = days.get(date)!;
      return {
        date,
        incoming: roundedSum(day.incoming, currency),
        outgoing: roundedSum(day.outgoing, currency),
        unconverted_count: day.unconverted,
      };
    }),
    total: {
      from: today,
      to: lastDate,
      incoming: roundMoney(incoming),
      outgoing: roundMoney(outgoing),
      net: roundMoney(incoming.plus(outgoing)),
      unconverted_count: unconvertedRows.size,
    },
  };
}

export async function computePlannedTotals({
  currency = EUR,
}: { currency?: CurrencyCode } = {}) {
  const target = currency;
  const today = todayAppDateString();
  const [rows, rates] = await Promise.all([
    plannedTransactionRepository.getForCommitmentProjection(OPEN_HORIZON),
    loadLatestRatesToEur(),
  ]);
  const restOfMonth = restOfMonthTotals(rows, today, target, rates);
  const monthly = monthlyEquivalent(rows, target, rates);
  const nextDays = nextDaysTotals(rows, today, target, rates);
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
    next_days: nextDays.days,
    next_days_total: nextDays.total,
  };
}
