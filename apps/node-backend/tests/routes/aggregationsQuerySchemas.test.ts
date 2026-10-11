/**
 * ADR-193 pins for the aggregation routers' zod query schemas: the inputs that
 * reject with a 400 VALIDATION_ERROR, and the lenient knobs that keep falling
 * back to their defaults (the schemas reuse the pre-zod accept sets).
 *
 * Runs against the REAL router on a throwaway Express app; only the calc
 * modules are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgent } from "../helpers/routeApp.ts";

type CalcSpy = (
  options: Record<string, unknown>,
) => Promise<{ data: object; meta: object }>;
const envelope: CalcSpy = async () => ({ data: {}, meta: {} });

const categoryBreakdownSpy = vi.fn(envelope);
const sankeySpy = vi.fn(envelope);
const forecastSpy = vi.fn(envelope);
const forecastMethodsSpy = vi.fn(envelope);
const monthlySpy = vi.fn(envelope);
const bankBalancesSpy = vi.fn(envelope);

vi.mock("../../src/services/calculations/aggregation/category.ts", () => ({
  computeCategoryBreakdown: (o: Record<string, unknown>) =>
    categoryBreakdownSpy(o),
}));
vi.mock("../../src/services/calculations/aggregation/sankey.ts", () => ({
  computeSankeyFlow: (o: Record<string, unknown>) => sankeySpy(o),
}));
vi.mock(
  "../../src/services/calculations/aggregation/cashflowForecast.ts",
  () => ({
    computeCashflowForecast: (o: Record<string, unknown>) => forecastSpy(o),
  }),
);
vi.mock("../../src/services/calculations/forecast/index.ts", () => ({
  computeCashflowForecast: (o: Record<string, unknown>) =>
    forecastMethodsSpy(o),
  computeCashflowForecastRolling: vi.fn(envelope),
}));
vi.mock("../../src/services/calculations/aggregation/monthly.ts", () => ({
  computeMonthlySummary: (o: Record<string, unknown>) => monthlySpy(o),
}));
vi.mock("../../src/services/calculations/aggregation/bankBalances.ts", () => ({
  computeBankBalances: (o: Record<string, unknown>) => bankBalancesSpy(o),
}));

const { default: aggregationsRouter } =
  await import("../../src/routes/aggregations.ts");

const api = routeAgent(aggregationsRouter, {
  mountPath: "/api/aggregations",
});
const get = (path: string) => api.get(`/api/aggregations${path}`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("aggregation query schemas — rejected inputs", () => {
  it.each(["12abc", "0", "1e3", ""])(
    "category-breakdown rejects ancestor_category_id=%s",
    async (raw) => {
      const res = await get(
        `/category-breakdown?ancestor_category_id=${raw}`,
      ).expect(400);
      expect(res.body.error).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "ancestor_category_id: must be a positive integer",
      });
      expect(categoryBreakdownSpy).not.toHaveBeenCalled();
    },
  );

  it("sankey rejects a repeated year", async () => {
    const res = await get("/sankey?year=2024&year=2025").expect(400);
    expect(res.body.error.message).toBe("year: must be a single value");
    expect(sankeySpy).not.toHaveBeenCalled();
  });

  it("monthly-summary reports a malformed date with its pinned message", async () => {
    const res = await get("/monthly-summary?start_date=2025-1-1").expect(400);
    expect(res.body.error.message).toBe(
      "start_date must be in YYYY-MM-DD format",
    );
    expect(monthlySpy).not.toHaveBeenCalled();
  });

  it("joins independent failures into one 400", async () => {
    const res = await get(
      "/monthly-summary?start_date=2025-02-01&end_date=2025-01-01&excluded_recipient_ids=x",
    ).expect(400);
    expect(res.body.error.message).toBe(
      "start_date must not be after end_date; excluded_recipient_ids contains invalid value: x",
    );
  });
});

describe("aggregation query schemas — lenient knobs keep their defaults", () => {
  it("forwards the parsed category-breakdown filter and currency", async () => {
    await get(
      "/category-breakdown?ancestor_category_id=007&currency=usd",
    ).expect(200);
    expect(categoryBreakdownSpy).toHaveBeenCalledWith({
      targetCurrency: "USD",
      ancestorCategoryId: 7,
    });
  });

  it("falls back on an unparseable months / currency / sankey year", async () => {
    await get("/cashflow-forecast?months=abc").expect(200);
    expect(forecastSpy).toHaveBeenCalledWith({ months: 3 });

    await get("/bank-balances?target_currency=euro").expect(200);
    expect(bankBalancesSpy).toHaveBeenCalledWith({ targetCurrency: "EUR" });

    await get("/sankey?year=1999").expect(200);
    expect(sankeySpy.mock.calls[0]![0]).toMatchObject({ year: undefined });
  });

  it("clamps the forecast-method knobs and applies flag defaults", async () => {
    await get(
      "/cashflow-forecast-methods?mc_paths=99999&history_months=0&include_backtest=nope",
    ).expect(200);
    expect(forecastMethodsSpy.mock.calls[0]![0]).toMatchObject({
      mcPaths: 5000,
      historyMonths: 36,
      includeBacktest: true,
      includePlanned: false,
      includeBreakdown: false,
      mcPercentiles: [10, 50, 90],
    });
  });

  it("all_time drops the date range", async () => {
    await get(
      "/monthly-summary?all_time=1&start_date=2025-01-01&end_date=2025-02-01",
    ).expect(200);
    expect(monthlySpy.mock.calls[0]![0]).toMatchObject({
      allTime: true,
      startDate: undefined,
      endDate: undefined,
    });
  });
});
