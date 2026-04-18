import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useSettings } from '@/contexts/SettingsContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';

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
  const { settings } = useSettings();
  const { appSettings } = useAppSettings();
  const targetCurrency = appSettings.defaultCurrency || 'EUR';

  // Check if exclusions should apply to dashboard
  const exclusionsApply =
    settings.exclusionScope === 'everywhere' || settings.exclusionScope === 'dashboard';

  // Derive a stable, minimal cache key that only includes the settings fields that
  // actually affect this query's output.  Using the entire `settings` object caused
  // cache misses on every unrelated setting change (language, theme, etc.).
  const queryKey = [
    'filteredDashboardStats',
    targetCurrency,
    exclusionsApply,
    exclusionsApply ? settings.excludedCategoryIds : [],
    exclusionsApply ? settings.excludedRecipientIds : [],
    exclusionsApply ? settings.excludeHiddenCategories : false,
  ] as const;

  return useQuery<FilteredDashboardStats>({
    queryKey,
    queryFn: async () => {
      // Fetch total transaction count from the transaction-count endpoint.
      // This card reflects the DB total independent of dashboard filtering.
      const countData = await apiClient.getTransactionCount();

      // Resolve hidden category IDs if needed
      let hiddenCategoryIds: number[] = [];
      if (exclusionsApply && settings.excludeHiddenCategories) {
        const categoriesData = await apiClient.getCategories({ limit: 1000 });
        hiddenCategoryIds = categoriesData.items
          .filter((cat) => !cat.is_active)
          .map((cat) => cat.id);
      }

      const allExcludedCategoryIds = exclusionsApply
        ? [...settings.excludedCategoryIds, ...hiddenCategoryIds]
        : [];
      const allExcludedRecipientIds = exclusionsApply ? settings.excludedRecipientIds : [];

      const envelope = await apiClient.getAggregationMonthlySummary({
        excluded_category_ids:
          allExcludedCategoryIds.length > 0 ? allExcludedCategoryIds : undefined,
        excluded_recipient_ids:
          allExcludedRecipientIds.length > 0 ? allExcludedRecipientIds : undefined,
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
