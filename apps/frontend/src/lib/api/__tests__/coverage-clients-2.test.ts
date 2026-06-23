// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";

import {
  getRecipients,
  getRecipient,
  createRecipient,
  updateRecipient,
  deleteRecipient,
  mergeRecipients,
  unmergeRecipient,
  getRecipientAliases,
  listRecipientPatterns,
  createRecipientPattern,
  updateRecipientPattern,
  deleteRecipientPattern,
  previewRecipientPattern,
  getRecipientClusters,
} from "@/lib/api/recipients";
import {
  getTransactions,
  getTransaction,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  bulkDeleteTransactions,
  bulkUpdateTransactions,
} from "@/lib/api/transactions";
import {
  getInvestments,
  getInvestment,
  createInvestment,
  refreshInvestmentPrices,
  getPriceProviders,
  updateInvestment,
  deleteInvestment,
  moveHolding,
  getInvestmentPriceHistory,
  getPortfolioTransactions,
  getPortfolioTransactionsBulk,
  createPortfolioTransaction,
  updatePortfolioTransaction,
} from "@/lib/api/portfolio";
import {
  listCustomParserConfigs,
  createCustomParserConfig,
  updateCustomParserConfig,
  deleteCustomParserConfig,
  listImportBatches,
  getImportBatch,
  rollbackImportBatch,
  getImportPreview,
  overrideImportRow,
  overrideImportRowCategory,
  commitImportBatch,
} from "@/lib/api/imports";

const API_BASE = "http://localhost:3002";

function ok<T>(data: T, init?: ResponseInit) {
  return HttpResponse.json({ ok: true, data }, init);
}

afterEach(() => server.resetHandlers());

// ---------------------------------------------------------------------------
// recipients
// ---------------------------------------------------------------------------

describe("recipients API client", () => {
  it("getRecipients forwards search/sort params", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/recipients`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );
    await getRecipients({ search: "acme", sort_by: "name", sort_dir: "desc", uncategorized: true });
    expect(url).toContain("search=acme");
    expect(url).toContain("sort_by=name");
    expect(url).toContain("sort_dir=desc");
    expect(url).toContain("uncategorized=true");
  });

  it("getRecipient fetches by id", async () => {
    server.use(http.get(`${API_BASE}/api/recipients/3`, () => ok({ id: 3, name: "Acme" })));
    expect((await getRecipient(3)).name).toBe("Acme");
  });

  it("createRecipient reports wasCreated=true on 201", async () => {
    server.use(
      http.post(`${API_BASE}/api/recipients`, () => ok({ id: 9, name: "New" }, { status: 201 })),
    );
    const res = await createRecipient({ name: "New" } as never);
    expect(res.recipient.id).toBe(9);
    expect(res.wasCreated).toBe(true);
  });

  it("createRecipient reports wasCreated=false on 200 (existing)", async () => {
    server.use(
      http.post(`${API_BASE}/api/recipients`, () => ok({ id: 9, name: "Existing" }, { status: 200 })),
    );
    const res = await createRecipient({ name: "Existing" } as never);
    expect(res.wasCreated).toBe(false);
  });

  it("updateRecipient PATCHes", async () => {
    server.use(http.patch(`${API_BASE}/api/recipients/9`, () => ok({ id: 9, name: "E" })));
    expect((await updateRecipient(9, {} as never)).name).toBe("E");
  });

  it("deleteRecipient resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/recipients/9`, () => ok(null)));
    await expect(deleteRecipient(9)).resolves.toBeUndefined();
  });

  it("mergeRecipients posts alias_ids", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/recipients/1/merge`, async ({ request }) => {
        body = await request.json();
        return ok({ primary: { id: 1 }, merged_ids: [2, 3], aliases: [], patternSuggestion: null });
      }),
    );
    const res = await mergeRecipients(1, [2, 3]);
    expect(body).toMatchObject({ alias_ids: [2, 3] });
    expect(res.merged_ids).toEqual([2, 3]);
  });

  it("unmergeRecipient POSTs to the unmerge route", async () => {
    server.use(http.post(`${API_BASE}/api/recipients/5/unmerge`, () => ok({ id: 5 })));
    expect((await unmergeRecipient(5)).id).toBe(5);
  });

  it("getRecipientAliases fetches alias list", async () => {
    server.use(http.get(`${API_BASE}/api/recipients/5/aliases`, () => ok({ items: [], total: 0 })));
    expect((await getRecipientAliases(5)).total).toBe(0);
  });

  it("listRecipientPatterns fetches patterns", async () => {
    server.use(http.get(`${API_BASE}/api/recipients/5/patterns`, () => ok({ items: [], total: 0 })));
    expect((await listRecipientPatterns(5)).items).toEqual([]);
  });

  it("createRecipientPattern posts the pattern body", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/recipients/5/patterns`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 77 });
      }),
    );
    const res = await createRecipientPattern(5, { pattern: "ACME*", pattern_kind: "glob" });
    expect(body).toMatchObject({ pattern: "ACME*", pattern_kind: "glob" });
    expect(res.id).toBe(77);
  });

  it("updateRecipientPattern PATCHes by pattern id", async () => {
    server.use(
      http.patch(`${API_BASE}/api/recipients/5/patterns/77`, () => ok({ patternId: 77 })),
    );
    expect((await updateRecipientPattern(5, 77, { priority: 2 })).patternId).toBe(77);
  });

  it("deleteRecipientPattern DELETEs by pattern id", async () => {
    server.use(
      http.delete(`${API_BASE}/api/recipients/5/patterns/77`, () => ok({ patternId: 77 })),
    );
    expect((await deleteRecipientPattern(5, 77)).patternId).toBe(77);
  });

  it("previewRecipientPattern posts and returns match counts", async () => {
    server.use(
      http.post(`${API_BASE}/api/recipients/5/patterns/preview`, () =>
        ok({ matchCount: 4, recipientIds: [1, 2, 3, 4] }),
      ),
    );
    const res = await previewRecipientPattern(5, { pattern: "X*", pattern_kind: "glob" });
    expect(res.matchCount).toBe(4);
  });

  it("getRecipientClusters forwards min_count", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/recipients/clusters`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );
    await getRecipientClusters({ min_count: 3 });
    expect(url).toContain("min_count=3");
  });
});

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

describe("transactions API client", () => {
  it("getTransactions joins category_ids and backfills transaction_date from date", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/transactions`, ({ request }) => {
        url = request.url;
        return ok({
          items: [
            { id: 1, transaction_date: "2026-01-01" },
            { id: 2, date: "2026-02-02" }, // legacy `date` field, no transaction_date
            { id: 3 }, // neither -> ''
          ],
          total: 3,
        });
      }),
    );

    const res = await getTransactions({ category_ids: [4, 5], search: "x" });

    expect(url).toContain("category_ids=4%2C5"); // "4,5" encoded
    expect(res.items[0].transaction_date).toBe("2026-01-01");
    expect(res.items[1].transaction_date).toBe("2026-02-02");
    expect(res.items[2].transaction_date).toBe("");
  });

  it("getTransaction fetches by id", async () => {
    server.use(http.get(`${API_BASE}/api/transactions/9`, () => ok({ id: 9 })));
    expect((await getTransaction(9)).id).toBe(9);
  });

  it("createTransaction POSTs", async () => {
    server.use(http.post(`${API_BASE}/api/transactions`, () => ok({ id: 10 })));
    expect((await createTransaction({} as never)).id).toBe(10);
  });

  it("updateTransaction PATCHes", async () => {
    server.use(http.patch(`${API_BASE}/api/transactions/10`, () => ok({ id: 10 })));
    expect((await updateTransaction(10, {} as never)).id).toBe(10);
  });

  it("deleteTransaction resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/transactions/10`, () => ok(null)));
    await expect(deleteTransaction(10)).resolves.toBeUndefined();
  });

  it("bulkDeleteTransactions posts the selection", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/transactions/bulk-delete`, async ({ request }) => {
        body = await request.json();
        return ok({ deleted: 2 });
      }),
    );
    const res = await bulkDeleteTransactions({ ids: [1, 2] } as never);
    expect(body).toMatchObject({ ids: [1, 2] });
    expect(res.deleted).toBe(2);
  });

  it("bulkUpdateTransactions posts the update", async () => {
    server.use(
      http.post(`${API_BASE}/api/transactions/bulk-update`, () => ok({ updated: 5 })),
    );
    expect((await bulkUpdateTransactions({ ids: [1], patch: {} } as never)).updated).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// portfolio / investments
// ---------------------------------------------------------------------------

describe("portfolio API client", () => {
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

  it("getInvestment fetches by id", async () => {
    server.use(http.get(`${API_BASE}/api/investments/3`, () => ok({ id: 3 })));
    expect((await getInvestment(3)).id).toBe(3);
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

  it("getPriceProviders lists providers", async () => {
    server.use(
      http.get(`${API_BASE}/api/investments/providers`, () =>
        ok({ providers: [{ key: "yahoo", name: "Yahoo", description: "" }] }),
      ),
    );
    expect((await getPriceProviders()).providers[0].key).toBe("yahoo");
  });

  it("updateInvestment PATCHes", async () => {
    server.use(http.patch(`${API_BASE}/api/investments/4`, () => ok({ id: 4 })));
    expect((await updateInvestment(4, {} as never)).id).toBe(4);
  });

  it("deleteInvestment resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/investments/4`, () => ok(null)));
    await expect(deleteInvestment(4)).resolves.toBeUndefined();
  });

  it("moveHolding POSTs the move body", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/investments/4/move`, async ({ request }) => {
        body = await request.json();
        return ok({
          investmentId: 4,
          from: 1,
          to: 2,
          mode: "whole",
          strategy: "fifo",
          movedUnits: 10,
          lotsMoved: 1,
          lotsSplit: 0,
        });
      }),
    );
    const res = await moveHolding(4, { from_account_id: 1, to_account_id: 2, strategy: "fifo" });
    expect(body).toMatchObject({ from_account_id: 1, to_account_id: 2, strategy: "fifo" });
    expect(res.movedUnits).toBe(10);
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
    server.use(
      http.patch(`${API_BASE}/api/investments/transactions/50`, () => ok({ id: 50 })),
    );
    expect((await updatePortfolioTransaction(50, {})).id).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// imports — parser configs + batch lifecycle
// ---------------------------------------------------------------------------

describe("imports API client", () => {
  it("listCustomParserConfigs fetches configs", async () => {
    server.use(http.get(`${API_BASE}/api/import/parsers`, () => ok([{ id: 1, name: "C" }])));
    expect((await listCustomParserConfigs())[0].name).toBe("C");
  });

  it("createCustomParserConfig posts name + config", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/import/parsers`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 2, name: "Mine" });
      }),
    );
    await createCustomParserConfig("Mine", { foo: "bar" } as never);
    expect(body).toMatchObject({ name: "Mine", config: { foo: "bar" } });
  });

  it("updateCustomParserConfig PATCHes", async () => {
    server.use(http.patch(`${API_BASE}/api/import/parsers/2`, () => ok({ id: 2, name: "R" })));
    expect((await updateCustomParserConfig(2, { name: "R" })).name).toBe("R");
  });

  it("deleteCustomParserConfig DELETEs", async () => {
    server.use(http.delete(`${API_BASE}/api/import/parsers/2`, () => ok(null)));
    await expect(deleteCustomParserConfig(2)).resolves.toBeNull();
  });

  it("listImportBatches passes limit/offset in the query string", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/import/batches`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );
    await listImportBatches(10, 5);
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=5");
  });

  it("getImportBatch fetches by id", async () => {
    server.use(http.get(`${API_BASE}/api/import/batches/7`, () => ok({ id: 7 })));
    expect((await getImportBatch(7)).id).toBe(7);
  });

  it("rollbackImportBatch DELETEs and returns deleted count", async () => {
    server.use(http.delete(`${API_BASE}/api/import/batches/7`, () => ok({ deleted: 3 })));
    expect((await rollbackImportBatch(7)).deleted).toBe(3);
  });

  it("getImportPreview fetches the preview", async () => {
    server.use(http.get(`${API_BASE}/api/import/batches/7/preview`, () => ok({ rows: [] })));
    expect(await getImportPreview(7)).toMatchObject({ rows: [] });
  });

  it("overrideImportRow posts recipient_id", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/import/batches/7/rows/3/override`, async ({ request }) => {
        body = await request.json();
        return ok({ row_id: 3, user_override_recipient_id: 9 });
      }),
    );
    const res = await overrideImportRow(7, 3, 9);
    expect(body).toMatchObject({ recipient_id: 9 });
    expect(res.user_override_recipient_id).toBe(9);
  });

  it("overrideImportRowCategory posts category_id", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/import/batches/7/rows/3/category-override`, async ({ request }) => {
        body = await request.json();
        return ok({ row_id: 3, override_category_id: 12 });
      }),
    );
    const res = await overrideImportRowCategory(7, 3, 12);
    expect(body).toMatchObject({ category_id: 12 });
    expect(res.override_category_id).toBe(12);
  });

  it("commitImportBatch POSTs the commit", async () => {
    server.use(
      http.post(`${API_BASE}/api/import/batches/7/commit`, () =>
        ok({ batch_id: 7, imported: 4, duplicates: 0, errors: 0 }),
      ),
    );
    expect((await commitImportBatch(7)).imported).toBe(4);
  });
});
