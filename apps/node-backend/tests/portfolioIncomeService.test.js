import { describe, expect, it } from 'vitest';
import { aggregateIncome, coverageRatio } from '../src/services/portfolio/portfolioIncomeService.js';

describe('aggregateIncome (ADR-096)', () => {
  it('sums realized totalIncome and projected annual interest across holdings', () => {
    const r = aggregateIncome([
      { totalIncome: 100, projectedAnnualInterest: 0 },
      { totalIncome: 50.5, projectedAnnualInterest: 300 },
      { totalIncome: 0, projectedAnnualInterest: 12.25 },
    ]);
    expect(r.realizedIncome).toBe(150.5);
    expect(r.projectedAnnualIncome).toBe(312.25);
  });

  it('treats missing fields as zero and handles empty input', () => {
    expect(aggregateIncome([{}])).toEqual({ realizedIncome: 0, projectedAnnualIncome: 0 });
    expect(aggregateIncome([])).toEqual({ realizedIncome: 0, projectedAnnualIncome: 0 });
    expect(aggregateIncome(undefined)).toEqual({ realizedIncome: 0, projectedAnnualIncome: 0 });
  });
});

describe('coverageRatio (ADR-096)', () => {
  it('is passive income / annual spending', () => {
    expect(coverageRatio(12000, 24000)).toBe(0.5);
    expect(coverageRatio(30000, 24000)).toBe(1.25);
  });

  it('returns null when annual spending is non-positive', () => {
    expect(coverageRatio(1000, 0)).toBeNull();
    expect(coverageRatio(1000, -5)).toBeNull();
  });
});
