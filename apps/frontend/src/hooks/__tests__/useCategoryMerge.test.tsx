// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper } from "@/test/queryWrapper";
import { useMergeCategoryNode } from "../useCategories";
import { apiClient } from "@/lib/api";
import {
    categoryKeys,
    recipientKeys,
    transactionKeys,
    aggregationKeys,
} from "@/lib/queryKeys";
vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));
afterEach(() => vi.restoreAllMocks());

describe("category merge dependent views", () => {
    it("refreshes mounted category, transaction, recipient and aggregate consumers inside their stale time", async () => {
        let categoryId = 1;
        const readCategory = async () => ({
            categoryId,
            categoryName:
                categoryId === 1 ? "Original category" : "Merged category",
            total: 125,
        });
        vi.spyOn(apiClient, "mergeCategoryNode").mockImplementation(
            async () => {
                categoryId = 2;
                return {} as never;
            },
        );
        const { result } = renderHook(
            () => ({
                merge: useMergeCategoryNode(),
                categories: useQuery({
                    queryKey: categoryKeys.all,
                    queryFn: readCategory,
                    staleTime: Infinity,
                }),
                transactions: useQuery({
                    queryKey: transactionKeys.all,
                    queryFn: readCategory,
                    staleTime: Infinity,
                }),
                recipients: useQuery({
                    queryKey: recipientKeys.all,
                    queryFn: readCategory,
                    staleTime: Infinity,
                }),
                totals: useQuery({
                    queryKey: aggregationKeys.all,
                    queryFn: readCategory,
                    staleTime: Infinity,
                }),
            }),
            { wrapper: createQueryWrapper() },
        );
        await waitFor(() =>
            expect(result.current.recipients.data).toEqual({
                categoryId: 1,
                categoryName: "Original category",
                total: 125,
            }),
        );
        await act(async () => {
            await result.current.merge.mutateAsync({
                sourceId: 1,
                targetId: 2,
            });
        });
        await waitFor(() =>
            expect([
                result.current.categories.data,
                result.current.transactions.data,
                result.current.recipients.data,
                result.current.totals.data,
            ]).toEqual(
                Array.from({ length: 4 }, () => ({
                    categoryId: 2,
                    categoryName: "Merged category",
                    total: 125,
                })),
            ),
        );
    });
});
