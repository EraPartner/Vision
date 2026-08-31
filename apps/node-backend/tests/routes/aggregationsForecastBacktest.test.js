/**
 * Regression test for the include_backtest default-drift finding.
 *
 * The two sibling forecast endpoints (cashflow-forecast-methods / -rolling)
 * intentionally default include_backtest differently (methods ON — backtest
 * diagnostics are core to method comparison; rolling OFF — keeps a fast cached
 * path), but they must now parse it through the same shared default-aware helper
 * so the accepted spellings can't diverge per endpoint (methods previously
 * accepted any value via `!== 'false'`, rolling only `=== 'true'`).
 *
 * The router half runs against the REAL router mounted on a throwaway Express
 * app (see tests/helpers/routeApp.js).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeAgent } from "../helpers/routeApp.js";
import { parseBooleanQueryParam } from "../../src/lib/httpParams.js";

describe("parseBooleanQueryParam — default-aware boolean query param", () => {
  it("returns the provided default when the param is absent/empty", () => {
    expect(parseBooleanQueryParam(undefined, true)).toBe(true);
    expect(parseBooleanQueryParam(undefined, false)).toBe(false);
    expect(parseBooleanQueryParam("", true)).toBe(true);
    expect(parseBooleanQueryParam(null, false)).toBe(false);
  });

  it("recognizes the same truthy/falsy spellings regardless of default", () => {
    for (const d of [true, false]) {
      expect(parseBooleanQueryParam("true", d)).toBe(true);
      expect(parseBooleanQueryParam("1", d)).toBe(true);
      expect(parseBooleanQueryParam("TRUE", d)).toBe(true);
      expect(parseBooleanQueryParam("false", d)).toBe(false);
      expect(parseBooleanQueryParam("0", d)).toBe(false);
    }
    expect(parseBooleanQueryParam(true, false)).toBe(true);
    expect(parseBooleanQueryParam(1, false)).toBe(true);
    expect(parseBooleanQueryParam(0, true)).toBe(false);
  });

  it("falls back to the default for unrecognized values", () => {
    expect(parseBooleanQueryParam("yes", true)).toBe(true);
    expect(parseBooleanQueryParam("banana", false)).toBe(false);
  });
});

const methodsSpy = vi.fn(async () => ({ data: {}, meta: {} }));
const rollingSpy = vi.fn(async () => ({ data: {}, meta: {} }));

vi.mock("../../src/services/calculations/forecast/index.js", () => ({
  computeCashflowForecast: (...a) => methodsSpy(...a),
  computeCashflowForecastRolling: (...a) => rollingSpy(...a),
}));

const { default: aggregationsRouter } =
  await import("../../src/routes/aggregations.js");

const api = routeAgent(aggregationsRouter, { mountPath: "/api/aggregations" });

const run = async (path, query = {}) => {
  const qs = new URLSearchParams(query).toString();
  await api.get(`/api/aggregations${path}${qs ? `?${qs}` : ""}`).expect(200);
};

describe("cashflow-forecast endpoints — include_backtest default drift", () => {
  beforeEach(() => {
    methodsSpy.mockClear();
    rollingSpy.mockClear();
  });

  it("methods defaults include_backtest ON when the param is omitted", async () => {
    await run("/cashflow-forecast-methods");
    expect(methodsSpy.mock.calls[0][0].includeBacktest).toBe(true);
  });

  it("rolling defaults include_backtest OFF when the param is omitted", async () => {
    await run("/cashflow-forecast-rolling");
    expect(rollingSpy.mock.calls[0][0].includeBacktest).toBe(false);
  });

  it('both endpoints accept the same spellings (methods "0" → false, rolling "1" → true)', async () => {
    await run("/cashflow-forecast-methods", { include_backtest: "0" });
    expect(methodsSpy.mock.calls[0][0].includeBacktest).toBe(false);

    await run("/cashflow-forecast-rolling", { include_backtest: "1" });
    expect(rollingSpy.mock.calls[0][0].includeBacktest).toBe(true);
  });

  it("explicit override flips each default", async () => {
    await run("/cashflow-forecast-methods", { include_backtest: "false" });
    expect(methodsSpy.mock.calls[0][0].includeBacktest).toBe(false);

    await run("/cashflow-forecast-rolling", { include_backtest: "true" });
    expect(rollingSpy.mock.calls[0][0].includeBacktest).toBe(true);
  });
});
