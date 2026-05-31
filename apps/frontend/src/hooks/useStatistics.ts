import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, useCallback } from 'react';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { useExcludedIds } from '@/hooks/useExcludedIds';
import {
  getAggregationMonthlySummary,
  getAggregationCategoryPivot,
  getAggregationRecipientInsights,
  getAggregationRecipientByYear,
  type CategoryPivotItem,
  type RecipientYearlySpending,
} from '@/lib/api/aggregations';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MonthlyData {
  period: string;
  year: number;
  month: number;
  income: number;
  spending: number;
  net: number;
  transactionCount: number;
}

interface CategoryMonthlyData {
  categoryName: string;
  categoryId: number | null;
  months: Record<string, number>;
  incomeMonths: Record<string, number>;
  expenseMonths: Record<string, number>;
  netMonths: Record<string, number>;
  total: number;
  incomeTotal: number;
  expenseTotal: number;
  netTotal: number;
}

interface RecipientSpending {
  name: string;
  total: number;
  count: number;
}

interface YearlyComparison {
  year: number;
  totalIncome: number;
  totalSpending: number;
  net: number;
  transactionCount: number;
}

export interface StatisticsData {
  monthlyData: MonthlyData[];
  categoryPivot: CategoryMonthlyData[];
  topRecipients: RecipientSpending[];
  topRecipientsByYear: Record<string, RecipientSpending[]>;
  yearlyComparison: YearlyComparison[];
  allPeriods: string[];
  allYears: number[];
  totalIncome: number;
  totalSpending: number;
  averageMonthlySpending: number;
  averageMonthlyIncome: number;
}

export type GraphExclusions = Record<string, boolean>;

// ── Payload aliases ───────────────────────────────────────────────────────────

type MonthlySummaryPayload = Awaited<ReturnType<typeof getAggregationMonthlySummary>>['data'];
type CategoryPivotPayload = Awaited<ReturnType<typeof getAggregationCategoryPivot>>['data'];
type RecipientInsightsPayload = Awaited<ReturnType<typeof getAggregationRecipientInsights>>['data'];
type RecipientByYearPayload = Awaited<ReturnType<typeof getAggregationRecipientByYear>>['data'];

// ── Pure mapping function ─────────────────────────────────────────────────────

export function mapToStatisticsData(
  monthlySummary: MonthlySummaryPayload,
  categoryPivotPayload: CategoryPivotPayload,
  recipientInsights: RecipientInsightsPayload,
  recipientByYear: RecipientByYearPayload,
): StatisticsData {
  const monthlyData: MonthlyData[] = (monthlySummary.months ?? [])
    .map((m) => ({
      period: `${m.year}-${String(m.month).padStart(2, '0')}`,
      year: m.year,
      month: m.month,
      income: m.total_income,
      spending: Math.abs(m.total_spending),
      net: m.net_amount,
      transactionCount: m.transaction_count,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));

  const yearMap = new Map<number, YearlyComparison>();
  for (const m of monthlyData) {
    if (!yearMap.has(m.year)) {
      yearMap.set(m.year, { year: m.year, totalIncome: 0, totalSpending: 0, net: 0, transactionCount: 0 });
    }
    const yd = yearMap.get(m.year)!;
    yd.totalIncome += m.income;
    yd.totalSpending += m.spending;
    yd.net += m.net;
    yd.transactionCount += m.transactionCount;
  }
  const yearlyComparison = Array.from(yearMap.values()).sort((a, b) => a.year - b.year);

  const catMap = new Map<string | number, CategoryMonthlyData>();
  for (const [period, items] of Object.entries(categoryPivotPayload.categoryPivot ?? {})) {
    for (const item of items as CategoryPivotItem[]) {
      const key = item.categoryId ?? 'null';
      if (!catMap.has(key)) {
        catMap.set(key, {
          categoryName: item.categoryName,
          categoryId: item.categoryId,
          months: {},
          incomeMonths: {},
          expenseMonths: {},
          netMonths: {},
          total: 0,
          incomeTotal: 0,
          expenseTotal: 0,
          netTotal: 0,
        });
      }
      const cd = catMap.get(key)!;
      const absTotal = Math.abs(item.total);
      const expenseAmount = item.total < 0 ? absTotal : 0;
      const incomeAmount = item.total > 0 ? item.total : 0;
      cd.months[period] = (cd.months[period] ?? 0) + absTotal;
      cd.expenseMonths[period] = (cd.expenseMonths[period] ?? 0) + expenseAmount;
      cd.incomeMonths[period] = (cd.incomeMonths[period] ?? 0) + incomeAmount;
      cd.netMonths[period] = (cd.netMonths[period] ?? 0) + item.total;
      cd.total += absTotal;
      cd.expenseTotal += expenseAmount;
      cd.incomeTotal += incomeAmount;
      cd.netTotal += item.total;
    }
  }
  const categoryPivot = Array.from(catMap.values()).sort((a, b) => b.total - a.total);

  const topRecipients: RecipientSpending[] = (recipientInsights.topMerchants ?? [])
    .slice(0, 20)
    .map((m) => ({ name: m.name, total: m.totalSpend, count: m.transactionCount }));

  const topRecipientsByYear: Record<string, RecipientSpending[]> = Object.fromEntries(
    Object.entries(recipientByYear.recipientsByYear ?? {}).map(([year, recs]) => [
      year,
      (recs as RecipientYearlySpending[]).map((r) => ({
        name: r.name,
        total: r.totalSpend,
        count: r.transactionCount,
      })),
    ]),
  );

  const allPeriods = monthlyData.map((m) => m.period);
  const allYears = yearlyComparison.map((y) => y.year);
  const totalIncome = monthlyData.reduce((s, m) => s + m.income, 0);
  const totalSpending = monthlyData.reduce((s, m) => s + m.spending, 0);
  const monthCount = monthlyData.length || 1;

  return {
    monthlyData,
    categoryPivot,
    topRecipients,
    topRecipientsByYear,
    yearlyComparison,
    allPeriods,
    allYears,
    totalIncome,
    totalSpending,
    averageMonthlySpending: totalSpending / monthCount,
    averageMonthlyIncome: totalIncome / monthCount,
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useStatistics() {
  const { appSettings } = useAppSettings();
  const targetCurrency = appSettings.defaultCurrency || 'EUR';

  const [graphExclusions, setGraphExclusions] = useState<GraphExclusions>({});

  const toggleGraphExclusion = useCallback((graphKey: string) => {
    setGraphExclusions((prev) => ({
      ...prev,
      [graphKey]: !(prev[graphKey] ?? true),
    }));
  }, []);

  // Excluded IDs (settings + hidden categories) resolved by the shared hook so
  // statistics and the dashboard exclude exactly the same set — see useExcludedIds.
  const {
    excludedCategoryIds: effectiveExcludedCategoryIds,
    excludedRecipientIds: settingsExcludedRecIds,
    exclusionsApply,
    isReady,
  } = useExcludedIds('statistics');

  const hasExclusions =
    effectiveExcludedCategoryIds.length > 0 || settingsExcludedRecIds.length > 0;

  // Gate on isReady so the filtered queries don't fire with an incomplete
  // hidden-category set on the first render.
  const filteredEnabled = exclusionsApply && hasExclusions && isReady;

  // ── Unfiltered queries ────────────────────────────────────────────────────

  const monthlySummaryUnfilteredQuery = useQuery({
    queryKey: ['aggregations', 'monthly-summary', 'unfiltered', targetCurrency],
    queryFn: () => getAggregationMonthlySummary({ currency: targetCurrency, all_time: true }),
    staleTime: 60_000,
  });

  const categoryPivotUnfilteredQuery = useQuery({
    queryKey: ['aggregations', 'category-pivot', 'unfiltered', targetCurrency],
    queryFn: () => getAggregationCategoryPivot({ currency: targetCurrency }),
    staleTime: 60_000,
  });

  const recipientInsightsQuery = useQuery({
    queryKey: ['aggregations', 'recipient-insights', targetCurrency],
    queryFn: () => getAggregationRecipientInsights({ currency: targetCurrency }),
    staleTime: 60_000,
  });

  const recipientByYearUnfilteredQuery = useQuery({
    queryKey: ['aggregations', 'recipient-by-year', 'unfiltered', targetCurrency],
    queryFn: () => getAggregationRecipientByYear({ currency: targetCurrency }),
    staleTime: 60_000,
  });

  // ── Filtered queries (only when exclusions are active) ────────────────────

  const monthlySummaryFilteredQuery = useQuery({
    queryKey: [
      'aggregations', 'monthly-summary', 'filtered',
      targetCurrency, effectiveExcludedCategoryIds, settingsExcludedRecIds,
    ],
    queryFn: () =>
      getAggregationMonthlySummary({
        currency: targetCurrency,
        all_time: true,
        excluded_category_ids: effectiveExcludedCategoryIds,
        excluded_recipient_ids: settingsExcludedRecIds,
      }),
    enabled: filteredEnabled,
    staleTime: 60_000,
  });

  const categoryPivotFilteredQuery = useQuery({
    queryKey: [
      'aggregations', 'category-pivot', 'filtered',
      targetCurrency, effectiveExcludedCategoryIds, settingsExcludedRecIds,
    ],
    queryFn: () =>
      getAggregationCategoryPivot({
        currency: targetCurrency,
        excluded_category_ids: effectiveExcludedCategoryIds,
        excluded_recipient_ids: settingsExcludedRecIds,
      }),
    enabled: filteredEnabled,
    staleTime: 60_000,
  });

  const recipientByYearFilteredQuery = useQuery({
    queryKey: [
      'aggregations', 'recipient-by-year', 'filtered',
      targetCurrency, settingsExcludedRecIds,
    ],
    queryFn: () =>
      getAggregationRecipientByYear({
        currency: targetCurrency,
        excluded_recipient_ids: settingsExcludedRecIds,
      }),
    enabled: filteredEnabled && settingsExcludedRecIds.length > 0,
    staleTime: 60_000,
  });

  // ── Map to StatisticsData ─────────────────────────────────────────────────

  const unfilteredReady =
    monthlySummaryUnfilteredQuery.data != null &&
    categoryPivotUnfilteredQuery.data != null &&
    recipientInsightsQuery.data != null &&
    recipientByYearUnfilteredQuery.data != null;

  const stats = useMemo(() => {
    if (!unfilteredReady) return null;

    const unfilteredData = mapToStatisticsData(
      monthlySummaryUnfilteredQuery.data!.data,
      categoryPivotUnfilteredQuery.data!.data,
      recipientInsightsQuery.data!.data,
      recipientByYearUnfilteredQuery.data!.data,
    );

    if (!filteredEnabled || !monthlySummaryFilteredQuery.data || !categoryPivotFilteredQuery.data) {
      return { filtered: unfilteredData, unfiltered: unfilteredData };
    }

    const filteredData = mapToStatisticsData(
      monthlySummaryFilteredQuery.data.data,
      categoryPivotFilteredQuery.data.data,
      recipientInsightsQuery.data!.data,
      (recipientByYearFilteredQuery.data ?? recipientByYearUnfilteredQuery.data!).data,
    );

    return { filtered: filteredData, unfiltered: unfilteredData };
  }, [
    unfilteredReady,
    monthlySummaryUnfilteredQuery.data,
    categoryPivotUnfilteredQuery.data,
    recipientInsightsQuery.data,
    recipientByYearUnfilteredQuery.data,
    filteredEnabled,
    monthlySummaryFilteredQuery.data,
    categoryPivotFilteredQuery.data,
    recipientByYearFilteredQuery.data,
  ]);

  const getGraphData = useCallback(
    (graphKey: string): StatisticsData | null => {
      if (!stats) return null;
      const useExclusions = graphExclusions[graphKey] ?? true;
      return useExclusions ? stats.filtered : stats.unfiltered;
    },
    [stats, graphExclusions],
  );

  const isLoading =
    monthlySummaryUnfilteredQuery.isLoading ||
    categoryPivotUnfilteredQuery.isLoading ||
    recipientInsightsQuery.isLoading ||
    recipientByYearUnfilteredQuery.isLoading;

  const isError =
    monthlySummaryUnfilteredQuery.isError ||
    categoryPivotUnfilteredQuery.isError ||
    recipientInsightsQuery.isError ||
    recipientByYearUnfilteredQuery.isError;

  const error =
    monthlySummaryUnfilteredQuery.error ??
    categoryPivotUnfilteredQuery.error ??
    recipientInsightsQuery.error ??
    recipientByYearUnfilteredQuery.error;

  return {
    data: stats?.filtered ?? null,
    unfilteredData: stats?.unfiltered ?? null,
    getGraphData,
    graphExclusions,
    toggleGraphExclusion,
    exclusionsApply,
    isLoading,
    isError,
    error,
  };
}
