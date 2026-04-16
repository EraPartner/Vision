import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Legend,
} from "recharts";
import {
    TrendingUp, TrendingDown, BarChart3, Loader2, Percent,
    DollarSign, Activity,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { PageHeader } from "@/components/shared/PageHeader";
import PerformanceBreakdown from "@/components/portfolio/PerformanceBreakdown";

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
            <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
                {PERIOD_KEYS.map((p) => (
                    <button
                        key={p}
                        onClick={() => setSelectedPeriod(p)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                            selectedPeriod === p
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {PERIOD_LABELS[p]}
                    </button>
                ))}
            </div>

            {/* Key metrics cards */}
            {overallMetrics && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <MetricCard
                        title={t('portfolio.portfolioValue')}
                        value={formatCurrency(overallMetrics.currentValue, defaultCurrency, locale)}
                        subtitle={t('portfolio.invested', { amount: formatCurrency(overallMetrics.totalInvested, defaultCurrency, locale) })}
                        icon={DollarSign}
                        trend={overallMetrics.totalGainLoss >= 0}
                    />
                    <MetricCard
                        title={t('portfolio.totalReturn')}
                        value={`${overallMetrics.totalReturnPct >= 0 ? "+" : ""}${overallMetrics.totalReturnPct.toFixed(2)}%`}
                        subtitle={formatCurrency(overallMetrics.totalGainLoss, defaultCurrency, locale)}
                        icon={overallMetrics.totalReturnPct >= 0 ? TrendingUp : TrendingDown}
                        trend={overallMetrics.totalReturnPct >= 0}
                    />
                    <MetricCard
                        title={t('portfolio.annualizedReturn')}
                        value={`${overallMetrics.annualizedReturn >= 0 ? "+" : ""}${overallMetrics.annualizedReturn.toFixed(2)}%`}
                        subtitle={t('performance.projectedYearly')}
                        icon={Activity}
                        trend={overallMetrics.annualizedReturn >= 0}
                    />
                    <MetricCard
                        title={t('portfolio.realReturn')}
                        value={`${overallMetrics.realReturnPct >= 0 ? "+" : ""}${overallMetrics.realReturnPct.toFixed(2)}%`}
                        subtitle={t('performance.cumulativeInflation', { n: overallMetrics.cumulativeInflation.toFixed(1) })}
                        icon={Percent}
                        trend={overallMetrics.realReturnPct >= 0}
                    />
                </div>
            )}

            {/* Portfolio Value Over Time chart */}
            {chartData.length > 1 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <BarChart3 className="h-5 w-5 text-primary" />
                            {t('performance.valueOverTime')}
                        </CardTitle>
                        <CardDescription>
                            {t('performance.chartDesc', { period: PERIOD_LABELS[selectedPeriod] })}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ResponsiveContainer width="100%" height={360}>
                            <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                                <defs>
                                    <linearGradient id="gradValue" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                                    </linearGradient>
                                    <linearGradient id="gradInvested" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0.15} />
                                        <stop offset="95%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0} />
                                    </linearGradient>
                                    <linearGradient id="gradInflAdj" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="hsl(30, 80%, 55%)" stopOpacity={0.2} />
                                        <stop offset="95%" stopColor="hsl(30, 80%, 55%)" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                                <XAxis
                                    dataKey="day"
                                    tick={{ fontSize: 12 }}
                                    className="fill-muted-foreground"
                                    interval="preserveStartEnd"
                                    minTickGap={20}
                                    tickFormatter={(value) => monthTickFormatter.format(parseISO(String(value)))}
                                />
                                <YAxis
                                    tick={{ fontSize: 12 }}
                                    className="fill-muted-foreground"
                                    tickFormatter={(v) => formatCurrency(v, defaultCurrency, locale)}
                                />
                                <Tooltip
                                    contentStyle={{
                                        backgroundColor: "hsl(var(--card))",
                                        border: "1px solid hsl(var(--border))",
                                        borderRadius: "8px",
                                        fontSize: "12px",
                                    }}
                                    labelFormatter={(label) => format(parseISO(String(label)), "dd MMM yyyy")}
                                    formatter={(value: number) => [formatCurrency(value, defaultCurrency, locale)]}
                                />
                                <Legend />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.invested}
                                    name={t('portfolio.totalInvested')}
                                    stroke="hsl(var(--muted-foreground))"
                                    fill="url(#gradInvested)"
                                    strokeWidth={1.5}
                                    strokeDasharray="4 4"
                                    isAnimationActive={false}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.inflationAdjusted}
                                    name={t('performance.inflationAdjusted')}
                                    stroke="hsl(30, 80%, 55%)"
                                    fill="url(#gradInflAdj)"
                                    strokeWidth={2}
                                    isAnimationActive={false}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.stocksEtfs}
                                    name={t('performance.relativeStocksEtfs') || t('nav.stocksEtfs')}
                                    stroke="hsl(0, 72%, 51%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                    isAnimationActive={false}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.crypto}
                                    name={t('performance.crypto')}
                                    stroke="hsl(142, 76%, 36%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                    isAnimationActive={false}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.metals}
                                    name={t('performance.metals')}
                                    stroke="hsl(45, 93%, 47%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                    isAnimationActive={false}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.value}
                                    name={t('portfolio.portfolioValue')}
                                    stroke="hsl(var(--primary))"
                                    fill="url(#gradValue)"
                                    strokeWidth={2.5}
                                    isAnimationActive={false}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>
            )}

            {/* Relative Performance chart */}
            {relativePerformanceData.length > 1 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Activity className="h-5 w-5 text-primary" />
                            {t('performance.relativeTitle')}
                        </CardTitle>
                        <CardDescription>
                            {t('performance.relativeDesc', { period: PERIOD_LABELS[selectedPeriod] })}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ResponsiveContainer width="100%" height={320}>
                            <AreaChart data={relativePerformanceData} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                                <defs>
                                    <linearGradient id="gradRelPortfolio" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.25} />
                                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                                <XAxis
                                    dataKey="day"
                                    tick={{ fontSize: 12 }}
                                    className="fill-muted-foreground"
                                    interval="preserveStartEnd"
                                    minTickGap={20}
                                    tickFormatter={(value) => monthTickFormatter.format(parseISO(String(value)))}
                                />
                                <YAxis
                                    tick={{ fontSize: 12 }}
                                    className="fill-muted-foreground"
                                    tickFormatter={(v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(0)}%`}
                                />
                                <Tooltip
                                    contentStyle={{
                                        backgroundColor: "hsl(var(--card))",
                                        border: "1px solid hsl(var(--border))",
                                        borderRadius: "8px",
                                        fontSize: "12px",
                                    }}
                                    labelFormatter={(label) => format(parseISO(String(label)), "dd MMM yyyy")}
                                    formatter={(value: number) => [`${value > 0 ? '+' : ''}${value.toFixed(2)}%`]}
                                />
                                <Legend />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.relativePortfolio}
                                    name={t('performance.relativePortfolio')}
                                    stroke="hsl(var(--primary))"
                                    fill="url(#gradRelPortfolio)"
                                    strokeWidth={2.5}
                                    isAnimationActive={false}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.relativeStocksEtfs}
                                    name={t('performance.relativeStocksEtfs')}
                                    stroke="hsl(0, 72%, 51%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                    isAnimationActive={false}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.relativeCrypto}
                                    name={t('performance.crypto')}
                                    stroke="hsl(142, 76%, 36%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                    isAnimationActive={false}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.relativeMetals}
                                    name={t('performance.metals')}
                                    stroke="hsl(45, 93%, 47%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                    isAnimationActive={false}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.relativeInflationAdjusted}
                                    name={t('performance.inflationAdjusted')}
                                    stroke="hsl(30, 80%, 55%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                    strokeDasharray="4 4"
                                    isAnimationActive={false}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>
            )}

            <PerformanceBreakdown heatmapData={heatmapData} breakdownSummary={breakdownSummary} />
        </div>
    );
}

function MetricCard({
    title, value, subtitle, icon: Icon, trend,
}: {
    title: string; value: string; subtitle: string;
    icon: React.ComponentType<{ className?: string }>; trend: boolean;
}) {
    const iconBg = trend
        ? "bg-gradient-to-br from-emerald-500/20 to-green-500/20 text-emerald-600 dark:text-emerald-400"
        : "bg-gradient-to-br from-rose-500/20 to-red-500/20 text-rose-600 dark:text-rose-300";
    const trendGlassClass = trend ? "liquid-glass-trend-up" : "liquid-glass-trend-down";

    return (
        <Card className={`liquid-glass micro-lift ${trendGlassClass} relative overflow-hidden border shadow-lg`}>
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16" />
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground">{title}</CardTitle>
                <div className={`h-9 w-9 rounded-xl flex items-center justify-center ${iconBg} shadow-sm`}>
                    <Icon className="h-4 w-4" />
                </div>
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold text-foreground">{value}</div>
                <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
            </CardContent>
        </Card>
    );
}
