// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getWatchlist, createWatchlistItem, updateWatchlistItem, deleteWatchlistItem, searchMarket, getMarketNews, getMarketQuotes, getMarketChart } from "@/lib/api/market";

afterEach(() => server.resetHandlers());

/** A watchlistRepository.mapWatchlistRow row. */
const WATCHLIST_ITEM = {
  id: 1,
  name: "Apple",
  symbol: "AAPL",
  asset_class: "stock",
  target_price: 150,
  added_price: null,
  currency: "USD",
  notes: null,
  price_provider_id: "AAPL",
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

describe("market API client", () => {
  it("getWatchlist fetches the watchlist", async () => {
    server.use(http.get(`${API_BASE}/api/watchlist`, () => ok({ items: [], total: 0, limit: 50, offset: 0 })));
    const res = await getWatchlist();
    expect(res.items).toEqual([]);
  });

  it("createWatchlistItem POSTs the item", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/watchlist`, async ({ request }) => {
        body = await request.json();
        return ok(WATCHLIST_ITEM, { status: 201 });
      }),
    );
    await createWatchlistItem({ symbol: "AAPL" } as never);
    expect(body).toMatchObject({ symbol: "AAPL" });
  });

  it("updateWatchlistItem PATCHes by id", async () => {
    server.use(http.patch(`${API_BASE}/api/watchlist/1`, () => ok(WATCHLIST_ITEM)));
    expect((await updateWatchlistItem(1, {} as never)).id).toBe(1);
  });

  it("deleteWatchlistItem resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/watchlist/1`, () => new HttpResponse(null, { status: 204 })));
    await expect(deleteWatchlistItem(1)).resolves.toBeUndefined();
  });

  it("searchMarket forwards the query", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/market/search`, ({ request }) => {
        url = request.url;
        return ok({ items: [] });
      }),
    );
    await searchMarket("apple");
    expect(url).toContain("apple");
  });

  it("getMarketNews joins symbols and forwards count", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/market/news`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );
    await getMarketNews(["AAPL", "MSFT"], 5);
    expect(url).toContain("symbols=AAPL%2CMSFT");
    expect(url).toContain("count=5");
  });

  it("getMarketNews omits params when symbols/count are absent", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/market/news`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );
    await getMarketNews();
    expect(url).not.toContain("symbols");
    expect(url).not.toContain("count");
  });

  it("getMarketQuotes appends detail=basic only when requested", async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${API_BASE}/api/market/quote`, ({ request }) => {
        urls.push(request.url);
        return ok({ items: [], total: 0 });
      }),
    );
    await getMarketQuotes("AAPL");
    await getMarketQuotes("AAPL", { detail: "basic" });
    expect(urls[0]).not.toContain("detail=basic");
    expect(urls[1]).toContain("detail=basic");
  });

  it("getMarketChart forwards symbol/range/interval", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/market/chart`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );
    await getMarketChart("AAPL", "1mo", "1d");
    expect(url).toContain("symbol=AAPL");
    expect(url).toContain("range=1mo");
    expect(url).toContain("interval=1d");
  });
});
