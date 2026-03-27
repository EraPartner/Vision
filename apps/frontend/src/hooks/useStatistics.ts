import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useMemo, useState, useCallback } from 'react';
import { useSettings } from '@/contexts/SettingsContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { processTransactions, type StatisticsData } from './statisticsProcessing';

/**
 * Per-graph exclusion override state.
 * Each graph can independently toggle exclusions on/off.
 */
export type GraphExclusions = Record<string, boolean>; // graphKey -> useExclusions (true = apply exclusions)

export function useStatistics() {
  const { settings } = useSettings();
  const { appSettings } = useAppSettings();
  const targetCurrency = appSettings.defaultCurrency || 'EUR';

  // Per-graph override state: defaults to true (apply exclusions) for all graphs
  const [graphExclusions, setGraphExclusions] = useState<GraphExclusions>({});

  const toggleGraphExclusion = useCallback((graphKey: string) => {
    setGraphExclusions(prev => ({
      ...prev,
      [graphKey]: !(prev[graphKey] ?? true),
    }));
  }, []);

  const transactionsQuery = useQuery({
    queryKey: ['transactions', 'all-for-stats', targetCurrency],
    queryFn: async () => {
      const allItems: Awaited<ReturnType<typeof apiClient.getTransactions>>['items'] = [];
      let offset = 0;
      const limit = 1000;
      let total = Infinity;

      while (offset < total) {
        const res = await apiClient.getTransactions({
          limit,
          offset,
          active: true,
          normalize_to_eur: true,
          target_currency: targetCurrency,
        });
        allItems.push(...res.items);
        total = res.total;
        offset += limit;
      }
      return allItems;
    },
    staleTime: 60000,
  });

  const categoriesQuery = useQuery({
    queryKey: ['categories', 'all-for-stats'],
    queryFn: async () => {
      const res = await apiClient.getCategories({ limit: 500 });
      return res.items;
    },
    staleTime: 60000,
  });

  // Check if exclusions should apply to statistics
  const exclusionsApply = settings.exclusionScope === 'everywhere' || settings.exclusionScope === 'statistics';

  // Compute full (with exclusions) and unfiltered stats
  const stats = useMemo(() => {
    if (!transactionsQuery.data || !categoriesQuery.data) return null;

    let hiddenCategoryIds: number[] = [];
    if (settings.excludeHiddenCategories) {
      hiddenCategoryIds = categoriesQuery.data
        .filter((cat) => !cat.is_active)
        .map((cat) => cat.id);
    }

    const excludedCategoryIds = new Set([
      ...settings.excludedCategoryIds,
      ...hiddenCategoryIds,
    ]);
    const excludedRecipientIds = new Set(settings.excludedRecipientIds);

    // Filtered stats (with exclusions)
    const filtered = exclusionsApply
      ? processTransactions(transactionsQuery.data, categoriesQuery.data, excludedCategoryIds, excludedRecipientIds)
      : processTransactions(transactionsQuery.data, categoriesQuery.data, new Set(), new Set());

    // Unfiltered stats (no exclusions) - needed for per-graph toggle
    const unfiltered = exclusionsApply
      ? processTransactions(transactionsQuery.data, categoriesQuery.data, new Set(), new Set())
      : filtered;

    return { filtered, unfiltered };
  }, [transactionsQuery.data, categoriesQuery.data, settings, exclusionsApply]);

  // Helper to get data for a specific graph
  const getGraphData = useCallback((graphKey: string): StatisticsData | null => {
    if (!stats) return null;
    const useExclusions = graphExclusions[graphKey] ?? true;
    return useExclusions ? stats.filtered : stats.unfiltered;
  }, [stats, graphExclusions]);

  return {
    data: stats?.filtered ?? null,
    unfilteredData: stats?.unfiltered ?? null,
    getGraphData,
    graphExclusions,
    toggleGraphExclusion,
    exclusionsApply,
    isLoading: transactionsQuery.isLoading || categoriesQuery.isLoading,
    isError: transactionsQuery.isError || categoriesQuery.isError,
    error: transactionsQuery.error || categoriesQuery.error,
  };
}
