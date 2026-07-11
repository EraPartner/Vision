import { describe, it, expect } from 'vitest';
import {
  deriveUnitMath,
  parsePositive,
  roundUnitMath,
  UNIT_MATH_AMOUNT_DP,
  UNIT_MATH_UNITS_DP,
  UNIT_MATH_PRICE_DP,
} from '@/lib/portfolioUnitMath';

describe('parsePositive', () => {
  it('parses plain and locale-formatted positive numbers', () => {
    expect(parsePositive('150')).toBe(150);
    expect(parsePositive('1.234,56')).toBe(1234.56);
  });

  it('maps empty, invalid, zero, and negative inputs to undefined', () => {
    expect(parsePositive('')).toBeUndefined();
    expect(parsePositive('   ')).toBeUndefined();
    expect(parsePositive('abc')).toBeUndefined();
    expect(parsePositive('0')).toBeUndefined();
    expect(parsePositive('-5')).toBeUndefined();
  });
});

describe('deriveUnitMath', () => {
  it('derives amount from units × price', () => {
    const r = deriveUnitMath({ units: 3, price: 10 });
    expect(r.derivedAmount).toBe(30);
    expect(r.effectiveAmount).toBe(30);
    expect(r.isConsistent).toBe(true);
    expect(r.providedCount).toBe(2);
  });

  it('derives units from amount ÷ price', () => {
    const r = deriveUnitMath({ amount: 30, price: 10 });
    expect(r.derivedUnits).toBe(3);
    expect(r.effectiveUnits).toBe(3);
    expect(r.isConsistent).toBe(true);
  });

  it('derives price from amount ÷ units', () => {
    const r = deriveUnitMath({ amount: 30, units: 3 });
    expect(r.derivedPrice).toBe(10);
    expect(r.effectivePrice).toBe(10);
    expect(r.isConsistent).toBe(true);
  });

  it('flags inconsistent when all three provided but amount ≠ units × price', () => {
    const r = deriveUnitMath({ amount: 999, units: 3, price: 10 });
    expect(r.providedCount).toBe(3);
    expect(r.derivedAmount).toBeUndefined();
    expect(r.isConsistent).toBe(false);
  });

  it('accepts all three when consistent within tolerance', () => {
    const r = deriveUnitMath({ amount: 30.00005, units: 3, price: 10 });
    expect(r.isConsistent).toBe(true);
  });

  it('is not consistent with fewer than two values', () => {
    expect(deriveUnitMath({ amount: 30 }).isConsistent).toBe(false);
    expect(deriveUnitMath({}).isConsistent).toBe(false);
  });

  it('rounds derived values to the configured precisions', () => {
    expect(deriveUnitMath({ amount: 1, units: 3 }).derivedPrice)
      .toBe(roundUnitMath(1 / 3, UNIT_MATH_PRICE_DP));
    expect(deriveUnitMath({ amount: 1, price: 3 }).derivedUnits)
      .toBe(roundUnitMath(1 / 3, UNIT_MATH_UNITS_DP));
    expect(deriveUnitMath({ units: 1 / 3, price: 3 }).derivedAmount)
      .toBe(roundUnitMath((1 / 3) * 3, UNIT_MATH_AMOUNT_DP));
  });

  it('does not derive or validate when derive is false (Add gift / non-buy-sell path)', () => {
    const r = deriveUnitMath({ units: 3, price: 10, derive: false });
    expect(r.derivedAmount).toBeUndefined();
    expect(r.effectiveAmount).toBeUndefined();
    expect(r.effectiveUnits).toBe(3);
    expect(r.effectivePrice).toBe(10);
    expect(r.isConsistent).toBe(false);
  });
});
