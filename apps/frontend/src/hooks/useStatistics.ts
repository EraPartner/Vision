import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { Transaction, Category } from '@/types/api';
import { useMemo } from 'react';
import { format, parseISO } from 'date-fns';
import { useSettings } from '@/contexts/SettingsContext';

interface MonthlyData {
  period: string; // "YYYY-MM"
  year: number;
  month: number;
  income: number;
  spending: number;
  net: number;
  transactionCount: number;
}

interface CategoryMonthlyData {
  categoryName: string;
  categoryId: number;
  months: Record<string, number>; // period -> total spending
  total: number;
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
  yearlyComparison: YearlyComparison[];
  allPeriods: string[];
  allYears: number[];
  totalIncome: number;
  totalSpending: number;
  averageMonthlySpending: number;
  averageMonthlyIncome: number;
}

function processTransactions(
  transactions: Transaction[],
  categories: Category[],
  excludedCategoryIds: Set<number>,
  excludedRecipientIds: Set<number>,
): StatisticsData {
  const categoryMap = new Map(categories.map(c => [c.id, `${c.general}: ${c.detail}`]));

  const monthlyMap = new Map<string, MonthlyData>();
  const categoryMonthlyMap = new Map<number, CategoryMonthlyData>();
  const recipientMap = new Map<string, RecipientSpending>();
  const yearlyMap = new Map<number, YearlyComparison>();

  for (const tx of transactions) {
    // Apply exclusion filters
    if (tx.category_id && excludedCategoryIds.has(tx.category_id)) continue;
    if (tx.recipient_id && excludedRecipientIds.has(tx.recipient_id)) continue;

    const date = parseISO(tx.transaction_date);
    const period = format(date, 'yyyy-MM');
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const amount = tx.amount;

    // Monthly aggregation
    if (!monthlyMap.has(period)) {
      monthlyMap.set(period, { period, year, month, income: 0, spending: 0, net: 0, transactionCount: 0 });
    }
    const md = monthlyMap.get(period)!;
    if (amount >= 0) md.income += amount;
    else md.spending += Math.abs(amount);
    md.net += amount;
    md.transactionCount++;

    // Category pivot
    const catId = tx.category_id;
    if (catId) {
      if (!categoryMonthlyMap.has(catId)) {
        categoryMonthlyMap.set(catId, {
          categoryName: categoryMap.get(catId) || tx.category_name || `Category ${catId}`,
          categoryId: catId,
          months: {},
          total: 0,
        });
      }
      const cd = categoryMonthlyMap.get(catId)!;
      cd.months[period] = (cd.months[period] || 0) + Math.abs(amount);
      cd.total += Math.abs(amount);
    }

    // Recipient spending
    const recipientName = tx.recipient_name || 'Unknown';
    if (amount < 0) {
      if (!recipientMap.has(recipientName)) {
        recipientMap.set(recipientName, { name: recipientName, total: 0, count: 0 });
      }
      const rd = recipientMap.get(recipientName)!;
      rd.total += Math.abs(amount);
      rd.count++;
    }

    // Yearly
    if (!yearlyMap.has(year)) {
      yearlyMap.set(year, { year, totalIncome: 0, totalSpending: 0, net: 0, transactionCount: 0 });
    }
    const yd = yearlyMap.get(year)!;
    if (amount >= 0) yd.totalIncome += amount;
    else yd.totalSpending += Math.abs(amount);
    yd.net += amount;
    yd.transactionCount++;
  }

  const monthlyData = Array.from(monthlyMap.values()).sort((a, b) => a.period.localeCompare(b.period));
  const categoryPivot = Array.from(categoryMonthlyMap.values()).sort((a, b) => b.total - a.total);
  const topRecipients = Array.from(recipientMap.values()).sort((a, b) => b.total - a.total).slice(0, 20);
  const yearlyComparison = Array.from(yearlyMap.values()).sort((a, b) => a.year - b.year);

  const allPeriods = monthlyData.map(m => m.period);
  const allYears = yearlyComparison.map(y => y.year);

  const totalIncome = monthlyData.reduce((s, m) => s + m.income, 0);
  const totalSpending = monthlyData.reduce((s, m) => s + m.spending, 0);
  const monthCount = monthlyData.length || 1;

  return {
    monthlyData,
    categoryPivot,
    topRecipients,
    yearlyComparison,
    allPeriods,
    allYears,
    totalIncome,
    totalSpending,
    averageMonthlySpending: totalSpending / monthCount,
    averageMonthlyIncome: totalIncome / monthCount,
  };
}

export function useStatistics() {
  const { settings } = useSettings();

  const transactionsQuery = useQuery({
    queryKey: ['transactions', 'all-for-stats'],
    queryFn: async () => {
      const allItems: Transaction[] = [];
      let offset = 0;
      const limit = 1000;
      let total = Infinity;

      while (offset < total) {
        const res = await apiClient.getTransactions({ limit, offset, active: true });
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

  const stats = useMemo(() => {
    if (!transactionsQuery.data || !categoriesQuery.data) return null;

    // Build exclusion sets from settings
    let hiddenCategoryIds: number[] = [];
    if (settings.excludeHiddenCategories) {
      hiddenCategoryIds = categoriesQuery.data
        .filter((cat) => !cat.active)
        .map((cat) => cat.id);
    }

    const excludedCategoryIds = new Set([
      ...settings.excludedCategoryIds,
      ...hiddenCategoryIds,
    ]);
    const excludedRecipientIds = new Set(settings.excludedRecipientIds);

    return processTransactions(
      transactionsQuery.data,
      categoriesQuery.data,
      excludedCategoryIds,
      excludedRecipientIds,
    );
  }, [transactionsQuery.data, categoriesQuery.data, settings]);

  return {
    data: stats,
    isLoading: transactionsQuery.isLoading || categoriesQuery.isLoading,
    isError: transactionsQuery.isError || categoriesQuery.isError,
    error: transactionsQuery.error || categoriesQuery.error,
  };
}
