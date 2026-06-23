// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";

import {
  getAggregationMonthlySummary,
  getAggregationCategoryBreakdown,
  getAggregationRecipientInsights,
  getAggregationCashflowComparison,
  getAggregationAverageVsCurrent,
  getAggregationBankBalances,
  getCashflowForecastMethods,
  getCashflowForecastRolling,
  getCashflowForecastAccuracy,
  getSankeyFlow,
} from "@/lib/api/aggregations";

const API_BASE = "http://localhost:3002";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, meta: {} });
}

/** Capture the request URL for an aggregations sub-path. */
function captureUrl(path: string, ref: { url: string }, data: unknown = {}) {
  server.use(
    http.get(`${API_BASE}${path}`, ({ request }) => {
      ref.url = request.url;
      return ok(data);
    }),
  );
}

afterEach(() => server.resetHandlers());

describe("aggregations — monthly summary branch coverage", () => {
  it("appends every param when all are provided", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/monthly-summary", ref);
    await getAggregationMonthlySummary({
      currency: "EUR",
      all_time: true,
      excluded_category_ids: [1, 2],
      excluded_recipient_ids: [3],
    });
    const p = new URL(ref.url).searchParams;
    expect(p.get("currency")).toBe("EUR");
    expect(p.get("all_time")).toBe("true");
    expect(p.getAll("excluded_category_ids")).toEqual(["1", "2"]);
    expect(p.getAll("excluded_recipient_ids")).toEqual(["3"]);
  });

  it("omits the query string entirely when no params (false-branch side)", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/monthly-summary", ref);
    await getAggregationMonthlySummary();
    expect(ref.url.endsWith("/api/aggregations/monthly-summary")).toBe(true);
  });

  it("skips all_time when false and empty exclusion arrays", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/monthly-summary", ref);
    await getAggregationMonthlySummary({ all_time: false, excluded_category_ids: [], excluded_recipient_ids: [] });
    const p = new URL(ref.url).searchParams;
    expect(p.has("all_time")).toBe(false);
    expect(p.has("excluded_category_ids")).toBe(false);
  });
});

describe("aggregations — simple wrappers", () => {
  it("getAggregationCategoryBreakdown forwards currency", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/category-breakdown", ref, { categories: [] });
    await getAggregationCategoryBreakdown({ currency: "USD" });
    expect(ref.url).toContain("currency=USD");
  });

  it("getAggregationRecipientInsights uses the shared exclusion query", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/recipient-insights", ref, { topMerchants: [], monthOverMonth: [] });
    await getAggregationRecipientInsights({ excluded_category_ids: [9] });
    expect(ref.url).toContain("excluded_category_ids=9");
  });

  it("getAggregationRecipientInsights omits the query with no params", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/recipient-insights", ref, { topMerchants: [], monthOverMonth: [] });
    await getAggregationRecipientInsights();
    expect(ref.url.endsWith("/api/aggregations/recipient-insights")).toBe(true);
  });

  it("getAggregationCashflowComparison uses the shared exclusion query", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/cashflow-comparison", ref, {});
    await getAggregationCashflowComparison({ excluded_recipient_ids: [4], currency: "EUR" });
    expect(ref.url).toContain("excluded_recipient_ids=4");
    expect(ref.url).toContain("currency=EUR");
  });

  it("getAggregationAverageVsCurrent forwards currency", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/average-vs-current", ref, {});
    await getAggregationAverageVsCurrent({ currency: "EUR" });
    expect(ref.url).toContain("currency=EUR");
  });

  it("getAggregationBankBalances forwards currency", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/bank-balances", ref, {
      accounts: [],
      total_net_position: 0,
      history: {},
      total_history: [],
    });
    await getAggregationBankBalances({ currency: "EUR" });
    expect(ref.url).toContain("currency=EUR");
  });
});

describe("aggregations — cashflow forecast branch coverage", () => {
  it("getCashflowForecastMethods sets every param (true-branch side)", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/cashflow-forecast-methods", ref);
    await getCashflowForecastMethods({
      currency: "EUR",
      history_months: 12,
      mc_paths: 500,
      mc_percentiles: [10, 90],
      include_planned: true,
      include_backtest: false,
      excluded_category_ids: [1],
      excluded_recipient_ids: [2],
    });
    const p = new URL(ref.url).searchParams;
    expect(p.get("history_months")).toBe("12");
    expect(p.get("mc_paths")).toBe("500");
    expect(p.getAll("mc_percentiles")).toEqual(["10", "90"]);
    expect(p.get("include_planned")).toBe("true");
    expect(p.get("include_backtest")).toBe("false");
    expect(p.getAll("excluded_category_ids")).toEqual(["1"]);
    expect(p.getAll("excluded_recipient_ids")).toEqual(["2"]);
  });

  it("getCashflowForecastMethods omits everything with no params (false-branch side)", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/cashflow-forecast-methods", ref);
    await getCashflowForecastMethods();
    expect(ref.url.endsWith("/api/aggregations/cashflow-forecast-methods")).toBe(true);
  });

  it("getCashflowForecastRolling sets every param", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/cashflow-forecast-rolling", ref);
    await getCashflowForecastRolling({
      currency: "EUR",
      history_months: 6,
      days_back: 30,
      days_forward: 60,
      mc_paths: 200,
      mc_percentiles: [25, 75],
      include_planned: false,
      include_backtest: true,
      excluded_category_ids: [5],
      excluded_recipient_ids: [6],
    });
    const p = new URL(ref.url).searchParams;
    expect(p.get("days_back")).toBe("30");
    expect(p.get("days_forward")).toBe("60");
    expect(p.get("include_planned")).toBe("false");
    expect(p.get("include_backtest")).toBe("true");
    expect(p.getAll("mc_percentiles")).toEqual(["25", "75"]);
  });

  it("getCashflowForecastRolling omits everything with no params", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/cashflow-forecast-rolling", ref);
    await getCashflowForecastRolling();
    expect(ref.url.endsWith("/api/aggregations/cashflow-forecast-rolling")).toBe(true);
  });

  it("getCashflowForecastAccuracy sets limit_months when provided, omits otherwise", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/cashflow-forecast-accuracy", ref, { methods: [], limit_months: 6 });
    await getCashflowForecastAccuracy({ limit_months: 6 });
    expect(ref.url).toContain("limit_months=6");

    const ref2 = { url: "" };
    captureUrl("/api/aggregations/cashflow-forecast-accuracy", ref2, { methods: [], limit_months: 0 });
    await getCashflowForecastAccuracy();
    expect(ref2.url.endsWith("/api/aggregations/cashflow-forecast-accuracy")).toBe(true);
  });

  it("getSankeyFlow sets year + exclusions when provided", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/sankey", ref, { nodes: [], links: [], year: 2025 });
    await getSankeyFlow({
      currency: "EUR",
      year: 2025,
      excluded_category_ids: [1],
      excluded_recipient_ids: [2],
    });
    const p = new URL(ref.url).searchParams;
    expect(p.get("year")).toBe("2025");
    expect(p.getAll("excluded_category_ids")).toEqual(["1"]);
  });

  it("getSankeyFlow omits everything with no params", async () => {
    const ref = { url: "" };
    captureUrl("/api/aggregations/sankey", ref, { nodes: [], links: [], year: 0 });
    await getSankeyFlow();
    expect(ref.url.endsWith("/api/aggregations/sankey")).toBe(true);
  });
});
