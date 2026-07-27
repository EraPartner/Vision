// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";

import {
  getSavedCharts,
  createSavedChart,
  updateSavedChart,
  deleteSavedChart,
} from "@/lib/api/charts";
import {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from "@/lib/api/categories";
import {
  getSettings,
  getSetting,
  saveSetting,
} from "@/lib/api/settings";
import {
  getOwedSummary,
  getOwedByRecipient,
  getSplitsByTransaction,
  createSplitsBatch,
  recordSplitPayment,
  settleSplit,
  settleAllSplitsByRecipient,
  deleteSplit,
} from "@/lib/api/splits";
import {
  getWatchlist,
  createWatchlistItem,
  updateWatchlistItem,
  deleteWatchlistItem,
  searchMarket,
  getMarketNews,
  getMarketQuotes,
  getMarketChart,
} from "@/lib/api/market";

const API_BASE = "http://localhost:3002";

function ok<T>(data: T, init?: ResponseInit) {
  return HttpResponse.json({ ok: true, data }, init);
}

afterEach(() => server.resetHandlers());

// ---------------------------------------------------------------------------
// saved charts
// ---------------------------------------------------------------------------

describe("saved charts API client", () => {
  it("getSavedCharts fetches the list", async () => {
    server.use(http.get(`${API_BASE}/api/saved-charts`, () => ok([{ id: 1, name: "C" }])));
    expect((await getSavedCharts())[0].id).toBe(1);
  });

  it("createSavedChart POSTs the payload", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/saved-charts`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 2, name: "New" });
      }),
    );
    await createSavedChart({ name: "New" } as never);
    expect(body).toMatchObject({ name: "New" });
  });

  it("updateSavedChart PATCHes by id", async () => {
    server.use(http.patch(`${API_BASE}/api/saved-charts/2`, () => ok({ id: 2, name: "E" })));
    expect((await updateSavedChart(2, { name: "E" })).name).toBe("E");
  });

  it("deleteSavedChart resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/saved-charts/2`, () => new HttpResponse(null, { status: 204 })));
    await expect(deleteSavedChart(2)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

describe("categories API client", () => {
  it("getCategories forwards filter params", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/categories`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );
    await getCategories({ general: "FOOD", search: "x", active: true });
    expect(url).toContain("general=FOOD");
    expect(url).toContain("search=x");
    expect(url).toContain("active=true");
  });

  it("createCategory reports wasCreated from the 201 status", async () => {
    server.use(
      http.post(`${API_BASE}/api/categories`, () => ok({ id: 9 }, { status: 201 })),
    );
    const res = await createCategory({ general: "FOOD" } as never);
    expect(res.category.id).toBe(9);
    expect(res.wasCreated).toBe(true);
  });

  it("updateCategory PATCHes", async () => {
    server.use(http.patch(`${API_BASE}/api/categories/9`, () => ok({ id: 9 })));
    expect((await updateCategory(9, {} as never)).id).toBe(9);
  });

  it("deleteCategory resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/categories/9`, () => new HttpResponse(null, { status: 204 })));
    await expect(deleteCategory(9)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

describe("settings API client", () => {
  it("getSettings fetches the settings map", async () => {
    server.use(http.get(`${API_BASE}/api/settings`, () => ok({ theme: "dark" })));
    expect((await getSettings()).theme).toBe("dark");
  });

  it("getSetting URL-encodes the key", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/settings/:key`, ({ request }) => {
        url = request.url;
        return ok({ key: "a/b", value: 1 });
      }),
    );
    await getSetting("a/b");
    expect(url).toContain("a%2Fb");
  });

  it("saveSetting PUTs the wrapped value", async () => {
    let body: unknown = null;
    server.use(
      http.put(`${API_BASE}/api/settings/:key`, async ({ request }) => {
        body = await request.json();
        return ok({ key: "theme", value: "light" });
      }),
    );
    await saveSetting("theme", "light");
    expect(body).toMatchObject({ value: "light" });
  });

});

// ---------------------------------------------------------------------------
// splits / owes
// ---------------------------------------------------------------------------

describe("splits API client", () => {
  it("getOwedSummary fetches the owed summary", async () => {
    server.use(http.get(`${API_BASE}/api/splits/owed`, () => ok({ items: [] })));
    expect((await getOwedSummary()).items).toEqual([]);
  });

  it("getOwedByRecipient fetches by recipient id", async () => {
    server.use(http.get(`${API_BASE}/api/splits/owed/4`, () => ok({ items: [{ id: 1 }] })));
    expect((await getOwedByRecipient(4)).items).toHaveLength(1);
  });

  it("getSplitsByTransaction fetches by transaction id", async () => {
    server.use(http.get(`${API_BASE}/api/splits/transaction/8`, () => ok({ items: [] })));
    expect((await getSplitsByTransaction(8)).items).toEqual([]);
  });

  it("createSplitsBatch posts transaction_id + splits", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/splits/batch`, async ({ request }) => {
        body = await request.json();
        return ok({ items: [{ id: 1 }] });
      }),
    );
    await createSplitsBatch(8, [{ recipient_id: 2, amount: 5 }]);
    expect(body).toMatchObject({ transaction_id: 8, splits: [{ recipient_id: 2, amount: 5 }] });
  });

  it("recordSplitPayment posts amount/note/paid_at", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/splits/3/pay`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 1, split_id: 3, amount: 5, paid_at: "2026-06-01", created_at: "" });
      }),
    );
    await recordSplitPayment(3, 5, "note", "2026-06-01");
    expect(body).toMatchObject({ amount: 5, note: "note", paid_at: "2026-06-01" });
  });

  it("settleSplit POSTs to the settle route", async () => {
    server.use(http.post(`${API_BASE}/api/splits/3/settle`, () => ok({ id: 3 })));
    expect((await settleSplit(3)).id).toBe(3);
  });

  it("settleAllSplitsByRecipient POSTs and returns the settled count", async () => {
    server.use(
      http.post(`${API_BASE}/api/splits/owed/4/settle-all`, () => ok({ settled_count: 6 })),
    );
    expect((await settleAllSplitsByRecipient(4)).settled_count).toBe(6);
  });

  it("deleteSplit resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/splits/3`, () => new HttpResponse(null, { status: 204 })));
    await expect(deleteSplit(3)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// market — watchlist + search
// ---------------------------------------------------------------------------

describe("market API client", () => {
  it("getWatchlist fetches the watchlist", async () => {
    server.use(http.get(`${API_BASE}/api/watchlist`, () => ok({ items: [], total: 0 })));
    const res = await getWatchlist();
    expect(res.items).toEqual([]);
  });

  it("createWatchlistItem POSTs the item", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/watchlist`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 1, symbol: "AAPL" });
      }),
    );
    await createWatchlistItem({ symbol: "AAPL" } as never);
    expect(body).toMatchObject({ symbol: "AAPL" });
  });

  it("updateWatchlistItem PATCHes by id", async () => {
    server.use(http.patch(`${API_BASE}/api/watchlist/1`, () => ok({ id: 1 })));
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
        return ok({ articles: [] });
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
        return ok({ articles: [] });
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
        return ok({ quotes: [] });
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
        return ok({ points: [] });
      }),
    );
    await getMarketChart("AAPL", "1mo", "1d");
    expect(url).toContain("symbol=AAPL");
    expect(url).toContain("range=1mo");
    expect(url).toContain("interval=1d");
  });
});
