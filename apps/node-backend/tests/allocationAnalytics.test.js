import { describe, expect, it } from 'vitest';
import {
  __backtestReturn as backtestReturn, __allocationDrift as allocationDrift, normalizeWeights, CLASSIC_PORTFOLIOS, foldTargetSleeves,
} from '../src/services/portfolio/allocationAnalytics.js';

describe('backtestReturn (ADR-097)', () => {
  it('is the fractional return from add-date to current price', () => {
    expect(backtestReturn(100, 150)).toBeCloseTo(0.5, 10);
    expect(backtestReturn(200, 150)).toBeCloseTo(-0.25, 10);
  });
  it('returns null for a missing/non-positive add-date price', () => {
    expect(backtestReturn(0, 150)).toBeNull();
    expect(backtestReturn(undefined, 150)).toBeNull();
    expect(backtestReturn(100, 'x')).toBeNull();
  });
});

describe('allocationDrift (ADR-097)', () => {
  it('is actual − target over the union of keys', () => {
    const d = allocationDrift({ stocks: 0.7, bonds: 0.3 }, { stocks: 0.6, bonds: 0.4 });
    expect(d.stocks).toBeCloseTo(0.1, 10);
    expect(d.bonds).toBeCloseTo(-0.1, 10);
  });
  it('treats missing keys as zero', () => {
    const d = allocationDrift({ stocks: 1 }, { bonds: 1 });
    expect(d.stocks).toBe(1);
    expect(d.bonds).toBe(-1);
  });
});

describe('normalizeWeights', () => {
  it('scales values to sum to 1', () => {
    const n = normalizeWeights({ a: 30, b: 10 });
    expect(n.a).toBeCloseTo(0.75, 10);
    expect(n.b).toBeCloseTo(0.25, 10);
  });
  it('is a no-op for empty/zero totals', () => {
    expect(normalizeWeights({})).toEqual({});
    expect(normalizeWeights({ a: 0 })).toEqual({ a: 0 });
  });
});

describe('foldTargetSleeves', () => {
  it('folds aliases into representable sleeves without mutating the input', () => {
    const input = { stocks: 0.48, intl_stocks: 0.12, gold: 0.075, commodities: 0.075 };
    expect(foldTargetSleeves(input)).toEqual({ stocks: 0.6, gold: 0.15 });
    expect(input).toEqual({ stocks: 0.48, intl_stocks: 0.12, gold: 0.075, commodities: 0.075 });
  });
});

describe('CLASSIC_PORTFOLIOS', () => {
  it('each model portfolio sums to ~1', () => {
    for (const w of Object.values(CLASSIC_PORTFOLIOS)) {
      const sum = Object.values(w).reduce((s, v) => s + v, 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });
});
