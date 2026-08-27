// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getTransactions, createTransaction, updateTransaction, deleteTransaction, bulkDeleteTransactions, bulkUpdateTransactions } from "@/lib/api/transactions";

afterEach(() => server.resetHandlers());

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

  it("createTransaction POSTs", async () => {
    server.use(http.post(`${API_BASE}/api/transactions`, () => ok({ id: 10 })));
    expect((await createTransaction({} as never)).id).toBe(10);
  });

  it("updateTransaction PATCHes", async () => {
    server.use(http.patch(`${API_BASE}/api/transactions/10`, () => ok({ id: 10 })));
    expect((await updateTransaction(10, {} as never)).id).toBe(10);
  });

  it("deleteTransaction resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/transactions/10`, () => new HttpResponse(null, { status: 204 })));
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
