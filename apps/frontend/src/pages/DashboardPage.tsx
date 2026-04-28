import { useState, useCallback, useMemo } from "react";
import { parseISO } from "@/components/shared/dateUtils";
import { StatCard } from "@/components/dashboard/StatCard";
import { NetSummaryCard } from "@/components/dashboard/NetSummaryCard";
import { MonthlyTrendsChart } from "@/components/dashboard/MonthlyTrendsChart";
import { CashFlowForecastChart } from "@/components/dashboard/CashFlowForecastChart";
import { CategoryPieChart } from "@/components/dashboard/CategoryPieChart";
import { BankBalancesWidget } from "@/components/dashboard/BankBalancesWidget";
import { DataTable } from "@/components/shared/DataTable";
import { ExclusionToggle } from "@/components/shared/ExclusionToggle";
import { PageHeader } from "@/components/shared/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUpRight, LayoutDashboard, Receipt, TrendingDown, Tags, AlertTriangle } from "lucide-react";
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
import { formatDateWithAppSettings } from "@/components/shared/dateUtils";
import type { Transaction } from "@/lib/api";

type GraphExclusions = Record<string, boolean>;

export default function DashboardPage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const targetCurrency = appSettings.defaultCurrency || 'EUR';
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const integerLocaleFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);

    const DASHBOARD_WIDGETS: WidgetDefinition[] = useMemo(() => [
        { id: 'statCards', label: t('dashboard.statCards'), description: t('dashboard.widgetDescriptions.statCards') },
        { id: 'bankBalances', label: t('dashboard.bankBalances'), description: t('dashboard.widgetDescriptions.bankBalances') },
        { id: 'monthlyTrends', label: t('dashboard.monthlyTrends'), description: t('dashboard.widgetDescriptions.monthlyTrends') },
        { id: 'categoryPie', label: t('dashboard.categoryDistribution'), description: t('dashboard.widgetDescriptions.categoryPie') },
        { id: 'cashflowComparison', label: t('dashboard.cashFlowComparison'), description: t('dashboard.widgetDescriptions.cashflowComparison') },
        { id: 'recentTransactions', label: t('dashboard.recentTransactions'), description: t('dashboard.widgetDescriptions.recentTransactions') },
    ], [t]);

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
        const seen = new Set<number>();
        const ordered: number[] = [];
        for (const id of ids) {
            if (!seen.has(id)) {
                seen.add(id);
                ordered.push(id);
            }
        }
        return ordered;
    }, [settings.exclusionScope, settings.excludedCategoryIds, settings.excludeHiddenCategories, categoriesData]);

    // Recipient exclusions
    const excludedRecipientIds = useMemo(
        () => ((settings.exclusionScope === 'everywhere' || settings.exclusionScope === 'dashboard')
            ? settings.excludedRecipientIds
            : []),
        [settings.exclusionScope, settings.excludedRecipientIds],
    );

    // Stable exclusion params (don't change with toggle)
    const filteredExclusionParams = useMemo(() => ({
        excluded_category_ids: allExcludedCategoryIds.length > 0 ? allExcludedCategoryIds : undefined,
        excluded_recipient_ids: excludedRecipientIds.length > 0 ? excludedRecipientIds : undefined,
    }), [allExcludedCategoryIds, excludedRecipientIds]);

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
            const picked: Transaction[] = [];

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
    const transactions = useMemo(() => {
        if (settings.exclusionScope !== 'everywhere' && settings.exclusionScope !== 'dashboard') {
            return allTransactions;
        }

        let hiddenCategoryIds: number[] = [];
        if (settings.excludeHiddenCategories && categoriesData) {
            hiddenCategoryIds = categoriesData.items
                .filter((cat) => !cat.is_active)
                .map((cat) => cat.id);
        }

        const excludedCategoryIdSet = new Set([
            ...settings.excludedCategoryIds,
            ...hiddenCategoryIds,
        ]);

        const excludedRecipientIdSet = new Set(settings.excludedRecipientIds);

        return allTransactions.filter((tx) => {
            if (tx.category_id && excludedCategoryIdSet.has(tx.category_id)) return false;
            if (tx.recipient_id && excludedRecipientIdSet.has(tx.recipient_id)) return false;
            return true;
        });
    }, [
        allTransactions,
        settings.exclusionScope,
        settings.excludedCategoryIds,
        settings.excludedRecipientIds,
        settings.excludeHiddenCategories,
        categoriesData,
    ]);

    // Use real-time statistics from API (last month with data)
    const totalTransactions = statsData?.totalTransactions ?? 0;
    const totalSpending = statsData?.monthlySpending ?? 0;
    const totalIncome = statsData?.monthlyIncome ?? 0;
    const netBalance = statsData?.netBalance ?? 0;
    const netHistory = statsData?.netHistory ?? [];

    // Get chart data based on per-graph toggle state
    const monthlyData = useMemo(() => {
        const useExclusions = graphExclusions['monthlyTrends'] ?? true;
        if (useExclusions && exclusionsApply && monthlySummaryFiltered) {
            return monthlySummaryFiltered.months || [];
        }
        return monthlySummaryUnfiltered?.months || [];
    }, [graphExclusions, exclusionsApply, monthlySummaryFiltered, monthlySummaryUnfiltered]);

    // Calculate category breakdown from transactions (with per-graph toggle)
    const categoryBreakdown = useMemo(() => {
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
    }, [graphExclusions, exclusionsApply, transactions, allTransactions, t]);

    // Extract detail part from category names (after the colon) and show only top categories
    const categoryData = useMemo(() => {
        const sorted = [...categoryBreakdown].sort((a, b) => b.count - a.count);
        const topCategories = sorted.slice(0, 5);
        const otherCount = sorted.slice(5).reduce((sum, cat) => sum + cat.count, 0);

        const extractDetail = (categoryName: string): string => {
            if (categoryName === t('txPage.field.uncategorized')) return categoryName;
            const parts = categoryName.split(':');
            if (parts.length > 1) {
                const detail = parts[1].trim();
                return detail.charAt(0) + detail.slice(1).toLowerCase();
            }
            return categoryName.charAt(0) + categoryName.slice(1).toLowerCase();
        };

        const result = topCategories.map(cat => ({
            name: extractDetail(cat.name),
            value: cat.count
        }));

        if (otherCount > 0) {
            result.push({ name: t('dashboard.other'), value: otherCount });
        }

        return result;
    }, [categoryBreakdown, t]);

    // Recent transactions data (with per-graph toggle)
    const recentTransactionsSource = useMemo(() => {
        const useExclusions = graphExclusions['recentTransactions'] ?? true;
        return (useExclusions && exclusionsApply)
            ? (recentFilteredTransactions ?? [])
            : allTransactions;
    }, [graphExclusions, exclusionsApply, recentFilteredTransactions, allTransactions]);

    const recentTransactions = recentTransactionsSource.slice(0, 5).map((txn) => ({
        id: txn.id,
        date: txn.transaction_date || null,
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
                if (!row.date) return <span>—</span>;
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

    if (statsLoading || transactionsLoading || monthlyLoading || recentTransactionsLoading) {
        return (
            <div className="space-y-8 animate-in">
                <PageHeader title={t('dashboard.title')} subtitle={t('dashboard.loadingData')} icon={LayoutDashboard} />
                {/* Stat cards skeleton */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {[...Array(4)].map((_, i) => (
                        <Card key={i} className="surface-elevated premium-frame micro-lift">
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

    // Show an inline banner for failed queries instead of replacing the whole
    // page. Cached data from any successful query still renders so the user
    // sees something useful when the host is offline. The banner distinguishes
    // "live" (some queries fresh, some failed) from "stale" (all served from cache).
    const partialError = statsError || transactionsError || recentFilteredError;
    const partialErrorMessage = statsError?.message || transactionsError?.message || recentFilteredError?.message || '';
    const hasAnyData = Boolean(statsData) || (transactionsData?.items?.length ?? 0) > 0;
    const allFromCache = Boolean(statsError) && Boolean(transactionsError);

    if (partialError && !hasAnyData) {
        return (
            <div className="space-y-8 animate-in">
                <PageHeader title={t('dashboard.title')} subtitle={t('dashboard.errorLoading', { msg: String(partialErrorMessage) })} icon={LayoutDashboard} />
            </div>
        );
    }

    // Time-of-day greeting
    const greetingKey = (() => {
        const hour = new Date().getHours();
        if (hour < 12) return 'dashboard.greetingMorning';
        if (hour < 18) return 'dashboard.greetingAfternoon';
        return 'dashboard.greetingEvening';
    })();

    const currencyFormatter = (n: number) => formatCurrency(n, appSettings.defaultCurrency, locale);

    return (
        <div className="space-y-8 animate-in">
            {/* Page header */}
            <PageHeader
                title={t(greetingKey) || t('dashboard.title')}
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

            {partialError && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                    <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-500 shrink-0" />
                    <div className="text-foreground/80">
                        {allFromCache
                            ? t('dashboard.staleDataWarning', { msg: String(partialErrorMessage) })
                              || t('dashboard.partialDataWarning', { msg: String(partialErrorMessage) })
                            : t('dashboard.partialDataWarning', { msg: String(partialErrorMessage) })}
                    </div>
                </div>
            )}

            {/* Stats — bento: featured net-balance tile + secondary metrics */}
            {isVisible('statCards') && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6 lg:grid-rows-2 animate-stagger">
                <div className="sm:col-span-2 lg:col-span-3 lg:row-span-2">
                    <NetSummaryCard
                        netBalance={netBalance}
                        income={totalIncome}
                        spending={totalSpending}
                        history={netHistory}
                        formatCurrency={currencyFormatter}
                    />
                </div>
                <div className="lg:col-span-3 lg:row-span-1">
                    <StatCard title={t('dashboard.stat.lastMonthIncome')} value={currencyFormatter(totalIncome)} numericValue={totalIncome} formatValue={currencyFormatter} icon={ArrowUpRight} trend="income"
                        subtitle={t('dashboard.stat.mostRecentMonth')} />
                </div>
                <div className="lg:col-span-3 lg:row-span-1 grid gap-4 sm:grid-cols-2">
                    <StatCard title={t('dashboard.stat.lastMonthSpending')} value={currencyFormatter(totalSpending)} numericValue={totalSpending} formatValue={currencyFormatter} icon={TrendingDown} trend="expense"
                        subtitle={t('dashboard.stat.mostRecentMonth')} />
                    <StatCard title={t('dashboard.stat.totalTransactions')} value={integerLocaleFormatter.format(totalTransactions)} numericValue={totalTransactions} formatValue={(n) => integerLocaleFormatter.format(Math.round(n))} icon={Receipt} />
                </div>
            </div>
            )}

            {/* Bank Account Balances */}
            {isVisible('bankBalances') && <BankBalancesWidget />}

            {/* Charts — asymmetric bento: trends span 3 of 5 cols, category pie spans 2 */}
            <div className="grid gap-6 lg:grid-cols-5">
                {isVisible('monthlyTrends') && monthlyData.length > 0 && (
                    <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm lg:col-span-3">
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
                <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm lg:col-span-2">
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

            {/* Cash Flow Forecast */}
            {isVisible('cashflowComparison') && (
                <CashFlowForecastChart
                    excludedCategoryIds={allExcludedCategoryIds}
                    excludedRecipientIds={excludedRecipientIds}
                    currency={targetCurrency}
                />
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
