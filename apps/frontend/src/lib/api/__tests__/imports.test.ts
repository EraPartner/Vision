// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { listCustomParserConfigs, createCustomParserConfig, updateCustomParserConfig, deleteCustomParserConfig, listImportBatches, rollbackImportBatch, getImportPreview, overrideImportRow, overrideImportRowCategory, commitImportBatch } from "@/lib/api/imports";

afterEach(() => server.resetHandlers());

describe("imports API client", () => {
  it("listCustomParserConfigs fetches configs", async () => {
    server.use(http.get(`${API_BASE}/api/import/parsers`, () => ok({ items: [{ id: 1, name: "C" }], total: 1 })));
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
    server.use(http.delete(`${API_BASE}/api/import/parsers/2`, () => new HttpResponse(null, { status: 204 })));
    await expect(deleteCustomParserConfig(2)).resolves.toBeUndefined();
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

  it("rollbackImportBatch DELETEs and returns deleted count", async () => {
    server.use(http.delete(`${API_BASE}/api/import/batches/7`, () => ok({ deleted: 3 })));
        expect((await rollbackImportBatch("7")).deleted).toBe(3);
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
