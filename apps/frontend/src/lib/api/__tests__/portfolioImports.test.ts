// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { listPortfolioParserConfigs, createPortfolioParserConfig, updatePortfolioParserConfig, deletePortfolioParserConfig, getPortfolioImportPreview, overridePortfolioImportRow, overridePortfolioImportRows, commitPortfolioImportBatch, rollbackPortfolioImportBatch, type PortfolioCustomConfig } from "@/lib/api/portfolioImports";

afterEach(() => server.resetHandlers());

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
        ok({
          items: [{ id: 1, name: "Degiro", kind: "custom", config, created_at: "", updated_at: "" }],
          total: 1,
        }),
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
    server.use(http.delete(`${API_BASE}/api/portfolio/import/parsers/2`, () => new HttpResponse(null, { status: 204 })));
    await expect(deletePortfolioParserConfig(2)).resolves.toBeUndefined();
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

  it("overridePortfolioImportRows sends one row-set request for an existing investment", async () => {
    let requests = 0;
    let body: unknown = null;
    server.use(
      http.post(
        `${API_BASE}/api/portfolio/import/batches/5/rows/investment-override`,
        async ({ request }) => {
          requests += 1;
          body = await request.json();
          return ok({ investment_id: 33, created: false, resolved: 3 });
        },
      ),
    );

    const result = await overridePortfolioImportRows(5, [9, 10, 11], { investmentId: 33 });

    expect(requests).toBe(1);
    expect(body).toEqual({ row_ids: [9, 10, 11], investment_id: 33 });
    expect(result.resolved).toBe(3);
  });

  it("overridePortfolioImportRows creates once for the complete row set", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        `${API_BASE}/api/portfolio/import/batches/5/rows/investment-override`,
        async ({ request }) => {
          body = await request.json();
          return ok({ investment_id: 44, created: true, resolved: 2 });
        },
      ),
    );

    await overridePortfolioImportRows(5, [9, 10], { createNew: true });

    expect(body).toEqual({ row_ids: [9, 10], create_new: true });
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
