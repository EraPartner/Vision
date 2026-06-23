import { describe, it, expect } from 'vitest';
import { densifyDailyHistory } from '../../src/services/calculations/forecast/_densify.js';
import * as simpleAverage from '../../src/services/calculations/forecast/methods/simpleAverage.js';

describe('densifyDailyHistory', () => {
  it('fills missing calendar days with net 0 through endIso', () => {
    const out = densifyDailyHistory([{ date: '2026-01-01', net: -300 }], '2026-01-03');
    expect(out).toEqual([
      { date: '2026-01-01', net: -300 },
      { date: '2026-01-02', net: 0 },
      { date: '2026-01-03', net: 0 },
    ]);
  });

  it('returns input unchanged for empty history', () => {
    expect(densifyDailyHistory([], '2026-01-03')).toEqual([]);
  });

  it('makes simpleAverage divide a one-off by month count, not occurrence count', () => {
    // −300 on the 15th, two months of grid → DOM-15 mean = (−300 + 0)/2 = −150.
    // On the sparse history the method divided by 1 occurrence → −300 (the bias).
    const dense = densifyDailyHistory([{ date: '2026-01-15', net: -300 }], '2026-02-28');
    const out = simpleAverage.forecast({ history: dense, forecastDates: ['2026-03-15'] });
    expect(out[0].value).toBeCloseTo(-150, 5);

    const sparse = simpleAverage.forecast({ history: [{ date: '2026-01-15', net: -300 }], forecastDates: ['2026-03-15'] });
    expect(sparse[0].value).toBeCloseTo(-300, 5); // unchanged method, sparse input
  });
});
