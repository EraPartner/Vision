// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { type ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useSavedCharts, useCreateSavedChart, useUpdateSavedChart, useDeleteSavedChart } from "@/hooks/useSavedCharts";
import { useOllamaStatus, useOllamaModels } from "@/hooks/useOllamaStatus";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import type { SavedChart } from "@/lib/api";

function makeQueryWrapper() {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    });
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    };
}

function makeFullWrapper() {
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

const CHART_STUB: SavedChart = {
    id: 1,
    name: "Monthly Income",
    chart_type: "bar",
    chart_variant: "default",
    time_bucket: "monthly",
    category_ids: [],
    recipient_ids: [],
    date_range_start: null,
    date_range_end: null,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
};

afterEach(() => vi.restoreAllMocks());

describe("useBankAccounts", () => {
    it("starts in loading state", () => {
        vi.spyOn(apiClient, "getDistinctBankAccounts").mockResolvedValue({ banks: [] });
        const { result } = renderHook(() => useBankAccounts(), { wrapper: makeQueryWrapper() });
        expect(result.current.isLoading).toBe(true);
    });

    it("returns bank accounts on success", async () => {
        vi.spyOn(apiClient, "getDistinctBankAccounts").mockResolvedValue({ banks: ["BE123", "BE456"] });
        const { result } = renderHook(() => useBankAccounts(), { wrapper: makeQueryWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data?.banks).toEqual(["BE123", "BE456"]);
    });

    it("exposes error on failure", async () => {
        vi.spyOn(apiClient, "getDistinctBankAccounts").mockRejectedValue(new Error("fail"));
        const { result } = renderHook(() => useBankAccounts(), { wrapper: makeQueryWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
    });
});

describe("useSavedCharts", () => {
    it("returns charts on success", async () => {
        vi.spyOn(apiClient, "getSavedCharts").mockResolvedValue([CHART_STUB]);
        const { result } = renderHook(() => useSavedCharts(), { wrapper: makeQueryWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toEqual([CHART_STUB]);
    });
});

describe("useCreateSavedChart", () => {
    it("calls apiClient.createSavedChart with payload", async () => {
        const spy = vi.spyOn(apiClient, "createSavedChart").mockResolvedValue(CHART_STUB);
        vi.spyOn(apiClient, "getSavedCharts").mockResolvedValue([]);
        const { result } = renderHook(() => useCreateSavedChart(), { wrapper: makeFullWrapper() });
        await act(async () => {
            result.current.mutate({
                name: "Monthly Income",
                chartType: "bar",
                chartVariant: "default",
                timeBucket: "monthly",
                categoryIds: [],
                recipientIds: [],
            });
        });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledOnce();
    });
});

describe("useUpdateSavedChart", () => {
    it("calls apiClient.updateSavedChart with id and payload", async () => {
        const spy = vi.spyOn(apiClient, "updateSavedChart").mockResolvedValue(CHART_STUB);
        vi.spyOn(apiClient, "getSavedCharts").mockResolvedValue([]);
        const { result } = renderHook(() => useUpdateSavedChart(), { wrapper: makeFullWrapper() });
        await act(async () => {
            result.current.mutate({ id: 1, name: "Updated Chart" });
        });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith(1, { name: "Updated Chart" });
    });
});

describe("useDeleteSavedChart", () => {
    it("calls apiClient.deleteSavedChart with id", async () => {
        const spy = vi.spyOn(apiClient, "deleteSavedChart").mockResolvedValue(undefined);
        vi.spyOn(apiClient, "getSavedCharts").mockResolvedValue([]);
        const { result } = renderHook(() => useDeleteSavedChart(), { wrapper: makeFullWrapper() });
        await act(async () => {
            result.current.mutate(1);
        });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(spy).toHaveBeenCalledWith(1);
    });
});

describe("useOllamaStatus", () => {
    it("returns status on success", async () => {
        vi.spyOn(apiClient, "getOllamaStatus").mockResolvedValue({
            ok: true,
            baseUrl: "http://localhost:11434",
            defaultModel: "llama3",
            enabled: true,
        });
        const { result } = renderHook(() => useOllamaStatus(), { wrapper: makeQueryWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data?.ok).toBe(true);
    });
});

describe("useOllamaModels", () => {
    it("skips fetch when enabled=false", () => {
        const spy = vi.spyOn(apiClient, "getOllamaModels").mockResolvedValue([]);
        renderHook(() => useOllamaModels(false), { wrapper: makeQueryWrapper() });
        expect(spy).not.toHaveBeenCalled();
    });

    it("fetches models when enabled=true", async () => {
        vi.spyOn(apiClient, "getOllamaModels").mockResolvedValue([{ name: "llama3", modified: "", size: 0 }]);
        const { result } = renderHook(() => useOllamaModels(true), { wrapper: makeQueryWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toHaveLength(1);
    });
});

describe("useCurrencyConverter", () => {
    it("returns convertToTarget and ratesToEur", async () => {
        vi.spyOn(apiClient, "getExchangeRates").mockResolvedValue({
            total_rates: 1,
            rates: [{ currency: "USD", rate_to_eur: 0.9, rate_date: "2025-01-01", fetched_at: "2025-01-01T00:00:00.000Z" }],
            fallback_rates: {},
        });
        const { result } = renderHook(() => useCurrencyConverter("EUR"), { wrapper: makeQueryWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.ratesToEur["USD"]).toBe(0.9);
    });

    it("converts USD to EUR correctly", async () => {
        vi.spyOn(apiClient, "getExchangeRates").mockResolvedValue({
            total_rates: 1,
            rates: [{ currency: "USD", rate_to_eur: 0.9, rate_date: "2025-01-01", fetched_at: "2025-01-01T00:00:00.000Z" }],
            fallback_rates: {},
        });
        const { result } = renderHook(() => useCurrencyConverter("EUR"), { wrapper: makeQueryWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        // 10 USD * 0.9 (USD→EUR) / 1 (EUR→EUR) = 9
        expect(result.current.convertToTarget(10, "USD")).toBeCloseTo(9);
    });

    it("returns same amount for same-currency conversion", async () => {
        vi.spyOn(apiClient, "getExchangeRates").mockResolvedValue({
            total_rates: 0,
            rates: [],
            fallback_rates: {},
        });
        const { result } = renderHook(() => useCurrencyConverter("EUR"), { wrapper: makeQueryWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.convertToTarget(100, "EUR")).toBe(100);
    });
});
