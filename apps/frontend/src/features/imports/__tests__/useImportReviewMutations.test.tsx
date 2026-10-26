// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "@/test/queryWrapper";
import { apiClient } from "@/lib/api";
import { useImportReviewMutations } from "../useImportReviewData";
import { asCategoryId } from "@vision/types/brands";
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));
afterEach(() => vi.restoreAllMocks());

describe("import review write ordering", () => {
    it("waits for a pending category override before committing", async () => {
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const order: string[] = [];
        vi.spyOn(apiClient, "overrideImportRowCategory").mockImplementation(
            async () => {
                await pending;
                order.push("override");
                return {} as never;
            },
        );
        vi.spyOn(apiClient, "commitImportBatch").mockImplementation(
            () => {
                order.push("commit");
                return Promise.resolve({
                    imported: 1,
                    duplicates: 0,
                    errors: 0,
                } as never);
            },
        );
        const { result } = renderHook(() => useImportReviewMutations(1, 0), {
            wrapper: createQueryWrapper(),
        });
        let edit!: Promise<void>;
        act(() => {
            edit = result.current.overrideCategories(["1"], asCategoryId(2));
            result.current.commit();
        });
        expect(order).toEqual([]);
        await act(async () => {
            finish();
            await edit;
        });
        await waitFor(() => expect(order).toEqual(["override", "commit"]));
    });
    it("blocks commit after partial failure until the saved staging state is explicitly reviewed", async () => {
        vi.spyOn(apiClient, "overrideImportRowCategory").mockImplementation(
            (_batch, row) =>
                row === "2"
                    ? Promise.reject(new Error("failed row"))
                    : Promise.resolve({} as never),
        );
        const commit = vi
            .spyOn(apiClient, "commitImportBatch")
            .mockResolvedValue({
                imported: 2,
                duplicates: 0,
                errors: 0,
            } as never);
        vi.spyOn(apiClient, "getImportPreview").mockResolvedValue({
            groups: [],
            totals: {},
        } as never);
        const { result } = renderHook(() => useImportReviewMutations(1, 0), {
            wrapper: createQueryWrapper(),
        });
        await act(async () => {
            await expect(
                result.current.overrideCategories(["1", "2"], asCategoryId(3)),
            ).rejects.toThrow("failed row");
        });
        expect(result.current.hasEditErrors).toBe(true);
        act(() => result.current.commit());
        await waitFor(() => expect(result.current.isCommitting).toBe(false));
        expect(commit).not.toHaveBeenCalled();
        await act(async () => {
            await result.current.reviewSavedEdits();
        });
        act(() => result.current.commit());
        await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    });
});
