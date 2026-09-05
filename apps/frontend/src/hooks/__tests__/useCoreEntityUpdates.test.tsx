// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import { useUpdateCategory } from "@/hooks/useCategories";
import { useUpdateRecipient } from "@/hooks/useRecipients";
import { createLanguageQueryWrapper } from "@/test/queryWrapper";

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("core entity update receipts", () => {
    it("invalidates categories and confirms the update", async () => {
        const invalidateSpy = vi.spyOn(
            QueryClient.prototype,
            "invalidateQueries",
        );
        vi.spyOn(apiClient, "updateCategory").mockResolvedValue({
            id: 3,
        } as never);
        const { result } = renderHook(() => useUpdateCategory(), {
            wrapper: createLanguageQueryWrapper(),
        });

        await act(async () => {
            await result.current.mutateAsync({
                id: 3,
                data: { detail: "Food" } as never,
            });
        });

        expect(invalidateSpy).toHaveBeenCalledWith({
            queryKey: ["categories"],
        });
        expect(toast.success).toHaveBeenCalledWith("Category updated");
    });

    it("invalidates recipients and confirms the update", async () => {
        const invalidateSpy = vi.spyOn(
            QueryClient.prototype,
            "invalidateQueries",
        );
        vi.spyOn(apiClient, "updateRecipient").mockResolvedValue({
            id: 4,
        } as never);
        const { result } = renderHook(() => useUpdateRecipient(), {
            wrapper: createLanguageQueryWrapper(),
        });

        await act(async () => {
            await result.current.mutateAsync({
                id: 4,
                data: { name: "Bakery" } as never,
            });
        });

        expect(invalidateSpy).toHaveBeenCalledWith({
            queryKey: ["recipients"],
        });
        expect(toast.success).toHaveBeenCalledWith("Recipient updated");
    });
});
