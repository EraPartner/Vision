import { PAGE_ICONS } from "@/lib/pageIcons";
import { useState, useCallback, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { parseISO } from "@/lib/dateUtils";
import { StatCard } from "@/components/shared/StatCard";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { NetSummaryCard } from "@/features/dashboard/NetSummaryCard";
import { MonthlyTrendsChart } from "@/features/dashboard/MonthlyTrendsChart";
import { CashFlowForecastChart } from "@/features/dashboard/CashFlowForecastChart";
import { CategoryPieChart } from "@/features/dashboard/CategoryPieChart";
import { BankBalancesWidget } from "@/features/dashboard/BankBalancesWidget";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { ExclusionToggle } from "@/components/shared/ExclusionToggle";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    ArrowUpRight,
    Receipt,
    TrendingDown,
    AlertTriangle,
} from "lucide-react";
import { useTransactions } from "@/hooks/useTransactions";
import {
    useFilteredDashboardStats,
    useMonthlySummary,
} from "@/hooks/useFilteredDashboardStats";
import { useExcludedIds } from "@/hooks/useExcludedIds";
import { useQuery } from "@tanstack/react-query";
import { dashboardKeys } from "@/lib/queryKeys";
import { fetchRecentDashboardTransactions } from "@/features/dashboard/recentTransactions";
import { getCategoryColor } from "@/utils/categoryColors";
import { formatCurrencyCompact, numberFormatToLocale } from "@/utils/currency";
import { Money } from "@/components/shared/Money";
import { ChartSyncProvider } from "@/components/charts/ChartSyncContext";
import { ChartSkeleton } from "@/components/charts/ChartSkeleton";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import {
    useWidgetVisibility,
    type WidgetDefinition,
} from "@/hooks/useWidgetVisibility";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateWithAppSettings } from "@/lib/dateUtils";
import { parseCategoryName } from "@vision/shared-utils";
import {
    claimDashboardArrival,
    DASHBOARD_ARRIVAL_EVENT,
    markDashboardArrivalSeen,
} from "@/utils/dashboardArrival";
import { PageShell } from "@/components/shared/PageShell";
import { buildTransactionDrillUrl } from "@/lib/transactionDrillUrl";

type GraphExclusions = Record<string, boolean>;

export default function DashboardPage() {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const targetCurrency = appSettings.defaultCurrency || "EUR";
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const integerLocaleFormatter = useMemo(
        () => new Intl.NumberFormat(locale),
        [locale],
    );
    const [arrivalRun, setArrivalRun] = useState(() =>
        claimDashboardArrival() ? 1 : 0,
    );
    const playArrival = arrivalRun > 0;

    useEffect(() => {
        const replayAfterCompletion = () => {
            markDashboardArrivalSeen();
            setArrivalRun((run) => run + 1);
        };
        window.addEventListener(DASHBOARD_ARRIVAL_EVENT, replayAfterCompletion);
        return () =>
            window.removeEventListener(
                DASHBOARD_ARRIVAL_EVENT,
                replayAfterCompletion,
            );
    }, []);

    const DASHBOARD_WIDGETS: WidgetDefinition[] = useMemo(
        () => [
            {
                id: "statCards",
                label: t("dashboard.statCards"),
                description: t("dashboard.widgetDescriptions.statCards"),
            },
            {
                id: "bankBalances",
                label: t("dashboard.bankBalances"),
                description: t("dashboard.widgetDescriptions.bankBalances"),
            },
            {
                id: "monthlyTrends",
                label: t("dashboard.monthlyTrends"),
                description: t("dashboard.widgetDescriptions.monthlyTrends"),
            },
            {
                id: "categoryPie",
                label: t("dashboard.categoryDistribution"),
                description: t("dashboard.widgetDescriptions.categoryPie"),
            },
            {
                id: "cashflowComparison",
                label: t("dashboard.cashFlowComparison"),
                description: t(
                    "dashboard.widgetDescriptions.cashflowComparison",
                ),
            },
            {
                id: "recentTransactions",
                label: t("dashboard.recentTransactions"),
                description: t(
                    "dashboard.widgetDescriptions.recentTransactions",
                ),
            },
        ],
        [t],
    );

    const {
        isVisible,
        setWidgetVisible,
        setAllVisible,
        resetToDefaults,
        widgets: widgetDefs,
    } = useWidgetVisibility("dashboard", DASHBOARD_WIDGETS);

    // Per-graph exclusion override state
    const [graphExclusions, setGraphExclusions] = useState<GraphExclusions>({});
    const toggleGraphExclusion = useCallback((graphKey: string) => {
        setGraphExclusions((prev) => ({
            ...prev,
            [graphKey]: !(prev[graphKey] ?? true),
        }));
    }, []);

    // Excluded category/recipient IDs (settings + hidden categories) from the
    // shared resolver, so the dashboard and statistics exclude exactly the same set.
    const {
        excludedCategoryIds: allExcludedCategoryIds,
        excludedRecipientIds,
        exclusionsApply: exclusionScopeApplies,
    } = useExcludedIds("dashboard");

    // Switch to the *filtered* aggregation queries only when there is actually
    // something to exclude (preserves prior enable behavior).
    const exclusionsApply =
        exclusionScopeApplies &&
        (allExcludedCategoryIds.length > 0 || excludedRecipientIds.length > 0);

    // Fetch real-time statistics from /api/info endpoints with applied filters
    const {
        data: statsData,
        isLoading: statsLoading,
        error: statsError,
        refetch: refetchStats,
    } = useFilteredDashboardStats();

    // Fetch transactions for charts and recent transactions table
    const {
        data: transactionsData,
        isLoading: transactionsLoading,
        error: transactionsError,
        refetch: refetchTransactions,
    } = useTransactions({ limit: 50 });

    // Monthly summary — FILTERED version. Shares the
    // ['monthlySummary', currency, categoryIds, recipientIds] key family with
    // useFilteredDashboardStats above, so the identical request is deduped into
    // one cache entry instead of refetched under a page-local key.
    const {
        data: monthlySummaryFiltered,
        isLoading: monthlyFilteredLoading,
        error: monthlyFilteredError,
        refetch: refetchMonthlyFiltered,
    } = useMonthlySummary({
        excludedCategoryIds: allExcludedCategoryIds,
        excludedRecipientIds,
        enabled: exclusionsApply,
    });

    // Monthly summary — UNFILTERED version (no exclusions in the key).
    // Always enabled as fallback when users toggle a graph to "ignore filters";
    // with exclusions off this collapses onto the same cache entry as the
    // filtered variant and the stat cards — one fetch for the whole page.
    const {
        data: monthlySummaryUnfiltered,
        isLoading: monthlyUnfilteredLoading,
        error: monthlyUnfilteredError,
        refetch: refetchMonthlyUnfiltered,
    } = useMonthlySummary();

    const monthlyLoading = monthlyFilteredLoading || monthlyUnfilteredLoading;

    // Fetch recent transactions that survive exclusions (up to 5),
    // scanning additional pages when early rows are excluded.
    const {
        data: recentFilteredTransactions,
        isLoading: recentFilteredLoading,
        error: recentFilteredError,
        refetch: refetchRecentFiltered,
    } = useQuery({
        queryKey: dashboardKeys.recentTransactions(
            allExcludedCategoryIds,
            excludedRecipientIds,
            exclusionsApply,
        ),
        queryFn: () =>
            fetchRecentDashboardTransactions(
                allExcludedCategoryIds,
                excludedRecipientIds,
            ),
        enabled: exclusionsApply,
        staleTime: 30000,
    });

    const recentTransactionsLoading = exclusionsApply
        ? recentFilteredLoading
        : false;

    const allTransactions = useMemo(
        () => transactionsData?.items || [],
        [transactionsData],
    );

    // Apply settings filters to transactions, using the shared resolved exclusion set.
    const transactions = useMemo(() => {
        if (!exclusionScopeApplies) {
            return allTransactions;
        }

        const excludedCategoryIdSet = new Set(allExcludedCategoryIds);
        const excludedRecipientIdSet = new Set(excludedRecipientIds);

        return allTransactions.filter((tx) => {
            if (tx.category_id && excludedCategoryIdSet.has(tx.category_id))
                return false;
            if (tx.recipient_id && excludedRecipientIdSet.has(tx.recipient_id))
                return false;
            return true;
        });
    }, [
        allTransactions,
        exclusionScopeApplies,
        allExcludedCategoryIds,
        excludedRecipientIds,
    ]);

    // Use real-time statistics from API (last month with data)
    const totalTransactions = statsData?.totalTransactions ?? 0;
    const totalSpending = statsData?.monthlySpending ?? 0;
    const totalIncome = statsData?.monthlyIncome ?? 0;
    const netBalance = statsData?.netBalance ?? 0;
    const netHistory = statsData?.netHistory ?? [];
    const latestPeriod = statsData?.latestPeriod;

    // Get chart data based on per-graph toggle state
    const monthlyData = useMemo(() => {
        const useExclusions = graphExclusions["monthlyTrends"] ?? true;
        if (useExclusions && exclusionsApply && monthlySummaryFiltered) {
            return monthlySummaryFiltered.months || [];
        }
        return monthlySummaryUnfiltered?.months || [];
    }, [
        graphExclusions,
        exclusionsApply,
        monthlySummaryFiltered,
        monthlySummaryUnfiltered,
    ]);

    // Calculate category breakdown from transactions (with per-graph toggle)
    const categoryBreakdown = useMemo(() => {
        const useExclusions = graphExclusions["categoryPie"] ?? true;
        const txToUse =
            useExclusions && exclusionsApply ? transactions : allTransactions;

        const categoryMap = new Map<
            string,
            {
                name: string;
                count: number;
                categoryId?: number;
                uncategorised?: boolean;
            }
        >();

        txToUse.forEach((tx) => {
            const categoryId = tx.category_id ?? undefined;
            const key =
                categoryId != null ? `category:${categoryId}` : "uncategorised";
            const name = tx.category_name || t("txPage.field.uncategorized");

            if (categoryMap.has(key)) {
                categoryMap.get(key)!.count++;
            } else {
                categoryMap.set(key, {
                    name,
                    count: 1,
                    categoryId,
                    uncategorised: categoryId == null,
                });
            }
        });

        return Array.from(categoryMap.values());
    }, [graphExclusions, exclusionsApply, transactions, allTransactions, t]);

    // Extract detail part from category names (after the colon) and show only top categories
    const categoryData = useMemo(() => {
        const uncategorised = categoryBreakdown.find(
            (cat) => cat.uncategorised,
        );
        const sorted = categoryBreakdown
            .filter((cat) => !cat.uncategorised)
            .sort((a, b) => b.count - a.count);
        const topCategories = sorted.slice(0, 5);
        const otherCategories = sorted.slice(5);
        const otherCount = otherCategories.reduce(
            (sum, cat) => sum + cat.count,
            0,
        );

        const extractDetail = (categoryName: string): string => {
            if (categoryName === t("txPage.field.uncategorized"))
                return categoryName;
            // Shared GENERAL:DETAIL split (first ':' only, detail may contain
            // colons); sentence-case the detail for display.
            const { general, detail } = parseCategoryName(categoryName);
            const label = detail || general;
            return label.charAt(0) + label.slice(1).toLowerCase();
        };

        const result = topCategories.map((cat) => ({
            name: extractDetail(cat.name),
            value: cat.count,
            to: buildTransactionDrillUrl({
                categoryId: cat.categoryId,
                label: cat.name,
            }),
        }));

        if (uncategorised) {
            result.push({
                name: uncategorised.name,
                value: uncategorised.count,
                to: buildTransactionDrillUrl({
                    uncategorised: true,
                    label: uncategorised.name,
                }),
            });
        }

        if (otherCount > 0) {
            const label = t("dashboard.other");
            result.push({
                name: label,
                value: otherCount,
                to: buildTransactionDrillUrl({
                    categoryIds: otherCategories
                        .map((cat) => cat.categoryId)
                        .filter((id): id is number => id != null),
                    label,
                }),
            });
        }

        return result;
    }, [categoryBreakdown, t]);

    // Recent transactions data (with per-graph toggle)
    const recentTransactionsSource = useMemo(() => {
        const useExclusions = graphExclusions["recentTransactions"] ?? true;
        return useExclusions && exclusionsApply
            ? (recentFilteredTransactions ?? [])
            : allTransactions;
    }, [
        graphExclusions,
        exclusionsApply,
        recentFilteredTransactions,
        allTransactions,
    ]);

    const recentTransactions = useMemo(
        () =>
            recentTransactionsSource.slice(0, 5).map((txn) => ({
                id: txn.id,
                date: txn.transaction_date || null,
                description: txn.memo || t("txPage.field.description"),
                amount: txn.amount,
                currency: txn.currency || appSettings.defaultCurrency,
                category: txn.category_name || t("txPage.field.uncategorized"),
                recipient: txn.recipient_name || t("txPage.field.unknown"),
                bank: txn.bank_account,
            })),
        [recentTransactionsSource, t, appSettings.defaultCurrency],
    );

    const columns = useMemo(
        () => [
            {
                key: "date",
                header: t("txPage.col.date"),
                render: (row: (typeof recentTransactions)[0]) => {
                    if (!row.date) return <span>—</span>;
                    try {
                        const dateObj = parseISO(row.date);
                        return (
                            <span>
                                {formatDateWithAppSettings(
                                    dateObj,
                                    appSettings.dateFormat,
                                )}
                            </span>
                        );
                    } catch {
                        return <span>{row.date}</span>;
                    }
                },
            },
            { key: "description", header: t("txPage.field.description") },
            {
                key: "category",
                header: t("txPage.col.category"),
                render: (row: (typeof recentTransactions)[0]) => (
                    <Badge
                        variant="outline"
                        className={cn(
                            "font-medium",
                            getCategoryColor(row.category),
                        )}
                    >
                        {row.category}
                    </Badge>
                ),
            },
            { key: "recipient", header: t("txPage.col.recipient") },
            {
                key: "amount",
                header: t("txPage.col.amount"),
                className: "text-right",
                render: (row: (typeof recentTransactions)[0]) => (
                    <span
                        className={cn(
                            "font-semibold",
                            row.amount >= 0 ? "text-gain" : "text-loss",
                        )}
                    >
                        <Money
                            signed
                            amount={row.amount}
                            currency={row.currency}
                        />
                    </span>
                ),
            },
        ],
        [t, appSettings.dateFormat],
    );

    // Per-widget hydration: each section renders its own skeleton while its
    // queries load, so the hero stats appear the moment they arrive instead
    // of gating the whole page on the slowest query.
    const statSkeleton = (
        <div
            {...loadingSurfaceProps}
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
            {[...Array(4)].map((_, i) => (
                <Card key={i} variant="interactive">
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
    );

    const recentSkeleton = (
        <Card {...loadingSurfaceProps}>
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
    );

    // Show an inline banner for failed queries instead of replacing the whole
    // page. Cached data from any successful query still renders so the user
    // sees something useful when the host is offline. The banner distinguishes
    // "live" (some queries fresh, some failed) from "stale" (all served from cache).
    const partialError =
        statsError ||
        transactionsError ||
        monthlyFilteredError ||
        monthlyUnfilteredError ||
        recentFilteredError;
    const partialErrorMessage =
        statsError?.message ||
        transactionsError?.message ||
        monthlyFilteredError?.message ||
        monthlyUnfilteredError?.message ||
        recentFilteredError?.message ||
        "";
    const hasAnyData =
        Boolean(statsData) ||
        (transactionsData?.items?.length ?? 0) > 0 ||
        Boolean(monthlySummaryFiltered) ||
        Boolean(monthlySummaryUnfiltered);
    const allFromCache = Boolean(statsError) && Boolean(transactionsError);

    const retryDashboard = () => {
        const requests: Promise<unknown>[] = [
            refetchStats(),
            refetchTransactions(),
            refetchMonthlyUnfiltered(),
        ];
        if (exclusionsApply) {
            requests.push(refetchMonthlyFiltered(), refetchRecentFiltered());
        }
        void Promise.allSettled(requests);
    };

    if (partialError && !hasAnyData) {
        return (
            <PageShell rhythm="airy" className="">
                <PageHeader
                    title={t("dashboard.title")}
                    icon={PAGE_ICONS["/"]}
                />
                <PageError
                    message={t("dashboard.errorLoading", {
                        msg: String(partialErrorMessage),
                    })}
                    onRetry={retryDashboard}
                />
            </PageShell>
        );
    }

    // Time-of-day greeting
    const greetingKey = (() => {
        const hour = new Date().getHours();
        if (hour < 12) return "dashboard.greetingMorning";
        if (hour < 18) return "dashboard.greetingAfternoon";
        return "dashboard.greetingEvening";
    })();

    const incomeCompact = formatCurrencyCompact(
        totalIncome,
        appSettings.defaultCurrency,
        locale, appSettings.showDecimalPlaces ?? 2
    );
    const spendingCompact = formatCurrencyCompact(
        totalSpending,
        appSettings.defaultCurrency,
        locale, appSettings.showDecimalPlaces ?? 2
    );

    return (
        <ChartSyncProvider>
            <PageShell rhythm="airy" className="">
                {/* Page header */}
                <PageHeader
                    title={t(greetingKey) || t("dashboard.title")}
                    subtitle={t("dashboard.subtitle")}
                    icon={PAGE_ICONS["/"]}
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
                    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                        <AlertTriangle className="h-4 w-4 mt-0.5 text-warning shrink-0" />
                        <div className="text-foreground/80">
                            {allFromCache
                                ? t("dashboard.staleDataWarning", {
                                      msg: String(partialErrorMessage),
                                  }) ||
                                  t("dashboard.partialDataWarning", {
                                      msg: String(partialErrorMessage),
                                  })
                                : t("dashboard.partialDataWarning", {
                                      msg: String(partialErrorMessage),
                                  })}
                        </div>
                    </div>
                )}

                {/* Upcoming-payment reminders render as the shared banner above the
                page (AppLayout → UpcomingPaymentsNotification), consistent with
                every other page — no dashboard-specific card. */}

                {/* Stats — bento: featured net-balance tile + secondary metrics */}
                {isVisible("statCards") && statsLoading && statSkeleton}
                {isVisible("statCards") && !statsLoading && (
                    <div
                        key={arrivalRun}
                        className={cn(
                            "grid gap-4 sm:grid-cols-2 lg:grid-cols-6 lg:grid-rows-2",
                            playArrival && "animate-stagger",
                        )}
                    >
                        <div className="sm:col-span-2 lg:col-span-3 lg:row-span-2">
                            <NetSummaryCard
                                netBalance={netBalance}
                                income={totalIncome}
                                spending={totalSpending}
                                history={netHistory}
                                animateNumber={playArrival}
                            />
                        </div>
                        <div className="lg:col-span-3 lg:row-span-1">
                            <StatCard
                                title={t("dashboard.stat.lastMonthIncome")}
                                to={
                                    latestPeriod
                                        ? buildTransactionDrillUrl({
                                              period: latestPeriod,
                                              valueMode: "income",
                                              label: t(
                                                  "dashboard.stat.lastMonthIncome",
                                              ),
                                          })
                                        : undefined
                                }
                                value={
                                    <RollingNumber
                                        parts={incomeCompact.parts}
                                        animate={playArrival}
                                    />
                                }
                                icon={ArrowUpRight}
                                trend="income"
                                subtitle={t("dashboard.stat.mostRecentMonth")}
                                titleValue={
                                    incomeCompact.isCompact
                                        ? incomeCompact.full
                                        : undefined
                                }
                            />
                        </div>
                        <div className="lg:col-span-3 lg:row-span-1 grid gap-4 sm:grid-cols-2">
                            <StatCard
                                title={t("dashboard.stat.lastMonthSpending")}
                                to={
                                    latestPeriod
                                        ? buildTransactionDrillUrl({
                                              period: latestPeriod,
                                              valueMode: "expense",
                                              label: t(
                                                  "dashboard.stat.lastMonthSpending",
                                              ),
                                          })
                                        : undefined
                                }
                                value={
                                    <RollingNumber
                                        parts={spendingCompact.parts}
                                        animate={playArrival}
                                    />
                                }
                                icon={TrendingDown}
                                trend="expense"
                                subtitle={t("dashboard.stat.mostRecentMonth")}
                                titleValue={
                                    spendingCompact.isCompact
                                        ? spendingCompact.full
                                        : undefined
                                }
                            />
                            <StatCard
                                title={t("dashboard.stat.totalTransactions")}
                                to="/transactions"
                                value={integerLocaleFormatter.format(
                                    totalTransactions,
                                )}
                                numericValue={totalTransactions}
                                formatValue={(n) =>
                                    integerLocaleFormatter.format(Math.round(n))
                                }
                                icon={Receipt}
                                odometer={playArrival}
                            />
                        </div>
                    </div>
                )}

                {/* Bank Account Balances */}
                {isVisible("bankBalances") && <BankBalancesWidget />}

                {/* Charts — asymmetric bento: trends span 3 of 5 cols, category pie spans 2 */}
                <div className="grid gap-6 lg:grid-cols-5 lg:[&>*:only-child]:col-span-5">
                    {isVisible("monthlyTrends") && monthlyLoading && (
                        <Card className="lg:col-span-3">
                            <CardContent variant="headerless">
                                <ChartSkeleton height={300} />
                            </CardContent>
                        </Card>
                    )}
                    {isVisible("monthlyTrends") &&
                        !monthlyLoading &&
                        monthlyData.length > 0 && (
                            <Card className="group relative overflow-hidden lg:col-span-3">
                                <CardHeader className="flex flex-row items-center justify-between">
                                    <div>
                                        <CardTitle variant="sm">
                                            {t("monthlyTrends.title")}
                                        </CardTitle>
                                        <CardDescription>
                                            {t("monthlyTrends.desc")}
                                        </CardDescription>
                                    </div>
                                    <ExclusionToggle
                                        graphKey="monthlyTrends"
                                        isFiltered={
                                            graphExclusions["monthlyTrends"] ??
                                            true
                                        }
                                        onToggle={toggleGraphExclusion}
                                        exclusionsApply={exclusionsApply}
                                    />
                                </CardHeader>
                                <CardContent>
                                    <MonthlyTrendsChart
                                        data={monthlyData}
                                        embedded
                                    />
                                </CardContent>
                            </Card>
                        )}
                    {isVisible("categoryPie") && transactionsLoading && (
                        <Card className="lg:col-span-2">
                            <CardContent variant="headerless">
                                <ChartSkeleton height={300} />
                            </CardContent>
                        </Card>
                    )}
                    {isVisible("categoryPie") && !transactionsLoading && (
                        <Card className="group relative overflow-hidden lg:col-span-2">
                            <CardHeader className="flex flex-row items-center justify-between">
                                <div>
                                    <CardTitle variant="sm">
                                        {t("categoryPie.title")}
                                    </CardTitle>
                                    <CardDescription>
                                        {t("categoryPie.desc")}
                                    </CardDescription>
                                </div>
                                <ExclusionToggle
                                    graphKey="categoryPie"
                                    isFiltered={
                                        graphExclusions["categoryPie"] ?? true
                                    }
                                    onToggle={toggleGraphExclusion}
                                    exclusionsApply={exclusionsApply}
                                />
                            </CardHeader>
                            <CardContent>
                                <CategoryPieChart
                                    data={categoryData}
                                    embedded
                                    formatValue={(v) => String(v)}
                                />
                            </CardContent>
                        </Card>
                    )}
                </div>

                {/* Cash Flow Forecast — below the fold on typical viewports, so let
                the browser skip its layout+paint until scrolled near (visually free). */}
                {isVisible("cashflowComparison") && (
                    <div className="cv-auto">
                        <CashFlowForecastChart
                            excludedCategoryIds={allExcludedCategoryIds}
                            excludedRecipientIds={excludedRecipientIds}
                            currency={targetCurrency}
                        />
                    </div>
                )}

                {/* Recent transactions */}
                {isVisible("recentTransactions") &&
                    (transactionsLoading || recentTransactionsLoading) &&
                    recentSkeleton}
                {isVisible("recentTransactions") &&
                    !(transactionsLoading || recentTransactionsLoading) && (
                        <div className="cv-auto">
                            <VirtualDataTable
                                title={t("dashboard.recentTransactions")}
                                subtitle={t(
                                    "dashboard.recentTransactionsSubtitle",
                                    { n: recentTransactions.length },
                                )}
                                columns={columns}
                                data={recentTransactions}
                                emptyIcon={Receipt}
                                emptyMessage={t(
                                    "dashboard.recentTransactions.empty",
                                )}
                                actions={
                                    <ExclusionToggle
                                        graphKey="recentTransactions"
                                        isFiltered={
                                            graphExclusions[
                                                "recentTransactions"
                                            ] ?? true
                                        }
                                        onToggle={toggleGraphExclusion}
                                        exclusionsApply={exclusionsApply}
                                    />
                                }
                            />
                        </div>
                    )}
            </PageShell>
        </ChartSyncProvider>
    );
}
