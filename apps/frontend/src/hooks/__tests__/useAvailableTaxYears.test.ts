// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/contexts/BelgianTaxProfileContext", () => ({
    useBelgianTaxProfile: vi.fn(),
}));
vi.mock("@/hooks/usePortfolio", () => ({
    usePortfolio: vi.fn(),
}));
vi.mock("@/hooks/useStatistics", () => ({
    useStatistics: vi.fn(),
}));

import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useStatistics } from "@/hooks/useStatistics";
import { useAvailableTaxYears } from "@/hooks/useAvailableTaxYears";

const mockedProfileCtx = vi.mocked(useBelgianTaxProfile);
const mockedPortfolio = vi.mocked(usePortfolio);
const mockedStats = vi.mocked(useStatistics);

function setMocks({
    taxYear = 2026,
    snapshotYears = [] as number[],
    filedYears = [] as number[],
    frozenYears = [] as number[],
    metaOnlyYears = [] as number[],
    taxIncomeCategoryIds = [] as number[],
    portfolioTxns = [] as Array<{
        date: string;
        taxes?: number;
        fees?: number;
        type?: string;
    }>,
    pivot = [] as Array<{
        categoryId: number | null;
        incomeMonths: Record<string, number>;
    }>,
} = {}) {
    const snapshots: Record<number, unknown> = {};
    for (const y of snapshotYears) snapshots[y] = { taxYear: y };
    const snapshotMetas: Record<
        number,
        { filing?: object; frozenCalculation?: object }
    > = {};
    for (const y of filedYears)
        snapshotMetas[y] = { filing: { filedAt: "2024-01-01T00:00:00Z" } };
    for (const y of frozenYears) {
        snapshotMetas[y] = {
            ...(snapshotMetas[y] ?? {}),
            frozenCalculation: {},
        };
    }
    for (const y of metaOnlyYears) {
        snapshotMetas[y] = { ...(snapshotMetas[y] ?? {}) };
    }
    mockedProfileCtx.mockImplementation((selector) =>
        selector({
            profile: { taxYear, taxIncomeCategoryIds },
            snapshots,
            snapshotMetas,
        } as never),
    );
    mockedPortfolio.mockReturnValue({
        summaries: [{ transactions: portfolioTxns }],
    } as unknown as ReturnType<typeof usePortfolio>);
    mockedStats.mockReturnValue({
        data: { categoryPivot: pivot },
    } as unknown as ReturnType<typeof useStatistics>);
}

describe("useAvailableTaxYears", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("always includes the active year flagged as current", () => {
        setMocks({ taxYear: 2026 });
        const { result } = renderHook(() => useAvailableTaxYears());
        expect(result.current).toEqual([
            {
                year: 2026,
                isCurrent: true,
                hasSnapshot: false,
                hasTransactions: false,
                isFiled: false,
                hasFrozenCalculation: false,
            },
        ]);
    });

    it("includes snapshot years, sorted descending", () => {
        setMocks({ taxYear: 2026, snapshotYears: [2023, 2024, 2025] });
        const { result } = renderHook(() => useAvailableTaxYears());
        expect(result.current.map((y) => y.year)).toEqual([
            2026, 2025, 2024, 2023,
        ]);
        expect(result.current.find((y) => y.year === 2024)?.hasSnapshot).toBe(
            true,
        );
        expect(result.current.find((y) => y.year === 2026)?.hasSnapshot).toBe(
            false,
        );
    });

    it("adds years from portfolio transactions with taxes or fees", () => {
        setMocks({
            taxYear: 2026,
            portfolioTxns: [
                { date: "2022-03-01", taxes: 50 },
                { date: "2021-07-15", fees: 12 },
                { date: "2020-01-01", taxes: 0, fees: 0 }, // ignored, no tax/fee
                { date: "2024-08-08", type: "tax", taxes: 0 },
            ],
        });
        const { result } = renderHook(() => useAvailableTaxYears());
        const years = result.current.map((y) => y.year);
        expect(years).toContain(2022);
        expect(years).toContain(2021);
        expect(years).toContain(2024);
        expect(years).not.toContain(2020);
        expect(
            result.current.find((y) => y.year === 2022)?.hasTransactions,
        ).toBe(true);
    });

    it("adds years from taxable-income category pivot when categories are configured", () => {
        setMocks({
            taxYear: 2026,
            taxIncomeCategoryIds: [10],
            pivot: [
                {
                    categoryId: 10,
                    incomeMonths: { "2022-04": 3000, "2023-12": 4000 },
                },
                { categoryId: 99, incomeMonths: { "2019-01": 5000 } }, // not flagged → skip
                { categoryId: null, incomeMonths: { "2018-01": 100 } }, // null id → skip
            ],
        });
        const { result } = renderHook(() => useAvailableTaxYears());
        const years = result.current.map((y) => y.year);
        expect(years).toContain(2022);
        expect(years).toContain(2023);
        expect(years).not.toContain(2019);
        expect(years).not.toContain(2018);
    });

    it("ignores taxable-income pivot when no categories are configured", () => {
        setMocks({
            taxYear: 2026,
            taxIncomeCategoryIds: [],
            pivot: [{ categoryId: 10, incomeMonths: { "2022-04": 3000 } }],
        });
        const { result } = renderHook(() => useAvailableTaxYears());
        expect(result.current.map((y) => y.year)).toEqual([2026]);
    });

    it("ignores zero-income months in the pivot", () => {
        setMocks({
            taxYear: 2026,
            taxIncomeCategoryIds: [10],
            pivot: [{ categoryId: 10, incomeMonths: { "2022-04": 0 } }],
        });
        const { result } = renderHook(() => useAvailableTaxYears());
        expect(result.current.map((y) => y.year)).toEqual([2026]);
    });

    it("deduplicates across all sources and marks each year accurately", () => {
        setMocks({
            taxYear: 2026,
            snapshotYears: [2024],
            taxIncomeCategoryIds: [10],
            pivot: [{ categoryId: 10, incomeMonths: { "2024-05": 4000 } }],
            portfolioTxns: [{ date: "2024-11-01", taxes: 5 }],
        });
        const { result } = renderHook(() => useAvailableTaxYears());
        const y2024 = result.current.find((y) => y.year === 2024);
        expect(y2024).toEqual({
            year: 2024,
            isCurrent: false,
            hasSnapshot: true,
            hasTransactions: true,
            isFiled: false,
            hasFrozenCalculation: false,
        });
    });

    it("flags filed and frozen years from meta", () => {
        setMocks({
            taxYear: 2026,
            snapshotYears: [2024, 2023],
            filedYears: [2024],
            frozenYears: [2024, 2023],
        });
        const { result } = renderHook(() => useAvailableTaxYears());
        const y2024 = result.current.find((y) => y.year === 2024);
        const y2023 = result.current.find((y) => y.year === 2023);
        expect(y2024?.isFiled).toBe(true);
        expect(y2024?.hasFrozenCalculation).toBe(true);
        expect(y2023?.isFiled).toBe(false);
        expect(y2023?.hasFrozenCalculation).toBe(true);
    });

    it("includes years that have meta but no snapshot (rare migration edge)", () => {
        setMocks({ taxYear: 2026, metaOnlyYears: [2019] });
        const { result } = renderHook(() => useAvailableTaxYears());
        expect(result.current.map((y) => y.year)).toEqual([2026, 2019]);
    });

    it("tolerates missing date / malformed period strings", () => {
        setMocks({
            taxYear: 2026,
            taxIncomeCategoryIds: [10],
            pivot: [
                { categoryId: 10, incomeMonths: { junk: 100, "2023-02": 50 } },
            ],
            portfolioTxns: [
                { date: "", taxes: 1 } as { date: string; taxes: number },
                { date: "2025-03-03", fees: 2 },
            ],
        });
        const { result } = renderHook(() => useAvailableTaxYears());
        const years = result.current.map((y) => y.year);
        expect(years).toEqual([2026, 2025, 2023]);
    });
});
