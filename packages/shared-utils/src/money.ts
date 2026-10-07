/**
 * Money helpers shared by the Vision backend and frontend.
 *
 * Money math must not accumulate IEEE-754 float drift: route running sums
 * through Decimal and round once on emit with an explicit mode. Banker's
 * rounding (ROUND_HALF_EVEN) is the canonical mode for the whole codebase, so
 * `roundToCents` and `roundMoney` agree on exact-half values and snapshot /
 * summary reconciliation cannot drift by a cent.
 *
 * Single source of truth: apps/{frontend,node-backend} re-export from here so
 * the two can no longer diverge (they previously did — frontend roundMoney was
 * ROUND_HALF_UP while the backend used ROUND_HALF_EVEN).
 */

import Decimal from "decimal.js";

export type DecimalInput = number | string | Decimal | null | undefined;

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

export function toDecimal(v: DecimalInput): Decimal {
  if (v === null || v === undefined || v === "") return new Decimal(0);
  return v instanceof Decimal ? v : new Decimal(v);
}

export function addAll(values: readonly DecimalInput[]): Decimal {
  let acc = new Decimal(0);
  for (const v of values) {
    acc = acc.plus(toDecimal(v));
  }
  return acc;
}

export function subtract(a: DecimalInput, b: DecimalInput): Decimal {
  return toDecimal(a).minus(toDecimal(b));
}

/** Banker's rounding to 2 decimal places. */
export function roundToCents(v: DecimalInput): Decimal {
  return toDecimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

export function multiply(a: DecimalInput, b: DecimalInput): Decimal {
  return toDecimal(a).times(toDecimal(b));
}

export function divide(a: DecimalInput, b: DecimalInput): Decimal {
  return toDecimal(a).div(toDecimal(b));
}

/**
 * Rounding to N decimal places, returned as a plain number. Use on emit to
 * replace lossy `Math.round(x * 10**n) / 10**n`. Uses banker's rounding
 * (the canonical mode declared at the top of this module).
 */
export function roundMoney(v: DecimalInput, places = 2): number {
  return toDecimal(v)
    .toDecimalPlaces(places, Decimal.ROUND_HALF_EVEN)
    .toNumber();
}

export function toNumber(v: DecimalInput): number {
  return toDecimal(v).toNumber();
}

/**
 * Coerce a single DB NUMERIC value to a JS number, preserving SQL NULL.
 *
 * node-postgres returns NUMERIC/DECIMAL columns as strings (it sets no global
 * type parser — doing so would reintroduce IEEE-754 drift into decimal math).
 * Repositories must therefore convert money/quantity columns to numbers on
 * emit so the value matches its `number` TypeScript type. `null`/`undefined`
 * pass through unchanged so response shapes (and `=== null` checks) are
 * preserved; only non-empty strings/numbers are converted.
 *
 * Use this at the read boundary, AFTER any decimal summation — internal math
 * must still run through {@link toDecimal} on the raw string to stay exact.
 */
export function numericColumn(v: DecimalInput): number | null | undefined {
  // Separate returns keep this narrowing valid for the backend's non-strict check.
  if (v === null) return null;
  if (v === undefined) return undefined;
  if (v === "") return undefined;
  return new Decimal(v).toNumber();
}

/**
 * Return a shallow copy of `row` with the named NUMERIC columns coerced to
 * numbers via {@link numericColumn}. No-op for a nullish row. Lets a repository
 * normalise every money/quantity column in one call instead of per-field.
 * A nullish row is returned unchanged.
 */
export function coerceNumericFields<T extends object>(
  row: T,
  fields: readonly string[],
): T;
export function coerceNumericFields<T extends object>(
  row: T | null | undefined,
  fields: readonly string[],
): T | null | undefined;
export function coerceNumericFields<T extends object>(
  row: T | null | undefined,
  fields: readonly string[],
): T | null | undefined {
  if (!row) return row;
  const out = { ...row } as Record<string, unknown>;
  for (const field of fields) {
    if (field in out) out[field] = numericColumn(out[field] as DecimalInput);
  }
  return out as T;
}

export { Decimal };
