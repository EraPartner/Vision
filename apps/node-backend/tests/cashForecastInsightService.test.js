import { beforeEach, describe, expect, it, vi } from "vitest";

const projectionRepository = vi.hoisted(() => ({
  getProjection: vi.fn(),
  saveProjection: vi.fn(),
}));

vi.mock("../src/repositories/insightCashProjectionRepository.js", () => ({
  default: projectionRepository,
}));

vi.mock("../src/services/calculations/forecast/index.js", () => ({
  computeCashflowForecast: vi.fn(),
}));

import { computeCashflowForecast } from "../src/services/calculations/forecast/index.js";
import { getCashForecastInsight } from "../src/services/cashForecastInsightService.js";

/** ISO date for day n of the synthetic month. */
const day = (n) => `2026-07-${String(n).padStart(2, "0")}`;

/** Map plain numbers onto [{date, value}] entries starting at day `startDay`. */
const series = (values, startDay = 1) =>
  values.map((v, i) => ({ date: day(startDay + i), value: v }));

/** A forecast method as found in payload.methods. */
const method = (overrides = {}) => ({
  id: "monte_carlo_parametric",
  label: "Monte Carlo (parametric)",
  daily: [],
  cumulative: [],
  bands: null,
  error: null,
  ...overrides,
});

/** The computeCashflowForecast envelope around a synthetic payload. */
const envelope = (payloadOverrides = {}) => ({
  data: {
    month: "2026-07",
    currency: "EUR",
    days_in_month: 6,
    current_day: 3,
    actual: [],
    planned: [],
    diagnostics: null,
    methods: [],
    ...payloadOverrides,
  },
  meta: {},
});

/**
 * A healthy 6-day month, 3 days of actuals: cumulative ends at 600 and the
 * future portion [400, 500, 600] never dips below zero. Bands cover only the
 * 3 future days (daily nets, not cumulative).
 */
const healthyMcMethod = () =>
  method({
    cumulative: series([100, 200, 300, 400, 500, 600]),
    bands: {
      p10: series([-50, -50, -50], 4),
      p50: series([100, 100, 100], 4),
      p90: series([200, 200, 200], 4),
    },
    cumulative_bands: {
      p10: series([250, 200, 150], 4),
      p50: series([400, 500, 600], 4),
      p90: series([500, 700, 900], 4),
    },
  });

describe("getCashForecastInsight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectionRepository.getProjection.mockResolvedValue(undefined);
    projectionRepository.saveProjection.mockResolvedValue(undefined);
  });

  it("compares the persisted same-method projection and stores the new observation", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({ methods: [healthyMcMethod()] }),
    );
    projectionRepository.getProjection.mockResolvedValue(400);

    const finding = await getCashForecastInsight();

    expect(finding.movedSignificantly).toBe(true);
    expect(projectionRepository.getProjection).toHaveBeenCalledWith(
      "2026-07",
      "EUR",
      "monte_carlo_parametric",
    );
    expect(projectionRepository.saveProjection).toHaveBeenCalledWith(
      "2026-07",
      "EUR",
      "monte_carlo_parametric",
      600,
    );
  });

  it("returns a standing finding with the full contract for a healthy positive month", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({ methods: [healthyMcMethod()] }),
    );

    const finding = await getCashForecastInsight();

    expect(finding).toEqual({
      month: "2026-07",
      currency: "EUR",
      monthEndNetCashflow: 600,
      monthEndNetCashflowLow: 150,
      monthEndNetCashflowHigh: 900,
      movedSignificantly: false,
      prominence: "standing",
      methodId: "monte_carlo_parametric",
    });
    expect(computeCashflowForecast).toHaveBeenCalledWith({
      includeBreakdown: false,
    });
  });

  it("does not turn a negative future net-flow point into an overdraft alert", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({
        methods: [method({ cumulative: series([100, 50, 20, -30, -10, 40]) })],
      }),
    );

    const finding = await getCashForecastInsight();

    expect(finding.monthEndNetCashflow).toBe(40);
    expect(finding.prominence).toBe("standing");
    expect(finding).not.toHaveProperty("minProjected");
    expect(finding).not.toHaveProperty("crossesZero");
  });

  it("ignores a negative dip in the PAST portion of the cumulative", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({
        // Day 2 was negative, but days >= current_day (index 3) stay positive.
        methods: [method({ cumulative: series([100, -50, 20, 30, 40, 50]) })],
      }),
    );

    const finding = await getCashForecastInsight();

    expect(finding.prominence).toBe("standing");
  });

  it("marks a large move vs. previousMonthEndNetCashflow as alert", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({ methods: [healthyMcMethod()] }),
    );

    // |600 - 100| = 500 >= max(100, 0.15 * 100) = 100
    const finding = await getCashForecastInsight({
      previousMonthEndNetCashflow: 100,
    });

    expect(finding.movedSignificantly).toBe(true);
    expect(finding.prominence).toBe("alert");
  });

  it("keeps a small move standing — both under the absolute floor and under the percent floor", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({ methods: [healthyMcMethod()] }),
    );

    // |600 - 590| = 10 < 100 (absolute floor)
    const smallAbs = await getCashForecastInsight({
      previousMonthEndNetCashflow: 590,
    });
    expect(smallAbs.movedSignificantly).toBe(false);
    expect(smallAbs.prominence).toBe("standing");

    // |600 - 700| = 100 >= 100 but < 0.15 * 700 = 105 (percent floor dominates)
    computeCashflowForecast.mockResolvedValue(
      envelope({ methods: [healthyMcMethod()] }),
    );
    const smallPct = await getCashForecastInsight({
      previousMonthEndNetCashflow: 700,
    });
    expect(smallPct.movedSignificantly).toBe(false);
    expect(smallPct.prominence).toBe("standing");
  });

  it("prefers the first Monte-Carlo method over earlier point methods", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({
        methods: [
          method({
            id: "simple_average",
            cumulative: series([1, 2, 3, 4, 5, 6]),
          }),
          method({
            id: "ensemble_imse",
            cumulative: series([9, 9, 9, 9, 9, 9]),
          }),
          healthyMcMethod(),
        ],
      }),
    );

    const finding = await getCashForecastInsight();

    expect(finding.methodId).toBe("monte_carlo_parametric");
    expect(finding.monthEndNetCashflow).toBe(600);
  });

  it("falls back to the ensemble when every MC method errored, with null bounds", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({
        methods: [
          method({
            id: "simple_average",
            cumulative: series([1, 2, 3, 4, 5, 6]),
          }),
          method({ id: "monte_carlo_parametric", error: "forecast_failed" }),
          method({
            id: "ensemble_imse",
            cumulative: series([10, 20, 30, 40, 50, 60]),
          }),
        ],
      }),
    );

    const finding = await getCashForecastInsight();

    expect(finding.methodId).toBe("ensemble_imse");
    expect(finding.monthEndNetCashflow).toBe(60);
    expect(finding.monthEndNetCashflowLow).toBeNull();
    expect(finding.monthEndNetCashflowHigh).toBeNull();
  });

  it("falls back to the first error-free method when neither MC nor ensemble is usable", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({
        methods: [
          method({ id: "monte_carlo_parametric", error: "forecast_failed" }),
          method({ id: "ensemble_imse", error: "forecast_failed" }),
          method({ id: "ewma", cumulative: series([5, 10, 15, 20, 25, 30]) }),
        ],
      }),
    );

    const finding = await getCashForecastInsight();

    expect(finding.methodId).toBe("ewma");
    expect(finding.monthEndNetCashflow).toBe(30);
  });

  it("returns null when every method has an error", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({
        methods: [
          method({ id: "monte_carlo_parametric", error: "forecast_failed" }),
          method({ id: "ensemble_imse", error: "forecast_failed" }),
        ],
      }),
    );

    expect(await getCashForecastInsight()).toBeNull();
  });

  it("orders p10/p90 folding sanely: monthEndNetCashflowLow <= monthEndNetCashflow <= monthEndNetCashflowHigh", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({
        // No actuals yet: current_day 0, the whole month is future, anchor 0.
        current_day: 0,
        methods: [
          method({
            cumulative: series([
              10.111, 22.222, 30.333, 41.444, 52.555, 60.666,
            ]),
            bands: {
              p10: series([-5, 0, -2, 1, 3, -4]),
              p50: series([10.111, 12.111, 8.111, 11.111, 11.111, 8.111]),
              p90: series([30, 25, 20, 28, 22, 26]),
            },
            cumulative_bands: {
              p10: series([-5, 4, 7, 12, 18, 20]),
              p50: series([10.111, 22.222, 30.333, 41.444, 52.555, 60.666]),
              p90: series([30, 48, 62, 75, 88, 100]),
            },
          }),
        ],
      }),
    );

    const finding = await getCashForecastInsight();

    // Bounds come directly from cumulative simulated-path distributions.
    expect(finding.monthEndNetCashflowLow).toBe(20);
    expect(finding.monthEndNetCashflowHigh).toBe(100);
    expect(finding.monthEndNetCashflow).toBe(60.67);
    expect(finding.monthEndNetCashflowLow).toBeLessThanOrEqual(
      finding.monthEndNetCashflow,
    );
    expect(finding.monthEndNetCashflow).toBeLessThanOrEqual(
      finding.monthEndNetCashflowHigh,
    );
  });

  it("handles an empty future portion (last day of month) without throwing", async () => {
    computeCashflowForecast.mockResolvedValue(
      envelope({
        current_day: 6,
        methods: [
          method({
            cumulative: series([100, 200, 300, 400, 500, 600]),
            bands: { p10: [], p50: [], p90: [] },
            cumulative_bands: { p10: [], p50: [], p90: [] },
          }),
        ],
      }),
    );

    const finding = await getCashForecastInsight();

    // No future days: both bounds equal the final realized net-flow value.
    expect(finding.monthEndNetCashflow).toBe(600);
    expect(finding.monthEndNetCashflowLow).toBe(600);
    expect(finding.monthEndNetCashflowHigh).toBe(600);
    expect(finding.prominence).toBe("standing");
  });

  it("returns null for a missing payload or an empty/absent methods array", async () => {
    computeCashflowForecast.mockResolvedValue({ data: null, meta: {} });
    expect(await getCashForecastInsight()).toBeNull();

    computeCashflowForecast.mockResolvedValue(envelope({ methods: [] }));
    expect(await getCashForecastInsight()).toBeNull();

    computeCashflowForecast.mockResolvedValue(envelope({ methods: undefined }));
    expect(await getCashForecastInsight()).toBeNull();
  });
});
