/**
 * Frontend money helpers — mirror of apps/node-backend/src/lib/money.js.
 *
 * Money math in the UI must not accumulate IEEE-754 float drift. Route running
 * sums through Decimal and round once on emit with an explicit mode.
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

export type DecimalInput = number | string | Decimal | null | undefined;

export function toDecimal(v: DecimalInput): Decimal {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  return v instanceof Decimal ? v : new Decimal(v);
}

export function addAll(values: DecimalInput[]): Decimal {
  let acc = new Decimal(0);
  for (const v of values) acc = acc.plus(toDecimal(v));
  return acc;
}

export function multiply(a: DecimalInput, b: DecimalInput): Decimal {
  return toDecimal(a).times(toDecimal(b));
}

export function divide(a: DecimalInput, b: DecimalInput): Decimal {
  return toDecimal(a).div(toDecimal(b));
}

/**
 * Half-up rounding to N decimal places, returned as a plain number.
 * Use on emit to replace lossy `Math.round(x * 10**n) / 10**n`.
 */
export function roundMoney(v: DecimalInput, places = 2): number {
  return toDecimal(v).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toNumber();
}

export function toNumber(v: DecimalInput): number {
  return toDecimal(v).toNumber();
}

export { Decimal };
