/**
 * Conversion at the latest STORED exchange rates (ADR-216): server-owned
 * totals (planned, accounts, owes, portfolio rent, net worth by account)
 * convert with the rates the user can see on the exchange-rates page. A
 * currency without a stored rate is unavailable — never a hard-coded constant
 * and never a 1:1 blend — so callers leave the amount out of a total and flag
 * or count it.
 */

import { divide, multiply, toDecimal } from "../../lib/money.ts";
import type { Decimal, DecimalInput } from "../../lib/money.ts";
import { listLatestStoredRates } from "./currencyConversionService.ts";

/** rate_to_eur per upper-cased currency code; EUR is always 1. */
export type LatestRatesToEur = ReadonlyMap<string, Decimal>;

export async function loadLatestRatesToEur(): Promise<LatestRatesToEur> {
  const { rows } = await listLatestStoredRates();
  const rates = new Map<string, Decimal>([["EUR", toDecimal(1)]]);
  for (const row of rows) {
    const rate = toDecimal(row.rate_to_eur);
    if (rate.isFinite() && rate.gt(0))
      rates.set(row.currency_code.toUpperCase(), rate);
  }
  return rates;
}

/** Convert `amount` from `from` to `to`; undefined when either rate is missing. */
export function convertAtLatestRates(
  amount: DecimalInput,
  from: string,
  to: string,
  rates: LatestRatesToEur,
): Decimal | undefined {
  const source = from.toUpperCase();
  const target = to.toUpperCase();
  if (source === target) return toDecimal(amount);
  const fromRate = rates.get(source);
  const toRate = rates.get(target);
  if (!fromRate || !toRate) return undefined;
  return divide(multiply(amount, fromRate), toRate);
}

/** Upper-cased ISO code of a stored currency column; empty means EUR. */
export function currencyCode(value: string | null | undefined): string {
  return (value || "EUR").toUpperCase();
}
