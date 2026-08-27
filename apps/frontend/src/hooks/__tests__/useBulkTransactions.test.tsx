// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createLanguageQueryWrapper } from "@/test/queryWrapper";
import { apiClient } from "@/lib/api";
import { ApiClientError } from "@/lib/api/client";
import en from "@/locales/en";
import {
    useBulkDeleteTransactions,
    useBulkUpdateTransactions,
    useBulkExportTransactions,
} from "@/hooks/useTransactions";

vi.mock("sonner", () => ({
    toast: {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
    },
}));
import { toast } from "sonner";

// jsdom does not implement createObjectURL / revokeObjectURL — stub them so the
// download trigger inside the export hook does not throw.
if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:mock";
}
if (typeof URL.revokeObjectURL !== "function") {
    URL.revokeObjectURL = () => undefined;
}

const makeWrapper = createLanguageQueryWrapper;

afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
});

/** Title + description of the most recent `toast.error(...)` call. */
function lastErrorToast(): { title: unknown; description: unknown } {
    const call = vi.mocked(toast.error).mock.calls.at(-1);
    return {
        title: call?.[0],
        description: (call?.[1] as { description?: unknown } | undefined)
            ?.description,
    };
}

describe("useBulkDeleteTransactions", () => {
    it("calls apiClient.bulkDeleteTransactions with the selector and reports the count", async () => {
        const spy = vi
            .spyOn(apiClient, "bulkDeleteTransactions")
            .mockResolvedValue({ deleted: 3, requested: 3, matched: 3 });

        const { result } = renderHook(() => useBulkDeleteTransactions(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            result.current.mutate({ ids: [1, 2, 3] });
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith({ ids: [1, 2, 3] });
        expect(result.current.data).toEqual({
            deleted: 3,
            requested: 3,
            matched: 3,
        });
        expect(toast.success).toHaveBeenCalledWith("Deleted 3 transactions");
    });

    it("uses singular copy for one deleted transaction", async () => {
        vi.spyOn(apiClient, "bulkDeleteTransactions").mockResolvedValue({
            deleted: 1,
            requested: 1,
            matched: 1,
        });
        const { result } = renderHook(() => useBulkDeleteTransactions(), {
            wrapper: makeWrapper(),
        });

        await act(async () => result.current.mutate({ ids: [1] }));

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(toast.success).toHaveBeenCalledWith("Deleted 1 transaction");
    });

    it("surfaces backend errors", async () => {
        vi.spyOn(apiClient, "bulkDeleteTransactions").mockRejectedValue(
            new Error("boom"),
        );

        const { result } = renderHook(() => useBulkDeleteTransactions(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            result.current.mutate({ ids: [1] });
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.error).toEqual(new Error("boom"));
    });

    it("reports selection drift separately from write-time disappearance", async () => {
        vi.spyOn(apiClient, "bulkDeleteTransactions").mockResolvedValue({
            deleted: 7,
            requested: 10,
            matched: 8,
        });

        const { result } = renderHook(() => useBulkDeleteTransactions(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            result.current.mutate({
                filter: { search: "coffee" },
                expected_count: 10,
            });
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(toast.success).toHaveBeenCalledWith(
            "Deleted 7 transactions — the selection changed from 10 to 8",
        );
    });

    it("reports rows that disappeared after an unchanged selection was resolved", async () => {
        vi.spyOn(apiClient, "bulkDeleteTransactions").mockResolvedValue({
            deleted: 2,
            requested: 3,
            matched: 3,
        });

        const { result } = renderHook(() => useBulkDeleteTransactions(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            result.current.mutate({ ids: [1, 2, 3] });
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(toast.success).toHaveBeenCalledWith(
            "Deleted 2 of 3 transactions — 1 no longer matched",
        );
    });

    // The bulk endpoints are POST, so a dead backend surfaces the browser's raw
    // TypeError ("Failed to fetch" / "Load failed" / "NetworkError…") and a 5xx
    // surfaces "Request failed (status 500)". Neither may reach the toast.
    it("shows humanized network copy instead of the browser's raw fetch error", async () => {
        vi.spyOn(apiClient, "bulkDeleteTransactions").mockRejectedValue(
            new TypeError("Failed to fetch"),
        );

        const { result } = renderHook(() => useBulkDeleteTransactions(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            result.current.mutate({ ids: [1] });
        });

        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        const { title, description } = lastErrorToast();
        expect(title).toBe(en["txPage.bulk.failed"]); // title copy is unchanged
        expect(description).toBe(en["apiError.network"]);
        expect(description).not.toBe("Failed to fetch");
    });

    it("shows humanized server copy instead of the status-only 5xx fallback", async () => {
        vi.spyOn(apiClient, "bulkDeleteTransactions").mockRejectedValue(
            new ApiClientError({
                status: 500,
                code: "INTERNAL_SERVER_ERROR",
                message: "Request failed (status 500)",
            }),
        );

        const { result } = renderHook(() => useBulkDeleteTransactions(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            result.current.mutate({ ids: [1] });
        });

        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        const { description } = lastErrorToast();
        expect(description).toBe(en["apiError.server"]);
        expect(description).not.toContain("status 500");
    });

    it("keeps a backend-authored 4xx detail verbatim", async () => {
        vi.spyOn(apiClient, "bulkDeleteTransactions").mockRejectedValue(
            new ApiClientError({
                status: 409,
                code: "CONFLICT",
                message:
                    "Some of these transactions are locked by an open import.",
            }),
        );

        const { result } = renderHook(() => useBulkDeleteTransactions(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            result.current.mutate({ ids: [1] });
        });

        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(lastErrorToast().description).toBe(
            "Some of these transactions are locked by an open import.",
        );
    });
});

describe("useBulkUpdateTransactions", () => {
    it("forwards the fields object verbatim and exposes the count", async () => {
        const spy = vi
            .spyOn(apiClient, "bulkUpdateTransactions")
            .mockResolvedValue({ updated: 5, requested: 5, matched: 5 });

        const { result } = renderHook(() => useBulkUpdateTransactions(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            result.current.mutate({
                ids: [1, 2, 3, 4, 5],
                fields: { is_active: false },
            });
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith({
            ids: [1, 2, 3, 4, 5],
            fields: { is_active: false },
        });
        expect(result.current.data).toEqual({
            updated: 5,
            requested: 5,
            matched: 5,
        });
        expect(toast.success).toHaveBeenCalledWith("Updated 5 transactions");
    });

    it("uses singular copy for one updated transaction", async () => {
        vi.spyOn(apiClient, "bulkUpdateTransactions").mockResolvedValue({
            updated: 1,
            requested: 1,
            matched: 1,
        });
        const { result } = renderHook(() => useBulkUpdateTransactions(), {
            wrapper: makeWrapper(),
        });

        await act(async () =>
            result.current.mutate({
                ids: [1],
                fields: { is_active: false },
            }),
        );

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(toast.success).toHaveBeenCalledWith("Updated 1 transaction");
    });

    it("reports filter selection drift", async () => {
        vi.spyOn(apiClient, "bulkUpdateTransactions").mockResolvedValue({
            updated: 4,
            requested: 5,
            matched: 4,
        });

        const { result } = renderHook(() => useBulkUpdateTransactions(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            result.current.mutate({
                filter: { active: true },
                expected_count: 5,
                fields: { is_active: false },
            });
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(toast.success).toHaveBeenCalledWith(
            "Updated 4 transactions — the selection changed from 5 to 4",
        );
    });
});

describe("useBulkExportTransactions", () => {
    it("calls apiClient.bulkExportTransactions with format and selector", async () => {
        const blob = new Blob(["a,b,c"], { type: "text/csv" });
        const spy = vi
            .spyOn(apiClient, "bulkExportTransactions")
            .mockResolvedValue({ blob, exported: 1 });

        const { result } = renderHook(() => useBulkExportTransactions(), {
            wrapper: makeWrapper(),
        });
        await act(async () => {
            result.current.mutate({ ids: [1], format: "csv" });
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith({ ids: [1], format: "csv" });
        expect(toast.success).toHaveBeenCalledWith("Exported 1 transaction");
    });
});
