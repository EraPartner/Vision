import { describe, expect, it } from 'vitest';
import {
  projectNetWorth, rebalanceDeployment, allocateByOwner, unifiedTax,
} from '../src/services/crossWorkspaceAnalytics.js';

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
});

describe('allocateByOwner / unifiedTax (ADR-098)', () => {
  it('joint splits 50/50; me/partner go fully to that owner', () => {
    expect(allocateByOwner(100, 'me')).toEqual({ me: 100, partner: 0 });
    expect(allocateByOwner(100, 'partner')).toEqual({ me: 0, partner: 100 });
    expect(allocateByOwner(100, 'joint')).toEqual({ me: 50, partner: 50 });
  });
  it('aggregates a unified tax view by owner and kind', () => {
    const r = unifiedTax([
      { amount: 50000, owner: 'me', kind: 'earned' },
      { amount: 4000, owner: 'joint', kind: 'realized_gains' },
      { amount: 1200, owner: 'partner', kind: 'dividend' },
    ]);
    expect(r.total).toBe(55200);
    expect(r.byOwner).toEqual({ me: 52000, partner: 3200 });
    expect(r.byKind).toEqual({ earned: 50000, realized_gains: 4000, dividend: 1200 });
  });
});
