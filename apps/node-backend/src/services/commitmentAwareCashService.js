import plannedTransactionRepository from "../repositories/plannedTransactionRepository.js";
import {
  expandOccurrences,
  nextOccurrenceYmd,
} from "../lib/calculations/recurrence.js";
import { todayAppDateString } from "../lib/timezone.js";
import { toWireDate } from "../lib/dateFormat.js";
import {
  convertWithRates,
  listLatestStoredRates,
} from "./currency/currencyConversionService.js";
import { assembleRebalanceInputs } from "./crossWorkspaceDataService.js";
import { projectCommitmentAwareCash } from "./commitmentAwareCash.js";

const HORIZON_DAYS = 90;

/** @param {string} today */
function horizonEndFor(today) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + HORIZON_DAYS);
  return date.toISOString().slice(0, 10);
}

/**
 * Estimate the lowest end-of-day spendable balance over the next 90 days.
 * Only explicit planned rows are included. The existing statistical cashflow
 * forecast is deliberately excluded because it can contain the same bills.
 * @param {{ currency?: string, reserveFloor?: number }} input
 */
export async function computeCommitmentAwareCash({
  currency = "EUR",
  reserveFloor = 0,
} = {}) {
  const today = todayAppDateString();
  const horizonEnd = horizonEndFor(today);
  const target = currency.toUpperCase();
  const [rows, stored] = await Promise.all([
    plannedTransactionRepository.getForCommitmentProjection(horizonEnd),
    listLatestStoredRates(),
  ]);
  const rates = Object.fromEntries(
    stored.rows.map((row) => [row.currency_code, Number(row.rate_to_eur)]),
  );
  rates.EUR = 1;
  const { availableCash, cashCurrencies } = await assembleRebalanceInputs({
    currency: target,
    rates,
  });

  const occurrences = [];
  for (const row of rows) {
    // A spending cap must not depend on future income arriving as planned.
    if (Number(row.amount) >= 0) continue;
    const remaining =
      row.max_occurrences == null
        ? Number.POSITIVE_INFINITY
        : Math.max(
            0,
            Number(row.max_occurrences) - Number(row.execution_count),
          );
    if (remaining === 0) continue;
    const lastDate = toWireDate(row.recurrence_end_date);
    const dates = expandOccurrences(row, horizonEnd, {
      maxOccurrences: Math.min(remaining, 500),
    });
    const nextDate =
      row.is_recurring && remaining > 500 && dates.length === 500
        ? nextOccurrenceYmd(dates.at(-1), row.recurrence_pattern)
        : undefined;
    if (
      nextDate &&
      nextDate <= horizonEnd &&
      (!lastDate || nextDate <= lastDate)
    ) {
      throw new Error(
        "Cash estimate unavailable: recurring item exceeds expansion limit",
      );
    }
    const sourceCurrency = (row.currency || "EUR").toUpperCase();
    for (const date of dates) {
      if (lastDate && date > lastDate) break;
      occurrences.push({
        date,
        amount: Number(row.amount),
        currency: sourceCurrency,
      });
    }
  }

  const conversionCurrencies = new Set([
    target,
    ...cashCurrencies,
    ...occurrences.map((occurrence) => occurrence.currency),
  ]);
  if (![...conversionCurrencies].some((code) => code !== target)) {
    conversionCurrencies.clear();
  }
  conversionCurrencies.delete("EUR");
  if (conversionCurrencies.size > 0) {
    const freshAfter = new Date(`${today}T00:00:00Z`);
    freshAfter.setUTCDate(freshAfter.getUTCDate() - 7);
    const cutoff = freshAfter.toISOString().slice(0, 10);
    for (const code of conversionCurrencies) {
      if (!Number.isFinite(rates[code]) || rates[code] <= 0) {
        throw new Error(
          `Cash estimate unavailable: no exchange rate for ${code}`,
        );
      }
      const row = stored.rows.find((item) => item.currency_code === code);
      if (
        !row ||
        !toWireDate(row.rate_date) ||
        toWireDate(row.rate_date) < cutoff
      ) {
        throw new Error(
          `Cash estimate unavailable: exchange rate for ${code} is stale`,
        );
      }
    }
  }
  const convertedOccurrences = occurrences.map((occurrence) => ({
    date: occurrence.date,
    amount: convertWithRates(
      occurrence.amount,
      occurrence.currency,
      target,
      rates,
    ),
  }));

  return {
    currency: target,
    today,
    horizonEnd,
    horizonDays: HORIZON_DAYS,
    ...projectCommitmentAwareCash({
      currentCash: availableCash,
      reserveFloor,
      today,
      horizonEnd,
      occurrences: convertedOccurrences,
    }),
    assumptions: {
      plannedOnly: true,
      excludesStatisticalForecast: true,
      excludesFutureIncome: true,
      excludesUnplannedExpenses: true,
      currencyConversionAtRecentRates: true,
    },
  };
}
