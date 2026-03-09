import { useState, useCallback } from "react";
import { format, parseISO } from "date-fns";
import { StatCard } from "@/components/dashboard/StatCard";
import { MonthlyTrendsChart } from "@/components/dashboard/MonthlyTrendsChart";
import { CashFlowComparisonChart } from "@/components/dashboard/CashFlowComparisonChart";
import { CategoryPieChart } from "@/components/dashboard/CategoryPieChart";
import { BankBalancesWidget } from "@/components/dashboard/BankBalancesWidget";
import { DataTable } from "@/components/shared/DataTable";
import { ExclusionToggle } from "@/components/shared/ExclusionToggle";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowUpRight, DollarSign, Receipt, TrendingDown, Loader2 } from "lucide-react";
import { useTransactions } from "@/hooks/useTransactions";
import { useFilteredDashboardStats } from "@/hooks/useFilteredDashboardStats";
import { useSettings } from "@/contexts/SettingsContext";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { getCategoryColor } from "@/utils/categoryColors";
import { formatCurrency } from "@/utils/currency";

type GraphExclusions = Record<string, boolean>;

export default function DashboardPage() {
    const { settings } = useSettings();

    // Per-graph exclusion override state
    const [graphExclusions, setGraphExclusions] = useState<GraphExclusions>({});
    const toggleGraphExclusion = useCallback((graphKey: string) => {
        setGraphExclusions(prev => ({
            ...prev,
            [graphKey]: !(prev[graphKey] ?? true),
        }));
    }, []);

    // Check if exclusions should apply to dashboard
    const exclusionsApply = (settings.exclusionScope === 'everywhere' || settings.exclusionScope === 'dashboard') &&
        (settings.excludedCategoryIds.length > 0 || settings.excludedRecipientIds.length > 0 || settings.excludeHiddenCategories);

    // Fetch real-time statistics from /api/info endpoints with applied filters
    const { data: statsData, isLoading: statsLoading, error: statsError } = useFilteredDashboardStats();

    // Fetch transactions for charts and recent transactions table
    const { data: transactionsData, isLoading: transactionsLoading, error: transactionsError } = useTransactions({ limit: 50 });

    // Fetch categories (needed to resolve hidden category exclusions)
    const { data: categoriesData } = useQuery({
        queryKey: ['categories', 'all'],
        queryFn: () => apiClient.getCategories({ limit: 1000 }),
        staleTime: 60000,
    });

    // Build complete excluded category IDs list (including hidden categories)
    const allExcludedCategoryIds = (() => {
        if (settings.exclusionScope !== 'everywhere' && settings.exclusionScope !== 'dashboard') {
            return [];
        }
        const ids = [...settings.excludedCategoryIds];
        if (settings.excludeHiddenCategories && categoriesData) {
            const hiddenIds = categoriesData.items
                .filter((cat) => !cat.is_active)
                .map((cat) => cat.id);
            ids.push(...hiddenIds);
        }
        return [...new Set(ids)];
    })();

    // Recipient exclusions
    const excludedRecipientIds = (settings.exclusionScope === 'everywhere' || settings.exclusionScope === 'dashboard')
        ? settings.excludedRecipientIds
        : [];

    // Stable exclusion params (don't change with toggle)
    const filteredExclusionParams = {
        excluded_category_ids: allExcludedCategoryIds.length > 0 ? allExcludedCategoryIds : undefined,
        excluded_recipient_ids: excludedRecipientIds.length > 0 ? excludedRecipientIds : undefined,
    };

    // Fetch monthly summary — FILTERED version (stable query key)
    const { data: monthlySummaryFiltered, isLoading: monthlyFilteredLoading } = useQuery({
        queryKey: ['monthlySummary', 'filtered', filteredExclusionParams],
        queryFn: () => apiClient.getMonthlyFinancialSummary(filteredExclusionParams),
        staleTime: 30000,
        enabled: exclusionsApply,
    });

    // Fetch monthly summary — UNFILTERED version (stable query key)
    const { data: monthlySummaryUnfiltered, isLoading: monthlyUnfilteredLoading } = useQuery({
        queryKey: ['monthlySummary', 'unfiltered'],
        queryFn: () => apiClient.getMonthlyFinancialSummary({}),
        staleTime: 30000,
    });

    const monthlyLoading = monthlyFilteredLoading || monthlyUnfilteredLoading;

    // Fetch cashflow comparison — FILTERED version (stable query key)
    const { data: cashflowDataFiltered, isLoading: cashflowFilteredLoading } = useQuery({
        queryKey: ['cashflowComparison', 'filtered', filteredExclusionParams],
        queryFn: () => apiClient.getCashflowComparison(filteredExclusionParams),
        staleTime: 30000,
        enabled: exclusionsApply,
    });

    // Fetch cashflow comparison — UNFILTERED version (stable query key)
    const { data: cashflowDataUnfiltered, isLoading: cashflowUnfilteredLoading } = useQuery({
        queryKey: ['cashflowComparison', 'unfiltered'],
        queryFn: () => apiClient.getCashflowComparison({}),
        staleTime: 30000,
    });

    const cashflowLoading = cashflowFilteredLoading || cashflowUnfilteredLoading;

    // Fetch recent transactions that survive exclusions (up to 5),
    // scanning additional pages when early rows are excluded.
    const {
        data: recentFilteredTransactions,
        isLoading: recentFilteredLoading,
        error: recentFilteredError,
    } = useQuery({
        queryKey: ['dashboardRecentTransactions', allExcludedCategoryIds, excludedRecipientIds, exclusionsApply],
        queryFn: async () => {
            const pageSize = 200;
            let offset = 0;
            const picked: any[] = [];

            const excludedCategoryIdSet = new Set(allExcludedCategoryIds);
            const excludedRecipientIdSet = new Set(excludedRecipientIds);

            while (picked.length < 5) {
                const page = await apiClient.getTransactions({
                    limit: pageSize,
                    offset,
                    active: true,
                });

                if (page.items.length === 0) {
                    break;
                }

                for (const t of page.items) {
                    if (t.category_id && excludedCategoryIdSet.has(t.category_id)) {
                        continue;
                    }

                    if (t.recipient_id && excludedRecipientIdSet.has(t.recipient_id)) {
                        continue;
                    }

                    picked.push(t);
                    if (picked.length === 5) {
                        break;
                    }
                }

                offset += pageSize;
                if (offset >= page.total || page.items.length < pageSize) {
                    break;
                }
            }

            return picked;
        },
        enabled: exclusionsApply,
        staleTime: 30000,
    });

    const recentTransactionsLoading = exclusionsApply ? recentFilteredLoading : false;

    const allTransactions = transactionsData?.items || [];

    // Apply settings filters to transactions
    const transactions = (() => {
        if (settings.exclusionScope !== 'everywhere' && settings.exclusionScope !== 'dashboard') {
            return allTransactions;
        }

        // Build hidden category IDs list if needed
        let hiddenCategoryIds: number[] = [];
        if (settings.excludeHiddenCategories && categoriesData) {
            hiddenCategoryIds = categoriesData.items
                .filter((cat) => !cat.is_active)
                .map((cat) => cat.id);
        }

        // Build complete exclusion list
        const excludedCategoryIdSet = new Set([
            ...settings.excludedCategoryIds,
            ...hiddenCategoryIds,
        ]);

        const excludedRecipientIdSet = new Set(settings.excludedRecipientIds);

        // Filter transactions
        return allTransactions.filter((t) => {
            // Exclude if category is in exclusion list
            if (t.category_id && excludedCategoryIdSet.has(t.category_id)) {
                return false;
            }

            // Exclude if recipient is in exclusion list
            if (t.recipient_id && excludedRecipientIdSet.has(t.recipient_id)) {
                return false;
            }

            return true;
        });
    })();

    // Use real-time statistics from API (last month with data)
    const totalTransactions = statsData?.totalTransactions ?? 0;
    const totalSpending = statsData?.monthlySpending ?? 0;
    const totalIncome = statsData?.monthlyIncome ?? 0;
    const netBalance = statsData?.netBalance ?? 0;

    // Get chart data based on per-graph toggle state
    const getMonthlyData = () => {
        const useExclusions = graphExclusions['monthlyTrends'] ?? true;
        if (useExclusions && exclusionsApply && monthlySummaryFiltered) {
            return monthlySummaryFiltered.months || [];
        }
        return monthlySummaryUnfiltered?.months || [];
    };

    const getCashflowData = () => {
        const useExclusions = graphExclusions['cashflowComparison'] ?? true;
        if (useExclusions && exclusionsApply && cashflowDataFiltered) {
            return cashflowDataFiltered;
        }
        return cashflowDataUnfiltered;
    };

    const monthlyData = getMonthlyData();
    const effectiveCashflowData = getCashflowData();

    // Calculate category breakdown from transactions (with per-graph toggle)
    const categoryBreakdown = (() => {
        const useExclusions = graphExclusions['categoryPie'] ?? true;
        const txToUse = (useExclusions && exclusionsApply) ? transactions : allTransactions;

        const categoryMap = new Map<string, { name: string; count: number }>();

        txToUse.forEach(t => {
            const key = t.category_name || 'Uncategorized';
            const name = t.category_name || 'Uncategorized';

            if (categoryMap.has(key)) {
                categoryMap.get(key)!.count++;
            } else {
                categoryMap.set(key, { name, count: 1 });
            }
        });

        return Array.from(categoryMap.values());
    })();

    // Extract detail part from category names (after the colon) and show only top categories
    const categoryData = (() => {
        // Sort by count descending
        const sorted = [...categoryBreakdown].sort((a, b) => b.count - a.count);

        // Take top 5 categories
        const topCategories = sorted.slice(0, 5);

        // Sum up the rest as "Other"
        const otherCount = sorted.slice(7).reduce((sum, cat) => sum + cat.count, 0);

        // Extract detail part from category name (e.g., "FOOD:GROCERIES" -> "Groceries")
        const extractDetail = (categoryName: string): string => {
            if (categoryName === 'Uncategorized') return categoryName;

            const parts = categoryName.split(':');
            if (parts.length > 1) {
                // Get the detail part and format it nicely
                const detail = parts[1].trim();
                return detail.charAt(0) + detail.slice(1).toLowerCase();
            }
            // If no colon, just format the whole name nicely
            return categoryName.charAt(0) + categoryName.slice(1).toLowerCase();
        };

        const result = topCategories.map(cat => ({
            name: extractDetail(cat.name),
            value: cat.count
        }));

        // Add "Other" if there are more categories
        if (otherCount > 0) {
            result.push({
                name: 'Andere',
                value: otherCount
            });
        }

        return result;
    })();

    // Recent transactions data (with per-graph toggle)
    const recentTransactionsSource = (() => {
        const useExclusions = graphExclusions['recentTransactions'] ?? true;
        return (useExclusions && exclusionsApply)
            ? (recentFilteredTransactions ?? [])
            : allTransactions;
    })();

    const recentTransactions = recentTransactionsSource.slice(0, 5).map(t => ({
        id: t.id,
        date: (t as any).date || t.transaction_date || '',
        description: t.memo || 'No description',
        amount: t.amount,
        currency: t.currency || 'EUR',
        category: t.category_name || 'Uncategorized',
        recipient: t.recipient_name || 'Unknown',
        bank: t.bank_account
    }));

    const columns = [
        {
            key: "date",
            header: "Date",
            render: (row: (typeof recentTransactions)[0]) => {
                try {
                    const dateObj = parseISO(row.date);
                    return <span>{format(dateObj, "EEE, d MMM")}</span>;
                } catch {
                    return <span>{row.date}</span>;
                }
            },
        },
        { key: "description", header: "Description" },
        {
            key: "category",
            header: "Category",
            render: (row: (typeof recentTransactions)[0]) => (
                <Badge variant="outline" className={`font-medium ${getCategoryColor(row.category)}`}>
                    {row.category}
                </Badge>
            ),
        },
        { key: "recipient", header: "Recipient" },
        {
            key: "amount",
            header: "Amount",
            className: "text-right",
            render: (row: (typeof recentTransactions)[0]) => (
                <span className={`font-semibold ${row.amount >= 0 ? "text-accent" : "text-destructive"}`}>
                    {row.amount >= 0 ? "+" : ""}{formatCurrency(Math.abs(row.amount), row.currency)}
                </span>
            ),
        },
    ];

    if (statsLoading || transactionsLoading || monthlyLoading || cashflowLoading || recentTransactionsLoading) {
        return (
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">Dashboard</h2>
                    <p className="text-muted-foreground mt-1">Loading your financial data...</p>
                </div>
                <div className="flex items-center justify-center h-96">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
            </div>
        );
    }

    if (statsError || transactionsError || recentFilteredError) {
        const errorMessage = statsError?.message || transactionsError?.message || recentFilteredError?.message || 'Unknown error';
        return (
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">Dashboard</h2>
                    <p className="text-destructive mt-1">Error loading data: {errorMessage}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in">
            {/* Page header */}
            <div>
                <h2 className="text-3xl font-bold text-foreground">Dashboard</h2>
                <p className="text-muted-foreground mt-1">Overview of your financial activity</p>
            </div>

            {/* Stats */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard title="Total Transactions" value={totalTransactions.toLocaleString()} icon={Receipt} />
                <StatCard title="Last Month Spending" value={formatCurrency(totalSpending, 'EUR')} icon={TrendingDown} trend="down"
                    subtitle="Most recent month" />
                <StatCard title="Last Month Income" value={formatCurrency(totalIncome, 'EUR')} icon={ArrowUpRight} trend="up"
                    subtitle="Most recent month" />
                <StatCard title="Last Month Net" value={formatCurrency(netBalance, 'EUR')} icon={DollarSign}
                    trend={netBalance >= 0 ? "up" : "down"}
                    subtitle={netBalance >= 0 ? "Positive cash flow" : "Negative cash flow"} />
            </div>

            {/* Bank Account Balances */}
            <BankBalancesWidget />

            {/* Charts */}
            <div className="grid gap-6 lg:grid-cols-2">
                {monthlyData.length > 0 && (
                    <Card className="relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-card backdrop-blur-sm">
                        <CardHeader className="flex flex-row items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20 flex items-center justify-center shadow-sm text-blue-600 dark:text-blue-400">
                                    <TrendingDown className="h-6 w-6" />
                                </div>
                                <div>
                                    <CardTitle className="text-xl">6-Month Trends</CardTitle>
                                    <CardDescription className="text-base">Income vs Spending over the last 6 months</CardDescription>
                                </div>
                            </div>
                            <ExclusionToggle
                                graphKey="monthlyTrends"
                                isFiltered={graphExclusions['monthlyTrends'] ?? true}
                                onToggle={toggleGraphExclusion}
                                exclusionsApply={exclusionsApply}
                            />
                        </CardHeader>
                        <CardContent>
                            <MonthlyTrendsChart data={monthlyData} embedded />
                        </CardContent>
                    </Card>
                )}
                <Card className="relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-card backdrop-blur-sm">
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div>
                            <CardTitle className="text-xl">Category Distribution</CardTitle>
                            <CardDescription className="text-base">Transaction breakdown by category</CardDescription>
                        </div>
                        <ExclusionToggle
                            graphKey="categoryPie"
                            isFiltered={graphExclusions['categoryPie'] ?? true}
                            onToggle={toggleGraphExclusion}
                            exclusionsApply={exclusionsApply}
                        />
                    </CardHeader>
                    <CardContent>
                        <CategoryPieChart data={categoryData} embedded />
                    </CardContent>
                </Card>
            </div>

            {/* Cash Flow Comparison */}
            {effectiveCashflowData && (
                <Card className="relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-card backdrop-blur-sm lg:col-span-2">
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-sm text-primary">
                                <DollarSign className="h-6 w-6" />
                            </div>
                            <div>
                                <CardTitle className="text-xl">Cash Flow Comparison</CardTitle>
                                <CardDescription className="text-base">
                                    {new Date(effectiveCashflowData.year, effectiveCashflowData.month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })} vs 6-month average
                                </CardDescription>
                            </div>
                        </div>
                        <ExclusionToggle
                            graphKey="cashflowComparison"
                            isFiltered={graphExclusions['cashflowComparison'] ?? true}
                            onToggle={toggleGraphExclusion}
                            exclusionsApply={exclusionsApply}
                        />
                    </CardHeader>
                    <CardContent>
                        <CashFlowComparisonChart
                            withoutPlanned={effectiveCashflowData.without_planned}
                            withPlanned={effectiveCashflowData.with_planned}
                            currentDay={effectiveCashflowData.current_day}
                            month={effectiveCashflowData.month}
                            year={effectiveCashflowData.year}
                            embedded
                        />
                    </CardContent>
                </Card>
            )}

            {/* Recent transactions */}
            <DataTable
                title="Recent Transactions"
                subtitle="Last 5 transactions"
                columns={columns}
                data={recentTransactions}
                emptyMessage="No transactions yet. Import a CSV to get started."
                actions={
                    <ExclusionToggle
                        graphKey="recentTransactions"
                        isFiltered={graphExclusions['recentTransactions'] ?? true}
                        onToggle={toggleGraphExclusion}
                        exclusionsApply={exclusionsApply}
                    />
                }
            />
        </div>
    );
}
