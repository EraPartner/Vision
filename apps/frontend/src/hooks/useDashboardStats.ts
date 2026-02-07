import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

interface DashboardStats {
  totalTransactions: number;
  monthlyIncome: number;
  monthlySpending: number;
  netBalance: number;
}

export function useDashboardStats() {
  return useQuery<DashboardStats>({
    queryKey: ['dashboardStats'],
    queryFn: async () => {
      // Fetch total transaction count
      const countData = await apiClient.getTransactionCount();
      
      // Fetch monthly financial summary (6 months)
      const monthlySummary = await apiClient.getMonthlyFinancialSummary();
      
      // Find the last month with actual transactions
      let lastMonthWithData = monthlySummary.months[monthlySummary.months.length - 1];
      for (let i = monthlySummary.months.length - 1; i >= 0; i--) {
        if (monthlySummary.months[i].transaction_count > 0) {
          lastMonthWithData = monthlySummary.months[i];
          break;
        }
      }
      
      return {
        totalTransactions: countData.total_transactions,
        monthlyIncome: lastMonthWithData.total_income,
        monthlySpending: Math.abs(lastMonthWithData.total_spending),
        netBalance: lastMonthWithData.net_amount,
      };
    },
    staleTime: 30000, // Consider data fresh for 30 seconds
    refetchOnWindowFocus: true,
  });
}
