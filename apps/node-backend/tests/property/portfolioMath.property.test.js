/**
 * Property-based tests for portfolioMath.js (Phase 9).
 *
 * Each test generates many random inputs via a deterministic seeded RNG and
 * verifies mathematical invariants that must hold for all valid inputs.
 * No I/O mocks needed — portfolioMath exports pure functions.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateCostBasis,
  calculateAccruedInterest,
  projectedAnnualInterest,
  annualizedReturn,
  contributionAdjustedMonthlyReturn,
  sanitizeSnapshotSpikes,
} from '../../src/utils/portfolioMath.js';

// ── Seeded RNG (same pattern as currencyRoundTrip.property.test.js) ──────────

function seeded(seed) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function randBetween(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

/** Generate a sorted array of YYYY-MM-DD strings */
function genDates(rng, count) {
  const base = 2020;
  const dates = [];
  for (let i = 0; i < count; i++) {
    const year  = base + Math.floor(rng() * 5);
    const month = 1 + Math.floor(rng() * 12);
    const day   = 1 + Math.floor(rng() * 28);
    dates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return dates.sort();
}

// ── calculateCostBasis ────────────────────────────────────────────────────────

describe('property: calculateCostBasis', () => {
  const rng = seeded(0xC057B451);

  it('totalUnits is never negative after any sequence of buys and sells', () => {
    for (let trial = 0; trial < 300; trial++) {
      const txnCount = 1 + Math.floor(rng() * 20);
      const dates = genDates(rng, txnCount);
      const txns = dates.map((date) => {
        const type = rng() < 0.6 ? 'buy' : (rng() < 0.5 ? 'sell' : 'gift');
        return {
          type,
          date,
          units: randBetween(rng, 0.1, 100),
          amount: randBetween(rng, 10, 10000),
          fees:   randBetween(rng, 0, 50),
          taxes:  randBetween(rng, 0, 30),
        };
      });
      const result = calculateCostBasis(txns);
      expect(result.totalUnits, `trial ${trial}: totalUnits < 0`).toBeGreaterThanOrEqual(0);
    }
  });

  it('avgCostBasis is non-negative when totalUnits > 0', () => {
    for (let trial = 0; trial < 300; trial++) {
      const txnCount = 1 + Math.floor(rng() * 15);
      const dates = genDates(rng, txnCount);
      const txns = dates.map((date) => ({
        type: 'buy',
        date,
        units:  randBetween(rng, 0.1, 50),
        amount: randBetween(rng, 10, 5000),
        fees:   0,
        taxes:  0,
      }));
      const result = calculateCostBasis(txns);
      expect(result.avgCostBasis, `trial ${trial}: avgCostBasis < 0`).toBeGreaterThanOrEqual(0);
    }
  });

  it('totalBuyCost equals sum of (amount + fees + taxes) for all buy/gift txns', () => {
    for (let trial = 0; trial < 200; trial++) {
      const txnCount = 2 + Math.floor(rng() * 10);
      const dates = genDates(rng, txnCount);
      const txns = dates.map((date) => ({
        type: rng() < 0.8 ? 'buy' : 'gift',
        date,
        units:  randBetween(rng, 0.1, 50),
        amount: randBetween(rng, 10, 5000),
        fees:   randBetween(rng, 0, 40),
        taxes:  randBetween(rng, 0, 20),
      }));
      const expected = txns.reduce((sum, t) => sum + Number(t.amount) + Number(t.fees) + Number(t.taxes), 0);
      const result = calculateCostBasis(txns);
      expect(result.totalBuyCost).toBeCloseTo(expected, 2);
    }
  });

  it('golden: 2 buys + 1 sell produces correct avgCostBasis and realizedGain', () => {
    const txns = [
      { type: 'buy',  date: '2022-01-01', units: 10, amount: 1000, fees: 5,  taxes: 0 },
      { type: 'buy',  date: '2022-03-01', units: 10, amount: 1100, fees: 5,  taxes: 0 },
      { type: 'sell', date: '2022-06-01', units: 10, amount: 1200, fees: 10, taxes: 5 },
    ];
    // After buy1: 10 units, cost 1005, avg = 100.5
    // After buy2: 20 units, cost 2110, avg = 105.5
    // After sell: avgCost = 105.5, costOfSold = 1055, netProceeds = 1200 - 10 - 5 = 1185, realizedGain = 130
    const result = calculateCostBasis(txns);
    expect(result.totalUnits).toBeCloseTo(10, 8);
    expect(result.avgCostBasis).toBeCloseTo(105.5, 4);
    expect(result.realizedGain).toBeCloseTo(130, 4);
  });
});

// ── projectedAnnualInterest ───────────────────────────────────────────────────

describe('property: projectedAnnualInterest', () => {
  const rng = seeded(0xACC12345);

  it('equals principal × rate / 100 for any positive inputs', () => {
    for (let trial = 0; trial < 500; trial++) {
      const principal = randBetween(rng, 0.01, 1_000_000);
      const rate      = randBetween(rng, 0.001, 50);
      const result    = projectedAnnualInterest(principal, rate);
      expect(result).toBeCloseTo(principal * rate / 100, 6);
    }
  });

  it('is always non-negative for positive principal and rate', () => {
    for (let trial = 0; trial < 200; trial++) {
      const principal = randBetween(rng, 0.01, 1_000_000);
      const rate      = randBetween(rng, 0.001, 50);
      expect(projectedAnnualInterest(principal, rate)).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns 0 when principal ≤ 0', () => {
    expect(projectedAnnualInterest(0, 5)).toBe(0);
    expect(projectedAnnualInterest(-100, 5)).toBe(0);
  });

  it('returns 0 when rate is falsy', () => {
    expect(projectedAnnualInterest(1000, 0)).toBe(0);
    expect(projectedAnnualInterest(1000, null)).toBe(0);
  });
});

// ── annualizedReturn ──────────────────────────────────────────────────────────

describe('property: annualizedReturn', () => {
  const rng = seeded(0xCAC12345);

  it('returns 0 when totalInvested ≤ 0', () => {
    for (let trial = 0; trial < 50; trial++) {
      const cv = randBetween(rng, 1, 10000);
      const d  = 1 + Math.floor(rng() * 3650);
      expect(annualizedReturn(cv, 0, d)).toBe(0);
      expect(annualizedReturn(cv, -10, d)).toBe(0);
    }
  });

  it('returns 0 when days ≤ 0', () => {
    expect(annualizedReturn(1200, 1000, 0)).toBe(0);
    expect(annualizedReturn(1200, 1000, -5)).toBe(0);
  });

  it('returns 0 when currentValue ≤ 0', () => {
    expect(annualizedReturn(0, 1000, 365)).toBe(0);
    expect(annualizedReturn(-100, 1000, 365)).toBe(0);
  });

  it('is always finite for valid positive inputs', () => {
    for (let trial = 0; trial < 300; trial++) {
      const cv = randBetween(rng, 1, 1_000_000);
      const ti = randBetween(rng, 1, 1_000_000);
      const d  = 1 + Math.floor(rng() * 10000);
      const result = annualizedReturn(cv, ti, d);
      expect(Number.isFinite(result), `trial ${trial}: result is not finite`).toBe(true);
    }
  });

  it('equals total return for exactly 365.25 days (1 year period)', () => {
    const currentValue    = 1200;
    const totalInvested   = 1000;
    const expectedReturn  = (currentValue / totalInvested - 1) * 100; // 20%
    const result = annualizedReturn(currentValue, totalInvested, 365.25);
    expect(result).toBeCloseTo(expectedReturn, 4);
  });
});

// ── contributionAdjustedMonthlyReturn ────────────────────────────────────────

describe('property: contributionAdjustedMonthlyReturn', () => {
  const rng = seeded(0xEAA71234 | 0);

  it('returns 0 when the value/invested ratio is unchanged month-over-month', () => {
    for (let trial = 0; trial < 200; trial++) {
      const invested = randBetween(rng, 100, 100000);
      const ratio    = randBetween(rng, 0.5, 2.5);
      const value    = invested * ratio;
      const result = contributionAdjustedMonthlyReturn(value, invested, value, invested);
      expect(result, `trial ${trial}`).toBeCloseTo(0, 8);
    }
  });

  it('returns null when prevInvested ≤ 0 or currInvested ≤ 0 or prevValue ≤ 0', () => {
    expect(contributionAdjustedMonthlyReturn(100, 100, 100, 0)).toBeNull();
    expect(contributionAdjustedMonthlyReturn(100, 100, 100, -1)).toBeNull();
    expect(contributionAdjustedMonthlyReturn(100, 0, 100, 100)).toBeNull();
    expect(contributionAdjustedMonthlyReturn(100, -1, 100, 100)).toBeNull();
    expect(contributionAdjustedMonthlyReturn(100, 100, 0, 100)).toBeNull();
  });

  it('is always finite for valid positive inputs', () => {
    for (let trial = 0; trial < 300; trial++) {
      const cv = randBetween(rng, 1, 1_000_000);
      const ci = randBetween(rng, 1, 1_000_000);
      const pv = randBetween(rng, 1, 1_000_000);
      const pi = randBetween(rng, 1, 1_000_000);
      const result = contributionAdjustedMonthlyReturn(cv, ci, pv, pi);
      expect(result === null || Number.isFinite(result), `trial ${trial}: not finite`).toBe(true);
    }
  });

  it('formula holds: result = ((currValue/currInvested) / (prevValue/prevInvested) - 1) * 100', () => {
    for (let trial = 0; trial < 200; trial++) {
      const cv = randBetween(rng, 100, 100000);
      const ci = randBetween(rng, 100, 100000);
      const pv = randBetween(rng, 100, 100000);
      const pi = randBetween(rng, 100, 100000);
      const expected = ((cv / ci) / (pv / pi) - 1) * 100;
      const result = contributionAdjustedMonthlyReturn(cv, ci, pv, pi);
      expect(result).toBeCloseTo(expected, 6);
    }
  });
});

// ── calculateAccruedInterest ──────────────────────────────────────────────────

describe('property: calculateAccruedInterest', () => {
  const rng = seeded(0xACC22345);

  it('returns 0 when principal ≤ 0', () => {
    const txns = [{ type: 'buy', date: '2022-01-01' }];
    expect(calculateAccruedInterest(txns, 0, 5)).toBe(0);
    expect(calculateAccruedInterest(txns, -100, 5)).toBe(0);
  });

  it('returns 0 when interestRate is falsy', () => {
    const txns = [{ type: 'buy', date: '2022-01-01' }];
    expect(calculateAccruedInterest(txns, 1000, 0)).toBe(0);
    expect(calculateAccruedInterest(txns, 1000, null)).toBe(0);
  });

  it('is non-negative for positive principal and rate', () => {
    const buyDate = '2021-01-01'; // well in the past
    for (let trial = 0; trial < 200; trial++) {
      const principal = randBetween(rng, 0.01, 100000);
      const rate      = randBetween(rng, 0.01, 20);
      const txns      = [{ type: 'buy', date: buyDate }];
      const result    = calculateAccruedInterest(txns, principal, rate);
      expect(result, `trial ${trial}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('is proportional to principal: doubling principal doubles accrued interest', () => {
    const buyDate = '2021-01-01';
    for (let trial = 0; trial < 100; trial++) {
      const principal = randBetween(rng, 1, 10000);
      const rate      = randBetween(rng, 0.1, 15);
      const txns      = [{ type: 'buy', date: buyDate }];
      const r1 = calculateAccruedInterest(txns, principal, rate);
      const r2 = calculateAccruedInterest(txns, principal * 2, rate);
      if (r1 > 0) {
        expect(r2 / r1).toBeCloseTo(2, 6);
      }
    }
  });
});

// ── sanitizeSnapshotSpikes ────────────────────────────────────────────────────

describe('property: sanitizeSnapshotSpikes', () => {
  const rng = seeded(0x5F1CE123);

  it('output length equals input length for any array size', () => {
    for (let trial = 0; trial < 200; trial++) {
      const len = Math.floor(rng() * 50);
      const snapshots = Array.from({ length: len }, () => ({
        value: randBetween(rng, 100, 10000),
        stocks_etfs_value: randBetween(rng, 0, 5000),
        crypto_value: randBetween(rng, 0, 2000),
        metals_value: randBetween(rng, 0, 1000),
      }));
      const result = sanitizeSnapshotSpikes(snapshots);
      expect(result.length, `trial ${trial}: length changed`).toBe(snapshots.length);
    }
  });

  it('does not mutate the input array', () => {
    for (let trial = 0; trial < 50; trial++) {
      const len = 3 + Math.floor(rng() * 20);
      const original = Array.from({ length: len }, (_, i) => ({
        value: 1000 + i * 10,
        stocks_etfs_value: 500,
        crypto_value: 200,
        metals_value: 100,
      }));
      const copy = original.map(s => ({ ...s }));
      sanitizeSnapshotSpikes(original);
      for (let i = 0; i < len; i++) {
        expect(original[i].value, `trial ${trial} index ${i}: input was mutated`).toBe(copy[i].value);
      }
    }
  });

  it('first and last elements are always unchanged', () => {
    for (let trial = 0; trial < 200; trial++) {
      const len = 3 + Math.floor(rng() * 20);
      const snapshots = Array.from({ length: len }, () => ({
        value: randBetween(rng, 100, 5000),
        stocks_etfs_value: randBetween(rng, 0, 2000),
        crypto_value: randBetween(rng, 0, 1000),
        metals_value: randBetween(rng, 0, 500),
      }));
      const result = sanitizeSnapshotSpikes(snapshots);
      expect(result[0].value, `trial ${trial}: first element changed`).toBe(snapshots[0].value);
      expect(result[len - 1].value, `trial ${trial}: last element changed`).toBe(snapshots[len - 1].value);
    }
  });

  it('returns empty array for empty input', () => {
    expect(sanitizeSnapshotSpikes([])).toEqual([]);
  });

  it('monotone sequences are not altered', () => {
    // A steadily rising sequence has no spikes — all values must survive unchanged.
    const snapshots = Array.from({ length: 10 }, (_, i) => ({
      value: 1000 + i * 100,  // +10% per step — below spike threshold
      stocks_etfs_value: 500 + i * 50,
      crypto_value: 100 + i * 10,
      metals_value: 50 + i * 5,
    }));
    const result = sanitizeSnapshotSpikes(snapshots);
    for (let i = 0; i < snapshots.length; i++) {
      expect(result[i].value).toBeCloseTo(snapshots[i].value, 8);
    }
  });

  it('needle-peak is corrected to geometric mean of neighbors', () => {
    // prev=1000, spike=5000 (5×), next=1020 → spike should be corrected
    const snapshots = [
      { value: 1000, stocks_etfs_value: 500, crypto_value: 200, metals_value: 100 },
      { value: 5000, stocks_etfs_value: 2500, crypto_value: 1000, metals_value: 500 },
      { value: 1020, stocks_etfs_value: 510, crypto_value: 204, metals_value: 102 },
    ];
    const result = sanitizeSnapshotSpikes(snapshots);
    const expected = Math.sqrt(1000 * 1020);
    expect(result[1].value).toBeCloseTo(expected, 4);
    // Endpoints unchanged
    expect(result[0].value).toBe(1000);
    expect(result[2].value).toBe(1020);
  });
});
