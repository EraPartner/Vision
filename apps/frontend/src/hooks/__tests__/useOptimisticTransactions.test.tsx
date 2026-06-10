// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { type ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api";
import type { Transaction, TransactionsListResponse } from "@/types/api";
import { useUpdateTransaction, useDeleteTransaction } from "@/hooks/useTransactions";

function makeClient() {
    return new QueryClient({
        // gcTime must outlive the test: seeded caches have no observers and
        // would be garbage-collected instantly with gcTime 0.
        defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
}

function makeWrapper(qc: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <QueryClientProvider client={qc}>
                <LanguageProvider language="en" setLanguage={() => {}}>
                    {children}
                </LanguageProvider>
            </QueryClientProvider>
        );
    };
}

function seedList(): TransactionsListResponse {
    return {
        items: [
            { id: 1, amount: -10, memo: "coffee" },
            { id: 2, amount: -25, memo: "books" },
        ],
        total: 2,
    } as unknown as TransactionsListResponse;
}

const LIST_KEY = ["transactions", { limit: 50 }] as const;
const VIRTUAL_KEY = ["transactions-virtual", { pageSize: 100 }] as const;

afterEach(() => vi.restoreAllMocks());

describe("useUpdateTransaction (optimistic)", () => {
    it("patches all ['transactions'] caches immediately and leaves the virtual cache untouched", async () => {
        const qc = makeClient();
        qc.setQueryData(LIST_KEY, seedList());
        qc.setQueryData(VIRTUAL_KEY, seedList());

        let resolveUpdate!: (tx: Transaction) => void;
        vi.spyOn(apiClient, "updateTransaction").mockImplementation(
            () => new Promise<Transaction>((res) => { resolveUpdate = res; }),
        );

        const { result } = renderHook(() => useUpdateTransaction(), { wrapper: makeWrapper(qc) });
        act(() => {
            result.current.mutate({ id: 1, data: { amount: -42 } });
        });

        await waitFor(() => {
            const list = qc.getQueryData<TransactionsListResponse>(LIST_KEY);
            expect(list?.items.find((tx) => tx.id === 1)?.amount).toBe(-42);
        });
        // Untouched row stays identical; virtual cache is not patched.
        const list = qc.getQueryData<TransactionsListResponse>(LIST_KEY);
        expect(list?.items.find((tx) => tx.id === 2)?.amount).toBe(-25);
        const virtual = qc.getQueryData<TransactionsListResponse>(VIRTUAL_KEY);
        expect(virtual?.items.find((tx) => tx.id === 1)?.amount).toBe(-10);

        resolveUpdate({ id: 1, amount: -42 } as unknown as Transaction);
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    it("rolls the cache back when the server rejects", async () => {
        const qc = makeClient();
        qc.setQueryData(LIST_KEY, seedList());
        vi.spyOn(apiClient, "updateTransaction").mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() => useUpdateTransaction(), { wrapper: makeWrapper(qc) });
        act(() => {
            result.current.mutate({ id: 1, data: { amount: -42 } });
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        const list = qc.getQueryData<TransactionsListResponse>(LIST_KEY);
        expect(list?.items.find((tx) => tx.id === 1)?.amount).toBe(-10);
        expect(list?.total).toBe(2);
    });
});

describe("useDeleteTransaction (optimistic)", () => {
    it("removes the row and decrements total immediately", async () => {
        const qc = makeClient();
        qc.setQueryData(LIST_KEY, seedList());

        let resolveDelete!: () => void;
        vi.spyOn(apiClient, "deleteTransaction").mockImplementation(
            () => new Promise<void>((res) => { resolveDelete = () => res(); }) as ReturnType<typeof apiClient.deleteTransaction>,
        );

        const { result } = renderHook(() => useDeleteTransaction(), { wrapper: makeWrapper(qc) });
        act(() => {
            result.current.mutate(1);
        });

        await waitFor(() => {
            const list = qc.getQueryData<TransactionsListResponse>(LIST_KEY);
            expect(list?.items).toHaveLength(1);
        });
        const list = qc.getQueryData<TransactionsListResponse>(LIST_KEY);
        expect(list?.items[0]?.id).toBe(2);
        expect(list?.total).toBe(1);

        resolveDelete();
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    it("restores the row when the server rejects", async () => {
        const qc = makeClient();
        qc.setQueryData(LIST_KEY, seedList());
        vi.spyOn(apiClient, "deleteTransaction").mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() => useDeleteTransaction(), { wrapper: makeWrapper(qc) });
        act(() => {
            result.current.mutate(1);
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        const list = qc.getQueryData<TransactionsListResponse>(LIST_KEY);
        expect(list?.items).toHaveLength(2);
        expect(list?.total).toBe(2);
    });
});
