// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { ApiContractError } from "@/lib/api/client";
import { server } from "@/test/msw/server";
import { SPLIT_PAYMENT_STUB, SPLIT_STUB } from "@/test/msw/handlers";
import { API_BASE, ok } from "./clientTestHarness";

import { getOwedSummary, getOwedByRecipient, getSplitsByTransaction, createSplitsBatch, recordSplitPayment, settleSplit, settleAllSplitsByRecipient, deleteSplit } from "@/lib/api/splits";
import {
    asCurrencyCode,
    asRecipientId,
    asSplitId,
    asTransactionId,
} from "@vision/types/brands";

afterEach(() => server.resetHandlers());

/** One `splitService.getOwedByRecipient` row: the split plus its transaction. */
const OWED_DETAIL = {
  ...SPLIT_STUB,
  recipient_id: 4,
  recipient_name: "Alex",
  amount_paid: 5,
  transaction_date: "2025-01-15",
  transaction_memo: null,
  transaction_amount: -50,
  transaction_currency: "EUR",
  bank_account: null,
  transaction_recipient_name: "Restaurant",
  remaining: 20,
};

/** Server-converted total outstanding on both owed reads. */
const OWED_TOTALS = { currency: "EUR", remaining: 20, unconverted_count: 0, unconverted_currencies: [] };

describe("splits API client", () => {
  it("getOwedSummary fetches the owed summary in the requested currency", async () => {
    let currency: string | null = null;
    server.use(
      http.get(`${API_BASE}/api/splits/owed`, ({ request }) => {
        currency = new URL(request.url).searchParams.get("currency");
        return ok({ items: [], total: 0, summary: OWED_TOTALS });
      }),
    );
    const res = await getOwedSummary(asCurrencyCode("EUR"));
    expect(res.items).toEqual([]);
    expect(res.summary).toEqual(OWED_TOTALS);
    expect(currency).toBe("EUR");
  });

  it("getOwedByRecipient fetches by recipient id with the converted total", async () => {
    server.use(
      http.get(`${API_BASE}/api/splits/owed/4`, () =>
        ok({ items: [OWED_DETAIL], total: 1, summary: OWED_TOTALS }),
      ),
    );
    const res = await getOwedByRecipient(asRecipientId(4), asCurrencyCode("EUR"));
    expect(res.items).toHaveLength(1);
    expect(res.summary.remaining).toBe(20);
  });

  it("getSplitsByTransaction fetches by transaction id", async () => {
    server.use(http.get(`${API_BASE}/api/splits/transaction/8`, () => ok({ items: [], total: 0 })));
    expect((await getSplitsByTransaction(asTransactionId(8))).items).toEqual([]);
  });

  it("createSplitsBatch posts transaction_id + splits", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/splits/batch`, async ({ request }) => {
        body = await request.json();
        return ok({ items: [SPLIT_STUB], total: 1 });
      }),
    );
    await createSplitsBatch(asTransactionId(8), [{ recipient_id: asRecipientId(2), amount: 5 }]);
    expect(body).toMatchObject({ transaction_id: 8, splits: [{ recipient_id: 2, amount: 5 }] });
  });

  it("recordSplitPayment posts amount/note/paid_at", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${API_BASE}/api/splits/3/pay`, async ({ request }) => {
        body = await request.json();
        return ok(SPLIT_PAYMENT_STUB);
      }),
    );
    await recordSplitPayment(asSplitId(3), 5, "note", "2026-06-01");
    expect(body).toMatchObject({ amount: 5, note: "note", paid_at: "2026-06-01" });
  });

  it("settleSplit POSTs to the settle route", async () => {
    server.use(http.post(`${API_BASE}/api/splits/3/settle`, () => ok({ ...SPLIT_STUB, id: 3 })));
    expect((await settleSplit(asSplitId(3))).id).toBe(3);
  });

  it("settleAllSplitsByRecipient POSTs and returns the settled count", async () => {
    server.use(
      http.post(`${API_BASE}/api/splits/owed/4/settle-all`, () => ok({ settled_count: 6 })),
    );
    expect((await settleAllSplitsByRecipient(asRecipientId(4))).settled_count).toBe(6);
  });

  it("deleteSplit resolves on void", async () => {
    server.use(http.delete(`${API_BASE}/api/splits/3`, () => new HttpResponse(null, { status: 204 })));
    await expect(deleteSplit(asSplitId(3))).resolves.toBeUndefined();
  });

  it("rejects an owed detail row whose NUMERIC remaining arrives as a string", async () => {
    server.use(
      http.get(`${API_BASE}/api/splits/owed/4`, () =>
        ok({ items: [{ ...OWED_DETAIL, remaining: "20.0000" }], total: 1, summary: OWED_TOTALS }),
      ),
    );
    await expect(getOwedByRecipient(asRecipientId(4), asCurrencyCode("EUR"))).rejects.toMatchObject({
      name: "ApiContractError",
      endpoint: "GET /api/splits/owed/4",
    });
  });

  it("recordSplitPayment rejects a payment amount sent as a string", async () => {
    server.use(
      http.post(`${API_BASE}/api/splits/3/pay`, () =>
        ok({
          id: 1,
          split_id: 3,
          amount: "5.00",
          note: null,
          paid_at: "2026-06-01",
          created_at: "2026-06-01T00:00:00.000Z",
        }),
      ),
    );

    await expect(recordSplitPayment(asSplitId(3), 5)).rejects.toBeInstanceOf(ApiContractError);
  });

  it("createSplitsBatch rejects items that are not splits", async () => {
    server.use(
      http.post(`${API_BASE}/api/splits/batch`, () => ok({ items: [{ id: 1 }], total: 1 })),
    );

    await expect(
      createSplitsBatch(1 as never, [{ recipient_id: asRecipientId(2), amount: 5 }]),
    ).rejects.toBeInstanceOf(ApiContractError);
  });
});
