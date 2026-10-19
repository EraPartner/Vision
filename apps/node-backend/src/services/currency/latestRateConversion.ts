/**
 * Conversion at the latest stored exchange rates, for "current" figures such
 * as an account's cash balance or a property's latest rent. The table matches
 * what the web app used to build from GET /api/info/exchange-rates: the
 * hard-coded fallback constants first, then every positive `is_latest` row.
 * A currency without a rate converts to `undefined`, never 1:1, so callers can
 * flag the amount instead of blending currencies.
 */

import {
  FALLBACK_RATES,
  listLatestStoredRates,
} from "./currencyConversionService.ts";
import { divide, multiply, toDecimal } from "../../lib/money.ts";
import type { Decimal, DecimalInput } from "../../lib/money.ts";

export type LatestRatesToEur = ReadonlyMap<string, Decimal>;

export async function loadLatestRatesToEur(): Promise<LatestRatesToEur> {
  const rates = new Map<string, Decimal>();
  for (const [code, rate] of Object.entries(FALLBACK_RATES)) {
    if (rate > 0) rates.set(code, toDecimal(rate));
  }
  rates.set("EUR", toDecimal(1));
  const { rows } = await listLatestStoredRates();
  for (const row of rows) {
    const rate = toDecimal(row.rate_to_eur);
    if (rate.isFinite() && rate.gt(0))
      rates.set(row.currency_code.toUpperCase(), rate);
  }
  return rates;
}

/** `amount` in `from` expressed in `to`; undefined when either rate is missing. */
export function convertAtLatestRate(
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
