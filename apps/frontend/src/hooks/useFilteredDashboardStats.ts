import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useSettings } from '@/contexts/SettingsContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';

interface FilteredDashboardStats {
  totalTransactions: number;
  monthlyIncome: number;
  monthlySpending: number;
  netBalance: number;
}

/**
 * Hook that applies dashboard settings to statistics calculations.
 * Fetches transactions and filters them based on user-configured exclusions.
 */
export function useFilteredDashboardStats() {
  const { settings } = useSettings();
  const { appSettings } = useAppSettings();
  const targetCurrency = appSettings.defaultCurrency || 'EUR';

  // Check if exclusions should apply to dashboard
  const exclusionsApply = settings.exclusionScope === 'everywhere' || settings.exclusionScope === 'dashboard';

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
      // Fetch total transaction count from the transaction-count endpoint
      const countData = await apiClient.getTransactionCount();

      // Resolve hidden category IDs if needed
      let hiddenCategoryIds: number[] = [];
      if (exclusionsApply && settings.excludeHiddenCategories) {
        const categoriesData = await apiClient.getCategories({ limit: 1000 });
        hiddenCategoryIds = categoriesData.items
          .filter((cat) => !cat.is_active)
          .map((cat) => cat.id);
      }

      const allExcludedCategoryIds = exclusionsApply ? [
        ...settings.excludedCategoryIds,
        ...hiddenCategoryIds,
      ] : [];

      // Fetch monthly financial summary (6 months) with excluded categories
      const monthlySummary = await apiClient.getMonthlyFinancialSummary({
        excluded_category_ids: allExcludedCategoryIds.length > 0 ? allExcludedCategoryIds : undefined,
        currency: targetCurrency,
      });

      // Use the most recent month with data to keep cards aligned with actual latest activity.
      const monthsWithData = monthlySummary.months
        .filter((month) => month.transaction_count > 0)
        .sort((a, b) => (a.year - b.year) || (a.month - b.month));

      const latestMonthWithData = monthsWithData[monthsWithData.length - 1];

      if (!latestMonthWithData) {
        return {
          totalTransactions: countData.total_transactions,
          monthlyIncome: 0,
          monthlySpending: 0,
          netBalance: 0,
        };
      }

      // Compute month totals from live transactions so values stay up-to-date
      // even if materialized views are slightly behind.
      const toIsoDate = (date: Date): string => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };

      const monthStart = new Date(latestMonthWithData.year, latestMonthWithData.month - 1, 1);
      const monthEnd = new Date(latestMonthWithData.year, latestMonthWithData.month, 0);

      const pageSize = 1000;
      let offset = 0;
      const txItems: Array<{ amount: number; amount_eur?: number; category_id?: number; recipient_id?: number }> = [];

      while (true) {
        const page = await apiClient.getTransactions({
          limit: pageSize,
          offset,
          active: true,
          normalize_to_eur: true,
          target_currency: targetCurrency,
          start_date: toIsoDate(monthStart),
          end_date: toIsoDate(monthEnd),
        });

        txItems.push(...page.items);

        offset += page.items.length;
        if (offset >= page.total || page.items.length < pageSize) {
          break;
        }
      }

      const excludedRecipientIds = new Set(settings.excludedRecipientIds);
      const excludedCategoryIds = new Set(allExcludedCategoryIds);

      // Filter transactions based on settings
      const filteredTransactions = txItems.filter((t) => {
        // Exclude if category is in exclusion list
        if (t.category_id && excludedCategoryIds.has(t.category_id)) {
          return false;
        }

        // Exclude if recipient is in exclusion list
        if (t.recipient_id && excludedRecipientIds.has(t.recipient_id)) {
          return false;
        }

        return true;
      });

      // Calculate latest-month statistics from fully filtered transactions
      // so category + recipient exclusions are both respected.
      const amountInEur = (tx: { amount: number; amount_eur?: number }) => (
        tx.amount_eur ?? tx.amount
      );

      let monthlyIncome = 0;
      let monthlySpending = 0;

      filteredTransactions.forEach((t) => {
        const amount = amountInEur(t);
        if (amount >= 0) {
          monthlyIncome += amount;
        } else {
          monthlySpending += Math.abs(amount);
        }
      });

      const netBalance = monthlyIncome - monthlySpending;

      return {
        // Dashboard total transaction count should always reflect DB total,
        // independent of dashboard filtering preferences.
        totalTransactions: countData.total_transactions,
        monthlyIncome,
        monthlySpending,
        netBalance,
      };
    },
    staleTime: 30000, // Consider data fresh for 30 seconds
    // Do not refetch on window focus — the dashboard has its own staleTime and
    // refetching on every alt-tab creates unnecessary API load.
    refetchOnWindowFocus: false,
  });
}
