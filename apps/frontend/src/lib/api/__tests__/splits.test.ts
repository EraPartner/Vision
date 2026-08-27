// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getOwedSummary, getOwedByRecipient, getSplitsByTransaction, createSplitsBatch, recordSplitPayment, settleSplit, settleAllSplitsByRecipient, deleteSplit } from "@/lib/api/splits";

afterEach(() => server.resetHandlers());

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
