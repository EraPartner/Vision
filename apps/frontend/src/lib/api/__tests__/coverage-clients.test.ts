// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";

import {
  getTags,
  createTag,
  updateTag,
  deleteTag,
  bulkTagTransactions,
} from "@/lib/api/tags";
import {
  getAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  mergeAccounts,
  setOpeningBalance,
  reconcileAccount,
} from "@/lib/api/accounts";
import {
  getPlannedTransactions,
  createPlannedTransaction,
  updatePlannedTransaction,
  deletePlannedTransaction,
  executePlannedTransaction,
  getPlannedMatchSuggestions,
} from "@/lib/api/planned";
import {
  listAttachments,
  deleteAttachment,
  getAttachmentDownloadUrl,
} from "@/lib/api/attachments";
import {
  listPortfolioParserConfigs,
  createPortfolioParserConfig,
  updatePortfolioParserConfig,
  deletePortfolioParserConfig,
  getPortfolioImportPreview,
  overridePortfolioImportRow,
  commitPortfolioImportBatch,
  rollbackPortfolioImportBatch,
  type PortfolioCustomConfig,
} from "@/lib/api/portfolioImports";
import {
  getAggregationCategoryPivot,
  getAggregationRecipientByYear,
  getAggregationRecipientPivot,
} from "@/lib/api/aggregations";

const API_BASE = "http://localhost:3002";

/** ADR-026 success envelope. */
function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data });
}

afterEach(() => server.resetHandlers());

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

describe("tags API client", () => {
  it("getTags forwards is_active/limit as query params and unwraps the envelope", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/tags`, ({ request }) => {
        url = request.url;
        return ok({ items: [{ id: 1, slug: "groceries" }], total: 1, limit: 25, offset: 0 });
      }),
    );

    const res = await getTags({ is_active: true, limit: 25 });

    expect(url).toContain("is_active=true");
    expect(url).toContain("limit=25");
    expect(res.items[0].slug).toBe("groceries");
  });

  it("createTag POSTs the body and returns the created tag", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/tags`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 7, slug: "rent" });
      }),
    );

    const tag = await createTag({ slug: "rent" });

    expect(body).toMatchObject({ slug: "rent" });
    expect(tag.id).toBe(7);
  });

  it("updateTag PATCHes by id", async () => {
    server.use(
      http.patch(`${API_BASE}/api/tags/7`, () => ok({ id: 7, slug: "rent", color: "#fff" })),
    );
    const tag = await updateTag(7, { color: "#fff" });
    expect(tag.color).toBe("#fff");
  });

  it("deleteTag resolves on a void response", async () => {
    server.use(http.delete(`${API_BASE}/api/tags/7`, () => ok(null)));
    await expect(deleteTag(7)).resolves.toBeUndefined();
  });

  it("bulkTagTransactions POSTs to the bulk endpoint", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/transactions/bulk-tag`, async ({ request }) => {
        body = await request.json();
        return ok({ added: 3, removed: 0, transactions_affected: 3 });
      }),
    );

    const result = await bulkTagTransactions({
      transaction_ids: [1, 2, 3],
      add_slugs: ["rent"],
    });

    expect(body).toMatchObject({ transaction_ids: [1, 2, 3], add_slugs: ["rent"] });
    expect(result.added).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

describe("accounts API client", () => {
  it("getAccounts coerces NUMERIC string balances into numbers", async () => {
    server.use(
      http.get(`${API_BASE}/api/accounts`, () =>
        ok({
          items: [
            {
              id: 1,
              name: "Checking",
              statement_balance: "100.50",
              computed_balance: "99.00",
              drift: "1.50",
            },
          ],
          total: 1,
        }),
      ),
    );

    const res = await getAccounts({ active: "all" });
    const a = res.items[0];

    expect(a.statement_balance).toBe(100.5);
    expect(a.computed_balance).toBe(99);
    expect(a.drift).toBe(1.5);
    expect(typeof a.drift).toBe("number");
  });

  it("getAccounts leaves null balances undefined", async () => {
    server.use(
      http.get(`${API_BASE}/api/accounts`, () =>
        ok({
          items: [{ id: 2, name: "Savings", statement_balance: null, computed_balance: null, drift: null }],
          total: 1,
        }),
      ),
    );

    const res = await getAccounts();
    expect(res.items[0].statement_balance).toBeUndefined();
    expect(res.items[0].computed_balance).toBeUndefined();
    expect(res.items[0].drift).toBeUndefined();
  });

  it("createAccount POSTs the payload", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/accounts`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 9, name: "New" });
      }),
    );
    const a = await createAccount({ name: "New" } as never);
    expect(body).toMatchObject({ name: "New" });
    expect(a.id).toBe(9);
  });

  it("updateAccount PATCHes by id", async () => {
    server.use(http.patch(`${API_BASE}/api/accounts/9`, () => ok({ id: 9, name: "Edited" })));
    const a = await updateAccount(9, { name: "Edited" } as never);
    expect(a.name).toBe("Edited");
  });

  it("deleteAccount resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/accounts/9`, () => ok(null)));
    await expect(deleteAccount(9)).resolves.toBeUndefined();
  });

  it("mergeAccounts posts source_ids and returns the merge result", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/accounts/1/merge`, async ({ request }) => {
        body = await request.json();
        return ok({
          into: 1,
          merged: [2, 3],
          reassigned: { transactions: 5, planned: 0, portfolio: 0, funding: 0 },
        });
      }),
    );

    const result = await mergeAccounts(1, [2, 3]);

    expect(body).toMatchObject({ source_ids: [2, 3] });
    expect(result.merged).toEqual([2, 3]);
    expect(result.reassigned.transactions).toBe(5);
  });

  it("setOpeningBalance posts the anchor payload and returns the transaction + warning", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/accounts/4/opening-balance`, async ({ request }) => {
        body = await request.json();
        return ok({
          transaction: { id: 88, balance: 1500, transfer_source: "opening" },
          warning: null,
        });
      }),
    );

    const result = await setOpeningBalance(4, { balance: 1500, date: "2024-01-01" });

    expect(body).toMatchObject({ balance: 1500, date: "2024-01-01" });
    expect(result.transaction?.transfer_source).toBe("opening");
    expect(result.warning).toBeNull();
  });

  it("reconcileAccount posts the mode and returns the reconciled figures", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/accounts/4/reconcile`, async ({ request }) => {
        body = await request.json();
        return ok({
          mode: "adjustment",
          drift: 0,
          statement_balance: 120,
          computed_balance: 120,
          transaction: { id: 77, amount: 20, transfer_source: "adjustment" },
        });
      }),
    );

    const result = await reconcileAccount(4, "adjustment");

    expect(body).toMatchObject({ mode: "adjustment" });
    expect(result.drift).toBe(0);
    expect(result.transaction?.transfer_source).toBe("adjustment");
  });
});

// ---------------------------------------------------------------------------
// planned transactions
// ---------------------------------------------------------------------------

describe("planned-transactions API client", () => {
  it("getPlannedTransactions forwards filter params", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/planned-transactions`, ({ request }) => {
        url = request.url;
        return ok({ items: [], total: 0 });
      }),
    );

    await getPlannedTransactions({ is_recurring: true, category_id: 4, search: "rent" });

    expect(url).toContain("is_recurring=true");
    expect(url).toContain("category_id=4");
    expect(url).toContain("search=rent");
  });

  it("createPlannedTransaction POSTs", async () => {
    server.use(http.post(`${API_BASE}/api/planned-transactions`, () => ok({ id: 11 })));
    expect((await createPlannedTransaction({} as never)).id).toBe(11);
  });

  it("updatePlannedTransaction PATCHes", async () => {
    server.use(http.patch(`${API_BASE}/api/planned-transactions/11`, () => ok({ id: 11 })));
    expect((await updatePlannedTransaction(11, {} as never)).id).toBe(11);
  });

  it("deletePlannedTransaction resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/planned-transactions/11`, () => ok(null)));
    await expect(deletePlannedTransaction(11)).resolves.toBeUndefined();
  });

  it("executePlannedTransaction POSTs to the execute sub-route", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/planned-transactions/11/execute`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 11, is_executed: true });
      }),
    );
    const res = await executePlannedTransaction(11, { transaction_date: "2026-06-01" } as never);
    expect(body).toMatchObject({ transaction_date: "2026-06-01" });
    expect(res.is_executed).toBe(true);
  });

  it("getPlannedMatchSuggestions returns suggestion list", async () => {
    server.use(
      http.get(`${API_BASE}/api/planned-transactions/match-suggestions`, () =>
        ok([{ planned: { id: 1 }, candidates: [] }]),
      ),
    );
    const res = await getPlannedMatchSuggestions();
    expect(res).toHaveLength(1);
    expect(res[0].planned.id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

describe("attachments API client", () => {
  it("listAttachments fetches by transaction id", async () => {
    server.use(
      http.get(`${API_BASE}/api/attachments/transaction/8`, () =>
        ok({ items: [{ id: 1, transaction_id: 8, filename: "r.pdf" }] }),
      ),
    );
    const res = await listAttachments(8);
    expect(res.items[0].filename).toBe("r.pdf");
  });

  it("deleteAttachment DELETEs by id", async () => {
    server.use(
      http.delete(`${API_BASE}/api/attachments/2`, () => ok({ deleted: true })),
    );
    const res = await deleteAttachment(2);
    // apiRequest unwraps the envelope `data` directly into the returned value.
    expect(res).toMatchObject({ deleted: true });
  });

  it("getAttachmentDownloadUrl builds the absolute download URL", () => {
    expect(getAttachmentDownloadUrl(42)).toBe(`${API_BASE}/api/attachments/42/download`);
  });
});

// ---------------------------------------------------------------------------
// portfolio imports — parser configs + batch review
// ---------------------------------------------------------------------------

describe("portfolioImports API client", () => {
  const config: PortfolioCustomConfig = {
    dateColumn: "Date",
    typeColumn: "Type",
    symbolColumn: "Symbol",
    nameColumn: "",
    unitsColumn: "Units",
    priceColumn: "",
    amountColumn: "",
    feesColumn: "",
    taxesColumn: "",
    currencyColumn: "",
    fxRateColumn: "",
    noteColumn: "",
    dateFormat: "YYYY-MM-DD",
    separator: ",",
    encoding: "utf-8",
    skipRows: 0,
    defaultAssetClass: "stock",
    defaultType: "buy",
    typeMapping: {},
  };

  it("listPortfolioParserConfigs returns saved configs", async () => {
    server.use(
      http.get(`${API_BASE}/api/portfolio/import/parsers`, () =>
        ok([{ id: 1, name: "Degiro", kind: "custom", config, created_at: "", updated_at: "" }]),
      ),
    );
    const res = await listPortfolioParserConfigs();
    expect(res[0].name).toBe("Degiro");
  });

  it("createPortfolioParserConfig POSTs name + config", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/portfolio/import/parsers`, async ({ request }) => {
        body = await request.json();
        return ok({ id: 2, name: "Mine", kind: "custom", config, created_at: "", updated_at: "" });
      }),
    );
    await createPortfolioParserConfig("Mine", config);
    expect(body).toMatchObject({ name: "Mine" });
  });

  it("updatePortfolioParserConfig PATCHes by id", async () => {
    server.use(
      http.patch(`${API_BASE}/api/portfolio/import/parsers/2`, () =>
        ok({ id: 2, name: "Renamed", kind: "custom", config, created_at: "", updated_at: "" }),
      ),
    );
    const res = await updatePortfolioParserConfig(2, { name: "Renamed" });
    expect(res.name).toBe("Renamed");
  });

  it("deletePortfolioParserConfig resolves on a void DELETE", async () => {
    server.use(http.delete(`${API_BASE}/api/portfolio/import/parsers/2`, () => ok(null)));
    await expect(deletePortfolioParserConfig(2)).resolves.toBeNull();
  });

  it("getPortfolioImportPreview returns groups + totals", async () => {
    server.use(
      http.get(`${API_BASE}/api/portfolio/import/batches/5/preview`, () =>
        ok({ batch_id: 5, groups: [], totals: { symbol: 0, name_exact: 0, unresolved: 0, error: 0 } }),
      ),
    );
    const res = await getPortfolioImportPreview(5);
    expect(res.batch_id).toBe(5);
  });

  it("overridePortfolioImportRow sends investment_id when not creating new", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        `${API_BASE}/api/portfolio/import/batches/5/rows/9/investment-override`,
        async ({ request }) => {
          body = await request.json();
          return ok({ row_id: 9, investment_id: 33 });
        },
      ),
    );
    await overridePortfolioImportRow(5, 9, { investmentId: 33 });
    expect(body).toMatchObject({ investment_id: 33 });
  });

  it("overridePortfolioImportRow sends create_new when createNew is set", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        `${API_BASE}/api/portfolio/import/batches/5/rows/9/investment-override`,
        async ({ request }) => {
          body = await request.json();
          return ok({ row_id: 9, created: true });
        },
      ),
    );
    await overridePortfolioImportRow(5, 9, { createNew: true });
    expect(body).toMatchObject({ create_new: true });
  });

  it("commitPortfolioImportBatch posts account_id when provided", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/portfolio/import/batches/5/commit`, async ({ request }) => {
        body = await request.json();
        return ok({ batch_id: 5, imported: 4, duplicates: 0, errors: 0 });
      }),
    );
    const res = await commitPortfolioImportBatch(5, 12);
    expect(body).toMatchObject({ account_id: 12 });
    expect(res.imported).toBe(4);
  });

  it("commitPortfolioImportBatch posts empty body when no account", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/portfolio/import/batches/5/commit`, async ({ request }) => {
        body = await request.json();
        return ok({ batch_id: 5, imported: 0, duplicates: 0, errors: 0 });
      }),
    );
    await commitPortfolioImportBatch(5);
    expect(body).toEqual({});
  });

  it("rollbackPortfolioImportBatch DELETEs and returns deleted count", async () => {
    server.use(
      http.delete(`${API_BASE}/api/portfolio/import/batches/5`, () => ok({ deleted: 7 })),
    );
    expect((await rollbackPortfolioImportBatch(5)).deleted).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// aggregations — query string construction for exclusion params
// ---------------------------------------------------------------------------

describe("aggregations exclusion query building", () => {
  it("getAggregationCategoryPivot appends repeated exclusion ids", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/aggregations/category-pivot`, ({ request }) => {
        url = request.url;
        return ok({ categoryPivot: {} });
      }),
    );

    await getAggregationCategoryPivot({
      currency: "EUR",
      excluded_category_ids: [1, 2],
      excluded_recipient_ids: [3],
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get("currency")).toBe("EUR");
    expect(parsed.searchParams.getAll("excluded_category_ids")).toEqual(["1", "2"]);
    expect(parsed.searchParams.getAll("excluded_recipient_ids")).toEqual(["3"]);
  });

  it("getAggregationCategoryPivot omits the query string with no params", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/aggregations/category-pivot`, ({ request }) => {
        url = request.url;
        return ok({ categoryPivot: {} });
      }),
    );
    await getAggregationCategoryPivot();
    expect(url.endsWith("/api/aggregations/category-pivot")).toBe(true);
  });

  it("getAggregationRecipientByYear appends both exclusion lists", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/aggregations/recipient-by-year`, ({ request }) => {
        url = request.url;
        return ok({ recipientsByYear: {} });
      }),
    );
    await getAggregationRecipientByYear({ excluded_recipient_ids: [5], excluded_category_ids: [6, 7] });
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll("excluded_recipient_ids")).toEqual(["5"]);
    expect(parsed.searchParams.getAll("excluded_category_ids")).toEqual(["6", "7"]);
  });

  it("getAggregationRecipientPivot forwards bucket, range and recipient ids", async () => {
    let url = "";
    server.use(
      http.get(`${API_BASE}/api/aggregations/recipient-pivot`, ({ request }) => {
        url = request.url;
        return ok({ recipientPivot: {} });
      }),
    );
    await getAggregationRecipientPivot({
      currency: "USD",
      bucket: "yearly",
      start: "2025-01-01",
      end: "2025-12-31",
      recipient_ids: [10, 11],
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("bucket")).toBe("yearly");
    expect(parsed.searchParams.get("start")).toBe("2025-01-01");
    expect(parsed.searchParams.get("end")).toBe("2025-12-31");
    expect(parsed.searchParams.getAll("recipient_ids")).toEqual(["10", "11"]);
  });
});
