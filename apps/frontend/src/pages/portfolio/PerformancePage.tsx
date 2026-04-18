import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/contexts/LanguageContext";
import { AreaChart, type AreaSeries } from "@/components/charts";
import {
    TrendingUp, TrendingDown, BarChart3, Loader2, Percent,
    DollarSign, Activity,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { PageHeader } from "@/components/shared/PageHeader";
import PerformanceBreakdown from "@/components/portfolio/PerformanceBreakdown";
import { StatCard } from "@/components/dashboard/StatCard";

type Period = "1m" | "3m" | "6m" | "1y" | "3y" | "all";

const PERIOD_KEYS = ["1m", "3m", "6m", "1y", "3y", "all"] as const;

const CHART_KEYS = {
    invested: 'invested',
    inflationAdjusted: 'inflationAdjusted',
    value: 'value',
    stocksEtfs: 'stocksEtfs',
    crypto: 'crypto',
    metals: 'metals',
    relativePortfolio: 'relativePortfolio',
    relativeStocksEtfs: 'relativeStocksEtfs',
    relativeCrypto: 'relativeCrypto',
    relativeMetals: 'relativeMetals',
    relativeInflationAdjusted: 'relativeInflationAdjusted',
} as const;

export default function PerformancePage() {
    const { t, language } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";
    const [selectedPeriod, setSelectedPeriod] = useState<Period>("all");

    const { data: portfolioPerformanceData, isLoading } = useQuery({
        queryKey: ["portfolio-performance", defaultCurrency, selectedPeriod],
        queryFn: () => apiClient.getPortfolioPerformance({ currency: defaultCurrency, period: selectedPeriod }),
        staleTime: 300_000,
        gcTime: 10 * 60_000,
        placeholderData: keepPreviousData,
    });

    const PERIOD_LABELS: Record<Period, string> = {
        "1m": t('performance.period.1m'),
        "3m": t('performance.period.3m'),
        "6m": t('performance.period.6m'),
        "1y": t('performance.period.1y'),
        "3y": t('performance.period.3y'),
        "all": t('performance.period.all'),
    };

    const monthLabelLocale = useMemo(() => (language === "nl" ? "nl-NL" : "en-US"), [language]);

    const monthTickFormatter = useMemo(
        () => new Intl.DateTimeFormat(monthLabelLocale, { month: "short", year: "2-digit" }),
        [monthLabelLocale],
    );

    const snapshots = portfolioPerformanceData?.snapshots ?? [];
    const overallMetrics = portfolioPerformanceData?.metrics ?? null;
    const heatmapData = portfolioPerformanceData?.heatmap ?? { years: [] as number[], data: {} as Record<number, (number | null)[]>, maxAbsPct: 0 };
    const breakdownSummary = portfolioPerformanceData?.breakdownSummary ?? [];

    // Lightweight mapping of already-downsampled snapshots to chart format
    const chartData = useMemo(() => snapshots.map((s) => ({
        day: s.date,
        [CHART_KEYS.invested]: Math.round(s.invested * 100) / 100,
        [CHART_KEYS.inflationAdjusted]: Math.round(s.inflation_adjusted_value * 100) / 100,
        [CHART_KEYS.value]: Math.round(s.value * 100) / 100,
        [CHART_KEYS.stocksEtfs]: Math.round(s.stocks_etfs_value * 100) / 100,
        [CHART_KEYS.crypto]: Math.round(s.crypto_value * 100) / 100,
        [CHART_KEYS.metals]: Math.round(s.metals_value * 100) / 100,
    })), [snapshots]);

    // Relative performance (percentage-based) from already-downsampled snapshots
    const relativePerformanceData = useMemo(() => {
        if (snapshots.length < 2) return [];

        const cumulativeReturn = (value: number, invested: number) =>
            invested > 0 ? Math.round(((value / invested) - 1) * 10000) / 100 : 0;

        return snapshots.map((s) => ({
            day: s.date,
            [CHART_KEYS.relativePortfolio]: cumulativeReturn(s.value, s.invested),
            [CHART_KEYS.relativeStocksEtfs]: cumulativeReturn(s.stocks_etfs_value, s.stocks_etfs_invested),
            [CHART_KEYS.relativeCrypto]: cumulativeReturn(s.crypto_value, s.crypto_invested),
            [CHART_KEYS.relativeMetals]: cumulativeReturn(s.metals_value, s.metals_invested),
            [CHART_KEYS.relativeInflationAdjusted]: cumulativeReturn(s.inflation_adjusted_value, s.invested),
        }));
    }, [snapshots]);

    if (isLoading || snapshots.length === 0) {
        return (
            <div className="space-y-6">
                <PageHeader title={t('performance.title')} icon={BarChart3} />
                <Card>
                    <CardContent className="flex items-center justify-center h-48">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <PageHeader
                title={t('performance.title')}
                subtitle={t('performance.subtitle')}
                icon={BarChart3}
            />

            {/* Period selector */}
            <div className="inline-flex gap-1 p-1 liquid-glass premium-frame rounded-xl w-fit">
                {PERIOD_KEYS.map((p) => (
                    <button
                        key={p}
                        onClick={() => setSelectedPeriod(p)}
                        className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all duration-300 ${
                            selectedPeriod === p
                                ? "bg-gradient-to-br from-primary/20 to-primary/10 text-primary shadow-sm ring-1 ring-primary/20"
                                : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                        }`}
                    >
                        {PERIOD_LABELS[p]}
                    </button>
                ))}
            </div>

            {/* Key metrics — bento */}
            {overallMetrics && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6 animate-stagger">
                    <div className="lg:col-span-3 lg:row-span-2 [&>*]:h-full">
                        <StatCard
                            title={t('portfolio.portfolioValue')}
                            value={formatCurrency(overallMetrics.currentValue, defaultCurrency, locale)}
                            numericValue={overallMetrics.currentValue}
                            formatValue={(v) => formatCurrency(v, defaultCurrency, locale)}
                            icon={DollarSign}
                            trend={overallMetrics.totalGainLoss >= 0 ? "income" : "expense"}
                            subtitle={t('portfolio.invested', { amount: formatCurrency(overallMetrics.totalInvested, defaultCurrency, locale) })}
                        />
                    </div>
                    <div className="lg:col-span-3">
                        <StatCard
                            title={t('portfolio.totalReturn')}
                            value={`${overallMetrics.totalReturnPct >= 0 ? "+" : ""}${overallMetrics.totalReturnPct.toFixed(2)}%`}
                            icon={overallMetrics.totalReturnPct >= 0 ? TrendingUp : TrendingDown}
                            trend={overallMetrics.totalReturnPct >= 0 ? "income" : "expense"}
                            subtitle={formatCurrency(overallMetrics.totalGainLoss, defaultCurrency, locale)}
                        />
                    </div>
                    <div className="lg:col-span-2">
                        <StatCard
                            title={t('portfolio.annualizedReturn')}
                            value={`${overallMetrics.annualizedReturn >= 0 ? "+" : ""}${overallMetrics.annualizedReturn.toFixed(2)}%`}
                            icon={Activity}
                            trend={overallMetrics.annualizedReturn >= 0 ? "income" : "expense"}
                            subtitle={t('performance.projectedYearly')}
                        />
                    </div>
                    <div className="lg:col-span-1">
                        <StatCard
                            title={t('portfolio.realReturn')}
                            value={`${overallMetrics.realReturnPct >= 0 ? "+" : ""}${overallMetrics.realReturnPct.toFixed(2)}%`}
                            icon={Percent}
                            trend={overallMetrics.realReturnPct >= 0 ? "income" : "expense"}
                            subtitle={t('performance.cumulativeInflation', { n: overallMetrics.cumulativeInflation.toFixed(1) })}
                        />
                    </div>
                </div>
            )}

            {/* Portfolio Value Over Time chart */}
            {chartData.length > 1 && (
                <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
                    <CardHeader>
                        <div className="flex items-center gap-3">
                            <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-sm text-primary transition-transform duration-300 group-hover:scale-105">
                                <BarChart3 className="h-5 w-5" />
                            </div>
                            <div>
                                <CardTitle>{t('performance.valueOverTime')}</CardTitle>
                                <CardDescription>
                                    {t('performance.chartDesc', { period: PERIOD_LABELS[selectedPeriod] })}
                                </CardDescription>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <AreaChart
                            data={chartData}
                            xAccessor={(d) => parseISO(String(d.day))}
                            xIsDate
                            height={360}
                            xTickFormat={(v) => monthTickFormatter.format(v as Date)}
                            yTickFormat={(v) => formatCurrency(v, defaultCurrency, locale)}
                            tooltipTitle={(d) => format(parseISO(String(d.day)), "dd MMM yyyy")}
                            tooltipValueFormat={(v) => formatCurrency(v, defaultCurrency, locale)}
                            series={[
                                { key: CHART_KEYS.value, label: t('portfolio.portfolioValue'), accessor: (d) => d[CHART_KEYS.value], color: "hsl(var(--primary))", strokeWidth: 2.5 },
                                { key: CHART_KEYS.inflationAdjusted, label: t('performance.inflationAdjusted'), accessor: (d) => d[CHART_KEYS.inflationAdjusted], color: "hsl(var(--chart-3))" },
                                { key: CHART_KEYS.stocksEtfs, label: t('performance.relativeStocksEtfs') || t('nav.stocksEtfs'), accessor: (d) => d[CHART_KEYS.stocksEtfs], color: "hsl(var(--chart-5))" },
                                { key: CHART_KEYS.crypto, label: t('performance.crypto'), accessor: (d) => d[CHART_KEYS.crypto], color: "hsl(var(--chart-2))" },
                                { key: CHART_KEYS.metals, label: t('performance.metals'), accessor: (d) => d[CHART_KEYS.metals], color: "hsl(var(--chart-4))" },
                                { key: CHART_KEYS.invested, label: t('portfolio.totalInvested'), accessor: (d) => d[CHART_KEYS.invested], color: "hsl(var(--muted-foreground))", dashed: true, strokeWidth: 1.5 },
                            ] as AreaSeries<(typeof chartData)[number]>[]}
                        />
                    </CardContent>
                </Card>
            )}

            {/* Relative Performance chart */}
            {relativePerformanceData.length > 1 && (
                <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
                    <CardHeader>
                        <div className="flex items-center gap-3">
                            <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-accent/20 to-accent/5 flex items-center justify-center shadow-sm text-accent-foreground transition-transform duration-300 group-hover:scale-105">
                                <Activity className="h-5 w-5" />
                            </div>
                            <div>
                                <CardTitle>{t('performance.relativeTitle')}</CardTitle>
                                <CardDescription>
                                    {t('performance.relativeDesc', { period: PERIOD_LABELS[selectedPeriod] })}
                                </CardDescription>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <AreaChart
                            data={relativePerformanceData}
                            xAccessor={(d) => parseISO(String(d.day))}
                            xIsDate
                            height={320}
                            xTickFormat={(v) => monthTickFormatter.format(v as Date)}
                            yTickFormat={(v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(0)}%`}
                            tooltipTitle={(d) => format(parseISO(String(d.day)), "dd MMM yyyy")}
                            tooltipValueFormat={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`}
                            referenceLines={[{ y: 0, color: "hsl(var(--border))" }]}
                            series={[
                                { key: CHART_KEYS.relativePortfolio, label: t('performance.relativePortfolio'), accessor: (d) => d[CHART_KEYS.relativePortfolio], color: "hsl(var(--primary))", strokeWidth: 2.5 },
                                { key: CHART_KEYS.relativeStocksEtfs, label: t('performance.relativeStocksEtfs'), accessor: (d) => d[CHART_KEYS.relativeStocksEtfs], color: "hsl(var(--chart-5))" },
                                { key: CHART_KEYS.relativeCrypto, label: t('performance.crypto'), accessor: (d) => d[CHART_KEYS.relativeCrypto], color: "hsl(var(--chart-2))" },
                                { key: CHART_KEYS.relativeMetals, label: t('performance.metals'), accessor: (d) => d[CHART_KEYS.relativeMetals], color: "hsl(var(--chart-4))" },
                                { key: CHART_KEYS.relativeInflationAdjusted, label: t('performance.inflationAdjusted'), accessor: (d) => d[CHART_KEYS.relativeInflationAdjusted], color: "hsl(var(--chart-3))", dashed: true },
                            ] as AreaSeries<(typeof relativePerformanceData)[number]>[]}
                        />
                    </CardContent>
                </Card>
            )}

            <PerformanceBreakdown heatmapData={heatmapData} breakdownSummary={breakdownSummary} />
        </div>
    );
}

