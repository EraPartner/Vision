import { useState, useCallback, useMemo } from "react";
import { parseISO } from "date-fns";
import { StatCard } from "@/components/dashboard/StatCard";
import { MonthlyTrendsChart } from "@/components/dashboard/MonthlyTrendsChart";
import { CashFlowComparisonChart } from "@/components/dashboard/CashFlowComparisonChart";
import { CategoryPieChart } from "@/components/dashboard/CategoryPieChart";
import { BankBalancesWidget } from "@/components/dashboard/BankBalancesWidget";
import { DataTable } from "@/components/shared/DataTable";
import { ExclusionToggle } from "@/components/shared/ExclusionToggle";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUpRight, DollarSign, LayoutDashboard, Receipt, TrendingDown, Tags } from "lucide-react";
import { useTransactions } from "@/hooks/useTransactions";
import { useFilteredDashboardStats } from "@/hooks/useFilteredDashboardStats";
import { useSettings } from "@/contexts/SettingsContext";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { getCategoryColor } from "@/utils/categoryColors";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateWithAppSettings, formatMonthYearWithAppSettings } from "@/components/shared/dateUtils";

type GraphExclusions = Record<string, boolean>;

export default function DashboardPage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const targetCurrency = appSettings.defaultCurrency || 'EUR';
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const integerLocaleFormatter = new Intl.NumberFormat(locale);

    const DASHBOARD_WIDGETS: WidgetDefinition[] = [
        { id: 'statCards', label: t('dashboard.statCards'), description: t('dashboard.widgetDescriptions.statCards') },
        { id: 'bankBalances', label: t('dashboard.bankBalances'), description: t('dashboard.widgetDescriptions.bankBalances') },
        { id: 'monthlyTrends', label: t('dashboard.monthlyTrends'), description: t('dashboard.widgetDescriptions.monthlyTrends') },
        { id: 'categoryPie', label: t('dashboard.categoryDistribution'), description: t('dashboard.widgetDescriptions.categoryPie') },
        { id: 'cashflowComparison', label: t('dashboard.cashFlowComparison'), description: t('dashboard.widgetDescriptions.cashflowComparison') },
        { id: 'recentTransactions', label: t('dashboard.recentTransactions'), description: t('dashboard.widgetDescriptions.recentTransactions') },
    ];

    const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } = useWidgetVisibility('dashboard', DASHBOARD_WIDGETS);
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
    // Memoized — only recomputes when the relevant settings or categories change.
    const allExcludedCategoryIds = useMemo(() => {
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
    }, [settings.exclusionScope, settings.excludedCategoryIds, settings.excludeHiddenCategories, categoriesData]);

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
        queryKey: ['monthlySummary', 'filtered', targetCurrency, filteredExclusionParams],
        queryFn: () => apiClient.getMonthlyFinancialSummary({ ...filteredExclusionParams, currency: targetCurrency }),
        staleTime: 30000,
        enabled: exclusionsApply,
    });

    // Fetch monthly summary — UNFILTERED version (stable query key)
    // Always enabled as fallback when users toggle a graph to "ignore filters"
    const { data: monthlySummaryUnfiltered, isLoading: monthlyUnfilteredLoading } = useQuery({
        queryKey: ['monthlySummary', 'unfiltered', targetCurrency],
        queryFn: () => apiClient.getMonthlyFinancialSummary({ currency: targetCurrency }),
        staleTime: 30000,
        enabled: true,
    });

    const monthlyLoading = monthlyFilteredLoading || monthlyUnfilteredLoading;

    // Fetch cashflow comparison — FILTERED version (stable query key)
    const { data: cashflowDataFiltered, isLoading: cashflowFilteredLoading } = useQuery({
        queryKey: ['cashflowComparison', 'filtered', targetCurrency, filteredExclusionParams],
        queryFn: () => apiClient.getCashflowComparison({ ...filteredExclusionParams, currency: targetCurrency }),
        staleTime: 30000,
        enabled: exclusionsApply,
    });

    // Fetch cashflow comparison — UNFILTERED version (stable query key)
    // Always enabled as fallback when users toggle a graph to "ignore filters"
    const { data: cashflowDataUnfiltered, isLoading: cashflowUnfilteredLoading } = useQuery({
        queryKey: ['cashflowComparison', 'unfiltered', targetCurrency],
        queryFn: () => apiClient.getCashflowComparison({ currency: targetCurrency }),
        staleTime: 30000,
        enabled: true,
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

                for (const tx of page.items) {
                    if (tx.category_id && excludedCategoryIdSet.has(tx.category_id)) {
                        continue;
                    }

                    if (tx.recipient_id && excludedRecipientIdSet.has(tx.recipient_id)) {
                        continue;
                    }

                    picked.push(tx);
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

        txToUse.forEach(tx => {
            const key = tx.category_name || t('txPage.field.uncategorized');
            const name = tx.category_name || t('txPage.field.uncategorized');

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
        const otherCount = sorted.slice(5).reduce((sum, cat) => sum + cat.count, 0);

        // Extract detail part from category name (e.g., "FOOD:GROCERIES" -> "Groceries")
        const extractDetail = (categoryName: string): string => {
            if (categoryName === t('txPage.field.uncategorized')) return categoryName;

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
                name: t('dashboard.other'),
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

    const recentTransactions = recentTransactionsSource.slice(0, 5).map((txn) => ({
        id: txn.id,
        date: (txn as any).date || txn.transaction_date || '',
        description: txn.memo || t('txPage.field.description'),
        amount: txn.amount,
        currency: txn.currency || appSettings.defaultCurrency,
        category: txn.category_name || t('txPage.field.uncategorized'),
        recipient: txn.recipient_name || t('txPage.field.unknown'),
        bank: txn.bank_account
    }));

    const columns = [
        {
            key: "date",
            header: t('txPage.col.date'),
            render: (row: (typeof recentTransactions)[0]) => {
                try {
                    const dateObj = parseISO(row.date);
                    return <span>{formatDateWithAppSettings(dateObj, appSettings.dateFormat)}</span>;
                } catch {
                    return <span>{row.date}</span>;
                }
            },
        },
        { key: "description", header: t('txPage.field.description') },
        {
            key: "category",
            header: t('txPage.col.category'),
            render: (row: (typeof recentTransactions)[0]) => (
                <Badge variant="outline" className={`font-medium ${getCategoryColor(row.category)}`}>
                    {row.category}
                </Badge>
            ),
        },
        { key: "recipient", header: t('txPage.col.recipient') },
        {
            key: "amount",
            header: t('txPage.col.amount'),
            className: "text-right",
            render: (row: (typeof recentTransactions)[0]) => (
                <span className={`font-semibold ${row.amount >= 0 ? "text-accent" : "text-destructive"}`}>
                    {row.amount >= 0 ? "+" : ""}{formatCurrency(Math.abs(row.amount), row.currency, locale)}
                </span>
            ),
        },
    ];

    if (statsLoading || transactionsLoading || monthlyLoading || cashflowLoading || recentTransactionsLoading) {
        return (
            <div className="space-y-8 animate-in">
                <PageHeader title={t('dashboard.title')} subtitle={t('dashboard.loadingData')} icon={LayoutDashboard} />
                {/* Stat cards skeleton */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {[...Array(4)].map((_, i) => (
                        <Card key={i} className="border-none shadow-lg">
                            <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
                                <Skeleton className="h-4 w-28" />
                                <Skeleton className="h-10 w-10 rounded-xl" />
                            </CardHeader>
                            <CardContent>
                                <Skeleton className="h-8 w-32 mb-2" />
                                <Skeleton className="h-3 w-20" />
                            </CardContent>
                        </Card>
                    ))}
                </div>
                {/* Bank balances skeleton */}
                <Skeleton className="h-64 w-full rounded-xl" />
                {/* Charts skeleton */}
                <div className="grid gap-6 lg:grid-cols-2">
                    <Skeleton className="h-80 w-full rounded-xl" />
                    <Skeleton className="h-80 w-full rounded-xl" />
                </div>
                {/* Recent transactions skeleton */}
                <Card>
                    <CardHeader>
                        <Skeleton className="h-6 w-44" />
                        <Skeleton className="h-4 w-32 mt-1" />
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {[...Array(5)].map((_, i) => (
                            <Skeleton key={i} className="h-10 w-full" />
                        ))}
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (statsError || transactionsError || recentFilteredError) {
        const errorMessage = statsError?.message || transactionsError?.message || recentFilteredError?.message || 'Unknown error';
        return (
            <div className="space-y-8 animate-in">
                <PageHeader title={t('dashboard.title')} subtitle={t('dashboard.errorLoading', { msg: String(errorMessage) })} icon={LayoutDashboard} />
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in">
            {/* Page header */}
            <PageHeader
                title={t('dashboard.title')}
                subtitle={t('dashboard.subtitle')}
                icon={LayoutDashboard}
                actions={
                    <WidgetVisibilityDialog
                        widgets={widgetDefs}
                        isVisible={isVisible}
                        setWidgetVisible={setWidgetVisible}
                        setAllVisible={setAllVisible}
                        resetToDefaults={resetToDefaults}
                    />
                }
            />

            {/* Stats */}
            {isVisible('statCards') && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-stagger">
                <StatCard title={t('dashboard.stat.totalTransactions')} value={integerLocaleFormatter.format(totalTransactions)} icon={Receipt} />
                <StatCard title={t('dashboard.stat.lastMonthSpending')} value={formatCurrency(totalSpending, appSettings.defaultCurrency, locale)} icon={TrendingDown} trend="expense"
                    subtitle={t('dashboard.stat.mostRecentMonth')} />
                <StatCard title={t('dashboard.stat.lastMonthIncome')} value={formatCurrency(totalIncome, appSettings.defaultCurrency, locale)} icon={ArrowUpRight} trend="income"
                    subtitle={t('dashboard.stat.mostRecentMonth')} />
                <StatCard title={t('dashboard.stat.lastMonthNet')} value={formatCurrency(netBalance, appSettings.defaultCurrency, locale)} icon={DollarSign}
                    trend={netBalance >= 0 ? "income" : "expense"}
                    subtitle={netBalance >= 0 ? t('dashboard.stat.positiveCashFlow') : t('dashboard.stat.negativeCashFlow')} />
            </div>
            )}

            {/* Bank Account Balances */}
            {isVisible('bankBalances') && <BankBalancesWidget />}

            {/* Charts */}
            <div className="grid gap-6 lg:grid-cols-2">
                {isVisible('monthlyTrends') && monthlyData.length > 0 && (
                    <Card className="group relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5 bg-card backdrop-blur-sm">
                        <CardHeader className="flex flex-row items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-sm text-primary transition-transform duration-300 group-hover:scale-105">
                                    <TrendingDown className="h-5 w-5" />
                                </div>
                                <div>
                                     <CardTitle className="text-lg">{t('monthlyTrends.title')}</CardTitle>
                                     <CardDescription>{t('monthlyTrends.desc')}</CardDescription>
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
                {isVisible('categoryPie') && (
                <Card className="group relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5 bg-card backdrop-blur-sm">
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-chart-4/20 to-chart-4/5 flex items-center justify-center shadow-sm text-chart-4 transition-transform duration-300 group-hover:scale-105">
                                <Tags className="h-5 w-5" />
                            </div>
                            <div>
                                <CardTitle className="text-lg">{t('categoryPie.title')}</CardTitle>
                                <CardDescription>{t('categoryPie.desc')}</CardDescription>
                            </div>
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
                )}
            </div>

            {/* Cash Flow Comparison */}
            {isVisible('cashflowComparison') && effectiveCashflowData && (
                <Card className="group relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5 bg-card backdrop-blur-sm lg:col-span-2">
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-accent/20 to-accent/5 flex items-center justify-center shadow-sm text-accent transition-transform duration-300 group-hover:scale-105">
                                <DollarSign className="h-5 w-5" />
                            </div>
                            <div>
                                <CardTitle className="text-lg">{t('cashflow.title')}</CardTitle>
                                <CardDescription>
                                    {t('cashflow.chartDesc', { monthName: formatMonthYearWithAppSettings(new Date(effectiveCashflowData.year, effectiveCashflowData.month - 1, 1), appSettings.dateFormat, locale) })}
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
            {isVisible('recentTransactions') && (
            <DataTable
                title={t('dashboard.recentTransactions')}
                subtitle={t('dashboard.recentTransactionsSubtitle', { n: recentTransactions.length })}
                columns={columns}
                data={recentTransactions}
                emptyMessage={t('dashboard.recentTransactions.empty')}
                actions={
                    <ExclusionToggle
                        graphKey="recentTransactions"
                        isFiltered={graphExclusions['recentTransactions'] ?? true}
                        onToggle={toggleGraphExclusion}
                        exclusionsApply={exclusionsApply}
                    />
                }
            />
            )}
        </div>
    );
}
