// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";
import {
    INVESTMENT_STUB,
    PORTFOLIO_TRANSACTION_STUB,
} from "@/test/msw/handlers";

import {
    getInvestments,
    getSupportedPriceProviders,
    createInvestment,
    refreshInvestmentPrices,
    updateInvestment,
    deleteInvestment,
    getInvestmentPriceHistory,
    getPortfolioTransactions,
    getPortfolioTransactionsBulk,
    createPortfolioTransaction,
    updatePortfolioTransaction,
    bulkRetagPortfolioTransactions,
} from "@/lib/api/portfolio";

afterEach(() => server.resetHandlers());

/** A `mapPortfolioTxRow` row with the given overrides. */
const txn = (overrides: Record<string, unknown>) => ({
    ...PORTFOLIO_TRANSACTION_STUB,
    ...overrides,
});

const txnList = (items: unknown[]) => ({
    items,
    total: items.length,
    limit: 100,
    offset: 0,
    links: [],
});

describe("portfolio API client", () => {
    it("keeps literal in-kind income visible next to standard income", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments/4/transactions`, () =>
                ok(
                    txnList([
                        txn({
                            id: 1,
                            type: "dividend",
                            amount: 5,
                            income_recognition_role: "included_in_units",
                            date: "2025-01-01",
                        }),
                        txn({
                            id: 2,
                            type: "dividend",
                            amount: 7,
                            income_recognition_role: "standard",
                            date: "2025-02-01",
                        }),
                    ]),
                ),
            ),
        );
        const result = await getPortfolioTransactions(4);
        expect(
            result.items.map((row) => [
                row.id,
                row.amount,
                row.income_recognition_role,
                row.date,
            ]),
        ).toEqual([
            [1, 5, "included_in_units", "2025-01-01"],
            [2, 7, "standard", "2025-02-01"],
        ]);
    });

    // An unknown role fails the response contract; a known role on the wrong
    // transaction type is caught by the client's accounting check.
    it.each([
        [
            { type: "dividend", income_recognition_role: "tax_free" },
            "ApiContractError",
        ],
        [
            { type: "gift", income_recognition_role: "included_in_units" },
            "PortfolioResponseError",
        ],
    ])("rejects invalid transaction accounting roles %j", async (row, name) => {
        server.use(
            http.get(`${API_BASE}/api/investments/transactions`, () =>
                ok(txnList([txn(row)])),
            ),
        );
        await expect(
            getPortfolioTransactionsBulk({ investment_ids: "4" }),
        ).rejects.toMatchObject({ name });
    });

    // income_recognition_role is NOT NULL DEFAULT 'standard' (migration 0124)
    // and `date` is the column itself, so a row without either is drift.
    it.each([
        ["income_recognition_role", { income_recognition_role: undefined }],
        ["date", { date: undefined, transaction_date: "2025-01-01" }],
    ])("rejects a transaction row without %s", async (_field, overrides) => {
        server.use(
            http.get(`${API_BASE}/api/investments/4/transactions`, () =>
                ok(txnList([txn(overrides)])),
            ),
        );
        await expect(getPortfolioTransactions(4)).rejects.toMatchObject({
            name: "ApiContractError",
        });
    });

    it.each(["standard", "included_in_units"])(
        "rejects an explicit manual role setter %s before any mutation",
        async (income_recognition_role) => {
            let calls = 0;
            server.use(
                http.post(`${API_BASE}/api/investments/4/transactions`, () => {
                    calls++;
                    return ok({ id: 1 });
                }),
                http.patch(`${API_BASE}/api/investments/transactions/1`, () => {
                    calls++;
                    return ok({ id: 1 });
                }),
            );
            const payload = {
                type: "dividend",
                date: "2025-01-01",
                amount: 5,
                income_recognition_role,
            } as never;
            await expect(
                createPortfolioTransaction(4, payload),
            ).rejects.toThrow("read-only");
            await expect(
                updatePortfolioTransaction(1, payload),
            ).rejects.toThrow("read-only");
            expect(calls).toBe(0);
        },
    );
    it("getSupportedPriceProviders unwraps the backend catalog", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments/providers`, () =>
                ok({
                    providers: [
                        {
                            key: "manual",
                            name: "Manual",
                            description: "Set price manually",
                        },
                        {
                            key: "yahoo",
                            name: "Yahoo Finance",
                            description: "Stocks and ETFs",
                        },
                    ],
                }),
            ),
        );

        const providers = await getSupportedPriceProviders();

        expect(providers.map((provider) => provider.key)).toEqual([
            "manual",
            "yahoo",
        ]);
    });

    it("getInvestments forwards asset_class + active", async () => {
        let url = "";
        server.use(
            http.get(`${API_BASE}/api/investments`, ({ request }) => {
                url = request.url;
                return ok({
                    items: [],
                    total: 0,
                    limit: 100,
                    offset: 0,
                    links: [],
                });
            }),
        );
        await getInvestments({ asset_class: "stock", active: true });
        expect(url).toContain("asset_class=stock");
        expect(url).toContain("active=true");
    });

    it("createInvestment POSTs", async () => {
        server.use(
            http.post(`${API_BASE}/api/investments`, () =>
                ok({ ...INVESTMENT_STUB, id: 4 }, { status: 201 }),
            ),
        );
        expect((await createInvestment({} as never)).id).toBe(4);
    });

    it("refreshInvestmentPrices POSTs and returns price map", async () => {
        server.use(
            http.post(`${API_BASE}/api/investments/refresh-prices`, () =>
                ok({
                    updated: 2,
                    total: 3,
                    prices: { AAPL: 100 },
                    priceSources: { AAPL: "live" },
                }),
            ),
        );
        const res = await refreshInvestmentPrices();
        expect(res.updated).toBe(2);
        expect(res.priceSources?.AAPL).toBe("live");
    });

    it("updateInvestment PATCHes", async () => {
        server.use(
            http.patch(`${API_BASE}/api/investments/4`, () =>
                ok({ ...INVESTMENT_STUB, id: 4 }),
            ),
        );
        expect((await updateInvestment(4, {} as never)).id).toBe(4);
    });

    it("deleteInvestment resolves on void", async () => {
        server.use(
            http.delete(
                `${API_BASE}/api/investments/4`,
                () => new HttpResponse(null, { status: 204 }),
            ),
        );
        await expect(deleteInvestment(4)).resolves.toBeUndefined();
    });

    it("getInvestmentPriceHistory forwards range params", async () => {
        let url = "";
        server.use(
            http.get(
                `${API_BASE}/api/investments/4/price-history`,
                ({ request }) => {
                    url = request.url;
                    return ok({
                        investment_id: 4,
                        provider: "yahoo",
                        points: [],
                    });
                },
            ),
        );
        await getInvestmentPriceHistory(4, {
            from_ms: 1000,
            to_ms: 2000,
            db_only: true,
        });
        expect(url).toContain("from_ms=1000");
        expect(url).toContain("to_ms=2000");
        expect(url).toContain("db_only=true");
    });

    it("getPortfolioTransactions returns the calendar-day date", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments/4/transactions`, () =>
                ok(txnList([txn({ id: 1, date: "2026-03-03" })])),
            ),
        );
        const res = await getPortfolioTransactions(4);
        expect(res.items[0].date).toBe("2026-03-03");
    });

    it("getPortfolioTransactionsBulk forwards investment_ids", async () => {
        let url = "";
        server.use(
            http.get(
                `${API_BASE}/api/investments/transactions`,
                ({ request }) => {
                    url = request.url;
                    return ok(txnList([txn({ id: 1 })]));
                },
            ),
        );
        const res = await getPortfolioTransactionsBulk({
            investment_ids: "1,2",
        });
        expect(url).toContain("investment_ids=1%2C2");
        expect(res.items[0].date).toBe("2025-01-01");
    });

    it("createPortfolioTransaction POSTs to the investment sub-route", async () => {
        server.use(
            http.post(`${API_BASE}/api/investments/4/transactions`, () =>
                ok(txn({ id: 50, investment_id: 4 }), { status: 201 }),
            ),
        );
        expect((await createPortfolioTransaction(4, {} as never)).id).toBe(50);
    });

    it("updatePortfolioTransaction PATCHes by txn id", async () => {
        let body: unknown;
        server.use(
            http.patch(
                `${API_BASE}/api/investments/transactions/50`,
                async ({ request }) => {
                    body = await request.json();
                    return ok(txn({ id: 50 }));
                },
            ),
        );
        const update = {
            fx_rate_to_eur: null,
            account_id: null,
            note: null,
            recurrence_interval: null,
            recurrence_end_date: null,
        };
        expect((await updatePortfolioTransaction(50, update)).id).toBe(50);
        expect(body).toEqual(update);
    });

    it("bulkRetagPortfolioTransactions PUTs the reviewed compare-and-set body", async () => {
        let body: unknown;
        server.use(
            http.put(
                `${API_BASE}/api/investments/transactions/broker`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({
                        receipt_id: 9,
                        idempotency_key: "receipt-key",
                        from_account_id: null,
                        to_account_id: 7,
                        transaction_ids: [1, 2],
                        previous_assignments: [
                            { transaction_id: 1, account_id: null },
                            { transaction_id: 2, account_id: null },
                        ],
                        selected_count: 2,
                        changed_count: 2,
                        created_at: "2025-01-01T00:00:00.000Z",
                        replayed: false,
                    });
                },
            ),
        );
        const request = {
            transaction_ids: [1, 2],
            from_account_id: null,
            to_account_id: 7,
            idempotency_key: "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
        };
        const receipt = await bulkRetagPortfolioTransactions(request);
        expect(body).toEqual(request);
        expect(receipt.changed_count).toBe(2);
    });
});
