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
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { TrendingUp, TrendingDown, Wallet, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatCard } from "@/components/shared/StatCard";
import { RollingNumber } from "@/components/shared/RollingNumber";
import {
    CHART_PERIODS,
    ChartPeriodSelector,
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
import { usePortfolio } from "@/hooks/usePortfolio";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { PageShell } from "@/components/shared/PageShell";
import {
    enumSearchParamCodec,
    useSearchParamState,
} from "@/hooks/useSearchParamState";
import { useNetWorthSummary } from "@/features/portfolio/usePortfolioQueries";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { usePortfolioSummaryQuery } from "@/hooks/portfolio/usePortfolioSummary";
import { NetWorthByAccountList } from "./NetWorthByAccountList";
import { buildNetWorthAccountRows } from "./netWorthByAccount";

const PERIOD_CODEC = enumSearchParamCodec<ChartPeriod>(
    ["1m", "3m", "6m", "1y", "3y", "all"],
    "1y",
);

/** Amounts below half a cent read as nothing to show. */
const ZERO_EPSILON = 0.005;

function changeTone(value: number) {
    return value > ZERO_EPSILON
        ? "text-gain"
        : value < -ZERO_EPSILON
          ? "text-loss"
          : "text-label-secondary";
}

export default function NetWorthPage() {
    const formatPercent = usePercentFormatter();
    const { t, language } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const targetCurrency = appSettings.defaultCurrency || "EUR";

    const { data, isLoading, error } = useNetWorthSummary(targetCurrency);
    const accountsQuery = useAccounts({ active: "all" });
    const portfolioSummaryQuery = usePortfolioSummaryQuery(targetCurrency);
    const currencyConverter = useCurrencyConverter(targetCurrency);

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
    const byAccountRows = useMemo(
        () =>
            accountsQuery.data && portfolioSummaryQuery.data
                ? buildNetWorthAccountRows(
                      accountsQuery.data.items,
                      portfolioSummaryQuery.data,
                      currencyConverter.convertToTargetIfAvailable,
                      t("networth.byAccount.unassigned"),
                  )
                : undefined,
        [
            accountsQuery.data,
            portfolioSummaryQuery.data,
            currencyConverter.convertToTargetIfAvailable,
            t,
        ],
    );

    const tooltipLabelFormatter = useCallback(
        (v: string) => fmtDay(v, appSettings.dateFormat),
        [appSettings.dateFormat],
    );

    const header = (
        <PageHeader
            title={t("networth.title")}
            icon={PAGE_ICONS["/portfolio/net-worth"]}
        />
    );

    if (isLoading) {
        return (
            <PageShell {...loadingSurfaceProps} className="">
                {header}
                <Card>
                    <CardContent
                        variant="headerless"
                        className="grid gap-6 lg:grid-cols-5"
                    >
                        <div className="space-y-3 lg:col-span-3">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-12 w-48 max-w-full" />
                            <Skeleton className="h-4 w-40 max-w-full" />
                        </div>
                        <div className="space-y-4 lg:col-span-2">
                            <Skeleton className="h-8 w-full" />
                            <Skeleton className="h-8 w-full" />
                        </div>
                    </CardContent>
                </Card>
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
                {header}
                <Card>
                    <CardContent
                        variant="state"
                        className="flex flex-col items-center gap-1 text-center"
                    >
                        <h2 className="type-headline text-foreground">
                            {t("networth.unableToLoad")}
                        </h2>
                        <p className="max-w-prose type-callout text-label-secondary">
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
                {header}
                <Card>
                    <CardContent
                        variant="state"
                        className="flex flex-col items-center gap-3 text-center"
                    >
                        <h2 className="type-headline text-foreground">
                            {t("networth.emptyTitle")}
                        </h2>
                        <p className="max-w-sm type-callout text-label-secondary">
                            {t("networth.emptyDescription")}
                        </p>
                        <Button
                            onClick={refreshPrices}
                            disabled={isRefreshingPrices || !isOnline}
                            title={
                                !isOnline
                                    ? t("portfolio.refreshPricesOffline")
                                    : undefined
                            }
                        >
                            <RefreshCw
                                aria-hidden="true"
                                className={cn(
                                    "mr-2 h-4 w-4",
                                    isRefreshingPrices && "animate-spin",
                                )}
                            />
                            {t("portfolio.refreshPrices")}
                        </Button>
                        {!isOnline && (
                            <p className="max-w-sm type-footnote text-label-tertiary">
                                {t("portfolio.refreshPricesOffline")}
                            </p>
                        )}
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    // Peak/trough/days-tracked reflect the selected period (the visible window),
    // matching the chart below; the all-time change stays on the full series.
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

    // The two bars read as a subtraction: assets minus debt is the number above.
    const assets = current.liquid + current.investments;
    const debt = Math.abs(current.liabilities);
    const barScale = Math.max(assets, debt, 1);
    const bars = [
        {
            key: "assets",
            label: t("networth.assets"),
            value: assets,
            tone: "bg-gain",
            detail: (
                <>
                    <span>
                        {t("networth.liquid")}{" "}
                        <Money amount={current.liquid} />
                    </span>
                    {" · "}
                    <span>
                        {t("networth.investments")}{" "}
                        <Money amount={current.investments} />
                    </span>
                </>
            ),
        },
        {
            key: "debt",
            label: t("networth.debt"),
            value: debt,
            tone: "bg-loss",
            detail: null,
        },
    ];

    return (
        <PageShell className="" data-print-page="net-worth">
            {header}

            <StalePricesBanner
                investments={investments}
                onRefresh={refreshPrices}
                isRefreshing={isRefreshingPrices}
            />

            <Card className="overflow-hidden">
                <CardContent
                    variant="headerless"
                    className="grid gap-6 lg:grid-cols-5"
                >
                    <div className="space-y-3 lg:col-span-3">
                        <p className="eyebrow">{t("networth.title")}</p>
                        <p className="type-large-title tabular-nums text-foreground">
                            <RollingNumber parts={fmtParts(current.netWorth)} />
                        </p>
                        <p className="type-callout text-label-secondary">
                            <span
                                className={cn(
                                    "tabular-nums",
                                    changeTone(monthlyChange),
                                )}
                            >
                                <Money amount={monthlyChange} signed /> (
                                {formatPercent(monthlyChangePercent, {
                                    digits: 1,
                                    signed: true,
                                })}
                                )
                            </span>{" "}
                            {t("networth.thisMonth")}
                        </p>
                        <PriceFreshnessCaption
                            investments={investments}
                            scope="investment"
                            className="type-footnote text-label-tertiary"
                        />
                        <dl className="pt-2">
                            <div className="min-w-0">
                                <dt className="type-caption text-label-tertiary">
                                    {t("networth.sinceStart")}
                                </dt>
                                <dd
                                    className={cn(
                                        "flex items-center gap-1.5 type-headline tabular-nums",
                                        changeTone(allTimeChange),
                                    )}
                                >
                                    {allTimeChange >= 0 ? (
                                        <TrendingUp
                                            aria-hidden="true"
                                            className="h-4 w-4 shrink-0"
                                        />
                                    ) : (
                                        <TrendingDown
                                            aria-hidden="true"
                                            className="h-4 w-4 shrink-0"
                                        />
                                    )}
                                    <Money amount={allTimeChange} signed />
                                    <span className="type-footnote">
                                        (
                                        {formatPercent(allTimePercent, {
                                            digits: 1,
                                            signed: true,
                                        })}
                                        )
                                    </span>
                                </dd>
                            </div>
                        </dl>
                    </div>
                    <dl className="space-y-4 lg:col-span-2 lg:self-center">
                        {bars.map((bar) => {
                            const empty = bar.value <= ZERO_EPSILON;
                            return (
                                <div key={bar.key} className="space-y-1.5">
                                    <div className="flex items-baseline justify-between gap-3 type-footnote">
                                        <dt className="text-label-secondary">
                                            {bar.label}
                                        </dt>
                                        <dd className="tabular-nums text-foreground">
                                            {empty ? (
                                                "—"
                                            ) : (
                                                <Money amount={bar.value} />
                                            )}
                                        </dd>
                                    </div>
                                    {!empty && (
                                        <div
                                            aria-hidden="true"
                                            className="h-1.5 overflow-hidden rounded-chip bg-foreground/[0.06]"
                                        >
                                            <div
                                                className={cn(
                                                    "h-full rounded-chip",
                                                    bar.tone,
                                                )}
                                                style={{
                                                    width: `${Math.min(100, (bar.value / barScale) * 100)}%`,
                                                }}
                                            />
                                        </div>
                                    )}
                                    {!empty && bar.detail && (
                                        <p className="type-caption tabular-nums text-label-tertiary">
                                            {bar.detail}
                                        </p>
                                    )}
                                </div>
                            );
                        })}
                    </dl>
                </CardContent>
            </Card>

            {accountsQuery.isLoading ||
            portfolioSummaryQuery.isLoading ||
            currencyConverter.isLoading ? (
                <Card>
                    <CardContent variant="headerless">
                        <Skeleton className="h-48 w-full" />
                    </CardContent>
                </Card>
            ) : accountsQuery.isError ||
              portfolioSummaryQuery.isError ||
              currencyConverter.error ||
              !byAccountRows ? (
                <Card>
                    <CardContent variant="state" className="text-center">
                        <p className="type-callout text-label-secondary">
                            {t("networth.byAccount.unavailable")}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <NetWorthByAccountList
                    rows={byAccountRows}
                    currency={targetCurrency}
                    headline={current.netWorth}
                />
            )}

            <NetWorthChart
                snapshots={displaySnapshots}
                actions={
                    <span data-print-actions>
                        <ChartPeriodSelector
                            periods={CHART_PERIODS}
                            value={period}
                            onChange={setPeriod}
                            labels={periodLabels}
                            size="sm"
                            aria-label={t("networth.overTime")}
                        />
                    </span>
                }
                fmt={fmt}
                xTickFormat={xTickFormat}
                tooltipLabelFormatter={tooltipLabelFormatter}
                t={t}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatCard
                    title={t("networth.peak")}
                    size="compact"
                    value={<RollingNumber parts={fmtParts(peak)} />}
                    icon={TrendingUp}
                    trend="income"
                />
                <StatCard
                    title={t("networth.lowest")}
                    size="compact"
                    value={<RollingNumber parts={fmtParts(trough)} />}
                    icon={TrendingDown}
                    trend="expense"
                />
                <StatCard
                    title={t("networth.daysTracked")}
                    size="compact"
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
