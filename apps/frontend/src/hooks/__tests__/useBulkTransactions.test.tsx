// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { type ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api";
import {
    useBulkDeleteTransactions,
    useBulkUpdateTransactions,
    useBulkExportTransactions,
} from "@/hooks/useTransactions";

// jsdom does not implement createObjectURL / revokeObjectURL — stub them so the
// download trigger inside the export hook does not throw.
if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:mock";
}
if (typeof URL.revokeObjectURL !== "function") {
    URL.revokeObjectURL = () => undefined;
}

function makeWrapper() {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    });
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

afterEach(() => vi.restoreAllMocks());

describe("useBulkDeleteTransactions", () => {
    it("calls apiClient.bulkDeleteTransactions with the selector and reports the count", async () => {
        const spy = vi
            .spyOn(apiClient, "bulkDeleteTransactions")
            .mockResolvedValue({ deleted: 3 });

        const { result } = renderHook(() => useBulkDeleteTransactions(), { wrapper: makeWrapper() });
        await act(async () => {
            result.current.mutate({ ids: [1, 2, 3] });
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith({ ids: [1, 2, 3] });
        expect(result.current.data).toEqual({ deleted: 3 });
    });

    it("surfaces backend errors", async () => {
        vi.spyOn(apiClient, "bulkDeleteTransactions").mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() => useBulkDeleteTransactions(), { wrapper: makeWrapper() });
        await act(async () => {
            result.current.mutate({ ids: [1] });
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.error).toEqual(new Error("boom"));
    });
});

describe("useBulkUpdateTransactions", () => {
    it("forwards the fields object verbatim and exposes the count", async () => {
        const spy = vi
            .spyOn(apiClient, "bulkUpdateTransactions")
            .mockResolvedValue({ updated: 5 });

        const { result } = renderHook(() => useBulkUpdateTransactions(), { wrapper: makeWrapper() });
        await act(async () => {
            result.current.mutate({ ids: [1, 2, 3, 4, 5], fields: { is_active: false } });
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith({ ids: [1, 2, 3, 4, 5], fields: { is_active: false } });
        expect(result.current.data).toEqual({ updated: 5 });
    });
});

describe("useBulkExportTransactions", () => {
    it("calls apiClient.bulkExportTransactions with format and selector", async () => {
        const blob = new Blob(["a,b,c"], { type: "text/csv" });
        const spy = vi.spyOn(apiClient, "bulkExportTransactions").mockResolvedValue(blob);

        const { result } = renderHook(() => useBulkExportTransactions(), { wrapper: makeWrapper() });
        await act(async () => {
            result.current.mutate({ ids: [1], format: "csv" });
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith({ ids: [1], format: "csv" });
    });
});
