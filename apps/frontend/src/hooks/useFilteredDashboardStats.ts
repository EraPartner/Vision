import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useSettings } from '@/contexts/SettingsContext';

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

  // Check if exclusions should apply to dashboard
  const exclusionsApply = settings.exclusionScope === 'everywhere' || settings.exclusionScope === 'dashboard';

  // Derive a stable, minimal cache key that only includes the settings fields that
  // actually affect this query's output.  Using the entire `settings` object caused
  // cache misses on every unrelated setting change (language, theme, etc.).
  const queryKey = [
    'filteredDashboardStats',
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

      // Use previous calendar month for "last month" cards.
      const now = new Date();
      const previousMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const previousMonth = previousMonthDate.getMonth() + 1;
      const previousMonthYear = previousMonthDate.getFullYear();

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
      });

      // Pick the previous calendar month from summary (may be empty).
      const previousMonthSummary = monthlySummary.months.find(
        (month) => month.month === previousMonth && month.year === previousMonthYear
      );

      // If no recipient exclusions (or exclusions don't apply), we can use the API data directly
      if (!exclusionsApply || settings.excludedRecipientIds.length === 0) {
        return {
          totalTransactions: countData.total_transactions,
          monthlyIncome: previousMonthSummary?.total_income ?? 0,
          monthlySpending: Math.abs(previousMonthSummary?.total_spending ?? 0),
          netBalance: previousMonthSummary?.net_amount ?? 0,
        };
      }

      // Recipient exclusions require client-side filtering of transactions.
      // Restrict query to the previous month for accuracy and smaller payload.
      const toIsoDate = (date: Date): string => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };

      const previousMonthStart = new Date(previousMonthYear, previousMonth - 1, 1);
      const previousMonthEnd = new Date(previousMonthYear, previousMonth, 0);

      const transactionsData = await apiClient.getTransactions({
        limit: 5000,
        active: true,
        normalize_to_eur: true,
        start_date: toIsoDate(previousMonthStart),
        end_date: toIsoDate(previousMonthEnd),
      });

      const excludedRecipientIds = new Set(settings.excludedRecipientIds);
      const excludedCategoryIds = new Set(allExcludedCategoryIds);

      // Filter transactions based on settings
      const filteredTransactions = transactionsData.items.filter((t) => {
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

      // Calculate last-month statistics from fully filtered transactions
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