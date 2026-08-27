import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTransactions } from "@/lib/api/transactions";
import { fetchRecentDashboardTransactions } from "@/features/dashboard/recentTransactions";
import type { Transaction, TransactionsListResponse } from "@/types/api";

vi.mock("@/lib/api/transactions", () => ({
    getTransactions: vi.fn(),
}));

const getTransactionsMock = vi.mocked(getTransactions);

function transaction(id: number, overrides: Partial<Transaction> = {}): Transaction {
    return {
        id,
        transaction_date: "2026-08-26",
        bank_account: "Test",
        amount: id,
        created_at: "2026-08-26T00:00:00Z",
        links: [],
        ...overrides,
    };
}

function page(items: Transaction[], total: number): TransactionsListResponse {
    return { items, total, limit: 200, offset: 0, links: [] };
}

beforeEach(() => {
    getTransactionsMock.mockReset();
});

describe("fetchRecentDashboardTransactions", () => {
    it("scans fixed 200-row pages until it finds five non-excluded rows", async () => {
        const excluded = Array.from({ length: 200 }, (_, index) => transaction(index + 1, { category_id: 7 }));
        const recipientExcluded = Array.from(
            { length: 200 },
            (_, index) => transaction(index + 201, { recipient_id: 9 }),
        );
        const survivors = Array.from({ length: 6 }, (_, index) => transaction(index + 401));
        getTransactionsMock
            .mockResolvedValueOnce(page(excluded, 1_000))
            .mockResolvedValueOnce(page(recipientExcluded, 1_000))
            .mockResolvedValueOnce(page(survivors, 1_000));

        const result = await fetchRecentDashboardTransactions([7], [9]);

        expect(result.map(({ id }) => id)).toEqual([401, 402, 403, 404, 405]);
        expect(getTransactionsMock.mock.calls.map(([params]) => params)).toEqual([
            { limit: 200, offset: 0, active: true },
            { limit: 200, offset: 200, active: true },
            { limit: 200, offset: 400, active: true },
        ]);
    });

    it("never scans more than three pages", async () => {
        const excluded = Array.from({ length: 200 }, (_, index) => transaction(index + 1, { category_id: 7 }));
        getTransactionsMock.mockResolvedValue(page(excluded, 10_000));

        await expect(fetchRecentDashboardTransactions([7], [])).resolves.toEqual([]);
        expect(getTransactionsMock).toHaveBeenCalledTimes(3);
    });

    it("stops on an empty page or when the reported total is exhausted", async () => {
        getTransactionsMock.mockResolvedValueOnce(page([], 1_000));
        await expect(fetchRecentDashboardTransactions([], [])).resolves.toEqual([]);
        expect(getTransactionsMock).toHaveBeenCalledTimes(1);

        getTransactionsMock.mockReset();
        const excluded = Array.from({ length: 200 }, (_, index) => transaction(index + 1, { category_id: 7 }));
        getTransactionsMock.mockResolvedValueOnce(page(excluded, 200));
        await expect(fetchRecentDashboardTransactions([7], [])).resolves.toEqual([]);
        expect(getTransactionsMock).toHaveBeenCalledTimes(1);
    });

    it("stops on a short page and propagates request failures", async () => {
        getTransactionsMock.mockResolvedValueOnce(page([transaction(1)], 1_000));
        await expect(fetchRecentDashboardTransactions([], [])).resolves.toEqual([transaction(1)]);
        expect(getTransactionsMock).toHaveBeenCalledTimes(1);

        getTransactionsMock.mockReset();
        getTransactionsMock.mockRejectedValueOnce(new Error("network failed"));
        await expect(fetchRecentDashboardTransactions([], [])).rejects.toThrow("network failed");
    });
});
