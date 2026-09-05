import { useMemo } from "react";
import { Money } from "@/components/shared/Money";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    AreaChart as VisxAreaChart,
    ChartCard,
    ChartPeriodSelector,
    CHART_PERIODS,
    type ChartPeriod,
} from "@/components/charts";
import {
    TrendingUp,
    TrendingDown,
    Percent,
    Activity,
    Info,
} from "lucide-react";
import {
    appLanguageToLocale,
    CHART_DATE_PATTERNS,
    formatDate,
    parseISO,
} from "@/lib/dateUtils";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { PageHeader } from "@/components/shared/PageHeader";
import { SectionLoader } from "@/components/shared/SectionLoader";
import PerformanceBreakdown from "@/features/portfolio/PerformanceBreakdown";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { StatCard } from "@/components/shared/StatCard";
import { EmptyState } from "@/components/shared/EmptyState";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { TouchDisclosure } from "@/components/shared/TouchDisclosure";
import { TotalValueCard } from "@/features/portfolio/TotalValueCard";
import { PageShell } from "@/components/shared/PageShell";
import {
    booleanSearchParamCodec,
    enumSearchParamCodec,
    useSearchParamState,
} from "@/hooks/useSearchParamState";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import { usePerformanceQueries } from "@/features/portfolio/usePortfolioQueries";

const PERIOD_CODEC = enumSearchParamCodec<ChartPeriod>(
    ["1m", "3m", "6m", "1y", "3y", "all"],
    "all",
);

const CHART_KEYS = {
    invested: "invested",
    inflationAdjusted: "inflationAdjusted",
    value: "value",
    fxNeutral: "fxNeutral",
    stocksEtfs: "stocksEtfs",
    crypto: "crypto",
    metals: "metals",
    relativePortfolio: "relativePortfolio",
    relativeStocksEtfs: "relativeStocksEtfs",
    relativeCrypto: "relativeCrypto",
    relativeMetals: "relativeMetals",
    relativeInflationAdjusted: "relativeInflationAdjusted",
} as const;

const FX_NEUTRAL_COLOR = "hsl(280, 87%, 65%)";

function PerformanceEmptyState() {
    const { t } = useLanguage();
    const { refreshPrices, isRefreshingPrices } = usePortfolio();
    const isOnline = useOnlineStatus();
    return (
        <PageShell className="">
            <PageHeader
                title={t("performance.title")}
                icon={PAGE_ICONS["/portfolio/performance"]}
            />
            <Card>
                <CardContent variant="flush">
                    <EmptyState
                        icon={PAGE_ICONS["/portfolio/performance"]}
                        title={t("performance.emptyTitle")}
                        description={t("performance.emptyDescription")}
                        action={
                            <div className="space-y-2">
                                <Button
                                    onClick={refreshPrices}
                                    disabled={isRefreshingPrices || !isOnline}
                                    size="sm"
                                    title={
                                        !isOnline
                                            ? t(
                                                  "portfolio.refreshPricesOffline",
                                              )
                                            : undefined
                                    }
                                >
                                    <RefreshCw
                                        className={cn(
                                            "h-3.5 w-3.5 mr-2",
                                            isRefreshingPrices &&
                                                "animate-spin",
                                        )}
                                    />
                                    {t("portfolio.refreshPrices")}
                                </Button>
                                {!isOnline && (
                                    <p className="max-w-md text-xs text-muted-foreground">
                                        {t("portfolio.refreshPricesOffline")}
                                    </p>
                                )}
                            </div>
                        }
                    />
                </CardContent>
            </Card>
        </PageShell>
    );
}

export default function PerformancePage() {
    const formatPercent = usePercentFormatter();
    const { t, language } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";
    const [selectedPeriod, setSelectedPeriod] = useSearchParamState(
        "period",
        PERIOD_CODEC,
    );
    const [showFxNeutral, setShowFxNeutral] = useSearchParamState(
        "fx_neutral",
        booleanSearchParamCodec,
    );

    const { performance, sparkline1m } = usePerformanceQueries(
        defaultCurrency,
        selectedPeriod,
    );
    const {
        data: portfolioPerformanceData,
        isLoading,
        isError,
        error,
    } = performance;

    const { data: sparkline1mData } = sparkline1m;

    const PERIOD_LABELS: Record<ChartPeriod, string> = {
        "1m": t("performance.period.1m"),
        "3m": t("performance.period.3m"),
        "6m": t("performance.period.6m"),
        "1y": t("performance.period.1y"),
        "3y": t("performance.period.3y"),
        all: t("performance.period.all"),
    };

    const monthLabelLocale = useMemo(
        () => appLanguageToLocale(language),
        [language],
    );

    const xTickPattern =
        selectedPeriod === "1m" ||
        selectedPeriod === "3m" ||
        selectedPeriod === "6m"
            ? CHART_DATE_PATTERNS.dayTick
            : CHART_DATE_PATTERNS.monthTick;

    const snapshots = useMemo(
        () => portfolioPerformanceData?.snapshots ?? [],
        [portfolioPerformanceData],
    );
    const overallMetrics = portfolioPerformanceData?.metrics ?? null;
    const heatmapData = portfolioPerformanceData?.heatmap ?? {
        years: [] as number[],
        data: {} as Record<number, (number | null)[]>,
        maxAbsPct: 0,
    };
    const breakdownSummary = portfolioPerformanceData?.breakdownSummary ?? [];
    const liveTotals = portfolioPerformanceData?.totals;

    // FX attribution is only meaningful when some holding is in a foreign
    // currency AND the snapshots carry the FX-neutral series (migration 0039
    // applied + snapshots recomputed). All-EUR portfolios see neither.
    const hasFxNeutralSeries = useMemo(
        () =>
            snapshots.some(
                (s) =>
                    typeof s.value_fx_neutral === "number" &&
                    Math.abs((s.value_fx_neutral ?? 0) - s.value) > 0.01,
            ),
        [snapshots],
    );
    const hasFxExposure = breakdownSummary.some(
        (b) => b.currency && b.currency !== defaultCurrency,
    );

    // Lightweight mapping of period-filtered daily snapshots to chart format.
    // chartDate is parsed ONCE here — parsing inside the chart's xAccessor ran
    // per point per render (~400 points × 7 series on a scrubbable chart).
    const chartData = useMemo(
        () =>
            snapshots.map((s) => ({
                day: s.date,
                chartDate: parseISO(s.date),
                [CHART_KEYS.invested]: Math.round(s.invested * 100) / 100,
                [CHART_KEYS.inflationAdjusted]:
                    Math.round(s.inflation_adjusted_value * 100) / 100,
                [CHART_KEYS.value]: Math.round(s.value * 100) / 100,
                [CHART_KEYS.fxNeutral]:
                    typeof s.value_fx_neutral === "number"
                        ? Math.round(s.value_fx_neutral * 100) / 100
                        : undefined,
                [CHART_KEYS.stocksEtfs]:
                    Math.round(s.stocks_etfs_value * 100) / 100,
                [CHART_KEYS.crypto]: Math.round(s.crypto_value * 100) / 100,
                [CHART_KEYS.metals]: Math.round(s.metals_value * 100) / 100,
            })),
        [snapshots],
    );

    const latestAssetSplit = useMemo(() => {
        if (snapshots.length === 0) return null;
        const last = snapshots[snapshots.length - 1];
        const total =
            last.stocks_etfs_value + last.crypto_value + last.metals_value;
        if (total <= 0) return null;
        return {
            stocksEtfs: {
                value: last.stocks_etfs_value,
                pct: (last.stocks_etfs_value / total) * 100,
            },
            crypto: {
                value: last.crypto_value,
                pct: (last.crypto_value / total) * 100,
            },
            metals: {
                value: last.metals_value,
                pct: (last.metals_value / total) * 100,
            },
        };
    }, [snapshots]);

    const sparklineData = useMemo(
        () =>
            (sparkline1mData?.snapshots ?? []).map((s) => ({
                day: s.date,
                value: s.value,
            })),
        [sparkline1mData],
    );

    // Relative performance (percentage-based) from period-filtered snapshots
    const relativePerformanceData = useMemo(() => {
        if (snapshots.length < 2) return [];

        const cumulativeReturn = (value: number, invested: number) =>
            invested > 0 ? Math.round((value / invested - 1) * 10000) / 100 : 0;

        return snapshots.map((s) => ({
            day: s.date,
            chartDate: parseISO(s.date),
            [CHART_KEYS.relativePortfolio]: cumulativeReturn(
                s.value,
                s.invested,
            ),
            [CHART_KEYS.relativeStocksEtfs]: cumulativeReturn(
                s.stocks_etfs_value,
                s.stocks_etfs_invested,
            ),
            [CHART_KEYS.relativeCrypto]: cumulativeReturn(
                s.crypto_value,
                s.crypto_invested,
            ),
            [CHART_KEYS.relativeMetals]: cumulativeReturn(
                s.metals_value,
                s.metals_invested,
            ),
            [CHART_KEYS.relativeInflationAdjusted]: cumulativeReturn(
                s.inflation_adjusted_value,
                s.invested,
            ),
        }));
    }, [snapshots]);

    if (isLoading) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("performance.title")}
                    icon={PAGE_ICONS["/portfolio/performance"]}
                />
                <SectionLoader />
            </PageShell>
        );
    }

    // A failed fetch must not masquerade as "no holdings yet" — the empty state
    // tells the user to add holdings / refresh prices, wrong on a network error.
    if (isError) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("performance.title")}
                    icon={PAGE_ICONS["/portfolio/performance"]}
                />
                <Card>
                    <CardContent variant="headerless">
                        <p className="text-destructive">
                            {t("common.loadError", {
                                msg: apiErrorToMessage(error, t),
                            })}
                        </p>
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    if (snapshots.length === 0) {
        return <PerformanceEmptyState />;
    }

    return (
        <PageShell className="">
            <PageHeader
                title={t("performance.title")}
                subtitle={t("performance.subtitle")}
                icon={PAGE_ICONS["/portfolio/performance"]}
            />

            {/* Period selector */}
            <ChartPeriodSelector
                periods={CHART_PERIODS}
                value={selectedPeriod}
                onChange={setSelectedPeriod}
                labels={PERIOD_LABELS}
            />

            {snapshots.at(-1)?.is_provisional ? (
                <div
                    role="note"
                    className="flex max-w-3xl items-start gap-2 rounded-lg border border-border/70 bg-muted/35 px-3 py-2 text-sm"
                >
                    <Info
                        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <div>
                        <span className="font-medium text-foreground">
                            {t("performance.latestSnapshotProvisional")}
                        </span>{" "}
                        <span className="text-muted-foreground">
                            {t(
                                "performance.latestSnapshotProvisionalDescription",
                            )}
                        </span>
                    </div>
                </div>
            ) : null}

            {/* Key metrics cards */}
            {overallMetrics && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:grid-rows-3">
                    <div className="lg:col-span-2 lg:row-span-3">
                        <TotalValueCard
                            formattedTotal={
                                <Money
                                    amount={overallMetrics.currentValue}
                                    currency={defaultCurrency}
                                />
                            }
                            totalValue={overallMetrics.currentValue}
                            isGain={overallMetrics.totalGainLoss >= 0}
                            headlineDetails={
                                <div className="mt-2 space-y-1 text-xs text-muted-foreground tabular-nums">
                                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                                        <span>
                                            {t("portfolio.totalInvested")}:{" "}
                                            <span className="font-medium text-foreground">
                                                <Money
                                                    amount={
                                                        overallMetrics.totalInvested
                                                    }
                                                    currency={defaultCurrency}
                                                />
                                            </span>
                                        </span>
                                        <span>
                                            {t("performance.netGainLoss")}:{" "}
                                            <span
                                                className={cn(
                                                    "font-semibold",
                                                    overallMetrics.totalGainLoss >=
                                                        0
                                                        ? "text-gain"
                                                        : "text-loss",
                                                )}
                                            >
                                                <Money
                                                    amount={
                                                        overallMetrics.totalGainLoss
                                                    }
                                                    currency={defaultCurrency}
                                                    signed
                                                />
                                            </span>{" "}
                                            <span
                                                className={cn(
                                                    "font-medium",
                                                    overallMetrics.totalReturnPct >=
                                                        0
                                                        ? "text-gain"
                                                        : "text-loss",
                                                )}
                                            >
                                                (
                                                {formatPercent(
                                                    overallMetrics.totalReturnPct,
                                                    { digits: 2, signed: true },
                                                )}
                                                )
                                            </span>
                                        </span>
                                    </div>
                                    {hasFxExposure && liveTotals ? (
                                        <div>
                                            {t("portfolio.assetGain")}:{" "}
                                            <span
                                                className={
                                                    (liveTotals.totalAssetGain ??
                                                        0) >= 0
                                                        ? "text-gain font-medium"
                                                        : "text-loss font-medium"
                                                }
                                            >
                                                <Money
                                                    amount={
                                                        liveTotals.totalAssetGain ??
                                                        0
                                                    }
                                                    currency={defaultCurrency}
                                                    signed
                                                />
                                            </span>
                                            {" · "}
                                            {t("portfolio.fxEffect")}:{" "}
                                            <span
                                                className={
                                                    (liveTotals.totalFxGain ??
                                                        0) >= 0
                                                        ? "text-gain font-medium"
                                                        : "text-loss font-medium"
                                                }
                                            >
                                                <Money
                                                    amount={
                                                        liveTotals.totalFxGain ??
                                                        0
                                                    }
                                                    currency={defaultCurrency}
                                                    signed
                                                />
                                            </span>
                                            {liveTotals.usedFallbackRate ===
                                            true ? (
                                                <TouchDisclosure
                                                    label={t(
                                                        "portfolio.fxFallbackNote",
                                                    )}
                                                    content={t(
                                                        "portfolio.fxFallbackNote",
                                                    )}
                                                    className="ml-1 text-warning [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10 [@media(pointer:coarse)]:justify-center"
                                                >
                                                    <span aria-hidden="true">
                                                        ⚠
                                                    </span>
                                                </TouchDisclosure>
                                            ) : null}
                                        </div>
                                    ) : null}
                                </div>
                            }
                            labels={{
                                title: t("portfolio.portfolioValue"),
                                investments: "",
                                assetSplit: t("performance.allocation"),
                                bestPerformer: t("portfolio.bestPerformer"),
                                worstPerformer: t("portfolio.worstPerformer"),
                                sparkline: t("performance.last30Days"),
                            }}
                            allocation={
                                latestAssetSplit
                                    ? [
                                          {
                                              name: t(
                                                  "performance.relativeStocksEtfs",
                                              ),
                                              value: latestAssetSplit.stocksEtfs
                                                  .value,
                                          },
                                          {
                                              name: t("performance.crypto"),
                                              value: latestAssetSplit.crypto
                                                  .value,
                                          },
                                          {
                                              name: t("performance.metals"),
                                              value: latestAssetSplit.metals
                                                  .value,
                                          },
                                      ].filter((slice) => slice.value > 0)
                                    : []
                            }
                            allocationTotal={
                                latestAssetSplit
                                    ? latestAssetSplit.stocksEtfs.value +
                                      latestAssetSplit.crypto.value +
                                      latestAssetSplit.metals.value
                                    : undefined
                            }
                            showAllocationValues
                            allocationFractionDigits={1}
                            sparkline={sparklineData.map((point) => ({
                                t: parseISO(point.day).getTime(),
                                v: point.value,
                            }))}
                            formatCurrency={(value) =>
                                formatCurrency(
                                    value,
                                    defaultCurrency,
                                    locale,
                                    appSettings.showDecimalPlaces ?? 2,
                                )
                            }
                        />
                    </div>
                    <StatCard
                        size="compact"
                        className="lg:col-span-2 lg:row-span-1"
                        title={t("portfolio.totalReturn")}
                        value={formatPercent(overallMetrics.totalReturnPct, {
                            digits: 2,
                            signed: true,
                        })}
                        subtitle={
                            <Money
                                amount={overallMetrics.totalGainLoss}
                                currency={defaultCurrency}
                            />
                        }
                        icon={
                            overallMetrics.totalReturnPct >= 0
                                ? TrendingUp
                                : TrendingDown
                        }
                        trend={
                            overallMetrics.totalReturnPct >= 0
                                ? "income"
                                : "expense"
                        }
                        valueClassName={
                            overallMetrics.totalReturnPct >= 0
                                ? "text-gain"
                                : "text-loss"
                        }
                    />
                    <StatCard
                        size="compact"
                        className="lg:col-span-2 lg:row-span-1"
                        title={t("portfolio.annualizedReturn")}
                        value={formatPercent(overallMetrics.annualizedReturn, {
                            digits: 2,
                            signed: true,
                        })}
                        subtitle={t("performance.projectedYearly")}
                        icon={Activity}
                        trend={
                            overallMetrics.annualizedReturn >= 0
                                ? "income"
                                : "expense"
                        }
                        valueClassName={
                            overallMetrics.annualizedReturn >= 0
                                ? "text-gain"
                                : "text-loss"
                        }
                    />
                    <StatCard
                        size="compact"
                        className="lg:col-span-2 lg:row-span-1"
                        title={t("portfolio.realReturn")}
                        value={formatPercent(overallMetrics.realReturnPct, {
                            digits: 2,
                            signed: true,
                        })}
                        subtitle={t("performance.cumulativeInflation", {
                            n: formatPercent(
                                overallMetrics.cumulativeInflation,
                                { digits: 1 },
                            ),
                        })}
                        icon={Percent}
                        trend={
                            overallMetrics.realReturnPct >= 0
                                ? "income"
                                : "expense"
                        }
                        valueClassName={
                            overallMetrics.realReturnPct >= 0
                                ? "text-gain"
                                : "text-loss"
                        }
                    />
                </div>
            )}

            {/* Portfolio Value Over Time chart */}
            {chartData.length > 1 && (
                <ChartCard
                    title={t("performance.valueOverTime")}
                    description={t("performance.chartDesc", {
                        period: PERIOD_LABELS[selectedPeriod],
                    })}
                    actions={
                        hasFxNeutralSeries ? (
                            <button
                                onClick={() => setShowFxNeutral((v) => !v)}
                                title={t("performance.fxNeutralDesc")}
                                className={cn(
                                    "px-3 py-1.5 text-xs font-medium rounded-md border transition-[color,background-color,border-color] shrink-0",
                                    showFxNeutral
                                        ? "bg-background text-foreground shadow-sm border-border"
                                        : "text-muted-foreground hover:text-foreground border-transparent",
                                )}
                            >
                                {t("performance.fxNeutral")}
                            </button>
                        ) : undefined
                    }
                    legend={[
                        {
                            label: t("portfolio.totalInvested"),
                            color: "hsl(var(--muted-foreground))",
                            dashed: true,
                        },
                        {
                            label: t("performance.inflationAdjusted"),
                            color: "hsl(30, 80%, 55%)",
                        },
                        {
                            label: t("performance.relativeStocksEtfs"),
                            color: "hsl(0, 72%, 51%)",
                        },
                        {
                            label: t("performance.crypto"),
                            color: "hsl(142, 76%, 36%)",
                        },
                        {
                            label: t("performance.metals"),
                            color: "hsl(45, 93%, 47%)",
                        },
                        ...(showFxNeutral && hasFxNeutralSeries
                            ? [
                                  {
                                      label: t("performance.fxNeutral"),
                                      color: FX_NEUTRAL_COLOR,
                                      dashed: true,
                                  },
                              ]
                            : []),
                        {
                            label: t("portfolio.portfolioValue"),
                            color: "hsl(var(--primary))",
                        },
                    ]}
                >
                    <VisxAreaChart
                        scrubbable
                        data={chartData}
                        xAccessor={(d) => d.chartDate}
                        series={[
                            {
                                key: CHART_KEYS.invested,
                                label: t("portfolio.totalInvested"),
                                accessor: (d) => d.invested,
                                color: "hsl(var(--muted-foreground))",
                                dashed: true,
                                strokeWidth: 1.5,
                            },
                            {
                                key: CHART_KEYS.inflationAdjusted,
                                label: t("performance.inflationAdjusted"),
                                accessor: (d) => d.inflationAdjusted,
                                color: "hsl(30, 80%, 55%)",
                                strokeWidth: 2,
                            },
                            {
                                key: CHART_KEYS.stocksEtfs,
                                label: t("performance.relativeStocksEtfs"),
                                accessor: (d) => d.stocksEtfs,
                                color: "hsl(0, 72%, 51%)",
                                fillOpacity: 0,
                                strokeWidth: 2,
                            },
                            {
                                key: CHART_KEYS.crypto,
                                label: t("performance.crypto"),
                                accessor: (d) => d.crypto,
                                color: "hsl(142, 76%, 36%)",
                                fillOpacity: 0,
                                strokeWidth: 2,
                            },
                            {
                                key: CHART_KEYS.metals,
                                label: t("performance.metals"),
                                accessor: (d) => d.metals,
                                color: "hsl(45, 93%, 47%)",
                                fillOpacity: 0,
                                strokeWidth: 2,
                            },
                            ...(showFxNeutral && hasFxNeutralSeries
                                ? [
                                      {
                                          key: CHART_KEYS.fxNeutral,
                                          label: t("performance.fxNeutral"),
                                          accessor: (
                                              d: (typeof chartData)[number],
                                          ) => d.fxNeutral,
                                          color: FX_NEUTRAL_COLOR,
                                          fillOpacity: 0,
                                          dashed: true,
                                          strokeWidth: 2,
                                      },
                                  ]
                                : []),
                            {
                                key: CHART_KEYS.value,
                                label: t("portfolio.portfolioValue"),
                                accessor: (d) => d.value,
                                color: "hsl(var(--primary))",
                                strokeWidth: 2.5,
                            },
                        ]}
                        xIsDate={true}
                        xTickFormat={(v) =>
                            formatDate(
                                v as Date,
                                xTickPattern,
                                monthLabelLocale,
                            )
                        }
                        yTickFormat={(v) =>
                            formatCurrency(
                                v as number,
                                defaultCurrency,
                                locale,
                                appSettings.showDecimalPlaces ?? 2,
                            )
                        }
                        tooltipTitle={(d) =>
                            formatDate(
                                parseISO(d.day),
                                CHART_DATE_PATTERNS.detail,
                                monthLabelLocale,
                            )
                        }
                        tooltipValueFormat={(v) =>
                            formatCurrency(
                                v,
                                defaultCurrency,
                                locale,
                                appSettings.showDecimalPlaces ?? 2,
                            )
                        }
                        height={360}
                        margin={{ top: 16, right: 24, bottom: 28, left: 110 }}
                    />
                </ChartCard>
            )}

            {/* Relative Performance chart */}
            {relativePerformanceData.length > 1 && (
                <ChartCard
                    title={t("performance.relativeTitle")}
                    description={t("performance.relativeDesc", {
                        period: PERIOD_LABELS[selectedPeriod],
                    })}
                    legend={[
                        {
                            label: t("performance.relativePortfolio"),
                            color: "hsl(var(--primary))",
                        },
                        {
                            label: t("performance.relativeStocksEtfs"),
                            color: "hsl(0, 72%, 51%)",
                        },
                        {
                            label: t("performance.crypto"),
                            color: "hsl(142, 76%, 36%)",
                        },
                        {
                            label: t("performance.metals"),
                            color: "hsl(45, 93%, 47%)",
                        },
                        {
                            label: t("performance.inflationAdjusted"),
                            color: "hsl(30, 80%, 55%)",
                            dashed: true,
                        },
                    ]}
                >
                    <VisxAreaChart
                        scrubbable
                        data={relativePerformanceData}
                        xAccessor={(d) => d.chartDate}
                        series={[
                            {
                                key: CHART_KEYS.relativePortfolio,
                                label: t("performance.relativePortfolio"),
                                accessor: (d) => d.relativePortfolio,
                                color: "hsl(var(--primary))",
                                strokeWidth: 2.5,
                            },
                            {
                                key: CHART_KEYS.relativeStocksEtfs,
                                label: t("performance.relativeStocksEtfs"),
                                accessor: (d) => d.relativeStocksEtfs,
                                color: "hsl(0, 72%, 51%)",
                                fillOpacity: 0,
                                strokeWidth: 2,
                            },
                            {
                                key: CHART_KEYS.relativeCrypto,
                                label: t("performance.crypto"),
                                accessor: (d) => d.relativeCrypto,
                                color: "hsl(142, 76%, 36%)",
                                fillOpacity: 0,
                                strokeWidth: 2,
                            },
                            {
                                key: CHART_KEYS.relativeMetals,
                                label: t("performance.metals"),
                                accessor: (d) => d.relativeMetals,
                                color: "hsl(45, 93%, 47%)",
                                fillOpacity: 0,
                                strokeWidth: 2,
                            },
                            {
                                key: CHART_KEYS.relativeInflationAdjusted,
                                label: t("performance.inflationAdjusted"),
                                accessor: (d) => d.relativeInflationAdjusted,
                                color: "hsl(30, 80%, 55%)",
                                fillOpacity: 0,
                                dashed: true,
                                strokeWidth: 2,
                            },
                        ]}
                        xIsDate={true}
                        xTickFormat={(v) =>
                            formatDate(
                                v as Date,
                                xTickPattern,
                                monthLabelLocale,
                            )
                        }
                        yTickFormat={(v) =>
                            formatPercent(v as number, {
                                digits: 0,
                                signed: true,
                            })
                        }
                        tooltipTitle={(d) =>
                            formatDate(
                                parseISO(d.day),
                                CHART_DATE_PATTERNS.detail,
                                monthLabelLocale,
                            )
                        }
                        tooltipValueFormat={(v) =>
                            formatPercent(v, { digits: 2, signed: true })
                        }
                        height={320}
                        margin={{ top: 16, right: 24, bottom: 28, left: 72 }}
                    />
                </ChartCard>
            )}

            <PerformanceBreakdown
                heatmapData={heatmapData}
                breakdownSummary={breakdownSummary}
            />
        </PageShell>
    );
}
