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

describe("recorded income attributed to partners (ADR-201)", () => {
    const INCOME_CATEGORY = 7;
    const period = `${LIVE_YEAR}-03`;

    function statsWithRecordedIncome(owners?: { partner?: number; joint?: number }) {
        vi.mocked(useStatistics).mockReturnValue({
            data: {
                totalIncome: 74_000,
                monthlyData: [{ period, income: 74_000 }],
                yearlyComparison: [{ year: LIVE_YEAR, totalIncome: 74_000 }],
                categoryPivot: [
                    {
                        categoryId: INCOME_CATEGORY,
                        categoryPathIds: [INCOME_CATEGORY],
                        incomeMonths: { [period]: 74_000 },
                        ...(owners
                            ? { incomeByOwnerMonths: { [period]: owners } }
                            : {}),
                    },
                ],
            },
            isError: false,
            isLoading: false,
        } as never);
    }

    function hydrate(withPartnerB: boolean) {
        const household = married(
            [{ ...activity("employee", PARTNER_A_GROSS), id: "act_A_1" }],
            [activity("employee", 22_000)],
            { taxYear: LIVE_YEAR, taxIncomeCategoryIds: [INCOME_CATEGORY] },
        );
        if (!withPartnerB) household.partners = household.partners.slice(0, 1);
        useSettingsStore.getState()._hydrate(runtime, household, {}, {});
    }

    it("taxes each partner on their recorded share", () => {
        hydrate(true);
        // 20 000 on partner accounts + half of 4 000 joint = 22 000 for B, 52 000 for A:
        // exactly the live household, so the bar equals the overview total.
        statsWithRecordedIncome({ partner: 20_000, joint: 4_000 });
        const { result } = renderHook(() => useTaxOverviewData());
        expect(result.current.recordedIncomeByPartner).toEqual({
            A: 52_000,
            B: 22_000,
        });
        const liveBar = result.current.yearlyIncome.find(
            (bar) => bar.year === String(LIVE_YEAR),
        );
        expect(liveBar?.estimatedTax).toBeCloseTo(
            useSettingsStore.getState().calculation.totalPIT,
            6,
        );
        const reserve = result.current.monthlyIncomeTax.reduce(
            (sum, m) => sum + m.estimatedTax,
            0,
        );
        expect(reserve).toBeCloseTo(liveBar!.estimatedTax, 6);
    });

    it("keeps the whole recorded income on partner A without partner B", () => {
        hydrate(false);
        statsWithRecordedIncome({ partner: 20_000, joint: 4_000 });
        const attributed = renderHook(() => useTaxOverviewData()).result.current;
        statsWithRecordedIncome();
        const plain = renderHook(() => useTaxOverviewData()).result.current;
        expect(attributed.recordedIncomeByPartner).toBeUndefined();
        expect(attributed.yearlyIncome).toEqual(plain.yearlyIncome);
        expect(attributed.monthlyIncomeTax).toEqual(plain.monthlyIncomeTax);
    });
});
