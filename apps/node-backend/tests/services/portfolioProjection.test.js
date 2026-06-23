import { describe, it, expect } from 'vitest';
import { runPortfolioForecast } from '../../src/services/research/projection/portfolioProjection.js';

/** Deterministic value series (Math.sin is host-stable) with positive drift + noise. */
function buildSnapshots(n = 200) {
  const out = [];
  let v = 1000;
  for (let i = 0; i < n; i++) {
    v *= 1 + 0.0005 + 0.01 * Math.sin(i);
    out.push({ value: v, snapshot_date: `2026-01-${i}` });
  }
  return out;
}

const baseSummary = {
  totals: { totalPortfolioValue: 1000 },
  summaries: [{ id: 1, symbol: 'AAA', asset_class: 'stock', currentValue: 1000 }],
};

/** Aggregator that gives AAA a 20% implied growth (120 target / 100 price) + 2% yield. */
const forwardAggregator = {
  fetch: async (type) => {
    if (type === 'quote') return { source: 'live', provider: 'x', data: { price: 100 } };
    if (type === 'analyst') return { source: 'live', provider: 'x', data: { targetMean: 120 } };
    if (type === 'fundamentals') return { source: 'live', provider: 'x', data: { dividendYield: 0.02 } };
    return { source: 'unavailable' };
  },
};

function deps(overrides = {}) {
  return {
    getPortfolioSummary: async () => baseSummary,
    getSnapshots: async () => buildSnapshots(),
    aggregator: { fetch: async () => ({ source: 'unavailable' }) },
    today: () => '2026-06-16',
    ...overrides,
  };
}

describe('runPortfolioForecast', () => {
  it('is deterministic for a given seed', async () => {
    const a = await runPortfolioForecast({ horizonMonths: 12, paths: 300, seed: 't' }, deps());
    const b = await runPortfolioForecast({ horizonMonths: 12, paths: 300, seed: 't' }, deps());
    expect(b.projected).toEqual(a.projected);
    expect(b.points).toEqual(a.points);
  });

  it('produces ordered percentile bands at the horizon', async () => {
    const r = await runPortfolioForecast({ horizonMonths: 24, paths: 500, seed: 't' }, deps());
    const last = r.points.at(-1);
    expect(last.p10).toBeLessThanOrEqual(last.p25);
    expect(last.p25).toBeLessThanOrEqual(last.p50);
    expect(last.p50).toBeLessThanOrEqual(last.p75);
    expect(last.p75).toBeLessThanOrEqual(last.p90);
    expect(r.points).toHaveLength(24);
    expect(last.date).toBe('2028-06-01');
  });

  it('guards on no holdings', async () => {
    const r = await runPortfolioForecast({}, deps({
      getPortfolioSummary: async () => ({ totals: { totalPortfolioValue: 0 }, summaries: [] }),
    }));
    expect(r).toEqual({ available: false, reason: 'no_holdings' });
  });

  it('guards on insufficient history', async () => {
    const r = await runPortfolioForecast({}, deps({ getSnapshots: async () => [{ value: 1000 }] }));
    expect(r.available).toBe(false);
    expect(r.reason).toBe('insufficient_history');
  });

  it('blends provider forward inputs into the drift', async () => {
    const r = await runPortfolioForecast(
      { horizonMonths: 12, paths: 300, forwardBlend: 1, seed: 't' },
      deps({ aggregator: forwardAggregator }),
    );
    expect(r.usedForward).toBe(true);
    expect(r.forwardHoldings[0].symbol).toBe('AAA');
    // Single 100%-weight holding at blend=1 → portfolio expected return ≈ 20% growth + 2% yield.
    expect(r.expectedAnnualReturn).toBeCloseTo(0.22, 2);
  });

  it('leans on historical drift when forwardBlend is 0', async () => {
    const r = await runPortfolioForecast(
      { horizonMonths: 12, paths: 300, forwardBlend: 0, seed: 't' },
      deps({ aggregator: forwardAggregator }),
    );
    expect(r.usedForward).toBe(false);
    expect(r.expectedAnnualReturn).toBeCloseTo(r.historicalAnnualReturn, 6);
  });

  it('reflects monthly contributions in net invested', async () => {
    const r = await runPortfolioForecast({ horizonMonths: 12, paths: 200, monthlyContribution: 100, seed: 't' }, deps());
    expect(r.netInvested).toBe(2200); // 1000 start + 100 × 12
    expect(r.points.at(-1).netInvested).toBe(2200);
  });

  it('supports the block bootstrap method with ordered bands', async () => {
    const r = await runPortfolioForecast({ horizonMonths: 12, paths: 400, method: 'block_bootstrap', seed: 't' }, deps());
    expect(r.available).toBe(true);
    expect(r.method).toBe('block_bootstrap');
    const last = r.points.at(-1);
    expect(last.p10).toBeLessThanOrEqual(last.p90);
  });

  it('computes target-hit probability when a target is given', async () => {
    const r = await runPortfolioForecast({ horizonMonths: 12, paths: 300, targetValue: 1, seed: 't' }, deps());
    expect(r.probTarget).toBe(1); // trivially above a tiny target
  });

  it('does not read contributions as market returns (flow-adjusted drift)', async () => {
    // value and invested both climb 100/day → pure deposits, zero market P&L.
    // Raw value growth would imply a large positive drift; flow adjustment → ~0.
    const snaps = [];
    let v = 1000;
    for (let i = 0; i < 120; i++) { snaps.push({ value: v, invested: v }); v += 100; }
    const r = await runPortfolioForecast(
      { horizonMonths: 12, paths: 200, seed: 't' },
      deps({
        getSnapshots: async () => snaps,
        getPortfolioSummary: async () => ({ totals: { totalPortfolioValue: v, totalInvested: v }, summaries: [] }),
      }),
    );
    expect(r.historicalAnnualReturn).toBeCloseTo(0, 6);
    expect(r.annualVolatility).toBeCloseTo(0, 6);
  });

  it('uses cost basis (not market value) for the net-invested baseline', async () => {
    const r = await runPortfolioForecast(
      { horizonMonths: 12, paths: 100, monthlyContribution: 50, seed: 't' },
      deps({
        getPortfolioSummary: async () => ({
          totals: { totalPortfolioValue: 1500, totalInvested: 1000 },
          summaries: [],
        }),
      }),
    );
    // 1000 cost basis + 50×12 contributions = 1600 — NOT 1500 market value + 600.
    expect(r.startInvested).toBe(1000);
    expect(r.netInvested).toBe(1600);
    expect(r.points.at(-1).netInvested).toBe(1600);
  });

  it('drops gross flow artifacts from the return series', async () => {
    // A day where value doubles with no cost-basis change is an untracked-flow
    // artifact, not a real 100% market day — it must not enter the drift estimate.
    const snaps = [
      { value: 1000, invested: 1000 },
      { value: 1010, invested: 1000 },
      { value: 2020, invested: 1000 }, // +100% in a day → dropped
      { value: 2040, invested: 1000 },
    ];
    const r = await runPortfolioForecast(
      { horizonMonths: 6, paths: 100, seed: 't' },
      deps({
        getSnapshots: async () => snaps,
        getPortfolioSummary: async () => ({ totals: { totalPortfolioValue: 2040, totalInvested: 1000 }, summaries: [] }),
      }),
    );
    expect(r.flowArtifactDays).toBe(1);
    expect(r.historyDays).toBe(2);
  });
});
