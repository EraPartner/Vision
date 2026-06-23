import { describe, it, expect } from 'vitest';
import { toDecimal, addAll, subtract, roundToCents, roundMoney, toNumber, numericColumn, coerceNumericFields } from '../src/lib/money.js';

describe('money util', () => {
  it('handles 0.1 + 0.2 exactly', () => {
    expect(toNumber(addAll([0.1, 0.2]))).toBe(0.3);
  });

  it('rounds half-even at .005', () => {
    expect(toNumber(roundToCents('0.005'))).toBe(0);
    expect(toNumber(roundToCents('0.015'))).toBe(0.02);
    expect(toNumber(roundToCents('0.025'))).toBe(0.02);
    expect(toNumber(roundToCents('0.035'))).toBe(0.04);
  });

  it('reduces a long list without drift', () => {
    const values = Array.from({ length: 1000 }, () => 0.01);
    expect(toNumber(addAll(values))).toBe(10);
  });

  it('accepts pg NUMERIC string inputs', () => {
    expect(toNumber(subtract('100.00', '33.33'))).toBe(66.67);
  });

  it('is associative regardless of order', () => {
    const a = toNumber(addAll([0.1, 0.2, 0.3]));
    const b = toNumber(addAll([0.3, 0.2, 0.1]));
    expect(a).toBe(b);
  });

  it('roundMoney uses banker\'s rounding, matching roundToCents', () => {
    expect(roundMoney('0.005')).toBe(0);
    expect(roundMoney('0.015')).toBe(0.02);
    expect(roundMoney('0.025')).toBe(0.02);
    expect(roundMoney('0.035')).toBe(0.04);
    expect(roundMoney('1.005', 2)).toBe(1);
    expect(roundMoney('2.5', 0)).toBe(2);
    expect(roundMoney('3.5', 0)).toBe(4);
  });

  it('handles null/undefined/empty as zero', () => {
    expect(toNumber(toDecimal(null))).toBe(0);
    expect(toNumber(toDecimal(undefined))).toBe(0);
    expect(toNumber(toDecimal(''))).toBe(0);
  });

  describe('numericColumn (DB NUMERIC → number, NULL-preserving)', () => {
    it('converts pg NUMERIC strings to numbers', () => {
      expect(numericColumn('1000.00')).toBe(1000);
      expect(numericColumn('-12.50')).toBe(-12.5);
      expect(numericColumn('5.00000000')).toBe(5);
    });

    it('preserves null and undefined unchanged (response shape must not drift)', () => {
      expect(numericColumn(null)).toBeNull();
      expect(numericColumn(undefined)).toBeUndefined();
    });

    it('treats empty string as undefined', () => {
      expect(numericColumn('')).toBeUndefined();
    });

    it('passes through numbers idempotently', () => {
      expect(numericColumn(42)).toBe(42);
    });
  });

  describe('coerceNumericFields', () => {
    it('coerces only the named columns, leaving others untouched', () => {
      const row = { id: 1, current_price: '31.20', interest_rate: null, symbol: 'IONQ' };
      expect(coerceNumericFields(row, ['current_price', 'interest_rate'])).toEqual({
        id: 1,
        current_price: 31.2,
        interest_rate: null,
        symbol: 'IONQ',
      });
    });

    it('ignores fields absent from the row and is a no-op on nullish rows', () => {
      expect(coerceNumericFields({ id: 1 }, ['amount'])).toEqual({ id: 1 });
      expect(coerceNumericFields(null, ['amount'])).toBeNull();
      expect(coerceNumericFields(undefined, ['amount'])).toBeUndefined();
    });

    it('returns a shallow copy without mutating the input', () => {
      const row = { amount: '10.00' };
      const out = coerceNumericFields(row, ['amount']);
      expect(row.amount).toBe('10.00');
      expect(out.amount).toBe(10);
    });
  });
});
