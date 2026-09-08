// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("@/stores/hydration/AppSettingsHydration", () => ({
    useAppSettings: () => ({ appSettings: { defaultCurrency: "USD" } }),
}));
vi.mock("@/hooks/useExcludedIds", () => ({
    useExcludedIds: () => ({
        excludedCategoryIds: [7],
        excludedRecipientIds: [8],
        exclusionsApply: true,
        isReady: true,
    }),
}));
vi.mock("@/lib/api/aggregations", () => ({
    getAggregationMonthlySummary: vi.fn().mockResolvedValue({ data: {} }),
    getAggregationCategoryPivot: vi.fn().mockResolvedValue({ data: {} }),
    getAggregationRecipientInsights: vi.fn().mockResolvedValue({ data: {} }),
    getAggregationRecipientByYear: vi.fn().mockResolvedValue({ data: {} }),
}));

import { useQuery } from "@tanstack/react-query";
import {
    getAggregationCategoryPivot,
    getAggregationMonthlySummary,
    getAggregationRecipientByYear,
    getAggregationRecipientInsights,
} from "@/lib/api/aggregations";
import { aggregationKeys } from "@/lib/queryKeys";
import { useRecipientInsights, useStatistics } from "../useStatistics";

interface CapturedQueryOptions {
    queryKey: readonly unknown[];
    queryFn: () => Promise<unknown>;
    enabled?: boolean;
    staleTime?: number;
}

describe("useStatistics filtered queries", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-07T12:00:00"));
        vi.clearAllMocks();
        vi.mocked(useQuery).mockReturnValue({
            data: undefined,
            error: null,
            isError: false,
            isLoading: false,
        } as never);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("preserves all four keys, exclusion arguments, and shared query policy", async () => {
        renderHook(() => useStatistics());

        const filtered = vi
            .mocked(useQuery)
            .mock.calls.map(
                ([options]) => options as unknown as CapturedQueryOptions,
            )
            .filter(({ enabled }) => enabled === true);

        expect(filtered).toHaveLength(4);
        expect(filtered.map(({ queryKey }) => queryKey)).toEqual([
            aggregationKeys.monthlySummaryFiltered("USD", [7], [8], "24m"),
            aggregationKeys.categoryPivotFiltered("USD", [7], [8], "24m"),
            aggregationKeys.recipientByYearFiltered("USD", [7], [8], "24m"),
            aggregationKeys.recipientInsightsFiltered("USD", [7], [8], "24m"),
        ]);
        expect(filtered.every(({ staleTime }) => staleTime === 60_000)).toBe(
            true,
        );

        await Promise.all(filtered.map(({ queryFn }) => queryFn()));

        const exclusions = {
            excluded_category_ids: [7],
            excluded_recipient_ids: [8],
        };
        const dateRange = {
            start_date: "2024-10-01",
            end_date: "2026-09-07",
        };
        expect(getAggregationMonthlySummary).toHaveBeenCalledWith({
            currency: "USD",
            ...dateRange,
            ...exclusions,
        });
        expect(getAggregationCategoryPivot).toHaveBeenCalledWith({
            currency: "USD",
            ...dateRange,
            ...exclusions,
        });
        expect(getAggregationRecipientByYear).toHaveBeenCalledWith({
            currency: "USD",
            ...dateRange,
            excluded_recipient_ids: [8],
            excluded_category_ids: [7],
        });
        expect(getAggregationRecipientInsights).toHaveBeenCalledWith({
            currency: "USD",
            ...dateRange,
            ...exclusions,
        });
    });

    it("uses the explicit all-time contract without date bounds", async () => {
        renderHook(() => useStatistics("all"));

        const calls = vi
            .mocked(useQuery)
            .mock.calls.map(
                ([options]) => options as unknown as CapturedQueryOptions,
            );
        await Promise.all(calls.map(({ queryFn }) => queryFn()));

        expect(getAggregationMonthlySummary).toHaveBeenCalledWith({
            currency: "USD",
            all_time: true,
        });
        expect(getAggregationCategoryPivot).toHaveBeenCalledWith({
            currency: "USD",
            all_time: true,
        });
        expect(getAggregationRecipientByYear).toHaveBeenCalledWith({
            currency: "USD",
            all_time: true,
        });
        expect(getAggregationRecipientInsights).toHaveBeenCalledWith({
            currency: "USD",
            all_time: true,
        });
    });
});

describe("useRecipientInsights window", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-07T12:00:00"));
        vi.clearAllMocks();
        vi.mocked(useQuery).mockReturnValue({ data: undefined } as never);
    });

    afterEach(() => vi.useRealTimers());

    it("keys and requests the selected 24-month window", async () => {
        renderHook(() => useRecipientInsights("USD", [7], [8], "24m"));
        const options = vi.mocked(useQuery).mock
            .calls[0][0] as unknown as CapturedQueryOptions;

        expect(options.queryKey).toEqual(
            aggregationKeys.recipientInsightsWithExclusions(
                "USD",
                [7],
                [8],
                "24m",
            ),
        );
        await options.queryFn();
        expect(getAggregationRecipientInsights).toHaveBeenCalledWith({
            currency: "USD",
            start_date: "2024-10-01",
            end_date: "2026-09-07",
            excluded_category_ids: [7],
            excluded_recipient_ids: [8],
        });
    });
});
