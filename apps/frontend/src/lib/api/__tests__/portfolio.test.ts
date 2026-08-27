// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getInvestments, getSupportedPriceProviders, createInvestment, refreshInvestmentPrices, updateInvestment, deleteInvestment, getInvestmentPriceHistory, getPortfolioTransactions, getPortfolioTransactionsBulk, createPortfolioTransaction, updatePortfolioTransaction } from "@/lib/api/portfolio";

afterEach(() => server.resetHandlers());

describe("portfolio API client", () => {
  it("getSupportedPriceProviders unwraps the backend catalog", async () => {
    server.use(
      http.get(`${API_BASE}/api/investments/providers`, () =>
        ok({
          providers: [
            { key: "manual", name: "Manual", description: "Set price manually" },
            { key: "yahoo", name: "Yahoo Finance", description: "Stocks and ETFs" },
          ],
        }),
      ),
    );

    const providers = await getSupportedPriceProviders();

    expect(providers.map((provider) => provider.key)).toEqual(["manual", "yahoo"]);
  });

  it("getInvestments forwards asset_class + active", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/investments`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );
    await getInvestments({ asset_class: "stock", active: true });
    expect(url).toContain("asset_class=stock");
    expect(url).toContain("active=true");
  });

  it("createInvestment POSTs", async () => {
    server.use(http.post(`${API_BASE}/api/investments`, () => ok({ id: 4 })));
    expect((await createInvestment({} as never)).id).toBe(4);
  });

  it("refreshInvestmentPrices POSTs and returns price map", async () => {
    server.use(
      http.post(`${API_BASE}/api/investments/refresh-prices`, () =>
        ok({ updated: 2, total: 3, prices: { AAPL: 100 }, priceSources: { AAPL: "live" } }),
      ),
    );
    const res = await refreshInvestmentPrices();
    expect(res.updated).toBe(2);
    expect(res.priceSources.AAPL).toBe("live");
  });

  it("updateInvestment PATCHes", async () => {
    server.use(http.patch(`${API_BASE}/api/investments/4`, () => ok({ id: 4 })));
    expect((await updateInvestment(4, {} as never)).id).toBe(4);
  });

  it("deleteInvestment resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/investments/4`, () => new HttpResponse(null, { status: 204 })));
    await expect(deleteInvestment(4)).resolves.toBeUndefined();
  });

  it("getInvestmentPriceHistory forwards range params", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/investments/4/price-history`, ({ request }) => {
        url = request.url;
        return ok({ investment_id: 4, provider: "yahoo", points: [] });
      }),
    );
    await getInvestmentPriceHistory(4, { from_ms: 1000, to_ms: 2000, db_only: true });
    expect(url).toContain("from_ms=1000");
    expect(url).toContain("to_ms=2000");
    expect(url).toContain("db_only=true");
  });

  it("getPortfolioTransactions backfills date from transaction_date", async () => {
    server.use(
      http.get(`${API_BASE}/api/investments/4/transactions`, () =>
        ok({ items: [{ id: 1, transaction_date: "2026-03-03" }], total: 1 }),
      ),
    );
    const res = await getPortfolioTransactions(4);
    expect(res.items[0].date).toBe("2026-03-03");
  });

  it("getPortfolioTransactionsBulk backfills date and forwards investment_ids", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/investments/transactions`, ({ request }) => {
        url = request.url;
        return ok({ items: [{ id: 1 }], total: 1 });
      }),
    );
    const res = await getPortfolioTransactionsBulk({ investment_ids: "1,2" });
    expect(url).toContain("investment_ids=1%2C2");
    expect(res.items[0].date).toBe("");
  });

  it("createPortfolioTransaction POSTs to the investment sub-route", async () => {
    server.use(
      http.post(`${API_BASE}/api/investments/4/transactions`, () => ok({ id: 50 })),
    );
    expect((await createPortfolioTransaction(4, {} as never)).id).toBe(50);
  });

  it("updatePortfolioTransaction PATCHes by txn id", async () => {
    let body: unknown;
    server.use(
      http.patch(`${API_BASE}/api/investments/transactions/50`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 50 });
      }),
    );
    const update = {
      fx_rate_to_eur: null,
      account_id: null,
      note: null,
      recurrence_interval: null,
      recurrence_end_date: null,
    };
    expect((await updatePortfolioTransaction(50, update)).id).toBe(50);
    expect(body).toEqual(update);
  });
});
