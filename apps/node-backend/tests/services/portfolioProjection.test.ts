import { describe, it, expect } from 'vitest';
import { runPortfolioForecast } from '../../src/services/research/projection/portfolioProjection.ts';
import type { PortfolioForecastInput } from '../../src/services/research/projection/portfolioProjection.ts';
import { must } from "../helpers/must.ts";

type ForecastDeps = NonNullable<Parameters<typeof runPortfolioForecast>[1]>;
type ForecastResult = Awaited<ReturnType<typeof runPortfolioForecast>>;
type AvailableForecast = Extract<ForecastResult, { points: unknown }>;

/** Runs the forecast for cases that expect a computed (available) result. */
async function runAvailable(input: PortfolioForecastInput, d: ForecastDeps) {
  return (await runPortfolioForecast(input, d)) as AvailableForecast;
}

/** Deterministic value series (Math.sin is host-stable) with positive drift + noise. */
function buildSnapshots(n = 200) {
  const out: { value: number; snapshot_date: string }[] = [];
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
  fetch: (type: string) => {
    if (type === 'quote') return Promise.resolve({ source: 'live', provider: 'x', data: { price: 100 } });
    if (type === 'analyst') return Promise.resolve({ source: 'live', provider: 'x', data: { targetMean: 120 } });
    if (type === 'fundamentals') return Promise.resolve({ source: 'live', provider: 'x', data: { dividendYield: 0.02 } });
    return Promise.resolve({ source: 'unavailable' });
  },
};

function deps(overrides: Record<string, unknown> = {}): ForecastDeps {
  // Partial fixtures: only the fields the projection reads are provided.
  return {
    getPortfolioSummary: () => Promise.resolve(baseSummary),
    getSnapshots: () => Promise.resolve(buildSnapshots()),
    aggregator: { fetch: () => Promise.resolve(({ source: 'unavailable' })) },
    today: () => '2026-06-16',
    ...overrides,
  } as unknown as ForecastDeps;
}

describe('runPortfolioForecast', () => {
  it('is deterministic for a given seed', async () => {
    const a = await runAvailable({ horizonMonths: 12, paths: 300, seed: 't' }, deps());
    const b = await runAvailable({ horizonMonths: 12, paths: 300, seed: 't' }, deps());
    expect(b.projected).toEqual(a.projected);
    expect(b.points).toEqual(a.points);
  });

  it('produces ordered percentile bands at the horizon', async () => {
    const r = await runAvailable({ horizonMonths: 24, paths: 500, seed: 't' }, deps());
    const last = must(r.points.at(-1), "r.points.at(-1)");
    expect(last.p10).toBeLessThanOrEqual(last.p25);
    expect(last.p25).toBeLessThanOrEqual(last.p50);
    expect(last.p50).toBeLessThanOrEqual(last.p75);
    expect(last.p75).toBeLessThanOrEqual(last.p90);
    expect(r.points).toHaveLength(24);
    expect(last.date).toBe('2028-06-01');
  });

  it('guards on no holdings', async () => {
    const r = await runPortfolioForecast({}, deps({
      getPortfolioSummary: () => Promise.resolve(({ totals: { totalPortfolioValue: 0 }, summaries: [] })),
    }));
    expect(r).toEqual({ available: false, reason: 'no_holdings' });
  });

  it('guards on insufficient history', async () => {
    const r = await runPortfolioForecast({}, deps({ getSnapshots: () => Promise.resolve([{ value: 1000 }]) }));
    expect(r.available).toBe(false);
    expect(r.reason).toBe('insufficient_history');
  });

  it('blends provider forward inputs into the drift', async () => {
    const r = await runAvailable(
      { horizonMonths: 12, paths: 300, forwardBlend: 1, seed: 't' },
      deps({ aggregator: forwardAggregator }),
    );
    expect(r.usedForward).toBe(true);
    expect(must(r.forwardHoldings[0], "r.forwardHoldings[0]").symbol).toBe('AAA');
    // Single 100%-weight holding at blend=1 → portfolio expected return ≈ 20% growth + 2% yield.
    expect(r.expectedAnnualReturn).toBeCloseTo(0.22, 2);
  });

  it('leans on historical drift when forwardBlend is 0', async () => {
    const r = await runAvailable(
      { horizonMonths: 12, paths: 300, forwardBlend: 0, seed: 't' },
      deps({ aggregator: forwardAggregator }),
    );
    expect(r.usedForward).toBe(false);
    expect(r.expectedAnnualReturn).toBeCloseTo(r.historicalAnnualReturn, 6);
  });

  it('reflects monthly contributions in net invested', async () => {
    const r = await runAvailable({ horizonMonths: 12, paths: 200, monthlyContribution: 100, seed: 't' }, deps());
    expect(r.netInvested).toBe(2200); // 1000 start + 100 × 12
    expect(must(r.points.at(-1), "r.points.at(-1)").netInvested).toBe(2200);
  });

  it('supports the block bootstrap method with ordered bands', async () => {
    const r = await runAvailable({ horizonMonths: 12, paths: 400, method: 'block_bootstrap', seed: 't' }, deps());
    expect(r.available).toBe(true);
    expect(r.method).toBe('block_bootstrap');
    const last = must(r.points.at(-1), "r.points.at(-1)");
    expect(last.p10).toBeLessThanOrEqual(last.p90);
  });

  it('computes target-hit probability when a target is given', async () => {
    const r = await runAvailable({ horizonMonths: 12, paths: 300, targetValue: 1, seed: 't' }, deps());
    expect(r.probTarget).toBe(1); // trivially above a tiny target
  });

  it('does not read contributions as market returns (flow-adjusted drift)', async () => {
    // value and invested both climb 100/day → pure deposits, zero market P&L.
    // Raw value growth would imply a large positive drift; flow adjustment → ~0.
    const snaps: { value: number; invested: number }[] = [];
    let v = 1000;
    for (let i = 0; i < 120; i++) { snaps.push({ value: v, invested: v }); v += 100; }
    const r = await runAvailable(
      { horizonMonths: 12, paths: 200, seed: 't' },
      deps({
        getSnapshots: () => Promise.resolve(snaps),
        getPortfolioSummary: () => Promise.resolve(({ totals: { totalPortfolioValue: v, totalInvested: v }, summaries: [] })),
      }),
    );
    expect(r.historicalAnnualReturn).toBeCloseTo(0, 6);
    expect(r.annualVolatility).toBeCloseTo(0, 6);
  });

  it('uses cost basis (not market value) for the net-invested baseline', async () => {
    const r = await runAvailable(
      { horizonMonths: 12, paths: 100, monthlyContribution: 50, seed: 't' },
      deps({
        getPortfolioSummary: () => Promise.resolve(({
          totals: { totalPortfolioValue: 1500, totalInvested: 1000 },
          summaries: [],
        })),
      }),
    );
    // 1000 cost basis + 50×12 contributions = 1600 — NOT 1500 market value + 600.
    expect(r.startInvested).toBe(1000);
    expect(r.netInvested).toBe(1600);
    expect(must(r.points.at(-1), "r.points.at(-1)").netInvested).toBe(1600);
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
    const r = await runAvailable(
      { horizonMonths: 6, paths: 100, seed: 't' },
      deps({
        getSnapshots: () => Promise.resolve(snaps),
        getPortfolioSummary: () => Promise.resolve(({ totals: { totalPortfolioValue: 2040, totalInvested: 1000 }, summaries: [] })),
      }),
    );
    expect(r.flowArtifactDays).toBe(1);
    expect(r.historyDays).toBe(2);
  });

  it('keeps a constant schedule identical to the legacy contribution path', async () => {
    for (const method of ['parametric', 'block_bootstrap'] as const) {
      const input: PortfolioForecastInput = { horizonMonths: 6, paths: 200, monthlyContribution: 100, method };
      const legacy = await runAvailable(input, deps());
      const scheduled = await runAvailable(
        { ...input, monthlyContributionSchedule: Array(6).fill(100) }, deps(),
      );
      expect(scheduled.seed).toBe(legacy.seed);
      expect(scheduled.projected).toEqual(legacy.projected);
      expect(scheduled.points).toEqual(legacy.points);
      expect(scheduled.totalContributions).toBe(legacy.totalContributions);
    }
  });

  it('accounts for interrupted contributions each month and evaluates a dated goal', async () => {
    const stable = deps({
      getSnapshots: () => Promise.resolve(Array.from({ length: 100 }, () => ({ value: 1000, invested: 1000 }))),
      getPortfolioSummary: () => Promise.resolve(({
        totals: { totalPortfolioValue: 1000, totalInvested: 1000 }, summaries: [],
      })),
    });
    const input: PortfolioForecastInput = {
      horizonMonths: 6, paths: 100, monthlyContribution: 100,
      monthlyContributionSchedule: [0, 0, 0], targetValue: 1250, seed: 'interruption',
    };
    const dated = await runAvailable({ ...input, goalMonth: 3 }, stable);
    const undated = await runAvailable(input, stable);
    expect(dated.points.map((point) => point.netInvested)).toEqual([1000, 1000, 1000, 1100, 1200, 1300]);
    expect(dated.totalContributions).toBe(300);
    expect(dated.netInvested).toBe(1300);
    expect(dated.goalMonth).toBe(3);
    expect(dated.probTarget).toBe(0);
    expect(undated.probTarget).toBe(1);
    expect(undated).not.toHaveProperty('goalMonth');
  });

  it('rejects schedules longer than the horizon or containing invalid amounts', async () => {
    await expect(runPortfolioForecast({ horizonMonths: 2, monthlyContributionSchedule: [0, 0, 0] }, deps()))
      .rejects.toThrow(RangeError);
    await expect(runPortfolioForecast({ horizonMonths: 2, monthlyContributionSchedule: [0, -1] }, deps()))
      .rejects.toThrow(RangeError);
    await expect(runPortfolioForecast({ horizonMonths: 2, monthlyContributionSchedule: [0, Infinity] }, deps()))
      .rejects.toThrow(RangeError);
  });

  it('serializes overflowing contribution money as null, which the forecast contract rejects', async () => {
    const { PortfolioForecastSchema } = await import('@vision/types/contracts');
    const snapshots = Array.from({ length: 100 }, (_, i) => ({
      value: 1000 * Math.exp(i * 0.0005),
      snapshot_date: `2026-01-${i}`,
    }));
    const result = await runAvailable(
      { horizonMonths: 3, paths: 100, monthlyContribution: 1e308, seed: 'overflow-wire' },
      deps({
        getPortfolioSummary: () => Promise.resolve(({ totals: { totalPortfolioValue: 1000 }, summaries: [] })),
        getSnapshots: () => Promise.resolve(snapshots),
        today: () => '2026-10-13',
      }),
    );
    const wire = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(wire.available).toBe(true);
    expect(wire.monthlyContribution).toBeNull();
    expect(wire.netInvested).toBeNull();
    expect((wire.projected as { p50: unknown }).p50).toBeNull();
    expect(PortfolioForecastSchema.safeParse(wire).success).toBe(false);
  });
});
