import { format, parseISO } from 'date-fns';
import type { Transaction, Category } from '../types/api';

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
  months: Record<string, number>; // period -> absolute total (legacy/default)
  incomeMonths: Record<string, number>;
  expenseMonths: Record<string, number>;
  netMonths: Record<string, number>;
  total: number; // absolute total (legacy/default)
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

function normalizeCategoryName(name: string): string {
  // Normalize category names to ensure consistent formatting: "GENERAL: DETAIL" (space after colon)
  return name.replace(/^([^:]+): */, '$1: ').trim();
}

export function processTransactions(
  transactions: Transaction[],
  categories: Category[],
  excludedCategoryIds: Set<number>,
  excludedRecipientIds: Set<number>,
): StatisticsData {
  const categoryMap = new Map(categories.map(c => [c.id, normalizeCategoryName(`${c.general}: ${c.detail}`)]));

  const monthlyMap = new Map<string, MonthlyData>();
  const categoryMonthlyMap = new Map<number, CategoryMonthlyData>();
  const recipientMap = new Map<string, RecipientSpending>();
  const recipientMapByYear = new Map<number, Map<string, RecipientSpending>>();
  const yearlyMap = new Map<number, YearlyComparison>();

  for (const tx of transactions) {
    // Apply exclusion filters
    if (tx.category_id && excludedCategoryIds.has(tx.category_id)) continue;
    if (tx.recipient_id && excludedRecipientIds.has(tx.recipient_id)) continue;

    const date = parseISO(tx.transaction_date);
    const period = format(date, 'yyyy-MM');
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const amount = tx.amount_eur ?? tx.amount;

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
      const categoryFromMap = categoryMap.get(catId);
      const categoryName = categoryFromMap || (catId ? `Category ${catId}` : 'Uncategorized');

      if (!categoryMonthlyMap.has(catId)) {
        categoryMonthlyMap.set(catId, {
          categoryName,
          categoryId: catId,
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
      const cd = categoryMonthlyMap.get(catId)!;
      const absAmount = Math.abs(amount);
      const incomeAmount = amount > 0 ? amount : 0;
      const expenseAmount = amount < 0 ? absAmount : 0;
      cd.months[period] = (cd.months[period] || 0) + absAmount;
      cd.incomeMonths[period] = (cd.incomeMonths[period] || 0) + incomeAmount;
      cd.expenseMonths[period] = (cd.expenseMonths[period] || 0) + expenseAmount;
      cd.netMonths[period] = (cd.netMonths[period] || 0) + amount;
      cd.total += absAmount;
      cd.incomeTotal += incomeAmount;
      cd.expenseTotal += expenseAmount;
      cd.netTotal += amount;
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

      if (!recipientMapByYear.has(year)) {
        recipientMapByYear.set(year, new Map<string, RecipientSpending>());
      }
      const yearRecipientMap = recipientMapByYear.get(year)!;
      if (!yearRecipientMap.has(recipientName)) {
        yearRecipientMap.set(recipientName, { name: recipientName, total: 0, count: 0 });
      }
      const yrd = yearRecipientMap.get(recipientName)!;
      yrd.total += Math.abs(amount);
      yrd.count++;
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
  const topRecipientsByYear = Array.from(recipientMapByYear.entries()).reduce<Record<string, RecipientSpending[]>>((acc, [year, yearMap]) => {
    acc[String(year)] = Array.from(yearMap.values()).sort((a, b) => b.total - a.total).slice(0, 20);
    return acc;
  }, {});
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
