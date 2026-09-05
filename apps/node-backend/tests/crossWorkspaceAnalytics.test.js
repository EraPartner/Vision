import { describe, expect, it } from 'vitest';
import {
  __projectNetWorth as projectNetWorth, rebalanceDeployment, resolveDeployableCash,
} from '../src/services/crossWorkspaceAnalytics.js';
import { foldTargetSleeves } from '../src/services/portfolio/allocationAnalytics.js';

describe('projectNetWorth (ADR-098)', () => {
  it('compounds the median path and widens bands with time', () => {
    const cone = projectNetWorth({ current: 10000, monthlyContribution: 100, annualReturn: 0.12, annualVolatility: 0.15, months: 12 });
    expect(cone).toHaveLength(12);
    // month 1: 10000*1.01 + 100 = 10200
    expect(cone[0].median).toBe(10200);
    // median strictly increasing here; bands straddle the median
    expect(cone[11].median).toBeGreaterThan(cone[0].median);
    expect(cone[11].p90).toBeGreaterThan(cone[11].median);
    expect(cone[11].p10).toBeLessThan(cone[11].median);
  });
  it('zero volatility → flat cone (p10=median=p90)', () => {
    const cone = projectNetWorth({ current: 1000, monthlyContribution: 0, annualReturn: 0, annualVolatility: 0, months: 3 });
    expect(cone[2].p10).toBe(cone[2].median);
    expect(cone[2].p90).toBe(cone[2].median);
    expect(cone[2].median).toBe(1000);
  });
});

describe('rebalanceDeployment (ADR-098)', () => {
  it('deploys cash into underweight sleeves proportional to shortfall', () => {
    // actual 6000/4000 (60/40 of 10k); target 50/50; +2000 cash → total 12k, desired 6k/6k.
    // bonds short by 2000, stocks short by 0 → all cash to bonds.
    const d = rebalanceDeployment({ actualValues: { stocks: 6000, bonds: 4000 }, targetWeights: { stocks: 0.5, bonds: 0.5 }, availableCash: 2000 });
    expect(d.bonds).toBe(2000);
    expect(d.stocks ?? 0).toBe(0);
  });
  it('returns {} when there is no cash or no target sleeves', () => {
    expect(rebalanceDeployment({ actualValues: { a: 100 }, targetWeights: { a: 1 }, availableCash: 0 })).toEqual({});
    expect(rebalanceDeployment({ actualValues: { a: 100 }, targetWeights: {}, availableCash: 50 })).toEqual({});
  });

  it('deploys idle cash into a single under-target sleeve', () => {
    expect(rebalanceDeployment({ actualValues: { a: 100 }, targetWeights: { a: 1 }, availableCash: 50 })).toEqual({ a: 50 });
  });

  it('deployed parts sum EXACTLY to the deployable cash (largest-remainder)', () => {
    // Three equally-underweight sleeves splitting 100: naive rounding gives
    // 33.33×3 = 99.99; the residual cent must land on a sleeve so the parts total 100.
    const d = rebalanceDeployment({
      actualValues: { a: 0, b: 0, c: 0 },
      targetWeights: { a: 1 / 3, b: 1 / 3, c: 1 / 3 },
      availableCash: 100,
    });
    const sum = Object.values(d).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(100, 10);
  });
});

describe('resolveDeployableCash (cash-cap, ADR-098)', () => {
  it('returns full available cash when no cap is given', () => {
    expect(resolveDeployableCash({ availableCash: 1000 })).toBe(1000);
    expect(resolveDeployableCash({ availableCash: 1000, cap: null })).toBe(1000);
  });
  it('clamps a cap to [0, availableCash]', () => {
    expect(resolveDeployableCash({ availableCash: 1000, cap: 400 })).toBe(400);
    // A stale/hostile cap above available cash can never deploy money that doesn't exist.
    expect(resolveDeployableCash({ availableCash: 1000, cap: 99999 })).toBe(1000);
    expect(resolveDeployableCash({ availableCash: 1000, cap: -50 })).toBe(0);
  });
  it('floors negative available cash at 0', () => {
    expect(resolveDeployableCash({ availableCash: -200 })).toBe(0);
  });
});

describe('foldTargetSleeves (rebalance, ADR-098)', () => {
  it('folds unrepresentable preset sleeves into holdable ones', () => {
    // all_weather targets commodities (→gold); three_fund targets intl_stocks (→stocks).
    expect(foldTargetSleeves({ stocks: 0.3, bonds: 0.55, gold: 0.075, commodities: 0.075 }))
      .toEqual({ stocks: 0.3, bonds: 0.55, gold: 0.15 });
    expect(foldTargetSleeves({ stocks: 0.48, intl_stocks: 0.12, bonds: 0.4 }))
      .toEqual({ stocks: 0.6, bonds: 0.4 });
  });
});
