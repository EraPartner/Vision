import { describe, expect, it } from 'vitest';
import {
  calculateCostBasis,
  calculateCostBasisByMethod,
  projectedAnnualInterest,
  annualizedReturn,
  contributionAdjustedMonthlyReturn,
  computeMetrics,
  computeHeatmap,
  toYmd,
} from '../src/utils/portfolioMath.js';

describe('calculateCostBasis (weighted average)', () => {
  it('produces zero result when no transactions', () => {
    expect(calculateCostBasis([])).toEqual({
      totalUnits: 0,
      totalCost: 0,
      avgCostBasis: 0,
      realizedGain: 0,
      totalBuyCost: 0,
      totalSellProceeds: 0,
      totalCostConv: 0,
      avgCostBasisConv: 0,
      realizedGainConv: 0,
      totalBuyCostConv: 0,
      totalSellProceedsConv: 0,
    });
  });

  it('averages the cost across multiple buys', () => {
    const r = calculateCostBasis([
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
      { type: 'buy', units: 10, amount: 200, fees: 0, taxes: 0, date: '2025-02-01' },
    ]);
    expect(r.totalUnits).toBe(20);
    expect(r.totalCost).toBe(300);
    expect(r.avgCostBasis).toBe(15);
    expect(r.totalBuyCost).toBe(300);
  });

  it('treats gifts the same as buys for cost-basis accumulation', () => {
    const r = calculateCostBasis([
      { type: 'gift', units: 5, amount: 0, fees: 0, taxes: 0, date: '2025-01-01' },
      { type: 'buy', units: 5, amount: 100, fees: 0, taxes: 0, date: '2025-02-01' },
    ]);
    expect(r.totalUnits).toBe(10);
    expect(r.totalCost).toBe(100);
    expect(r.avgCostBasis).toBe(10);
  });

  it('records realized gain when selling above average cost', () => {
    const r = calculateCostBasis([
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
      { type: 'sell', units: 5, amount: 75, fees: 0, taxes: 0, date: '2025-03-01' },
    ]);
    expect(r.totalUnits).toBe(5);
    expect(r.realizedGain).toBe(25); // 75 - (avg 10 * 5)
    expect(r.totalSellProceeds).toBe(75);
  });

  it('subtracts fees and taxes from net proceeds on sale', () => {
    const r = calculateCostBasis([
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
      { type: 'sell', units: 10, amount: 200, fees: 5, taxes: 5, date: '2025-03-01' },
    ]);
    // Net proceeds = 200 - 5 - 5 = 190; cost = 100; gain = 90
    expect(r.realizedGain).toBe(90);
  });

  it('caps sell units at totalUnits to prevent negatives', () => {
    const r = calculateCostBasis([
      { type: 'buy', units: 5, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
      { type: 'sell', units: 100, amount: 5000, fees: 0, taxes: 0, date: '2025-03-01' },
    ]);
    expect(r.totalUnits).toBe(0);
  });

  it('applies stock split (units = post-split total)', () => {
    const r = calculateCostBasis([
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
      { type: 'split', units: 30, amount: 0, fees: 0, taxes: 0, date: '2025-02-01' },
    ]);
    expect(r.totalUnits).toBe(30);
    expect(r.totalCost).toBe(100); // basis unchanged
  });

  it('reduces basis on return_of_capital', () => {
    const r = calculateCostBasis([
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
      { type: 'return_of_capital', units: 0, amount: 30, fees: 0, taxes: 0, date: '2025-02-01' },
    ]);
    expect(r.totalCost).toBe(70);
  });

  it('clamps basis at zero on excessive return_of_capital', () => {
    const r = calculateCostBasis([
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
      { type: 'return_of_capital', units: 0, amount: 500, fees: 0, taxes: 0, date: '2025-02-01' },
    ]);
    expect(r.totalCost).toBe(0);
  });

  it('sorts transactions by date before processing', () => {
    const ascending = calculateCostBasis([
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
      { type: 'sell', units: 5, amount: 75, fees: 0, taxes: 0, date: '2025-03-01' },
    ]);
    const reversed = calculateCostBasis([
      { type: 'sell', units: 5, amount: 75, fees: 0, taxes: 0, date: '2025-03-01' },
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
    ]);
    expect(reversed).toEqual(ascending);
  });
});

describe('oversell flag (_oversold)', () => {
  it('sets _oversold on a weighted-avg oversell while leaving the clamped numbers intact', () => {
    const exact = calculateCostBasis([
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
      { type: 'sell', units: 10, amount: 200, fees: 0, taxes: 0, date: '2025-03-01' },
    ]);
    const over = calculateCostBasis([
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
      { type: 'sell', units: 15, amount: 200, fees: 0, taxes: 0, date: '2025-03-01' },
    ]);
    // A well-formed (non-oversell) result never carries the flag.
    expect(exact._oversold).toBeUndefined();
    // The oversell is flagged, but the sell is still clamped to the 10 units held:
    // position drains to 0 and only 10/15 of the proceeds/gain are recognised.
    expect(over._oversold).toBe(true);
    expect(over.totalUnits).toBe(0);
    expect(over.totalCost).toBe(0);
    expect(over.realizedGain).toBe(33.33); // 200*(10/15) - avg10*10
    expect(over.totalSellProceeds).toBe(133.33);
    // The flag is purely additive — stripping it yields the same numbers.
    const { _oversold, ...numbers } = over;
    expect(_oversold).toBe(true);
    expect(numbers.totalUnits).toBe(0);
  });

  it('sets _oversold on a FIFO oversell without changing the clamp', () => {
    const over = calculateCostBasisByMethod(
      [
        { type: 'buy', units: 4, amount: 40, fees: 0, taxes: 0, date: '2025-01-01' },
        { type: 'sell', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-03-01' },
      ],
      'fifo',
    );
    expect(over._oversold).toBe(true);
    expect(over.totalUnits).toBe(0);
    expect(over.totalCost).toBe(0);
  });
});

describe('calculateCostBasisByMethod', () => {
  const txns = [
    { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2025-01-01' },
    { type: 'buy', units: 10, amount: 200, fees: 0, taxes: 0, date: '2025-02-01' },
    { type: 'sell', units: 5, amount: 100, fees: 0, taxes: 0, date: '2025-03-01' },
  ];

  it('routes "weighted_avg" to calculateCostBasis', () => {
    expect(calculateCostBasisByMethod(txns, 'weighted_avg').realizedGain).toBe(25); // sell 5 @ avg 15 → cost 75; gain 25
  });

  it('routes "fifo" to calculateCostBasisFIFO', () => {
    // FIFO consumes oldest 5 units at $10 each → cost 50, proceeds 100, gain 50
    expect(calculateCostBasisByMethod(txns, 'fifo').realizedGain).toBe(50);
  });

  it('routes "lifo" to calculateCostBasisLIFO', () => {
    // LIFO consumes newest 5 units at $20 each → cost 100, proceeds 100, gain 0
    expect(calculateCostBasisByMethod(txns, 'lifo').realizedGain).toBe(0);
  });

  it('defaults to weighted average for unknown methods', () => {
    expect(calculateCostBasisByMethod(txns, 'unknown').realizedGain).toBe(25);
  });
});

describe('projectedAnnualInterest', () => {
  it('returns principal * rate%', () => {
    expect(projectedAnnualInterest(1000, 5)).toBe(50);
  });

  it('returns 0 when rate is missing', () => {
    expect(projectedAnnualInterest(1000, 0)).toBe(0);
    expect(projectedAnnualInterest(1000, null)).toBe(0);
  });

  it('returns 0 when principal is non-positive', () => {
    expect(projectedAnnualInterest(0, 5)).toBe(0);
    expect(projectedAnnualInterest(-100, 5)).toBe(0);
  });
});

describe('annualizedReturn', () => {
  it('returns 0 when totalInvested is zero/negative', () => {
    expect(annualizedReturn(150, 0, 365)).toBe(0);
    expect(annualizedReturn(150, -1, 365)).toBe(0);
  });

  it('returns 0 when days is zero/negative', () => {
    expect(annualizedReturn(150, 100, 0)).toBe(0);
  });

  it('returns 0 when currentValue is zero', () => {
    expect(annualizedReturn(0, 100, 365)).toBe(0);
  });

  it('computes CAGR for one-year holding', () => {
    const r = annualizedReturn(110, 100, 365.25);
    expect(r).toBeCloseTo(10, 2);
  });

  it('computes CAGR for multi-year holding', () => {
    // 100 → 200 over 2 years → ~41.42% CAGR
    const r = annualizedReturn(200, 100, 365.25 * 2);
    expect(r).toBeCloseTo(41.42, 1);
  });
});

describe('contributionAdjustedMonthlyReturn', () => {
  it('returns null on invalid inputs', () => {
    expect(contributionAdjustedMonthlyReturn(100, 100, 100, 0)).toBeNull();
    expect(contributionAdjustedMonthlyReturn(100, 0, 100, 100)).toBeNull();
    expect(contributionAdjustedMonthlyReturn(100, 100, 0, 100)).toBeNull();
  });

  it('returns 0 when neither value nor cost basis changes', () => {
    expect(contributionAdjustedMonthlyReturn(100, 100, 100, 100)).toBe(0);
  });

  it('isolates performance from new contributions', () => {
    // Value/invested ratio: prev 100/100 = 1.0; curr 220/200 = 1.1 → +10%
    const r = contributionAdjustedMonthlyReturn(220, 200, 100, 100);
    expect(r).toBeCloseTo(10, 5);
  });

  it('returns negative percent when investment underperforms', () => {
    // Prev 100/100=1.0 → curr 90/100=0.9 → -10%
    const r = contributionAdjustedMonthlyReturn(90, 100, 100, 100);
    expect(r).toBeCloseTo(-10, 5);
  });
});

describe('computeMetrics', () => {
  it('returns null when snapshots missing or empty', () => {
    expect(computeMetrics(null)).toBeNull();
    expect(computeMetrics([])).toBeNull();
  });

  it('produces metrics from a single snapshot', () => {
    const r = computeMetrics([
      { snapshot_date: '2025-04-15', invested: 1000, value: 1100, gain_loss: 100, inflation_adjusted_value: 1050 },
    ]);
    expect(r).toMatchObject({
      currentValue: 1100,
      totalInvested: 1000,
      totalGainLoss: 100,
      totalReturnPct: 10,
    });
    expect(r.realReturnPct).toBe(5);
  });

  it('computes annualized return between first and last snapshot', () => {
    const r = computeMetrics([
      { snapshot_date: '2024-04-15', invested: 1000, value: 1000, gain_loss: 0, inflation_adjusted_value: 1000 },
      { snapshot_date: '2025-04-15', invested: 1000, value: 1100, gain_loss: 100, inflation_adjusted_value: 1050 },
    ]);
    expect(r.annualizedReturn).toBeCloseTo(10, 1);
  });

  it('handles zero totalInvested by returning 0 percentages', () => {
    const r = computeMetrics([
      { snapshot_date: '2025-04-15', invested: 0, value: 0, gain_loss: 0, inflation_adjusted_value: 0 },
    ]);
    expect(r.totalReturnPct).toBe(0);
    expect(r.realReturnPct).toBe(0);
    expect(r.cumulativeInflation).toBe(0);
  });

  it('rounds percentages to 2 decimals', () => {
    const r = computeMetrics([
      { snapshot_date: '2025-04-15', invested: 333, value: 366.66, gain_loss: 33.66, inflation_adjusted_value: 350 },
    ]);
    expect(Number.isFinite(r.totalReturnPct)).toBe(true);
    expect(r.totalReturnPct.toString()).not.toMatch(/\.\d{3,}/); // ≤2 decimals
  });
});

describe('computeHeatmap', () => {
  it('returns empty shape for fewer than 2 snapshots', () => {
    expect(computeHeatmap([])).toEqual({ years: [], data: {}, maxAbsPct: 0 });
    expect(computeHeatmap([{ snapshot_date: '2025-04-01', value: 100, invested: 100 }])).toEqual({ years: [], data: {}, maxAbsPct: 0 });
  });

  it('produces a 12-month grid per year', () => {
    const r = computeHeatmap([
      { snapshot_date: '2025-01-31', value: 100, invested: 100 },
      { snapshot_date: '2025-02-28', value: 110, invested: 100 },
      { snapshot_date: '2025-03-31', value: 121, invested: 100 },
    ]);
    expect(r.years).toEqual([2025]);
    expect(r.data[2025]).toHaveLength(12);
    expect(r.data[2025][1]).toBeCloseTo(10, 2); // Feb +10%
    expect(r.data[2025][2]).toBeCloseTo(10, 2); // Mar +10%
    expect(r.data[2025][0]).toBeNull(); // Jan has no prior month
  });

  it('takes the last snapshot of each month for grouping', () => {
    const r = computeHeatmap([
      { snapshot_date: '2025-01-15', value: 100, invested: 100 },
      { snapshot_date: '2025-01-31', value: 105, invested: 100 }, // last of Jan wins
      { snapshot_date: '2025-02-28', value: 110, invested: 100 }, // 110/100 vs 105/100 → ~4.76%
    ]);
    expect(r.data[2025][1]).toBeCloseTo(4.76, 1);
  });

  it('reports maxAbsPct from the largest monthly move (positive or negative)', () => {
    const r = computeHeatmap([
      { snapshot_date: '2025-01-31', value: 100, invested: 100 },
      { snapshot_date: '2025-02-28', value: 80, invested: 100 }, // -20%
      { snapshot_date: '2025-03-31', value: 88, invested: 100 }, // +10%
    ]);
    expect(r.maxAbsPct).toBeCloseTo(20, 1);
  });

  it('groups across multiple years', () => {
    const r = computeHeatmap([
      { snapshot_date: '2024-12-31', value: 100, invested: 100 },
      { snapshot_date: '2025-01-31', value: 110, invested: 100 },
    ]);
    expect(r.years).toEqual([2024, 2025]);
    expect(r.data[2025][0]).toBeCloseTo(10, 2);
  });

  it('accepts Date objects for snapshot_date', () => {
    const r = computeHeatmap([
      { snapshot_date: new Date('2025-01-31'), value: 100, invested: 100 },
      { snapshot_date: new Date('2025-02-28'), value: 110, invested: 100 },
    ]);
    expect(r.years).toEqual([2025]);
    expect(r.data[2025][1]).toBeCloseTo(10, 2);
  });

  it('buckets a local-midnight Date by its local calendar month (pg DATE shape)', () => {
    // node-postgres returns DATE columns as a *local-midnight* Date. Bucketing
    // those with toISOString() shifted them a day back in UTC+ zones, landing
    // the 1st of a month in the previous month. Using new Date(y, m, d) builds
    // exactly that local-midnight value, so this is deterministic in any TZ.
    const r = computeHeatmap([
      { snapshot_date: new Date(2026, 4, 1), value: 100, invested: 100 }, // 2026-05-01
      { snapshot_date: new Date(2026, 5, 1), value: 110, invested: 100 }, // 2026-06-01
    ]);
    expect(r.years).toEqual([2026]);
    expect(r.data[2026][5]).toBeCloseTo(10, 2); // June move present (not May)
    expect(r.data[2026][4]).toBeNull(); // May is the first month, no prior
  });
});

describe('toYmd', () => {
  it('recovers the local calendar day from a local-midnight Date', () => {
    expect(toYmd(new Date(2026, 5, 1))).toBe('2026-06-01');
    expect(toYmd(new Date(2026, 0, 31))).toBe('2026-01-31');
  });

  it('passes a YYYY-MM-DD string straight through', () => {
    expect(toYmd('2026-06-15')).toBe('2026-06-15');
    expect(toYmd('2026-06-15T00:00:00.000Z')).toBe('2026-06-15');
  });
});
