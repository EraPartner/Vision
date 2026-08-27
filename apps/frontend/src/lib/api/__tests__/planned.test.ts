// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getPlannedTransactions, createPlannedTransaction, updatePlannedTransaction, deletePlannedTransaction, executePlannedTransaction, getPlannedMatchSuggestions } from "@/lib/api/planned";

afterEach(() => server.resetHandlers());

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
    server.use(http.delete(`${API_BASE}/api/planned-transactions/11`, () => new HttpResponse(null, { status: 204 })));
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
        ok({ items: [{ planned: { id: 1 }, candidates: [] }], total: 1 }),
      ),
    );
    const res = await getPlannedMatchSuggestions();
    expect(res).toHaveLength(1);
    expect(res[0].planned.id).toBe(1);
  });
});
