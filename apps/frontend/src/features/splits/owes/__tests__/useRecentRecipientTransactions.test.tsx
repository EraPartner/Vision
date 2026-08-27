// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRecentRecipientTransactions } from "@/features/splits/owes/useRecentRecipientTransactions";
import { apiClient } from "@/lib/api";
import { createQueryWrapper } from "@/test/queryWrapper";
import type { Transaction, TransactionsListResponse } from "@/types/api";

const transaction = (id: number): Transaction => ({
    id,
    transaction_date: `2026-08-${String(id).padStart(2, "0")}`,
    memo: `Transaction ${id}`,
    amount: id,
    currency: "EUR",
} as Transaction);

const response = (ids: number[], total?: number): TransactionsListResponse => ({
    items: ids.map(transaction),
    ...(total === undefined ? {} : { total }),
    limit: 10,
    offset: 0,
    links: [],
} as TransactionsListResponse);

afterEach(() => vi.restoreAllMocks());

describe("useRecentRecipientTransactions", () => {
    it("loads the first recipient-group page and derives hasMore from the body total", async () => {
        const getTransactions = vi.spyOn(apiClient, "getTransactions")
            .mockResolvedValue(response([1, 2], 5));

        const { result } = renderHook(
            () => useRecentRecipientTransactions(42),
            { wrapper: createQueryWrapper() },
        );

        await waitFor(() => expect(result.current.items).toHaveLength(2));
        expect(result.current.totalItems).toBe(5);
        expect(result.current.hasMore).toBe(true);
        expect(getTransactions).toHaveBeenCalledWith({
            recipient_group_id: 42,
            limit: 10,
            offset: 0,
            sort_by: "transaction_date",
            sort_dir: "desc",
        });
    });

    it("advances by raw page length, suppresses duplicate ids, and stops at total", async () => {
        const firstPageIds = Array.from({ length: 10 }, (_, index) => index + 1);
        const getTransactions = vi.spyOn(apiClient, "getTransactions")
            .mockResolvedValueOnce(response(firstPageIds, 12))
            .mockResolvedValueOnce(response([10, 11, 12], 12));

        const { result } = renderHook(
            () => useRecentRecipientTransactions(7),
            { wrapper: createQueryWrapper() },
        );

        await waitFor(() => expect(result.current.items).toHaveLength(10));
        await act(async () => result.current.loadMore());

        expect(getTransactions).toHaveBeenLastCalledWith({
            recipient_group_id: 7,
            limit: 10,
            offset: 10,
            sort_by: "transaction_date",
            sort_dir: "desc",
        });
        expect(result.current.items.map((item) => item.id)).toEqual([
            ...firstPageIds,
            11,
            12,
        ]);
        expect(result.current.totalItems).toBe(12);
        expect(result.current.hasMore).toBe(false);

        await act(async () => result.current.loadMore());
        expect(getTransactions).toHaveBeenCalledTimes(2);
    });

    it("guards concurrent load-more requests", async () => {
        let resolveNextPage!: (value: ReturnType<typeof response>) => void;
        const nextPage = new Promise<ReturnType<typeof response>>((resolve) => {
            resolveNextPage = resolve;
        });
        const getTransactions = vi.spyOn(apiClient, "getTransactions")
            .mockResolvedValueOnce(response(Array.from({ length: 10 }, (_, index) => index + 1), 20))
            .mockReturnValueOnce(nextPage);

        const { result } = renderHook(
            () => useRecentRecipientTransactions(9),
            { wrapper: createQueryWrapper() },
        );

        await waitFor(() => expect(result.current.items).toHaveLength(10));
        let firstLoad!: Promise<void>;
        let secondLoad!: Promise<void>;
        act(() => {
            firstLoad = result.current.loadMore();
            secondLoad = result.current.loadMore();
        });
        expect(getTransactions).toHaveBeenCalledTimes(2);

        resolveNextPage(response([11], 20));
        await act(async () => Promise.all([firstLoad, secondLoad]));
        expect(result.current.items).toHaveLength(11);
    });

    it("falls back to page length when total is absent", async () => {
        vi.spyOn(apiClient, "getTransactions").mockResolvedValue(response([1]));

        const { result } = renderHook(
            () => useRecentRecipientTransactions(5),
            { wrapper: createQueryWrapper() },
        );

        await waitFor(() => expect(result.current.items).toHaveLength(1));
        expect(result.current.totalItems).toBe(1);
        expect(result.current.hasMore).toBe(false);
    });
});
