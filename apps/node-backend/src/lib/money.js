import Decimal from 'decimal.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

/**
 * @param {number|string|Decimal|null|undefined} v
 * @returns {Decimal}
 */
export function toDecimal(v) {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  return v instanceof Decimal ? v : new Decimal(v);
}

/**
 * @param {Array<number|string|Decimal>} values
 * @returns {Decimal}
 */
export function addAll(values) {
  /** @type {Decimal} */
  let acc = new Decimal(0);
  for (const v of values) {
    acc = acc.plus(toDecimal(v));
  }
  return acc;
}

/**
 * @param {number|string|Decimal} a
 * @param {number|string|Decimal} b
 * @returns {Decimal}
 */
export function subtract(a, b) {
  return toDecimal(a).minus(toDecimal(b));
}

/**
 * Banker's rounding to 2 decimal places.
 * @param {number|string|Decimal} v
 * @returns {Decimal}
 */
export function roundToCents(v) {
  return toDecimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

/**
 * @param {number|string|Decimal} v
 * @returns {number}
 */
export function toNumber(v) {
  return toDecimal(v).toNumber();
}
