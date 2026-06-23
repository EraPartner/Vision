// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";

import {
  getSupportedParsers,
  getBanks,
  getDistinctBankAccounts,
  getTransactionCount,
  getBelgianInflationRates,
  getRecurringPatterns,
  getPortfolioPerformance,
  getPortfolioSummary,
  getNetWorth,
  getNetWorthByAccount,
  refreshMaterializedViews,
  getExchangeRates,
  refreshExchangeRates,
} from "@/lib/api/info";

const API_BASE = "http://localhost:3002";

function ok<T>(data: T, init?: ResponseInit) {
  return HttpResponse.json({ ok: true, data }, init);
}

afterEach(() => server.resetHandlers());

describe("info API client", () => {
  it("getSupportedParsers fetches the adapter list", async () => {
    server.use(
      http.get(`${API_BASE}/api/info/supported-adapters`, () =>
        ok({ adapters: [{ key: "kbc", name: "KBC" }], total_count: 1 }),
      ),
    );
    const res = await getSupportedParsers();
    expect(res.total_count).toBe(1);
    expect(res.adapters[0].key).toBe("kbc");
  });

  it("getBanks maps adapter keys onto the banks array (deprecated shim)", async () => {
    server.use(
      http.get(`${API_BASE}/api/info/supported-adapters`, () =>
        ok({ adapters: [{ key: "kbc", name: "KBC" }, { key: "ing", name: "ING" }], total_count: 2 }),
      ),
    );
    const res = await getBanks();
    expect(res.banks).toEqual(["kbc", "ing"]);
  });

  it("getDistinctBankAccounts fetches the banks endpoint", async () => {
    server.use(http.get(`${API_BASE}/api/info/banks`, () => ok({ banks: ["acc1"] })));
    expect((await getDistinctBankAccounts()).banks).toEqual(["acc1"]);
  });

  it("getTransactionCount fetches the count", async () => {
    server.use(
      http.get(`${API_BASE}/api/info/transaction-count`, () => ok({ total_transactions: 42 })),
    );
    expect((await getTransactionCount()).total_transactions).toBe(42);
  });

  it("getBelgianInflationRates forwards range + db_only params", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/info/inflation-rates`, ({ request }) => {
        url = request.url;
        return ok({ source: "database", total_rates: 0, rates: [] });
      }),
    );
    await getBelgianInflationRates({ start_month: "2025-01", end_month: "2025-12", db_only: true });
    expect(url).toContain("start_month=2025-01");
    expect(url).toContain("end_month=2025-12");
    expect(url).toContain("db_only=true");
  });

  it("getRecurringPatterns returns the patterns on success", async () => {
    server.use(
      http.get(`${API_BASE}/api/info/recurring-patterns`, () =>
        ok({ patterns: [{ recipientId: 1 }], total: 1 }),
      ),
    );
    const res = await getRecurringPatterns();
    expect(res.total).toBe(1);
  });

  it("getRecurringPatterns fails soft to an empty result on error", async () => {
    server.use(
      http.get(`${API_BASE}/api/info/recurring-patterns`, () =>
        HttpResponse.json({ ok: false, error: { message: "down" } }, { status: 500 }),
      ),
    );
    const res = await getRecurringPatterns();
    expect(res).toEqual({ patterns: [], total: 0 });
  });

  it("getPortfolioPerformance forwards currency + period", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/info/portfolio-performance`, ({ request }) => {
        url = request.url;
        return ok({ currency: "EUR", start_date: "", end_date: "", snapshots: [], metrics: null, heatmap: { years: [], data: {}, maxAbsPct: 0 }, breakdownSummary: [] });
      }),
    );
    await getPortfolioPerformance({ currency: "EUR", period: "1y" });
    expect(url).toContain("currency=EUR");
    expect(url).toContain("period=1y");
  });

  it("getPortfolioSummary fetches the summary", async () => {
    server.use(
      http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
        ok({ currency: "EUR", computed_at: "", totals: {}, summaries: [] }),
      ),
    );
    expect((await getPortfolioSummary({ currency: "EUR" })).currency).toBe("EUR");
  });

  it("getNetWorth forwards pagination params", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/info/net-worth`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );
    await getNetWorth({ currency: "EUR", limit: 10, offset: 5 });
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=5");
  });

  it("getNetWorthByAccount fetches the by-account breakdown", async () => {
    server.use(
      http.get(`${API_BASE}/api/info/net-worth/by-account`, () =>
        ok({ currency: "EUR", accounts: [] }),
      ),
    );
    expect((await getNetWorthByAccount()).currency).toBe("EUR");
  });

  it("refreshMaterializedViews POSTs and returns timing", async () => {
    server.use(
      http.post(`${API_BASE}/api/info/refresh-views`, () =>
        ok({ message: "done", duration_ms: 12 }),
      ),
    );
    expect((await refreshMaterializedViews()).duration_ms).toBe(12);
  });

  it("getExchangeRates appends db_only only when requested", async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${API_BASE}/api/info/exchange-rates`, ({ request }) => {
        urls.push(request.url);
        return ok({ total_rates: 0, rates: [], fallback_rates: {} });
      }),
    );

    await getExchangeRates();
    await getExchangeRates({ dbOnly: true });

    expect(urls[0]).not.toContain("db_only");
    expect(urls[1]).toContain("db_only=true");
  });

  it("refreshExchangeRates POSTs to the refresh route", async () => {
    server.use(
      http.post(`${API_BASE}/api/info/exchange-rates/refresh`, () => ok({ message: "refreshed" })),
    );
    expect((await refreshExchangeRates()).message).toBe("refreshed");
  });
});
