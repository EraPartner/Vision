// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api";
import { insightsKeys } from "@/lib/queryKeys";
import {
    useBulkUpdateTransactions,
    useCreateTransaction,
    useDeleteTransaction,
    useUpdateTransaction,
} from "@/hooks/useTransactions";
import {
    createLanguageQueryWrapper,
    createTestQueryClient,
} from "@/test/queryWrapper";
import type { Transaction } from "@/types/api";

vi.mock("sonner", () => ({
    toast: {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
    },
}));

afterEach(() => vi.restoreAllMocks());

async function expectDigestInvalidated(
    mutate: () => void,
    isSuccess: () => boolean,
    invalidateSpy: ReturnType<typeof vi.spyOn>,
) {
    act(mutate);
    await waitFor(() => expect(isSuccess()).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: insightsKeys.digest,
    });
}

describe("transaction mutation Insights invalidation", () => {
    it("invalidates after create", async () => {
        vi.spyOn(apiClient, "createTransaction").mockResolvedValue({
            id: 10,
            amount: -5,
        } as Transaction);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const { result } = renderHook(() => useCreateTransaction(), {
            wrapper: createLanguageQueryWrapper(queryClient),
        });

        await expectDigestInvalidated(
            () => result.current.mutate({ amount: -5 } as never),
            () => result.current.isSuccess,
            invalidateSpy,
        );
    });

    it("invalidates after update", async () => {
        vi.spyOn(apiClient, "updateTransaction").mockResolvedValue({
            id: 10,
            amount: -6,
        } as Transaction);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const { result } = renderHook(() => useUpdateTransaction(), {
            wrapper: createLanguageQueryWrapper(queryClient),
        });

        await expectDigestInvalidated(
            () => result.current.mutate({ id: 10, data: { amount: -6 } }),
            () => result.current.isSuccess,
            invalidateSpy,
        );
    });

    it("invalidates after delete", async () => {
        vi.spyOn(apiClient, "deleteTransaction").mockResolvedValue(undefined);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const { result } = renderHook(() => useDeleteTransaction(), {
            wrapper: createLanguageQueryWrapper(queryClient),
        });

        await expectDigestInvalidated(
            () => result.current.mutate(10),
            () => result.current.isSuccess,
            invalidateSpy,
        );
    });

    it("invalidates after bulk update", async () => {
        vi.spyOn(apiClient, "bulkUpdateTransactions").mockResolvedValue({
            updated: 1,
            requested: 1,
            matched: 1,
        });
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const { result } = renderHook(() => useBulkUpdateTransactions(), {
            wrapper: createLanguageQueryWrapper(queryClient),
        });

        await expectDigestInvalidated(
            () =>
                result.current.mutate({
                    ids: [10],
                    fields: { is_active: false },
                }),
            () => result.current.isSuccess,
            invalidateSpy,
        );
    });
});
