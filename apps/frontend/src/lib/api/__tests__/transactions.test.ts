// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";
import { TRANSACTION_STUB } from "@/test/msw/handlers";
import { ApiContractError } from "@/lib/api/client";

import {
    getTransactions,
    createTransaction,
    updateTransaction,
    deleteTransaction,
    bulkDeleteTransactions,
    bulkUpdateTransactions,
} from "@/lib/api/transactions";

afterEach(() => server.resetHandlers());

describe("transactions API client", () => {
    it("getTransactions joins category_ids and accepts canonical transaction dates", async () => {
        let url = "";
        server.use(
            http.get(`${API_BASE}/api/transactions`, ({ request }) => {
                url = request.url;
                return ok({
                    items: [
                        { ...TRANSACTION_STUB, transaction_date: "2026-01-01" },
                    ],
                    total: 1,
                    limit: 50,
                    offset: 0,
                    links: [],
                });
            }),
        );

        const res = await getTransactions({
            category_ids: [4, 5],
            search: "x",
        });

        expect(url).toContain("category_ids=4%2C5"); // "4,5" encoded
        expect(res.items[0].transaction_date).toBe("2026-01-01");
    });

    it("rejects a response without the canonical transaction_date", async () => {
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                ok({ items: [{ id: 2, date: "2026-02-02" }], total: 1 }),
            ),
        );

        await expect(getTransactions()).rejects.toThrow(
            "items[0].transaction_date must be a non-empty string",
        );
    });

    it("getTransactions accepts the formatTransaction shape, null bank_account included", async () => {
        const row = {
            ...TRANSACTION_STUB,
            bank_account: null,
            account_id: null,
            is_transfer: false,
            transfer_peer_id: null,
            transfer_source: null,
            amount_eur: -25.5,
            tags: [{ id: 1, slug: "rent", color: null, is_active: true }],
            links: [],
        };
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                ok({ items: [row], total: 1, limit: 50, offset: 0, links: [] }),
            ),
        );
        expect((await getTransactions()).items).toEqual([row]);
    });

    it("getTransactions rejects a null currency (NOT NULL column)", async () => {
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                ok({
                    items: [{ ...TRANSACTION_STUB, currency: null }],
                    total: 1,
                    limit: 50,
                    offset: 0,
                    links: [],
                }),
            ),
        );
        const error = await getTransactions().catch((err: unknown) => err);
        expect(error).toBeInstanceOf(ApiContractError);
        expect((error as ApiContractError).issues).toEqual([
            "items[0].currency: Invalid input: expected string, received null",
        ]);
    });

    it("getTransactions rejects a row missing a field formatTransaction always sends", async () => {
        const { tags: _tags, ...withoutTags } = TRANSACTION_STUB;
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                ok({
                    items: [withoutTags],
                    total: 1,
                    limit: 50,
                    offset: 0,
                    links: [],
                }),
            ),
        );
        const error = await getTransactions().catch((err: unknown) => err);
        expect(error).toBeInstanceOf(ApiContractError);
        expect((error as ApiContractError).issues).toEqual([
            "items[0].tags: Invalid input: expected array, received undefined",
        ]);
    });

    it("getTransactions rejects a NUMERIC amount string in strict mode", async () => {
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                ok({
                    items: [{ ...TRANSACTION_STUB, amount: "-25.50" }],
                    total: 1,
                    limit: 50,
                    offset: 0,
                    links: [],
                }),
            ),
        );
        const error = await getTransactions().catch((err: unknown) => err);
        expect(error).toBeInstanceOf(ApiContractError);
        expect((error as ApiContractError).issues).toEqual([
            "items[0].amount: Invalid input: expected number, received string",
        ]);
    });

    it("createTransaction POSTs", async () => {
        server.use(
            http.post(`${API_BASE}/api/transactions`, () =>
                ok({ ...TRANSACTION_STUB, id: 10, auto_linked: null }),
            ),
        );
        expect((await createTransaction({} as never)).id).toBe(10);
    });

    it("updateTransaction PATCHes", async () => {
        server.use(
            http.patch(`${API_BASE}/api/transactions/10`, () => ok({ id: 10 })),
        );
        expect((await updateTransaction(10, {} as never)).id).toBe(10);
    });

    it("deleteTransaction resolves on void", async () => {
        server.use(
            http.delete(
                `${API_BASE}/api/transactions/10`,
                () => new HttpResponse(null, { status: 204 }),
            ),
        );
        await expect(deleteTransaction(10)).resolves.toBeUndefined();
    });

    it("bulkDeleteTransactions posts the selection", async () => {
        let body: unknown = null;
        server.use(
            http.post(
                `${API_BASE}/api/transactions/bulk-delete`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({ deleted: 2, requested: 2, matched: 2 });
                },
            ),
        );
        const res = await bulkDeleteTransactions({ ids: [1, 2] } as never);
        expect(body).toMatchObject({ ids: [1, 2] });
        expect(res.deleted).toBe(2);
        expect(res.requested).toBe(2);
        expect(res.matched).toBe(2);
    });

    it("bulkUpdateTransactions posts the update", async () => {
        server.use(
            http.post(`${API_BASE}/api/transactions/bulk-update`, () =>
                ok({ updated: 5, requested: 5, matched: 5 }),
            ),
        );
        expect(
            (await bulkUpdateTransactions({ ids: [1], patch: {} } as never))
                .updated,
        ).toBe(5);
    });
});
