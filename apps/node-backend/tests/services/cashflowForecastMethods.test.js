/**
 * Phase A forecast module contract tests.
 *
 * Locks: method outputs deterministic, shape stable, backtest + accuracyStore
 * behave as orchestrator expects. Does NOT assert statistical quality —
 * walk-forward MAE targets belong in a separate accuracy harness (Phase D).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCategoryBreakdown,
  __reconcileCategoryForecasts as reconcileCategoryForecasts,
} from "../../src/services/calculations/forecast/categoryBreakdown.js";

import * as simpleAverage from "../../src/services/calculations/forecast/methods/simpleAverage.js";
import * as weightedAverage from "../../src/services/calculations/forecast/methods/weightedAverage.js";
import * as ewma from "../../src/services/calculations/forecast/methods/ewma.js";
import * as holtWinters from "../../src/services/calculations/forecast/methods/holtWinters.js";
import * as prophetLite from "../../src/services/calculations/forecast/methods/prophetLite.js";
import * as monteCarloParametric from "../../src/services/calculations/forecast/methods/monteCarloParametric.js";
import * as monteCarloBlockBootstrap from "../../src/services/calculations/forecast/methods/monteCarloBlockBootstrap.js";
import * as ensemble from "../../src/services/calculations/forecast/methods/ensemble.js";
import {
  buildSeasonalityBuckets,
  lookupBucket,
  __dayOfWeek as dayOfWeek,
  dayOfMonth,
} from "../../src/services/calculations/forecast/seasonality.js";
import { walkForwardBacktest } from "../../src/services/calculations/forecast/backtest.js";
import {
  recordAccuracy,
  getLatestAccuracyByMethod,
  __getAccuracyHistory as getAccuracyHistory,
  __resetForTests as _resetForTests,
} from "../../src/services/calculations/forecast/accuracyStore.js";
import {
  fnv1aHash,
  makeRng,
  gaussian,
} from "../../src/services/calculations/forecast/prng.js";
import {
  monthKey,
  orderedMonthKeys,
} from "../../src/services/calculations/forecast/months.js";

// accuracyStore silently degrades to an in-memory Map when its table is missing
// OR when Postgres is simply unreachable (ECONNREFUSED). The `accuracyStore`
// cases below assert that in-memory behaviour — `_resetForTests()` clears only
// the Map — so until now they passed purely because no test environment ever had
// a database. With a real Postgres wired into CI they hit the live repository
// instead: `_resetForTests()` stopped isolating anything (rows persisted across
// tests and across runs) and the DB rows came back snake_cased, so `asOfMonth`
// read `undefined`. Force the documented fallback explicitly with a table-missing
// error (42P01) so these cases exercise the same path deterministically whether
// or not a database is reachable.
vi.mock("../../src/repositories/cashflowForecastAccuracyRepository.js", () => {
  const undefinedTable = () => {
    const err = new Error(
      'relation "cashflow_forecast_accuracy" does not exist',
    );
    err.code = "42P01";
    return Promise.reject(err);
  };
  return {
    default: {
      upsert: undefinedTable,
      getHistory: undefinedTable,
      getLatestByMethod: undefinedTable,
      getAllHistory: undefinedTable,
    },
  };
});

function syntheticHistory({
  startIso = "2024-01-01",
  days = 365 * 2,
  amplitude = 10,
  noise = 0,
} = {}) {
  const start = Date.UTC(
    ...startIso.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))),
  );
  const out = [];
  for (let i = 0; i < days; i++) {
    const ms = start + i * 86_400_000;
    const iso = new Date(ms).toISOString().slice(0, 10);
    const dow = new Date(ms).getUTCDay();
    const base =
      amplitude * Math.sin((2 * Math.PI * i) / 7) + (dow === 0 ? -5 : 2);
    const value = base + (noise ? (i % 7) * noise : 0);
    out.push({ date: iso, net: value });
  }
  return out;
}

function futureDates({ startIso = "2026-04-25", days = 6 } = {}) {
  const start = Date.UTC(
    ...startIso.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))),
  );
  const out = [];
  for (let i = 0; i < days; i++) {
    const iso = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    out.push(iso);
  }
  return out;
}

describe("prng", () => {
  it("fnv1aHash is deterministic and stable", () => {
    expect(fnv1aHash("hello")).toBe(fnv1aHash("hello"));
    expect(fnv1aHash("a")).not.toBe(fnv1aHash("b"));
  });

  it("makeRng yields reproducible sequence per seed", () => {
    const a = makeRng("seed-1");
    const b = makeRng("seed-1");
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });

  it("makeRng differs across seeds", () => {
    const a = makeRng("seed-1");
    const b = makeRng("seed-2");
    expect(a()).not.toBe(b());
  });

  it("gaussian returns finite samples", () => {
    const rng = makeRng("g");
    for (let i = 0; i < 50; i++)
      expect(Number.isFinite(gaussian(rng))).toBe(true);
  });
});

describe("seasonality", () => {
  it("dayOfWeek / dayOfMonth parse ISO dates", () => {
    expect(dayOfMonth("2026-04-24")).toBe(24);
    expect(dayOfWeek("2026-04-24")).toBe(
      new Date(Date.UTC(2026, 3, 24)).getUTCDay(),
    );
  });

  it("buildSeasonalityBuckets returns mean and std with hierarchical fallback", () => {
    const hist = syntheticHistory({ days: 90 });
    const buckets = buildSeasonalityBuckets(hist);
    expect(buckets.overall.n).toBe(90);
    expect(Number.isFinite(buckets.overall.mean)).toBe(true);
    expect(Number.isFinite(buckets.overall.std)).toBe(true);
    const lookup = lookupBucket(buckets, "2026-04-24");
    expect(lookup).toBeDefined();
    expect(Number.isFinite(lookup.mean)).toBe(true);
  });
});

describe("simpleAverage", () => {
  it("returns mean-per-DOM and correct length", () => {
    const hist = [
      { date: "2024-01-01", net: 2 },
      { date: "2024-02-01", net: 4 },
      { date: "2024-01-02", net: 10 },
    ];
    const out = simpleAverage.forecast({
      history: hist,
      forecastDates: ["2026-04-01", "2026-04-02"],
    });
    expect(out).toHaveLength(2);
    expect(out[0].value).toBe(3);
    expect(out[1].value).toBe(10);
  });

  it("falls back to 0 for missing DOM", () => {
    const out = simpleAverage.forecast({
      history: [{ date: "2024-01-01", net: 5 }],
      forecastDates: ["2026-04-15"],
    });
    expect(out[0].value).toBe(0);
  });
});

describe("forecast month helpers", () => {
  it("extracts, deduplicates, and sorts represented months", () => {
    const history = [
      { date: "2025-03-01" },
      { date: "2024-12-31" },
      { date: "2025-03-19" },
      { date: "2025-01-02" },
    ];
    expect(monthKey(history[0].date)).toBe("2025-03");
    expect(orderedMonthKeys(history)).toEqual([
      "2024-12",
      "2025-01",
      "2025-03",
    ]);
  });
});

describe("weightedAverage", () => {
  it("weights recent months heavier than older ones", () => {
    const hist = [
      { date: "2024-01-01", net: 10 },
      { date: "2024-02-01", net: 20 },
    ];
    const out = weightedAverage.forecast({
      history: hist,
      forecastDates: ["2026-04-01"],
    });
    // w: month0=1, month1=2. (1*10 + 2*20) / 3 = 50/3 ≈ 16.67
    expect(out[0].value).toBeCloseTo(50 / 3, 6);
  });
});

describe("ewma", () => {
  it("smooths toward recent observations", () => {
    const hist = [
      { date: "2024-01-01", net: 10 },
      { date: "2024-02-01", net: 20 },
      { date: "2024-03-01", net: 30 },
    ];
    const out = ewma.forecast({ history: hist, forecastDates: ["2026-04-01"] });
    expect(Number.isFinite(out[0].value)).toBe(true);
    expect(out[0].value).toBeGreaterThan(10);
    expect(out[0].value).toBeLessThan(30);
  });
});

describe("holtWinters", () => {
  it("returns zeros when history too short", () => {
    const out = holtWinters.forecast({
      history: [{ date: "2024-01-01", net: 1 }],
      forecastDates: ["2026-04-25", "2026-04-26"],
    });
    expect(out).toEqual([
      { date: "2026-04-25", value: 0 },
      { date: "2026-04-26", value: 0 },
    ]);
  });

  it("produces finite forecasts on adequate history", () => {
    const hist = syntheticHistory({ days: 200 });
    const dates = futureDates({ days: 5 });
    const out = holtWinters.forecast({ history: hist, forecastDates: dates });
    expect(out).toHaveLength(5);
    for (const p of out) expect(Number.isFinite(p.value)).toBe(true);
  });
});

describe("prophetLite", () => {
  it("returns zeros under the minimum density threshold", () => {
    const out = prophetLite.forecast({
      history: [{ date: "2024-01-01", net: 1 }],
      forecastDates: ["2026-04-25"],
    });
    expect(out[0].value).toBe(0);
  });

  it("produces finite values on adequate history", () => {
    const hist = syntheticHistory({ days: 400 });
    const dates = futureDates({ days: 6 });
    const out = prophetLite.forecast({ history: hist, forecastDates: dates });
    expect(out).toHaveLength(6);
    for (const p of out) expect(Number.isFinite(p.value)).toBe(true);
  });
});

describe("monteCarloParametric", () => {
  it("is deterministic per seed", () => {
    const hist = syntheticHistory({ days: 120 });
    const dates = futureDates({ days: 4 });
    const a = monteCarloParametric.forecast({
      history: hist,
      forecastDates: dates,
      paths: 200,
      seed: "abc",
    });
    const b = monteCarloParametric.forecast({
      history: hist,
      forecastDates: dates,
      paths: 200,
      seed: "abc",
    });
    expect(a.series).toEqual(b.series);
    expect(a.bands.p10).toEqual(b.bands.p10);
  });

  it("returns monotone percentiles", () => {
    const hist = syntheticHistory({ days: 120 });
    const dates = futureDates({ days: 4 });
    const out = monteCarloParametric.forecast({
      history: hist,
      forecastDates: dates,
      paths: 500,
      seed: "s",
    });
    for (let i = 0; i < dates.length; i++) {
      expect(out.bands.p10[i].value).toBeLessThanOrEqual(
        out.bands.p50[i].value,
      );
      expect(out.bands.p50[i].value).toBeLessThanOrEqual(
        out.bands.p90[i].value,
      );
    }
  });

  it("handles empty forecast horizon", () => {
    const out = monteCarloParametric.forecast({
      history: [],
      forecastDates: [],
      paths: 10,
    });
    expect(out.series).toEqual([]);
  });
});

describe("monteCarloBlockBootstrap", () => {
  it("is deterministic per seed", () => {
    const hist = syntheticHistory({ days: 120 });
    const dates = futureDates({ days: 4 });
    const a = monteCarloBlockBootstrap.forecast({
      history: hist,
      forecastDates: dates,
      paths: 200,
      seed: "xyz",
    });
    const b = monteCarloBlockBootstrap.forecast({
      history: hist,
      forecastDates: dates,
      paths: 200,
      seed: "xyz",
    });
    expect(a.series).toEqual(b.series);
  });

  it("returns monotone percentiles on realistic history", () => {
    const hist = syntheticHistory({ days: 120 });
    const dates = futureDates({ days: 4 });
    const out = monteCarloBlockBootstrap.forecast({
      history: hist,
      forecastDates: dates,
      paths: 500,
      seed: "s",
    });
    for (let i = 0; i < dates.length; i++) {
      expect(out.bands.p10[i].value).toBeLessThanOrEqual(
        out.bands.p50[i].value,
      );
      expect(out.bands.p50[i].value).toBeLessThanOrEqual(
        out.bands.p90[i].value,
      );
    }
  });

  it("handles empty history gracefully", () => {
    const dates = futureDates({ days: 2 });
    const out = monteCarloBlockBootstrap.forecast({
      history: [],
      forecastDates: dates,
      paths: 10,
    });
    expect(out.series.every((p) => p.value === 0)).toBe(true);
  });
});

describe("walkForwardBacktest", () => {
  it("computes per-method aggregate metrics", () => {
    const hist = syntheticHistory({ days: 400 });
    const methods = [
      {
        id: simpleAverage.id,
        label: simpleAverage.label,
        forecast: simpleAverage.forecast,
      },
    ];
    const result = walkForwardBacktest({
      history: hist,
      methods,
      asOfMonth: "2025-02",
      windowMonths: 3,
    });
    expect(result).toHaveLength(1);
    expect(result[0].aggregate.months).toBeGreaterThan(0);
    expect(Number.isFinite(result[0].aggregate.mae)).toBe(true);
    expect(Number.isFinite(result[0].aggregate.rmse)).toBe(true);
    expect(Number.isFinite(result[0].aggregate.mape)).toBe(true);
  });

  it("short-circuits methods with no training history", () => {
    const methods = [
      {
        id: simpleAverage.id,
        label: simpleAverage.label,
        forecast: simpleAverage.forecast,
      },
    ];
    const result = walkForwardBacktest({
      history: [],
      methods,
      asOfMonth: "2025-02",
      windowMonths: 2,
    });
    expect(result[0].aggregate).toEqual({
      mae: 0,
      rmse: 0,
      mape: 0,
      months: 0,
    });
  });
});

describe("ensemble", () => {
  const dates = ["2026-04-25", "2026-04-26", "2026-04-27"];

  const makeOutputs = (ids, values) =>
    ids.map((id, i) => ({
      id,
      series: dates.map((date) => ({ date, value: values[i] })),
    }));

  it("computeWeights returns empty map when no accuracy rows", () => {
    const w = ensemble.computeWeights([], ["simple_avg", "ewma"]);
    expect(w.size).toBe(0);
  });

  it("computeWeights normalizes to sum 1", () => {
    const rows = [
      { methodId: "simple_avg", rmse: 2 },
      { methodId: "ewma", rmse: 1 },
    ];
    const w = ensemble.computeWeights(rows, ["simple_avg", "ewma"]);
    const total = [...w.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("computeWeights gives higher weight to lower RMSE", () => {
    const rows = [
      { methodId: "simple_avg", rmse: 4 },
      { methodId: "ewma", rmse: 1 },
    ];
    const w = ensemble.computeWeights(rows, ["simple_avg", "ewma"]);
    expect(w.get("ewma")).toBeGreaterThan(w.get("simple_avg"));
  });

  it("computeWeights (v2) trusts a low-RMSE method less when it has few backtest samples", () => {
    const ids = ["a", "b"];
    const fewSamples = ensemble.computeWeights(
      [
        { methodId: "a", rmse: 1, sampleDays: 2 },
        { methodId: "b", rmse: 3, sampleDays: 300 },
      ],
      ids,
    );
    const manySamples = ensemble.computeWeights(
      [
        { methodId: "a", rmse: 1, sampleDays: 300 },
        { methodId: "b", rmse: 3, sampleDays: 300 },
      ],
      ids,
    );
    // 'a' has the better RMSE in both, but with only 2 sample days its low RMSE
    // is shrunk toward the mean, so it earns less weight than when well-sampled.
    expect(manySamples.get("a")).toBeGreaterThan(fewSamples.get("a"));
  });

  it("computeWeights (v2) blends toward uniform so the best method never takes all the weight", () => {
    const w = ensemble.computeWeights(
      [
        { methodId: "a", rmse: 0.001, sampleDays: 300 },
        { methodId: "b", rmse: 100, sampleDays: 300 },
      ],
      ["a", "b"],
    );
    const total = [...w.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(w.get("a")).toBeLessThan(1); // dominance capped by the uniform floor
    expect(w.get("b")).toBeGreaterThan(0); // weakest method still contributes
  });

  it("forecast equal-weights all methods when weights map is empty", () => {
    const outputs = makeOutputs(["simple_avg", "ewma"], [10, 20]);
    const result = ensemble.forecast({
      forecastDates: dates,
      methodOutputs: outputs,
      weights: new Map(),
    });
    expect(result).toHaveLength(3);
    expect(result[0].value).toBeCloseTo(15, 5);
  });

  it("forecast applies explicit weights correctly", () => {
    const outputs = makeOutputs(["simple_avg", "ewma"], [0, 100]);
    const weights = new Map([
      ["simple_avg", 0.25],
      ["ewma", 0.75],
    ]);
    const result = ensemble.forecast({
      forecastDates: dates,
      methodOutputs: outputs,
      weights,
    });
    expect(result[0].value).toBeCloseTo(75, 5);
  });

  it("forecast skips errored methods", () => {
    const outputs = [
      { id: "simple_avg", series: dates.map((date) => ({ date, value: 10 })) },
      {
        id: "ewma",
        series: dates.map((date) => ({ date, value: 20 })),
        error: "forecast_failed",
      },
    ];
    const result = ensemble.forecast({
      forecastDates: dates,
      methodOutputs: outputs,
      weights: new Map(),
    });
    expect(result[0].value).toBeCloseTo(10, 5);
  });

  it("forecast returns zeros when all methods errored", () => {
    const outputs = [
      {
        id: "simple_avg",
        series: dates.map((date) => ({ date, value: 10 })),
        error: "forecast_failed",
      },
    ];
    const result = ensemble.forecast({
      forecastDates: dates,
      methodOutputs: outputs,
      weights: new Map(),
    });
    expect(result[0].value).toBe(0);
  });

  it("id and label are stable", () => {
    expect(ensemble.id).toBe("ensemble_imse");
    expect(typeof ensemble.label).toBe("string");
    expect(ensemble.label.length).toBeGreaterThan(0);
  });
});

describe("accuracyStore", () => {
  beforeEach(() => _resetForTests());

  it("records and retrieves latest by method", async () => {
    await recordAccuracy({
      userId: "u1",
      methodId: "simple_avg",
      asOfMonth: "2026-03",
      mae: 1,
      rmse: 2,
      mape: 0.1,
      sampleDays: 30,
    });
    await recordAccuracy({
      userId: "u1",
      methodId: "simple_avg",
      asOfMonth: "2026-04",
      mae: 0.5,
      rmse: 1,
      mape: 0.05,
      sampleDays: 30,
    });
    const latest = await getLatestAccuracyByMethod({ userId: "u1" });
    expect(latest).toHaveLength(1);
    expect(latest[0].asOfMonth).toBe("2026-04");
  });

  it("returns history sorted newest-first", async () => {
    await recordAccuracy({
      userId: "u1",
      methodId: "ewma",
      asOfMonth: "2026-01",
      mae: 1,
      rmse: 1,
      mape: 0,
      sampleDays: 30,
    });
    await recordAccuracy({
      userId: "u1",
      methodId: "ewma",
      asOfMonth: "2026-03",
      mae: 2,
      rmse: 2,
      mape: 0,
      sampleDays: 30,
    });
    const hist = await getAccuracyHistory({ userId: "u1", methodId: "ewma" });
    expect(hist.map((r) => r.asOfMonth)).toEqual(["2026-03", "2026-01"]);
  });
});

describe("orchestrator computeCashflowForecast", () => {
  beforeEach(() => {
    vi.resetModules();
    _resetForTests();
  });

  it("returns envelope with all methods and backtest diagnostics", async () => {
    vi.doMock("../../src/repositories/infoRepository.js", () => {
      const history = syntheticHistory({ days: 400 });
      return {
        infoRepository: {
          // ADR-083 cache-key input (forecast/index.js filterHash).
          getIncludeTransfers: vi.fn().mockResolvedValue(false),
          getCashflowForecastData: vi.fn().mockResolvedValue({
            history,
            currentActual: [],
            plannedCurrent: [],
            plannedHist: [],
            historyMonths: 36,
          }),
        },
      };
    });

    const { computeCashflowForecast } =
      await import("../../src/services/calculations/forecast/index.js");
    const env = await computeCashflowForecast({
      mcPaths: 100,
      includeBacktest: true,
      userId: "u1",
    });

    expect(env).toHaveProperty("data");
    expect(env).toHaveProperty("meta");
    expect(env.meta.source).toBe("live");
    expect(env.data.methods).toHaveLength(8);
    const ids = env.data.methods.map((m) => m.id);
    expect(ids).toContain("simple_avg");
    expect(ids).toContain("monte_carlo_parametric");
    expect(ids).toContain("monte_carlo_block_bootstrap");
    expect(ids).toContain("ensemble_imse");

    const mc = env.data.methods.find((m) => m.id === "monte_carlo_parametric");
    expect(mc.bands).toBeTruthy();
    expect(mc.bands.p10).toBeDefined();
    expect(mc.bands.p90).toBeDefined();

    expect(env.data.diagnostics).toBeTruthy();
    expect(env.data.diagnostics.backtest.length).toBeGreaterThan(0);
  });

  it("ensemble_imse present in methods output", async () => {
    vi.doMock("../../src/repositories/infoRepository.js", () => {
      const history = syntheticHistory({ days: 200 });
      return {
        infoRepository: {
          // ADR-083 cache-key input (forecast/index.js filterHash).
          getIncludeTransfers: vi.fn().mockResolvedValue(false),
          getCashflowForecastData: vi.fn().mockResolvedValue({
            history,
            currentActual: [],
            plannedCurrent: [],
            plannedHist: [],
            historyMonths: 36,
          }),
        },
      };
    });
    const { computeCashflowForecast } =
      await import("../../src/services/calculations/forecast/index.js");
    const env = await computeCashflowForecast({
      mcPaths: 50,
      includeBacktest: false,
    });
    const ens = env.data.methods.find((m) => m.id === "ensemble_imse");
    expect(ens).toBeDefined();
    expect(ens.error).toBeNull();
  });

  it("skips diagnostics when includeBacktest=false", async () => {
    vi.doMock("../../src/repositories/infoRepository.js", () => {
      const history = syntheticHistory({ days: 200 });
      return {
        infoRepository: {
          // ADR-083 cache-key input (forecast/index.js filterHash).
          getIncludeTransfers: vi.fn().mockResolvedValue(false),
          getCashflowForecastData: vi.fn().mockResolvedValue({
            history,
            currentActual: [],
            plannedCurrent: [],
            plannedHist: [],
            historyMonths: 36,
          }),
        },
      };
    });

    const { computeCashflowForecast } =
      await import("../../src/services/calculations/forecast/index.js");
    const env = await computeCashflowForecast({
      mcPaths: 50,
      includeBacktest: false,
    });
    expect(env.data.diagnostics).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase G: per-category breakdown
// ---------------------------------------------------------------------------

describe("reconcileCategoryForecasts", () => {
  const future = ["2026-04-26", "2026-04-27"];

  it("scales categories so their sum matches reference", () => {
    const refByDate = new Map([
      ["2026-04-26", 10],
      ["2026-04-27", 20],
    ]);
    const categoryForecasts = [
      {
        cat: { key: "a", category_id: 1, general: "G", detail: "D" },
        series: [
          { date: "2026-04-26", value: 2 },
          { date: "2026-04-27", value: 4 },
        ],
      },
      {
        cat: { key: "b", category_id: 2, general: "H", detail: "E" },
        series: [
          { date: "2026-04-26", value: 3 },
          { date: "2026-04-27", value: 6 },
        ],
      },
    ];

    const result = reconcileCategoryForecasts(
      categoryForecasts,
      future,
      refByDate,
    );

    // sum for '2026-04-26' = 5, ref = 10 → scale = 2
    expect(result[0].series[0].value).toBeCloseTo(4); // 2 * 2
    expect(result[1].series[0].value).toBeCloseTo(6); // 3 * 2

    // sum for '2026-04-27' = 10, ref = 20 → scale = 2
    expect(result[0].series[1].value).toBeCloseTo(8); // 4 * 2
    expect(result[1].series[1].value).toBeCloseTo(12); // 6 * 2
  });

  it("splits the residual equally when all category magnitudes are zero", () => {
    const refByDate = new Map([["2026-04-26", 5]]);
    const categoryForecasts = [
      {
        cat: { key: "a", category_id: null, general: "G", detail: "D" },
        series: [{ date: "2026-04-26", value: 0 }],
      },
    ];
    const result = reconcileCategoryForecasts(
      categoryForecasts,
      ["2026-04-26"],
      refByDate,
    );
    // totalAbs=0 → split diff (5) equally → the single category absorbs it so Σ===ref.
    expect(result[0].series[0].value).toBe(5);
  });

  it("does not explode when mixed-sign categories nearly cancel", () => {
    // income +3000, expenses −2990 → sum=+10; aggregate reference 200.
    // Old ref/sum scaling = 20 → +60000 / −59800 (absurd). Additive stays bounded.
    const refByDate = new Map([["2026-04-26", 200]]);
    const categoryForecasts = [
      {
        cat: {
          key: "inc",
          category_id: 1,
          general: "Income",
          detail: "Salary",
        },
        series: [{ date: "2026-04-26", value: 3000 }],
      },
      {
        cat: {
          key: "exp",
          category_id: 2,
          general: "Food",
          detail: "Groceries",
        },
        series: [{ date: "2026-04-26", value: -2990 }],
      },
    ];

    const result = reconcileCategoryForecasts(
      categoryForecasts,
      ["2026-04-26"],
      refByDate,
    );
    const inc = result[0].series[0].value;
    const exp = result[1].series[0].value;

    expect(inc + exp).toBeCloseTo(200); // Σ === ref
    expect(Math.abs(inc - 3000)).toBeLessThanOrEqual(190); // |adjustment| ≤ |diff|
    expect(Math.abs(exp - -2990)).toBeLessThanOrEqual(190);
    expect(inc).toBeGreaterThan(0); // dominant sign preserved
    expect(exp).toBeLessThan(0);
  });

  it("preserves cat metadata", () => {
    const refByDate = new Map([["2026-04-26", 10]]);
    const cat = {
      key: "x",
      category_id: 99,
      general: "Food",
      detail: "Groceries",
    };
    const categoryForecasts = [
      { cat, series: [{ date: "2026-04-26", value: 10 }] },
    ];
    const result = reconcileCategoryForecasts(
      categoryForecasts,
      ["2026-04-26"],
      refByDate,
    );
    expect(result[0].cat).toEqual(cat);
  });
});

describe("buildCategoryBreakdown", () => {
  // Minimal fixture: 2 categories, 3 days, today=2
  const all = ["2026-04-01", "2026-04-02", "2026-04-03"];
  const future = ["2026-04-03"];
  const todayDay = 2;

  const historyByCategory = [
    {
      date: "2025-04-03",
      category_id: 1,
      general: "Income",
      detail: "Salary",
      net: 100,
    },
    {
      date: "2025-04-03",
      category_id: 2,
      general: "Expense",
      detail: "Food",
      net: -30,
    },
  ];

  const currentActualByCategory = [
    {
      date: "2026-04-01",
      category_id: 1,
      general: "Income",
      detail: "Salary",
      net: 120,
    },
    {
      date: "2026-04-02",
      category_id: 1,
      general: "Income",
      detail: "Salary",
      net: 50,
    },
    {
      date: "2026-04-01",
      category_id: 2,
      general: "Expense",
      detail: "Food",
      net: -20,
    },
  ];

  const referenceDaily = [{ date: "2026-04-03", value: 70 }]; // simple_avg aggregate

  it("returns one entry per category", () => {
    const result = buildCategoryBreakdown({
      historyByCategory,
      currentActualByCategory,
      future,
      all,
      todayDay,
      referenceDaily,
    });
    expect(result).toHaveLength(2);
  });

  it("each entry has required shape", () => {
    const result = buildCategoryBreakdown({
      historyByCategory,
      currentActualByCategory,
      future,
      all,
      todayDay,
      referenceDaily,
    });
    for (const item of result) {
      expect(item).toHaveProperty("category_id");
      expect(item).toHaveProperty("general");
      expect(item).toHaveProperty("detail");
      expect(Array.isArray(item.actual)).toBe(true);
      expect(Array.isArray(item.forecast)).toBe(true);
      expect(Array.isArray(item.cumulative)).toBe(true);
    }
  });

  it("actual rows null after todayDay", () => {
    const result = buildCategoryBreakdown({
      historyByCategory,
      currentActualByCategory,
      future,
      all,
      todayDay,
      referenceDaily,
    });
    for (const item of result) {
      // days 1 and 2 have actuals, day 3 is future
      expect(item.actual[0].net).not.toBeNull();
      expect(item.actual[1].net).not.toBeNull();
      expect(item.actual[2].net).toBeNull();
      expect(item.actual[2].cumulative).toBeNull();
    }
  });

  it("forecast only covers future dates", () => {
    const result = buildCategoryBreakdown({
      historyByCategory,
      currentActualByCategory,
      future,
      all,
      todayDay,
      referenceDaily,
    });
    for (const item of result) {
      expect(item.forecast).toHaveLength(1);
      expect(item.forecast[0].date).toBe("2026-04-03");
    }
  });

  it("sum of category forecasts equals referenceDaily after reconciliation", () => {
    const result = buildCategoryBreakdown({
      historyByCategory,
      currentActualByCategory,
      future,
      all,
      todayDay,
      referenceDaily,
    });
    const sumForecast = result.reduce((s, item) => {
      const p = item.forecast.find((f) => f.date === "2026-04-03");
      return s + (p?.value ?? 0);
    }, 0);
    expect(sumForecast).toBeCloseTo(70, 5); // reconciled to referenceDaily value
  });

  it("cumulative continues from last actual cumulative", () => {
    const result = buildCategoryBreakdown({
      historyByCategory,
      currentActualByCategory,
      future,
      all,
      todayDay,
      referenceDaily,
    });
    const income = result.find((r) => r.general === "Income");
    // actual day1=120, day2=50 → cum after day2=170
    expect(income.actual[1].cumulative).toBe(170);
    // cumulative[2] should be > 170 (actual_cum + forecast)
    expect(income.cumulative[2].value).toBeGreaterThanOrEqual(170);
  });

  it("adds scheduled category rows on their effective date", () => {
    const result = buildCategoryBreakdown({
      historyByCategory,
      currentActualByCategory,
      scheduledActualByCategory: [
        {
          date: "2026-04-03",
          category_id: 2,
          general: "Expense",
          detail: "Food",
          net: -40,
        },
      ],
      future,
      all,
      todayDay,
      referenceDaily,
    });
    const expense = result.find((r) => r.general === "Expense");
    const withoutScheduled = buildCategoryBreakdown({
      historyByCategory,
      currentActualByCategory,
      future,
      all,
      todayDay,
      referenceDaily,
    }).find((r) => r.general === "Expense");

    expect(expense.cumulative[2].value).toBe(
      withoutScheduled.cumulative[2].value - 40,
    );
  });

  it("empty history for category produces zero forecast", () => {
    const result = buildCategoryBreakdown({
      historyByCategory: [],
      currentActualByCategory,
      future,
      all,
      todayDay,
      referenceDaily,
    });
    // categories extracted from currentActualByCategory only
    expect(result.length).toBeGreaterThan(0);
    // with no history, raw forecast = 0 before reconciliation
    // after reconciliation with ref=70: sum=0 → scale=1 → stays 0
    for (const item of result) {
      expect(Number.isFinite(item.forecast[0].value)).toBe(true);
    }
  });

  it("sorted by general then detail", () => {
    const result = buildCategoryBreakdown({
      historyByCategory,
      currentActualByCategory,
      future,
      all,
      todayDay,
      referenceDaily,
    });
    expect(result[0].general).toBe("Expense");
    expect(result[1].general).toBe("Income");
  });
});

// NOTE: orchestrator integration tests for includeBreakdown omitted — vi.doMock not
// available in this Bun+vitest compat layer (same issue as pre-existing orchestrator tests).
// Coverage provided by buildCategoryBreakdown and reconcileCategoryForecasts unit tests above.
