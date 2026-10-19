/**
 * Currency-code helpers for values the backend produces itself (ADR-220).
 * Request input goes through `assertCurrency`; stored columns arrive branded
 * from their row schemas.
 */
import { asCurrencyCode } from "@vision/types/brands";
import type { CurrencyCode } from "@vision/types/brands";

/** The ledger's base currency and the default of every currency column. */
export const EUR: CurrencyCode = asCurrencyCode("EUR");

/** A stored currency column as-is, empty meaning EUR. */
export function currencyOrEur(
  value: CurrencyCode | null | undefined,
): CurrencyCode {
  return value ? value : EUR;
}

/**
 * A stored currency column upper-cased, empty meaning EUR. Normalises rather
 * than validates: the ISO CHECK constraints can be NOT VALID on long-lived
 * databases, and the read paths always tolerated legacy casing.
 */
export function storedCurrencyCode(
  value: CurrencyCode | null | undefined,
): CurrencyCode {
  return value ? (value.toUpperCase() as CurrencyCode) : EUR;
}

/**
 * A staged currency cell trimmed, empty meaning EUR. Case is kept so a
 * malformed cell still fails the column's CHECK instead of being rewritten.
 */
export function trimmedCurrencyCode(
  value: CurrencyCode | null | undefined,
): CurrencyCode {
  const trimmed = (value ?? "").trim() as CurrencyCode;
  return currencyOrEur(trimmed);
}
