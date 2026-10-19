import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { fetchRecentDashboardTransactions } from "@/features/dashboard/recentTransactions";
import { server } from "@/test/msw/server";
import { ok, TRANSACTION_STUB } from "@/test/msw/handlers";

const API_BASE = "http://localhost:3002";

function transaction(
    id: number,
    overrides: { category_id?: number; recipient_id?: number } = {},
) {
    // The stub's category 1 and recipient 1 are never excluded below.
    return { ...TRANSACTION_STUB, id, amount: id, ...overrides };
}

function page(items: unknown[], total: number, offset = 0) {
    return ok({ items, total, limit: 200, offset, links: [] });
}

/** Serves `pages[n]` for the n-th request and records each request's query. */
function servePages(pages: Array<(offset: number) => Response>) {
    const requests: Array<Record<string, string>> = [];
    server.use(
        http.get(`${API_BASE}/api/transactions`, ({ request }) => {
            const query = Object.fromEntries(new URL(request.url).searchParams);
            requests.push(query);
            const respond = pages[requests.length - 1] ?? pages[pages.length - 1]!;
            return respond(Number(query.offset ?? 0));
        }),
    );
    return requests;
}

describe("fetchRecentDashboardTransactions (over HTTP)", () => {
    it("pages through 200-row windows until it finds five non-excluded rows", async () => {
        const requests = servePages([
            (offset) =>
                page(Array.from({ length: 200 }, (_, i) => transaction(i + 1, { category_id: 7 })), 1_000, offset),
            (offset) =>
                page(Array.from({ length: 200 }, (_, i) => transaction(i + 201, { recipient_id: 9 })), 1_000, offset),
            (offset) => page(Array.from({ length: 6 }, (_, i) => transaction(i + 401)), 1_000, offset),
        ]);

        const result = await fetchRecentDashboardTransactions([7], [9]);

        expect(result.map(({ id }) => id)).toEqual([401, 402, 403, 404, 405]);
        expect(requests.map(({ limit, offset, active }) => ({ limit, offset, active }))).toEqual([
            { limit: "200", offset: "0", active: "true" },
            { limit: "200", offset: "200", active: "true" },
            { limit: "200", offset: "400", active: "true" },
        ]);
    });

    it("never requests more than three pages", async () => {
        const requests = servePages([
            (offset) =>
                page(Array.from({ length: 200 }, (_, i) => transaction(offset + i + 1, { category_id: 7 })), 10_000, offset),
        ]);

        await expect(fetchRecentDashboardTransactions([7], [])).resolves.toEqual([]);
        expect(requests).toHaveLength(3);
    });

    it("stops after an empty page", async () => {
        const requests = servePages([(offset) => page([], 1_000, offset)]);
        await expect(fetchRecentDashboardTransactions([], [])).resolves.toEqual([]);
        expect(requests).toHaveLength(1);
    });

    it("stops when the reported total is exhausted", async () => {
        const requests = servePages([
            (offset) =>
                page(Array.from({ length: 200 }, (_, i) => transaction(i + 1, { category_id: 7 })), 200, offset),
        ]);
        await expect(fetchRecentDashboardTransactions([7], [])).resolves.toEqual([]);
        expect(requests).toHaveLength(1);
    });

    it("stops after a short page", async () => {
        const requests = servePages([(offset) => page([transaction(1)], 1_000, offset)]);
        const result = await fetchRecentDashboardTransactions([], []);
        expect(result.map(({ id }) => id)).toEqual([1]);
        expect(requests).toHaveLength(1);
    });

    it("propagates a failed request", async () => {
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                HttpResponse.json({ ok: false, error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
            ),
        );
        await expect(fetchRecentDashboardTransactions([], [])).rejects.toThrow();
    });
});
