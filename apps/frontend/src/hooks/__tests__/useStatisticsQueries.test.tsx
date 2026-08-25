// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("@/contexts/AppSettingsContext", () => ({
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
import { useStatistics } from "../useStatistics";

interface CapturedQueryOptions {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  enabled?: boolean;
  staleTime?: number;
}

describe("useStatistics filtered queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useQuery).mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isLoading: false,
    } as never);
  });

  it("preserves all four keys, exclusion arguments, and shared query policy", async () => {
    renderHook(() => useStatistics());

    const filtered = vi.mocked(useQuery).mock.calls
      .map(([options]) => options as unknown as CapturedQueryOptions)
      .filter(({ enabled }) => enabled === true);

    expect(filtered).toHaveLength(4);
    expect(filtered.map(({ queryKey }) => queryKey)).toEqual([
      aggregationKeys.monthlySummaryFiltered("USD", [7], [8]),
      aggregationKeys.categoryPivotFiltered("USD", [7], [8]),
      aggregationKeys.recipientByYearFiltered("USD", [7], [8]),
      aggregationKeys.recipientInsightsFiltered("USD", [7], [8]),
    ]);
    expect(filtered.every(({ staleTime }) => staleTime === 60_000)).toBe(true);

    await Promise.all(filtered.map(({ queryFn }) => queryFn()));

    const exclusions = {
      excluded_category_ids: [7],
      excluded_recipient_ids: [8],
    };
    expect(getAggregationMonthlySummary).toHaveBeenCalledWith({
      currency: "USD",
      all_time: true,
      ...exclusions,
    });
    expect(getAggregationCategoryPivot).toHaveBeenCalledWith({
      currency: "USD",
      ...exclusions,
    });
    expect(getAggregationRecipientByYear).toHaveBeenCalledWith({
      currency: "USD",
      excluded_recipient_ids: [8],
      excluded_category_ids: [7],
    });
    expect(getAggregationRecipientInsights).toHaveBeenCalledWith({
      currency: "USD",
      ...exclusions,
    });
  });
});
