/**
 * Rolling-window backtest unit tests + rolling MC cache + diagnostics integration tests.
 *
 * Three concerns tested here:
 *   1. walkForwardBacktestRolling — pure function, no mocks needed.
 *   2. Rolling MC cache — cache hit short-circuits DB fetch; miss triggers upsert.
 *   3. Rolling diagnostics — includeBacktest=true populates diagnostics, skips cache.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { walkForwardBacktestRolling } from '../../src/services/calculations/forecast/backtest.js';
import mcRollingCacheRepo from '../../src/repositories/cashflowForecastMcRollingRepository.js';
import { infoRepository } from '../../src/repositories/infoRepository.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const buildHistory = ({ days = 300 } = {}) => {
  const out = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < days; i++) {
    const ms = start + i * 86_400_000;
    out.push({ date: new Date(ms).toISOString().slice(0, 10), net: (i % 5) - 2 });
  }
  return out;
};

const isoOffset = (offsetDays) => {
  const now = new Date();
  const ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
};

const todayIso = () => new Date().toISOString().slice(0, 10);

const stubMethod = (id) => ({
  id,
  label: id,
  forecast: ({ forecastDates }) => forecastDates.map((date) => ({ date, value: 1 })),
});

// ─── mocks (hoisted by vitest) ────────────────────────────────────────────────

vi.mock('../../src/repositories/infoRepository.js', () => ({
  infoRepository: {
    // ADR-083 cache-key input (forecast/index.js filterHash).
    getIncludeTransfers: vi.fn(async () => false),
    getCashflowForecastDataRolling: vi.fn(async (historyMonths, daysBack, daysForward) => ({
      history: buildHistory({ days: 400 }),
      currentActual: Array.from({ length: daysBack + 1 }, (_, i) => ({
        date: isoOffset(-daysBack + i),
        net: i % 7 === 0 ? -50 : 10,
      })),
      plannedCurrent: [],
      historyMonths,
    })),
    getCashflowForecastData: vi.fn(),
    getCashflowForecastDataByCategory: vi.fn(),
  },
}));

vi.mock('../../src/repositories/cashflowForecastMcRollingRepository.js', () => ({
  default: {
    get: vi.fn(async () => null),
    isFresh: vi.fn(() => false),
    upsert: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/repositories/cashflowForecastMcRepository.js', () => ({
  default: {
    get: vi.fn(async () => null),
    isFresh: vi.fn(() => false),
    upsert: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

// ─── walkForwardBacktestRolling unit tests ────────────────────────────────────

describe('walkForwardBacktestRolling', () => {
  it('returns one entry per method', () => {
    const history = buildHistory({ days: 300 });
    const result = walkForwardBacktestRolling({
      history,
      methods: [stubMethod('a'), stubMethod('b')],
      daysBack: 14,
      daysForward: 7,
      windowCount: 3,
    });
    expect(result).toHaveLength(2);
  });

  it('each entry has id, label, aggregate, perWindow', () => {
    const result = walkForwardBacktestRolling({
      history: buildHistory({ days: 300 }),
      methods: [stubMethod('m1')],
      daysBack: 14,
      daysForward: 7,
      windowCount: 3,
    });
    const entry = result[0];
    expect(entry.id).toBe('m1');
    expect(entry.label).toBe('m1');
    expect(entry.aggregate).toMatchObject({
      mae: expect.any(Number),
      rmse: expect.any(Number),
      mape: expect.any(Number),
      windows: expect.any(Number),
    });
    expect(Array.isArray(entry.perWindow)).toBe(true);
  });

  it('perWindow entries contain required fields with ISO window_end', () => {
    const result = walkForwardBacktestRolling({
      history: buildHistory({ days: 300 }),
      methods: [stubMethod('m1')],
      daysBack: 7,
      daysForward: 7,
      windowCount: 4,
    });
    for (const w of result[0].perWindow) {
      expect(w.window_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof w.mae).toBe('number');
      expect(typeof w.rmse).toBe('number');
      expect(typeof w.mape).toBe('number');
      expect(typeof w.sampleDays).toBe('number');
    }
  });

  it('aggregate.windows equals perWindow.length', () => {
    const result = walkForwardBacktestRolling({
      history: buildHistory({ days: 300 }),
      methods: [stubMethod('m1')],
      daysBack: 14,
      daysForward: 7,
      windowCount: 4,
    });
    const entry = result[0];
    expect(entry.aggregate.windows).toBe(entry.perWindow.length);
  });

  it('aggregate.mae is mean of per-window maes', () => {
    const result = walkForwardBacktestRolling({
      history: buildHistory({ days: 300 }),
      methods: [stubMethod('m1')],
      daysBack: 7,
      daysForward: 7,
      windowCount: 3,
    });
    const entry = result[0];
    if (entry.perWindow.length === 0) return;
    const expected = entry.perWindow.reduce((s, w) => s + w.mae, 0) / entry.perWindow.length;
    expect(entry.aggregate.mae).toBeCloseTo(expected, 10);
  });

  it('empty history → aggregate zeros, empty perWindow', () => {
    const result = walkForwardBacktestRolling({
      history: [],
      methods: [stubMethod('m1')],
      daysBack: 7,
      daysForward: 7,
      windowCount: 3,
    });
    expect(result[0].aggregate).toMatchObject({ mae: 0, rmse: 0, mape: 0, windows: 0 });
    expect(result[0].perWindow).toHaveLength(0);
  });

  it('window_end dates are strictly in the past relative to today', () => {
    const result = walkForwardBacktestRolling({
      history: buildHistory({ days: 300 }),
      methods: [stubMethod('m1')],
      daysBack: 7,
      daysForward: 7,
      windowCount: 4,
    });
    const today = todayIso();
    for (const w of result[0].perWindow) {
      expect(w.window_end < today).toBe(true);
    }
  });
});

// ─── rolling MC cache integration tests ──────────────────────────────────────

describe('computeCashflowForecastRolling — MC cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcRollingCacheRepo.get.mockResolvedValue(null);
    mcRollingCacheRepo.isFresh.mockReturnValue(false);
    mcRollingCacheRepo.upsert.mockResolvedValue(undefined);
    infoRepository.getCashflowForecastDataRolling.mockImplementation(
      async (historyMonths, daysBack, daysForward) => ({
        history: buildHistory({ days: 400 }),
        currentActual: Array.from({ length: daysBack + 1 }, (_, i) => ({
          date: isoOffset(-daysBack + i),
          net: i % 7 === 0 ? -50 : 10,
        })),
        plannedCurrent: [],
        historyMonths,
      }),
    );
  });

  it('cache miss with default MC params → live compute + upsert called', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const result = await computeCashflowForecastRolling({
      daysBack: 10,
      daysForward: 10,
      mcPaths: 500,
      mcPercentiles: [25, 75],
      userId: 'u_cache_miss',
    });
    expect(result.meta.source).toBe('live');
    // upsert is fire-and-forget; flush microtask queue
    await Promise.resolve();
    expect(mcRollingCacheRepo.upsert).toHaveBeenCalledOnce();
  });

  it('cache hit with fresh entry → cached payload returned, DB not called', async () => {
    const cachedPayload = {
      window_start: isoOffset(-10),
      window_end: isoOffset(10),
      today: todayIso(),
      currency: 'EUR',
      days_back: 10,
      days_forward: 10,
      actual: [],
      methods: [],
      planned: [],
      diagnostics: null,
      history_months: 36,
      include_planned: false,
    };
    mcRollingCacheRepo.get.mockResolvedValue({
      payload: cachedPayload,
      computed_at: new Date(),
    });
    mcRollingCacheRepo.isFresh.mockReturnValue(true);

    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const result = await computeCashflowForecastRolling({
      daysBack: 10,
      daysForward: 10,
      mcPaths: 500,
      mcPercentiles: [25, 75],
      userId: 'u_cache_hit',
    });

    expect(result.meta.source).toBe('cache');
    expect(result.data).toEqual(cachedPayload);
    expect(infoRepository.getCashflowForecastDataRolling).not.toHaveBeenCalled();
  });

  it('non-default mcPaths → cache check skipped entirely', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    await computeCashflowForecastRolling({
      daysBack: 10,
      daysForward: 10,
      mcPaths: 200,
      userId: 'u_noncache',
    });
    expect(mcRollingCacheRepo.get).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(mcRollingCacheRepo.upsert).not.toHaveBeenCalled();
  });

  // ADR-083 `includeTransfers` changes what the forecast repositories return,
  // so it must be part of the cache identity. Before it was hashed in, toggling
  // the setting kept serving the pre-toggle forecast for the cache's 6h TTL.
  it('includeTransfers is a cache-key input → toggling it misses the cache', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const args = { daysBack: 10, daysForward: 10, mcPaths: 500, mcPercentiles: [25, 75], userId: 'u_tx' };

    infoRepository.getIncludeTransfers.mockResolvedValue(false);
    await computeCashflowForecastRolling(args);
    const hashOff = mcRollingCacheRepo.get.mock.calls.at(-1)[0].filterHash;

    infoRepository.getIncludeTransfers.mockResolvedValue(true);
    await computeCashflowForecastRolling(args);
    const hashOn = mcRollingCacheRepo.get.mock.calls.at(-1)[0].filterHash;

    expect(hashOff).not.toBe(hashOn);
    // Every other input is identical, so the difference is the toggle alone.
    expect(hashOff.replace(/\|t0$/, '')).toBe(hashOn.replace(/\|t1$/, ''));

    infoRepository.getIncludeTransfers.mockResolvedValue(false);
  });
});

// ─── rolling diagnostics integration tests ───────────────────────────────────

describe('computeCashflowForecastRolling — diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcRollingCacheRepo.get.mockResolvedValue(null);
    mcRollingCacheRepo.isFresh.mockReturnValue(false);
    mcRollingCacheRepo.upsert.mockResolvedValue(undefined);
    infoRepository.getCashflowForecastDataRolling.mockImplementation(
      async (historyMonths, daysBack, daysForward) => ({
        history: buildHistory({ days: 400 }),
        currentActual: Array.from({ length: daysBack + 1 }, (_, i) => ({
          date: isoOffset(-daysBack + i),
          net: i % 7 === 0 ? -50 : 10,
        })),
        plannedCurrent: [],
        historyMonths,
      }),
    );
  });

  it('includeBacktest=false → diagnostics is null', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const result = await computeCashflowForecastRolling({
      daysBack: 10,
      daysForward: 10,
      mcPaths: 50,
      includeBacktest: false,
      userId: 'u_nodiag',
    });
    expect(result.data.diagnostics).toBeNull();
  });

  it('includeBacktest=true → diagnostics non-null with per-method backtest entries', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const result = await computeCashflowForecastRolling({
      daysBack: 10,
      daysForward: 10,
      mcPaths: 50,
      includeBacktest: true,
      userId: 'u_diag',
    });
    const diag = result.data.diagnostics;
    expect(diag).not.toBeNull();
    expect(Array.isArray(diag.backtest)).toBe(true);
    expect(diag.backtest.length).toBeGreaterThan(0);
    for (const entry of diag.backtest) {
      expect(typeof entry.method_id).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.mae).toBe('number');
      expect(typeof entry.rmse).toBe('number');
      expect(typeof entry.mape).toBe('number');
      expect(typeof entry.months).toBe('number');
      expect(Array.isArray(entry.per_month)).toBe(true);
    }
  });

  it('includeBacktest=true → per_month entries have month (ISO), mae, rmse, mape, sample_days', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    const result = await computeCashflowForecastRolling({
      daysBack: 10,
      daysForward: 10,
      mcPaths: 50,
      includeBacktest: true,
      userId: 'u_diag2',
    });
    const entry = result.data.diagnostics.backtest[0];
    if (entry.per_month.length === 0) return;
    const w = entry.per_month[0];
    expect(w.month).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof w.mae).toBe('number');
    expect(typeof w.sample_days).toBe('number');
  });

  it('includeBacktest=true with default MC params → cache skipped (no get or upsert)', async () => {
    const { computeCashflowForecastRolling } = await import(
      '../../src/services/calculations/forecast/index.js'
    );
    await computeCashflowForecastRolling({
      daysBack: 10,
      daysForward: 10,
      mcPaths: 1000,
      mcPercentiles: [10, 50, 90],
      includeBacktest: true,
      userId: 'u_backtest_nocache',
    });
    expect(mcRollingCacheRepo.get).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(mcRollingCacheRepo.upsert).not.toHaveBeenCalled();
  });
});
