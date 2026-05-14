/**
 * Property-based tests for pure portfolio calculation functions.
 * Uses fast-check to verify mathematical invariants across random inputs.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  calculateCostBasis,
  calculateAccruedInterest,
  calculateProjectedAnnualInterest,
} from '../usePortfolioCalculations';
import type { PortfolioTransaction } from '@/types/api';

// ─── Helpers ────────────────────────────────────────────────────────────────

let idSeq = 0;

function makeTxn(
  overrides: Partial<PortfolioTransaction> & Pick<PortfolioTransaction, 'type' | 'date' | 'amount'>
): PortfolioTransaction {
  return {
    id: ++idSeq,
    investment_id: 1,
    currency: 'EUR',
    is_recurring: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

// fast-check arbitrary for a buy transaction with positive units
const arbBuy = fc.record({
  amount: fc.double({ min: 1, max: 100_000, noNaN: true }),
  units: fc.double({ min: 0.000001, max: 100_000, noNaN: true }),
  fees: fc.double({ min: 0, max: 100, noNaN: true }),
  taxes: fc.double({ min: 0, max: 100, noNaN: true }),
  date: fc.constantFrom('2020-01-01', '2021-06-15', '2022-03-10', '2023-11-01'),
}).map(({ amount, units, fees, taxes, date }) =>
  makeTxn({ type: 'buy', amount, units, fees, taxes, date })
);

const arbSell = fc.record({
  amount: fc.double({ min: 1, max: 100_000, noNaN: true }),
  units: fc.double({ min: 0.000001, max: 100_000, noNaN: true }),
  fees: fc.double({ min: 0, max: 100, noNaN: true }),
  taxes: fc.double({ min: 0, max: 100, noNaN: true }),
  date: fc.constantFrom('2020-06-01', '2021-12-31', '2022-09-20', '2024-01-01'),
}).map(({ amount, units, fees, taxes, date }) =>
  makeTxn({ type: 'sell', amount, units, fees, taxes, date })
);

// ─── calculateCostBasis ─────────────────────────────────────────────────────

describe('calculateCostBasis', () => {
  it('returns zero result for empty input', () => {
    const result = calculateCostBasis([]);
    expect(result.totalUnits).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.avgCostBasis).toBe(0);
    expect(result.realizedGain).toBe(0);
  });

  it('avgCostBasis >= 0 whenever totalUnits > 0', () => {
    fc.assert(
      fc.property(fc.array(arbBuy, { minLength: 1, maxLength: 10 }), (buys) => {
        const result = calculateCostBasis(buys);
        if (result.totalUnits > 0) {
          expect(result.avgCostBasis).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 500 }
    );
  });

  it('totalUnits never negative', () => {
    fc.assert(
      fc.property(
        fc.array(arbBuy, { minLength: 1, maxLength: 8 }),
        fc.array(arbSell, { minLength: 0, maxLength: 8 }),
        (buys, sells) => {
          const txns = [...buys, ...sells];
          const result = calculateCostBasis(txns);
          expect(result.totalUnits).toBeGreaterThanOrEqual(0);
          expect(result.totalCost).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('avgCostBasis = totalCost / totalUnits when totalUnits > 0', () => {
    fc.assert(
      fc.property(fc.array(arbBuy, { minLength: 1, maxLength: 10 }), (buys) => {
        const result = calculateCostBasis(buys);
        if (result.totalUnits > 0) {
          const expected = result.totalCost / result.totalUnits;
          // Relative tolerance: avgCostBasis is computed with decimal.js while
          // `expected` here is a raw-float division — on billion-magnitude
          // inputs the two diverge by more than a fixed 6-digit absolute
          // tolerance would allow, even though the invariant holds.
          const relErr = Math.abs(result.avgCostBasis - expected) / Math.max(Math.abs(expected), 1);
          expect(relErr).toBeLessThan(1e-9);
        }
      }),
      { numRuns: 500 }
    );
  });

  it('buy-only: totalUnits equals sum of buy units', () => {
    fc.assert(
      fc.property(fc.array(arbBuy, { minLength: 1, maxLength: 10 }), (buys) => {
        const expectedUnits = buys.reduce((acc, t) => acc + (t.units ?? 0), 0);
        const result = calculateCostBasis(buys);
        expect(result.totalUnits).toBeCloseTo(expectedUnits, 5);
      }),
      { numRuns: 300 }
    );
  });

  it('buy-only: totalBuyCost equals sum of (amount + fees + taxes)', () => {
    fc.assert(
      fc.property(fc.array(arbBuy, { minLength: 1, maxLength: 10 }), (buys) => {
        const expectedCost = buys.reduce(
          (acc, t) => acc + (t.amount ?? 0) + (t.fees ?? 0) + (t.taxes ?? 0),
          0
        );
        const result = calculateCostBasis(buys);
        expect(result.totalBuyCost).toBeCloseTo(expectedCost, 4);
      }),
      { numRuns: 300 }
    );
  });

  it('golden value: 3 buys → correct avgCostBasis and totalUnits', () => {
    const txns = [
      makeTxn({ type: 'buy', date: '2023-01-01', amount: 1000, units: 10, fees: 5, taxes: 0 }),
      makeTxn({ type: 'buy', date: '2023-03-01', amount: 2000, units: 15, fees: 10, taxes: 0 }),
      makeTxn({ type: 'buy', date: '2023-06-01', amount: 1500, units: 12, fees: 7.5, taxes: 0 }),
    ];
    // totalCost = (1000+5) + (2000+10) + (1500+7.5) = 4522.5
    // totalUnits = 10 + 15 + 12 = 37
    // avgCostBasis = 4522.5 / 37 ≈ 122.23
    const result = calculateCostBasis(txns);
    expect(result.totalUnits).toBeCloseTo(37, 5);
    expect(result.totalCost).toBeCloseTo(4522.5, 2);
    expect(result.avgCostBasis).toBeCloseTo(4522.5 / 37, 2);
  });

  it('golden value: 2 buys + 1 sell → correct realized gain', () => {
    const txns = [
      makeTxn({ type: 'buy', date: '2023-01-01', amount: 1000, units: 10, fees: 0, taxes: 0 }),
      makeTxn({ type: 'buy', date: '2023-02-01', amount: 1000, units: 10, fees: 0, taxes: 0 }),
      // avg cost = 2000/20 = 100 per unit
      // sell 5 units at 150 each = 750 proceeds, cost = 5 × 100 = 500, gain = 250
      makeTxn({ type: 'sell', date: '2023-06-01', amount: 750, units: 5, fees: 0, taxes: 0 }),
    ];
    const result = calculateCostBasis(txns);
    expect(result.totalUnits).toBeCloseTo(15, 5);
    expect(result.realizedGain).toBeCloseTo(250, 2);
  });
});

// ─── calculateAccruedInterest ───────────────────────────────────────────────

describe('calculateAccruedInterest', () => {
  it('returns 0 when interestRate is 0', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 1_000_000, noNaN: true }),
        fc.array(arbBuy, { minLength: 1, maxLength: 5 }),
        (principal, txns) => {
          expect(calculateAccruedInterest(txns, principal, 0)).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns 0 when principal <= 0', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 100, noNaN: true }),
        fc.array(arbBuy, { minLength: 1, maxLength: 5 }),
        (rate, txns) => {
          expect(calculateAccruedInterest(txns, 0, rate)).toBe(0);
          expect(calculateAccruedInterest(txns, -1, rate)).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns >= 0 for positive principal and rate', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 1_000_000, noNaN: true }),
        fc.double({ min: 0.01, max: 100, noNaN: true }),
        fc.array(arbBuy, { minLength: 1, maxLength: 5 }),
        (principal, rate, txns) => {
          const result = calculateAccruedInterest(txns, principal, rate);
          expect(result).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(result)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('proportional to principal: doubling principal doubles accrued interest', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 100_000, noNaN: true }),
        fc.double({ min: 0.01, max: 30, noNaN: true }),
        fc.array(arbBuy, { minLength: 1, maxLength: 5 }),
        (principal, rate, txns) => {
          const single = calculateAccruedInterest(txns, principal, rate);
          const double = calculateAccruedInterest(txns, principal * 2, rate);
          if (single > 0) {
            expect(double).toBeCloseTo(single * 2, 6);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns 0 when no transactions (no start date)', () => {
    expect(calculateAccruedInterest([], 10000, 5)).toBe(0);
  });
});

// ─── calculateProjectedAnnualInterest ───────────────────────────────────────

describe('calculateProjectedAnnualInterest', () => {
  it('returns 0 when interestRate is 0', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 1_000_000, noNaN: true }),
        (principal) => {
          expect(calculateProjectedAnnualInterest(principal, 0)).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns 0 when principal <= 0', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 100, noNaN: true }),
        (rate) => {
          expect(calculateProjectedAnnualInterest(0, rate)).toBe(0);
          expect(calculateProjectedAnnualInterest(-100, rate)).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('equals principal * rate / 100', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 1_000_000, noNaN: true }),
        fc.double({ min: 0.01, max: 100, noNaN: true }),
        (principal, rate) => {
          const result = calculateProjectedAnnualInterest(principal, rate);
          expect(result).toBeCloseTo(principal * (rate / 100), 6);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('always >= 0 for positive inputs', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 1_000_000, noNaN: true }),
        fc.double({ min: 0.01, max: 100, noNaN: true }),
        (principal, rate) => {
          expect(calculateProjectedAnnualInterest(principal, rate)).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('golden values', () => {
    expect(calculateProjectedAnnualInterest(10000, 5)).toBeCloseTo(500, 4);
    expect(calculateProjectedAnnualInterest(50000, 3.5)).toBeCloseTo(1750, 4);
    expect(calculateProjectedAnnualInterest(1000, 0.1)).toBeCloseTo(1, 4);
  });
});
