import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  calculateCostBasisFIFO,
  calculateCostBasisLIFO,
} from '@vision/shared-utils/portfolio'
import {
  calculateAccruedInterest,
  sanitizeSnapshotSpikes,
} from '../src/utils/portfolioMath.js'

describe('calculateCostBasisFIFO', () => {
  it('returns zeros for empty transactions', () => {
    const result = calculateCostBasisFIFO([])
    expect(result.totalUnits).toBe(0)
    expect(result.totalCost).toBe(0)
    expect(result.realizedGain).toBe(0)
    expect(result.totalSellProceeds).toBe(0)
  })

  it('accumulates buy-only position', () => {
    const txns = [{ type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2024-01-01' }]
    const result = calculateCostBasisFIFO(txns)
    expect(result.totalUnits).toBe(10)
    expect(result.totalCost).toBe(100)
    expect(result.avgCostBasis).toBe(10)
    expect(result.realizedGain).toBe(0)
  })

  it('exhausts oldest lot first (FIFO ordering)', () => {
    const txns = [
      { type: 'buy', units: 5, amount: 50, fees: 0, taxes: 0, date: '2024-01-01' },
      { type: 'buy', units: 10, amount: 200, fees: 0, taxes: 0, date: '2024-01-02' },
      { type: 'sell', units: 5, amount: 75, fees: 0, taxes: 0, date: '2024-01-03' },
    ]
    const result = calculateCostBasisFIFO(txns)
    // FIFO exhausts lot1 (costBasis=50): realizedGain = 75 - 50 = 25
    expect(result.realizedGain).toBe(25)
    expect(result.totalUnits).toBe(10)
  })

  it('caps sell units at available and scales proceeds proportionally (oversell)', () => {
    const txns = [
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2024-01-01' },
      { type: 'sell', units: 20, amount: 200, fees: 0, taxes: 0, date: '2024-01-02' },
    ]
    const result = calculateCostBasisFIFO(txns)
    // sellRatio = min(20,10)/20 = 0.5; netProceeds = 200*0.5 = 100; costOfSold = 100
    expect(result.totalUnits).toBe(0)
    expect(result.realizedGain).toBe(0)
    expect(result.totalSellProceeds).toBe(100)
  })

  it('applies split events — doubles units, preserves total cost', () => {
    const txns = [
      { type: 'buy', units: 10, amount: 100, fees: 0, taxes: 0, date: '2024-01-01' },
      { type: 'split', units: 20, amount: 0, fees: 0, taxes: 0, date: '2024-01-02' },
    ]
    const result = calculateCostBasisFIFO(txns)
    expect(result.totalUnits).toBe(20)
    expect(result.totalCost).toBe(100)
    expect(result.avgCostBasis).toBe(5)
  })
})

describe('calculateCostBasisLIFO', () => {
  it('returns zeros for empty transactions', () => {
    const result = calculateCostBasisLIFO([])
    expect(result.totalUnits).toBe(0)
    expect(result.realizedGain).toBe(0)
  })

  it('exhausts newest lot first — opposite realized gain from FIFO', () => {
    // Two buys at different costs; sell exhausts the more-expensive recent lot (LIFO)
    // vs the cheaper old lot (FIFO), flipping realized gain from positive to negative.
    const txns = [
      { type: 'buy', units: 5, amount: 50, fees: 0, taxes: 0, date: '2024-01-01' },
      { type: 'buy', units: 10, amount: 200, fees: 0, taxes: 0, date: '2024-01-02' },
      { type: 'sell', units: 5, amount: 75, fees: 0, taxes: 0, date: '2024-01-03' },
    ]
    const lifo = calculateCostBasisLIFO(txns)
    const fifo = calculateCostBasisFIFO(txns)
    // LIFO takes from lot2 (200/10=20/unit × 5 = 100): gain = 75 - 100 = -25
    // FIFO takes from lot1 (50/5=10/unit × 5 = 50): gain = 75 - 50 = 25
    expect(lifo.realizedGain).toBe(-25)
    expect(fifo.realizedGain).toBe(25)
    expect(lifo.totalUnits).toBe(fifo.totalUnits)
  })

  it('caps sell units at available and scales proceeds proportionally (oversell)', () => {
    const txns = [
      { type: 'buy', units: 5, amount: 50, fees: 0, taxes: 0, date: '2024-01-01' },
      { type: 'sell', units: 15, amount: 150, fees: 0, taxes: 0, date: '2024-01-02' },
    ]
    const result = calculateCostBasisLIFO(txns)
    // sellRatio = min(15,5)/15 = 1/3; netProceeds = 150*(1/3) = 50; costOfSold = 50
    expect(result.totalUnits).toBe(0)
    expect(result.realizedGain).toBe(0)
    expect(result.totalSellProceeds).toBe(50)
  })
})

describe('calculateAccruedInterest', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('returns 0 when interestRate is 0', () => {
    vi.setSystemTime(new Date('2024-07-01T00:00:00Z'))
    expect(calculateAccruedInterest([{ type: 'buy', date: '2024-01-01' }], 1000, 0)).toBe(0)
  })

  it('returns 0 when principal is 0', () => {
    vi.setSystemTime(new Date('2024-07-01T00:00:00Z'))
    expect(calculateAccruedInterest([{ type: 'buy', date: '2024-01-01' }], 0, 5)).toBe(0)
  })

  it('returns 0 when no buy or interest transaction exists', () => {
    vi.setSystemTime(new Date('2024-07-01T00:00:00Z'))
    expect(calculateAccruedInterest([], 1000, 5)).toBe(0)
  })

  it('computes exact simple interest over 365 days from first buy', () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'))
    const txns = [{ type: 'buy', date: '2023-01-01' }]
    // 365 days, 5% annual → 1000 × 0.05 / 365 × 365 = 50
    expect(calculateAccruedInterest(txns, 1000, 5)).toBeCloseTo(50, 4)
  })

  it('uses last interest payment date as start, not first buy', () => {
    vi.setSystemTime(new Date('2024-01-10T00:00:00Z'))
    const txns = [
      { type: 'buy', date: '2024-01-01' },
      { type: 'interest', date: '2024-01-05' },
    ]
    // From interest date (Jan 5): 5 days elapsed; from buy date (Jan 1): 9 days
    const result = calculateAccruedInterest(txns, 1000, 5)
    expect(result).toBeCloseTo(1000 * (5 / 100 / 365) * 5, 4)
  })

  it('returns 0 when start date is in the future', () => {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'))
    expect(calculateAccruedInterest([{ type: 'buy', date: '2025-01-01' }], 1000, 5)).toBe(0)
  })
})

describe('sanitizeSnapshotSpikes', () => {
  it('returns empty array for non-array input', () => {
    expect(sanitizeSnapshotSpikes(null)).toEqual([])
  })

  it('returns input reference unchanged when fewer than 3 elements', () => {
    const snapshots = [{ value: 100 }, { value: 200 }]
    expect(sanitizeSnapshotSpikes(snapshots)).toBe(snapshots)
  })

  it('leaves non-spike sequences untouched', () => {
    const snapshots = [{ value: 100 }, { value: 110 }, { value: 120 }]
    const result = sanitizeSnapshotSpikes(snapshots)
    expect(result[1].value).toBe(110)
  })

  it('replaces a high needle spike (localNeedlePeak) with geo mean of neighbors', () => {
    // 500 >= max(100, 102) * 1.8 = 183.6 → spike. Replacement is rounded to
    // cents (shared implementation with sanitizeIsolatedValueSpikes).
    const snapshots = [{ value: 100 }, { value: 500 }, { value: 102 }]
    const result = sanitizeSnapshotSpikes(snapshots)
    expect(result[1].value).toBeCloseTo(Math.sqrt(100 * 102), 2)
  })

  it('replaces a low needle spike (localNeedleTrough) with geo mean of neighbors', () => {
    // 20 * 1.8 = 36 <= min(100, 102) = 100 → trough spike
    const snapshots = [{ value: 100 }, { value: 20 }, { value: 102 }]
    const result = sanitizeSnapshotSpikes(snapshots)
    expect(result[1].value).toBeCloseTo(Math.sqrt(100 * 102), 2)
  })

  it('does not smooth a needle when the neighbors disagree (abnormal bridge)', () => {
    // 400 >= max(100, 200) * 1.8 = 360, but prev→next doubles (bridge is NOT
    // normal) — the series is repricing, not needling. The unguarded legacy
    // copy smoothed this; the shared bridge-guarded rule must keep it.
    const snapshots = [{ value: 100 }, { value: 400 }, { value: 200 }]
    const result = sanitizeSnapshotSpikes(snapshots)
    expect(result[1].value).toBe(400)
  })

  it('does not mutate the input array or its elements', () => {
    const snapshots = [{ value: 100 }, { value: 500 }, { value: 102 }]
    sanitizeSnapshotSpikes(snapshots)
    expect(snapshots[1].value).toBe(500)
  })
})

describe('UTC day-walk DST safety', () => {
  it('produces correct days across European spring-forward boundary (2024-03-31)', () => {
    // European DST springs forward on 2024-03-31 at 02:00 — that day is only 23h locally.
    // setUTCDate always steps exactly 24h regardless of local DST, so the walk must yield 3 days.
    const start = new Date('2024-03-30T00:00:00Z')
    const end = new Date('2024-04-01T00:00:00Z')
    const days = []
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().split('T')[0])
    }
    expect(days).toEqual(['2024-03-30', '2024-03-31', '2024-04-01'])
  })
})
