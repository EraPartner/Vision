// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";

import { getAccounts, createAccount, updateAccount, deleteAccount, mergeAccounts, setOpeningBalance, reconcileAccount } from "@/lib/api/accounts";

afterEach(() => server.resetHandlers());

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
    server.use(http.delete(`${API_BASE}/api/accounts/9`, () => new HttpResponse(null, { status: 204 })));
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
