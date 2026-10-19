/**
 * Conversion at the latest STORED exchange rates (ADR-216): server-owned
 * totals (planned, accounts, owes, portfolio rent, net worth by account)
 * convert with the rates the user can see on the exchange-rates page. A
 * currency without a stored rate is unavailable — never a hard-coded constant
 * and never a 1:1 blend — so callers leave the amount out of a total and flag
 * or count it.
 */

import { isCurrencyCode } from "@vision/types/brands";
import type { CurrencyCode } from "@vision/types/brands";
import { divide, money, multiply, toDecimal } from "../../lib/money.ts";
import type { Decimal, Money } from "../../lib/money.ts";
import { listLatestStoredRates } from "./currencyConversionService.ts";
import { EUR, storedCurrencyCode } from "../../lib/currencyCode.ts";

/** rate_to_eur per upper-cased currency code; EUR is always 1. */
export type LatestRatesToEur = ReadonlyMap<CurrencyCode, Decimal>;

export async function loadLatestRatesToEur(): Promise<LatestRatesToEur> {
  const { rows } = await listLatestStoredRates();
  const rates = new Map<CurrencyCode, Decimal>([[EUR, toDecimal(1)]]);
  for (const row of rows) {
    const code = row.currency_code.toUpperCase();
    const rate = toDecimal(row.rate_to_eur);
    if (isCurrencyCode(code) && rate.isFinite() && rate.gt(0))
      rates.set(code, rate);
  }
  return rates;
}

/**
 * `value` converted to `to` (ADR-220: the result is Money in `to`, ready for
 * `sumMoney`); undefined when either rate is missing.
 */
export function convertAtLatestRates(
  value: Money,
  to: CurrencyCode,
  rates: LatestRatesToEur,
): Money | undefined {
  const source = storedCurrencyCode(value.currency);
  const target = storedCurrencyCode(to);
  if (source === target) return money(value.amount, target);
  const fromRate = rates.get(source);
  const toRate = rates.get(target);
  if (!fromRate || !toRate) return undefined;
  return money(divide(multiply(value.amount, fromRate), toRate), target);
}

/** Upper-cased ISO code of a stored currency column; empty means EUR. */
export const currencyCode = storedCurrencyCode;
