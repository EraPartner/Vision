// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import { useShallow } from "zustand/react/shallow";

vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock("@/contexts/BelgianTaxProfileContext", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    return {
        useBelgianTaxProfile: (selector: (state: unknown) => unknown) =>
            useSettingsStore(useShallow((state) => selector(state))),
    };
});

vi.mock("@/hooks/useDebounce", () => ({
    useDebounce: <T,>(value: T) => value,
}));

vi.mock("@/hooks/useAvailableTaxYears", () => ({
    useAvailableTaxYears: vi.fn(),
}));

vi.mock("@/hooks/useCurrencyFormatter", () => ({
    useCurrencyFormatter: () => (value: number) => `EUR ${value.toFixed(0)}`,
    usePercentFormatter: () => (value: number) => `${value.toFixed(1)}%`,
}));

vi.mock("@/stores/hydration/AppSettingsHydration", () => ({
    useAppSettings: () => ({ appSettings: { defaultCurrency: "EUR" } }),
}));

vi.mock("@/hooks/useCurrencyConverter", () => ({
    useCurrencyConverter: () => ({
        convertToTarget: (value: number) => value,
    }),
}));

vi.mock("@/hooks/usePortfolio", () => ({
    usePortfolio: () => ({ allSummaries: [] }),
}));

vi.mock("@/hooks/useStatistics", () => ({
    useStatistics: vi.fn(),
}));

import { useSettingsStore } from "@/stores/settingsStore";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@/stores/belgianTaxStore";
import * as runtime from "@/lib/belgianTax/householdRuntime";
import { computeBelgianPIT } from "@/lib/belgianTax/pit";
import { useAvailableTaxYears } from "@/hooks/useAvailableTaxYears";
import { useStatistics } from "@/hooks/useStatistics";
import { useTaxOverviewData } from "@/hooks/useTaxOverviewData";
import { MultiYearTrendStrip } from "../MultiYearTrendStrip";
import { activity, married } from "@/lib/belgianTax/__tests__/testHousehold";

const LIVE_YEAR = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
const PARTNER_A_GROSS = 52_000;

function hydrateTwoPartnerHousehold() {
    const household = married(
        [{ ...activity("employee", PARTNER_A_GROSS), id: "act_A_1" }],
        [activity("employee", 22_000)],
        { taxYear: LIVE_YEAR },
    );
    useSettingsStore.getState()._hydrate(runtime, household, {}, {});
}

describe("two-partner household totals", () => {
    beforeEach(() => {
        hydrateTwoPartnerHousehold();
        vi.mocked(useAvailableTaxYears).mockReturnValue(
            [LIVE_YEAR, LIVE_YEAR - 1].map((year) => ({
                year,
                isCurrent: year === LIVE_YEAR,
                hasSnapshot: false,
                hasTransactions: true,
                isFiled: false,
                hasFrozenCalculation: false,
            })),
        );
        vi.mocked(useStatistics).mockReturnValue({
            data: {
                totalIncome: PARTNER_A_GROSS,
                monthlyData: [],
                yearlyComparison: [
                    { year: LIVE_YEAR, totalIncome: PARTNER_A_GROSS },
                ],
                categoryPivot: [],
            },
            isError: false,
            isLoading: false,
        } as never);
    });

    it("differs from the v1 engine on the projection (the case under test)", () => {
        const state = useSettingsStore.getState();
        expect(
            Math.abs(
                state.calculation.totalPIT -
                    computeBelgianPIT(state.profile).totalPIT,
            ),
        ).toBeGreaterThan(1);
    });

    it("gives the trend strip's live tile the overview total", () => {
        const overviewTotal =
            useSettingsStore.getState().calculation.totalPIT;
        render(<MultiYearTrendStrip />);
        expect(
            screen.getAllByText(`EUR ${overviewTotal.toFixed(0)}`),
        ).not.toHaveLength(0);
    });

    it("gives the yearly chart's live bar the overview total", () => {
        const { result } = renderHook(() => useTaxOverviewData());
        const liveBar = result.current.yearlyIncome.find(
            (bar) => bar.year === String(LIVE_YEAR),
        );
        expect(result.current.calculation.totalPIT).toBe(
            useSettingsStore.getState().calculation.totalPIT,
        );
        expect(liveBar?.estimatedTax).toBeCloseTo(
            result.current.calculation.totalPIT,
            6,
        );
    });
});
