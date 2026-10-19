// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { delay, http } from "msw";
import { server } from "@/test/msw/server";
import { computeTaxStub, err, ok } from "@/test/msw/handlers";
import { apiClient } from "@/lib/api";
import { SettingsPreloadProvider } from "@/contexts/SettingsPreloadContext";
import {
    BelgianTaxProfileProvider,
    useBelgianTaxProfile,
} from "@/contexts/BelgianTaxProfileContext";
import {
    TAX_COMPUTE_DEBOUNCE_MS,
    useTaxYearFigures,
} from "@/hooks/useBelgianTaxComputation";
import type { BelgianTaxHouseholdV2 } from "@/lib/belgianTax/householdTypes";

const API_BASE = "http://localhost:3002";

function wrapper({ children }: { children: ReactNode }) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return (
        <QueryClientProvider client={queryClient}>
            <SettingsPreloadProvider>
                <BelgianTaxProfileProvider>{children}</BelgianTaxProfileProvider>
            </SettingsPreloadProvider>
        </QueryClientProvider>
    );
}

function useLiveYear() {
    const state = useBelgianTaxProfile((s) => ({
        isLoading: s.isLoading,
        year: s.viewedYear,
        updateProfile: s.updateProfile,
    }));
    return { state, figures: useTaxYearFigures(state.year) };
}

/** Records the gross income of every household POSTed to the compute route. */
function recordComputeRequests(options: { delayMs?: number } = {}) {
    const incomes: number[] = [];
    server.use(
        http.post(`${API_BASE}/api/belgian-tax/compute`, async ({ request }) => {
            const { household } = (await request.json()) as {
                household: BelgianTaxHouseholdV2;
            };
            incomes.push(household.partners[0]?.activities[0]?.grossIncome ?? 0);
            if (options.delayMs !== undefined && options.delayMs > 0)
                await delay(options.delayMs);
            return ok(computeTaxStub(household));
        }),
    );
    return incomes;
}

describe("useTaxYearFigures", () => {
    beforeEach(() => {
        vi.spyOn(apiClient, "saveSettings").mockResolvedValue(undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it("shows the overview's figures for the hydrated household without a compute request", async () => {
        const incomes = recordComputeRequests();
        const { result } = renderHook(useLiveYear, { wrapper });
        await waitFor(() => expect(result.current.state.isLoading).toBe(false));
        expect(result.current.figures.isPending).toBe(false);
        expect(result.current.figures.calculation.grossIncome).toBe(0);
        expect(incomes).toEqual([]);
    });

    it("computes the last of a burst of edits once, after the debounce", async () => {
        const incomes = recordComputeRequests();
        const { result } = renderHook(useLiveYear, { wrapper });
        await waitFor(() => expect(result.current.state.isLoading).toBe(false));
        act(() => result.current.state.updateProfile({ grossAnnualIncome: 41_000 }));
        act(() => result.current.state.updateProfile({ grossAnnualIncome: 41_500 }));
        act(() => result.current.state.updateProfile({ grossAnnualIncome: 42_000 }));
        await waitFor(() =>
            expect(result.current.figures.calculation.grossIncome).toBe(42_000),
        );
        expect(incomes).toEqual([42_000]);
    });

    it("keeps the previous figures on screen while the server computes an edit", async () => {
        recordComputeRequests({ delayMs: 150 });
        const { result } = renderHook(useLiveYear, { wrapper });
        await waitFor(() => expect(result.current.state.isLoading).toBe(false));
        act(() => result.current.state.updateProfile({ grossAnnualIncome: 50_000 }));
        await waitFor(() =>
            expect(result.current.figures.calculation.grossIncome).toBe(50_000),
        );
        act(() => result.current.state.updateProfile({ grossAnnualIncome: 60_000 }));
        await act(async () => {
            await new Promise((resolve) =>
                setTimeout(resolve, TAX_COMPUTE_DEBOUNCE_MS + 50),
            );
        });
        expect(result.current.figures.isComputing).toBe(true);
        expect(result.current.figures.isPending).toBe(false);
        expect(result.current.figures.calculation.grossIncome).toBe(50_000);
        await waitFor(() =>
            expect(result.current.figures.calculation.grossIncome).toBe(60_000),
        );
    });

    it("never lets a slower response for an older edit replace the current figures", { timeout: 20_000 }, async () => {
        const incomes: number[] = [];
        server.use(
            http.post(`${API_BASE}/api/belgian-tax/compute`, async ({ request }) => {
                const { household } = (await request.json()) as {
                    household: BelgianTaxHouseholdV2;
                };
                const income = household.partners[0]?.activities[0]?.grossIncome ?? 0;
                incomes.push(income);
                // The first edit answers long after the second one.
                await delay(income === 70_000 ? 600 : 10);
                return ok(computeTaxStub(household));
            }),
        );
        const { result } = renderHook(useLiveYear, { wrapper });
        await waitFor(() => expect(result.current.state.isLoading).toBe(false));
        act(() => result.current.state.updateProfile({ grossAnnualIncome: 70_000 }));
        await waitFor(() => expect(incomes).toContain(70_000), { timeout: 5000 });
        act(() => result.current.state.updateProfile({ grossAnnualIncome: 80_000 }));
        await waitFor(() =>
            expect(result.current.figures.calculation.grossIncome).toBe(80_000),
            { timeout: 5000 },
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 700));
        });
        expect(result.current.figures.calculation.grossIncome).toBe(80_000);
    });

    it("reports a failed computation", async () => {
        server.use(
            http.post(`${API_BASE}/api/belgian-tax/compute`, () =>
                err(500, "engine unavailable"),
            ),
        );
        const { result } = renderHook(useLiveYear, { wrapper });
        await waitFor(() => expect(result.current.state.isLoading).toBe(false));
        act(() => result.current.state.updateProfile({ grossAnnualIncome: 30_000 }));
        await waitFor(() => expect(result.current.figures.error).not.toBeNull(), {
            timeout: 3000,
        });
        expect(result.current.figures.isPending).toBe(true);
    });
});
