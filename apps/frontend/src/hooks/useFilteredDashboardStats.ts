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

  return useQuery<FilteredDashboardStats>({
    queryKey: ['filteredDashboardStats', settings],
    queryFn: async () => {
      // Fetch total transaction count from the transaction-count endpoint
      const countData = await apiClient.getTransactionCount();

      // Resolve hidden category IDs if needed
      let hiddenCategoryIds: number[] = [];
      if (settings.excludeHiddenCategories) {
        const categoriesData = await apiClient.getCategories({ limit: 1000 });
        hiddenCategoryIds = categoriesData.items
          .filter((cat) => !cat.active)
          .map((cat) => cat.id);
      }

      const allExcludedCategoryIds = [
        ...settings.excludedCategoryIds,
        ...hiddenCategoryIds,
      ];

      // Fetch monthly financial summary (6 months) with excluded categories
      const monthlySummary = await apiClient.getMonthlyFinancialSummary({
        excluded_category_ids: allExcludedCategoryIds.length > 0 ? allExcludedCategoryIds : undefined,
      });
      
      // Find the last month with actual transactions
      let lastMonthWithData = monthlySummary.months[monthlySummary.months.length - 1];
      for (let i = monthlySummary.months.length - 1; i >= 0; i--) {
        if (monthlySummary.months[i].transaction_count > 0) {
          lastMonthWithData = monthlySummary.months[i];
          break;
        }
      }

      // If no recipient exclusions, we can use the API data directly
      if (settings.excludedRecipientIds.length === 0) {
        return {
          totalTransactions: countData.total_transactions,
          monthlyIncome: lastMonthWithData.total_income,
          monthlySpending: Math.abs(lastMonthWithData.total_spending),
          netBalance: lastMonthWithData.net_amount,
        };
      }

      // Fetch transactions for filtering (get a large sample for accurate stats)
      const transactionsData = await apiClient.getTransactions({ 
        limit: 5000,
        active: true 
      });

      // Fetch categories if we need to exclude hidden ones
      let hiddenCategoryIds: number[] = [];
      if (settings.excludeHiddenCategories) {
        const categoriesData = await apiClient.getCategories({ limit: 1000 });
        hiddenCategoryIds = categoriesData.items
          .filter((cat) => !cat.active)
          .map((cat) => cat.id);
      }

      // Build complete exclusion list
      const excludedCategoryIds = new Set([
        ...settings.excludedCategoryIds,
        ...hiddenCategoryIds,
      ]);

      const excludedRecipientIds = new Set(settings.excludedRecipientIds);

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

      // Get last month's date range
      const lastMonthStart = new Date(lastMonthWithData.period_start);
      const lastMonthEnd = new Date(lastMonthWithData.period_end);

      // Filter for last month's transactions
      const lastMonthTransactions = filteredTransactions.filter((t) => {
        const transactionDate = new Date(t.transaction_date);
        return transactionDate >= lastMonthStart && transactionDate <= lastMonthEnd;
      });

      // Calculate statistics from filtered transactions
      const monthlyIncome = lastMonthTransactions
        .filter((t) => t.amount > 0)
        .reduce((sum, t) => sum + t.amount, 0);

      const monthlySpending = Math.abs(
        lastMonthTransactions
          .filter((t) => t.amount < 0)
          .reduce((sum, t) => sum + t.amount, 0)
      );

      const netBalance = monthlyIncome - monthlySpending;

      return {
        totalTransactions: filteredTransactions.length,
        monthlyIncome,
        monthlySpending,
        netBalance,
      };
    },
    staleTime: 30000, // Consider data fresh for 30 seconds
    refetchOnWindowFocus: true,
  });
}