import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { useExcludedIds } from '@/hooks/useExcludedIds';

export interface NetHistoryPoint {
  year: number;
  month: number;
  net: number;
}

interface FilteredDashboardStats {
  totalTransactions: number;
  monthlyIncome: number;
  monthlySpending: number;
  netBalance: number;
  netHistory: NetHistoryPoint[];
}

const NET_HISTORY_MONTHS = 12;

/**
 * Hook that applies dashboard settings to statistics calculations.
 *
 * Phase 2 (dashboard perf): reads the server-side aggregation envelope
 * `/api/aggregations/monthly-summary`, which already applies category and
 * recipient exclusions. Client-side transaction pagination + re-filtering
 * have been removed.
 */
export function useFilteredDashboardStats() {
  const { appSettings } = useAppSettings();
  const targetCurrency = appSettings.defaultCurrency || 'EUR';

  // Shared resolution of excluded category/recipient IDs (incl. hidden categories)
  // so the dashboard, statistics page, and net-summary card all exclude the same
  // set — see useExcludedIds for why this was centralized.
  const { excludedCategoryIds, excludedRecipientIds, isReady } = useExcludedIds('dashboard');

  // Derive a stable, minimal cache key from the *resolved* exclusion set so the
  // query refetches when the effective exclusions change (hidden categories
  // included) but not on unrelated settings (language, theme, …).
  const queryKey = [
    'filteredDashboardStats',
    targetCurrency,
    excludedCategoryIds,
    excludedRecipientIds,
  ] as const;

  return useQuery<FilteredDashboardStats>({
    queryKey,
    // Wait until hidden-category resolution has settled, otherwise the first
    // run would omit hidden categories and momentarily show wrong totals.
    enabled: isReady,
    queryFn: async () => {
      // Fetch total transaction count from the transaction-count endpoint.
      // This card reflects the DB total independent of dashboard filtering.
      const countData = await apiClient.getTransactionCount();

      const envelope = await apiClient.getAggregationMonthlySummary({
        excluded_category_ids: excludedCategoryIds.length > 0 ? excludedCategoryIds : undefined,
        excluded_recipient_ids: excludedRecipientIds.length > 0 ? excludedRecipientIds : undefined,
        currency: targetCurrency,
      });

      // Use the most recent month with data to keep cards aligned with actual latest activity.
      const monthsWithData = envelope.data.months
        .filter((month) => month.transaction_count > 0)
        .sort((a, b) => a.year - b.year || a.month - b.month);

      const latest = monthsWithData[monthsWithData.length - 1];

      const netHistory: NetHistoryPoint[] = monthsWithData
        .slice(-NET_HISTORY_MONTHS)
        .map((m) => ({
          year: m.year,
          month: m.month,
          net: m.total_income - Math.abs(m.total_spending),
        }));

      if (!latest) {
        return {
          totalTransactions: countData.total_transactions,
          monthlyIncome: 0,
          monthlySpending: 0,
          netBalance: 0,
          netHistory,
        };
      }

      // Server stores spending as negative; surface as positive magnitude.
      const monthlyIncome = latest.total_income;
      const monthlySpending = Math.abs(latest.total_spending);
      const netBalance = monthlyIncome - monthlySpending;

      return {
        totalTransactions: countData.total_transactions,
        monthlyIncome,
        monthlySpending,
        netBalance,
        netHistory,
      };
    },
    staleTime: 30000, // Consider data fresh for 30 seconds
    // Do not refetch on window focus — the dashboard has its own staleTime and
    // refetching on every alt-tab creates unnecessary API load.
    refetchOnWindowFocus: false,
  });
}
