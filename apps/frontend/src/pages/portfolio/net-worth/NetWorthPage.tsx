import { PAGE_ICONS } from "@/lib/pageIcons";
import { useCallback, useMemo } from "react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    appLanguageToLocale,
    CHART_DATE_PATTERNS,
    formatDate,
} from "@/lib/dateUtils";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import {
    useCurrencyFormatter,
    useCurrencyPartsFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    TrendingUp,
    TrendingDown,
    Wallet,
    Landmark,
    PiggyBank,
    CreditCard,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatCard } from "@/components/shared/StatCard";
import { RollingNumber } from "@/components/shared/RollingNumber";
import {
    CHART_PERIODS,
    filterByPeriod,
    type ChartPeriod,
} from "@/components/charts";
import { EMPTY_SNAPSHOTS, normalizeYmd, fmtDay } from "./netWorthChartUtils";
import { NetWorthChart } from "./NetWorthChart";
import { SnapshotDataTable } from "./SnapshotDataTable";
import { Money } from "@/components/shared/Money";
import { useNetWorthTableData } from "./useNetWorthTableData";
import { StalePricesBanner } from "@/features/portfolio/StalePricesBanner";
import { PriceFreshnessCaption } from "@/features/portfolio/PriceFreshnessCaption";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { PageShell } from "@/components/shared/PageShell";
import {
    enumSearchParamCodec,
    useSearchParamState,
} from "@/hooks/useSearchParamState";
import { useNetWorthSummary } from "@/features/portfolio/usePortfolioQueries";

const PERIOD_CODEC = enumSearchParamCodec<ChartPeriod>(
    ["1m", "3m", "6m", "1y", "3y", "all"],
    "all",
);

export default function NetWorthPage() {
    const formatPercent = usePercentFormatter();
    const { t, language } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const targetCurrency = appSettings.defaultCurrency || "EUR";

    const { data, isLoading, error } = useNetWorthSummary(targetCurrency);

    const { investments, refreshPrices, isRefreshingPrices } = usePortfolio();
    const isOnline = useOnlineStatus();

    const {
        allItems: tableSnapshots,
        totalItems: tableTotal,
        isFetchingMore: tableIsFetchingMore,
        hasMore: tableHasMore,
        loadMore: tableLoadMore,
    } = useNetWorthTableData({
        currency: targetCurrency,
        pageSize: appSettings.defaultPageSize,
    });

    const [period, setPeriod] = useSearchParamState("period", PERIOD_CODEC);

    const snapshots = useMemo(() => {
        const raw = data?.snapshots ?? EMPTY_SNAPSHOTS;
        const result: typeof EMPTY_SNAPSHOTS = [];
        for (let i = 0; i < raw.length; i++) {
            const s = raw[i];
            const date = normalizeYmd(s.date);
            if (
                date &&
                Number.isFinite(s.netWorth) &&
                Number.isFinite(s.liquid) &&
                Number.isFinite(s.investments)
            ) {
                const liabilities = Number.isFinite(s.liabilities)
                    ? s.liabilities
                    : 0;
                result.push(
                    date !== s.date
                        ? {
                              date,
                              netWorth: s.netWorth,
                              liquid: s.liquid,
                              liabilities,
                              investments: s.investments,
                          }
                        : s,
                );
            }
        }
        return result;
    }, [data?.snapshots]);

    // Full daily resolution — no downsampling — so the chart and drag-to-compare
    // scrubbing stay day-granular. Period only scopes the visible window.
    const displaySnapshots = useMemo(
        () => filterByPeriod(snapshots, (s) => s.date, period),
        [snapshots, period],
    );

    const fmt = useCurrencyFormatter();
    const fmtParts = useCurrencyPartsFormatter();

    const monthLabelLocale = useMemo(
        () => appLanguageToLocale(language),
        [language],
    );
    const xTickPattern =
        period === "1m" || period === "3m" || period === "6m"
            ? CHART_DATE_PATTERNS.dayTick
            : CHART_DATE_PATTERNS.monthTick;
    const xTickFormat = useCallback(
        (d: Date) => formatDate(d, xTickPattern, monthLabelLocale),
        [monthLabelLocale, xTickPattern],
    );

    const periodLabels = useMemo(
        (): Record<ChartPeriod, string> => ({
            "1m": t("performance.period.1m"),
            "3m": t("performance.period.3m"),
            "6m": t("performance.period.6m"),
            "1y": t("performance.period.1y"),
            "3y": t("performance.period.3y"),
            all: t("performance.period.all"),
        }),
        [t],
    );

    const current = data?.current ?? {
        liquid: 0,
        liabilities: 0,
        investments: 0,
        netWorth: 0,
    };

    const tooltipLabelFormatter = useCallback(
        (v: string) => fmtDay(v, appSettings.dateFormat),
        [appSettings.dateFormat],
    );

    if (isLoading) {
        return (
            <PageShell {...loadingSurfaceProps} className="">
                <PageHeader
                    title={t("networth.title")}
                    icon={PAGE_ICONS["/portfolio/net-worth"]}
                />
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {[1, 2, 3].map((i) => (
                        <Card key={i}>
                            <CardContent variant="headerless">
                                <Skeleton className="h-16 w-full" />
                            </CardContent>
                        </Card>
                    ))}
                </div>
                <Card>
                    <CardContent variant="headerless">
                        <Skeleton className="h-[400px] w-full" />
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    if (error || !data) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("networth.title")}
                    icon={PAGE_ICONS["/portfolio/net-worth"]}
                />
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                        <Wallet className="h-12 w-12 text-muted-foreground/40 mb-4" />
                        <h2 className="text-lg font-semibold text-foreground mb-1">
                            {t("networth.unableToLoad")}
                        </h2>
                        <p className="text-muted-foreground text-sm">
                            {apiErrorToMessage(error, t)}
                        </p>
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    if (snapshots.length === 0) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("networth.title")}
                    icon={PAGE_ICONS["/portfolio/net-worth"]}
                />
                <EmptyState
                    icon={PAGE_ICONS["/portfolio/net-worth"]}
                    title={t("networth.emptyTitle")}
                    description={t("networth.emptyDescription")}
                    action={
                        <div className="flex flex-col items-center gap-2">
                            <Button
                                onClick={refreshPrices}
                                disabled={isRefreshingPrices || !isOnline}
                                size="sm"
                                title={
                                    !isOnline
                                        ? t("portfolio.refreshPricesOffline")
                                        : undefined
                                }
                            >
                                <RefreshCw
                                    className={cn(
                                        "h-3.5 w-3.5 mr-2",
                                        isRefreshingPrices && "animate-spin",
                                    )}
                                />
                                {t("portfolio.refreshPrices")}
                            </Button>
                            {!isOnline && (
                                <p className="text-xs text-muted-foreground max-w-md">
                                    {t("portfolio.refreshPricesOffline")}
                                </p>
                            )}
                        </div>
                    }
                />
            </PageShell>
        );
    }

    // Peak/trough/days-tracked reflect the selected period (the visible window),
    // matching the chart below; the "all time" change badge stays on the full series.
    let peak = current.netWorth;
    let trough = current.netWorth;
    for (const s of displaySnapshots) {
        if (s.netWorth > peak) peak = s.netWorth;
        if (s.netWorth < trough) trough = s.netWorth;
    }
    const firstNetWorth = snapshots[0]?.netWorth ?? 0;
    const allTimeChange = current.netWorth - firstNetWorth;
    const allTimePercent =
        firstNetWorth !== 0
            ? (allTimeChange / Math.abs(firstNetWorth)) * 100
            : 0;
    const monthlyChange = data.monthlyChange ?? 0;
    const monthlyChangePercent = data.monthlyChangePercent ?? 0;

    const liquidPct = formatPercent(
        current.netWorth > 0 ? (current.liquid / current.netWorth) * 100 : 0,
        { digits: 0 },
    );
    const investmentsPct = formatPercent(
        current.netWorth > 0
            ? (current.investments / current.netWorth) * 100
            : 0,
        { digits: 0 },
    );
    const liabilitiesPct = formatPercent(
        current.netWorth > 0
            ? (current.liabilities / current.netWorth) * 100
            : 0,
        { digits: 0 },
    );
    const hasLiabilities = Math.abs(current.liabilities) > 0.005;

    return (
        <PageShell className="" data-print-page="net-worth">
            <PageHeader
                title={t("networth.title")}
                icon={PAGE_ICONS["/portfolio/net-worth"]}
                actions={
                    <span data-print-actions>
                        <Badge
                            variant="outline"
                            className={cn(
                                "text-sm px-3 py-1",
                                allTimeChange >= 0
                                    ? "border-gain/30 text-gain"
                                    : "border-loss/30 text-loss",
                            )}
                        >
                            {allTimeChange >= 0 ? (
                                <TrendingUp className="h-3.5 w-3.5 mr-1" />
                            ) : (
                                <TrendingDown className="h-3.5 w-3.5 mr-1" />
                            )}
                            <Money amount={allTimeChange} signed />{" "}
                            {t("networth.allTime")} (
                            {formatPercent(allTimePercent, {
                                digits: 1,
                                signed: true,
                            })}
                            )
                        </Badge>
                    </span>
                }
            />

            <StalePricesBanner
                investments={investments}
                onRefresh={refreshPrices}
                isRefreshing={isRefreshingPrices}
            />

            {/* Summary — intrinsic Net Worth hero beside the component breakdown. */}
            <div className="grid items-start gap-4 lg:grid-cols-2 animate-stagger">
                <div>
                    <StatCard
                        title={t("networth.title")}
                        value={
                            <RollingNumber parts={fmtParts(current.netWorth)} />
                        }
                        icon={Wallet}
                        valueClassName="text-primary"
                        trend={monthlyChange >= 0 ? "income" : "expense"}
                        subtitle={
                            <span className="flex flex-col gap-0.5">
                                <span>
                                    <Money amount={monthlyChange} signed /> (
                                    {formatPercent(monthlyChangePercent, {
                                        digits: 1,
                                        signed: true,
                                    })}
                                    ) {t("networth.thisMonth")}
                                </span>
                                <PriceFreshnessCaption
                                    investments={investments}
                                    scope="investment"
                                />
                            </span>
                        }
                    />
                </div>
                <div className="grid gap-4">
                    <StatCard
                        title={t("networth.liquid")}
                        value={
                            <RollingNumber parts={fmtParts(current.liquid)} />
                        }
                        icon={Landmark}
                        trend="neutral"
                        subtitle={t("networth.ofNetWorth", { n: liquidPct })}
                    />
                    <StatCard
                        title={t("networth.investments")}
                        value={
                            <RollingNumber
                                parts={fmtParts(current.investments)}
                            />
                        }
                        icon={PiggyBank}
                        trend="neutral"
                        subtitle={t("networth.ofNetWorth", {
                            n: investmentsPct,
                        })}
                    />
                    {hasLiabilities && (
                        <StatCard
                            title={t("networth.liabilities")}
                            value={
                                <RollingNumber
                                    parts={fmtParts(current.liabilities)}
                                />
                            }
                            icon={CreditCard}
                            trend="expense"
                            subtitle={t("networth.ofNetWorth", {
                                n: liabilitiesPct,
                            })}
                        />
                    )}
                </div>
            </div>

            <NetWorthChart
                snapshots={displaySnapshots}
                period={period}
                periods={CHART_PERIODS}
                periodLabels={periodLabels}
                onPeriodChange={setPeriod}
                fmt={fmt}
                xTickFormat={xTickFormat}
                tooltipLabelFormatter={tooltipLabelFormatter}
                t={t}
            />

            {/* Historical extremes */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard
                    title={t("networth.peak")}
                    value={<RollingNumber parts={fmtParts(peak)} />}
                    icon={TrendingUp}
                    trend="income"
                />
                <StatCard
                    title={t("networth.lowest")}
                    value={<RollingNumber parts={fmtParts(trough)} />}
                    icon={TrendingDown}
                    trend="expense"
                />
                <StatCard
                    title={t("networth.daysTracked")}
                    value={String(displaySnapshots.length)}
                    icon={Wallet}
                />
            </div>

            <SnapshotDataTable
                snapshots={tableSnapshots}
                currency={targetCurrency}
                dateFormat={appSettings.dateFormat}
                t={t}
                totalItems={tableTotal}
                isFetchingMore={tableIsFetchingMore}
                hasMore={tableHasMore}
                onLoadMore={tableLoadMore}
            />
        </PageShell>
    );
}
