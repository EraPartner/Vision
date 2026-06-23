import { useMemo, useState } from "react";
import { Money } from "@/components/shared/Money";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    AreaChart as VisxAreaChart,
    ChartCard,
    ChartPeriodSelector,
    CHART_PERIODS,
    Sparkline,
    type ChartPeriod,
} from "@/components/charts";
import {
    TrendingUp, TrendingDown, BarChart3, Loader2, Percent,
    DollarSign, Activity,
} from "lucide-react";
import { formatDate, parseISO } from "@/components/shared/dateUtils";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { PageHeader } from "@/components/shared/PageHeader";
import PerformanceBreakdown from "@/components/portfolio/PerformanceBreakdown";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

const CHART_KEYS = {
    invested: 'invested',
    inflationAdjusted: 'inflationAdjusted',
    value: 'value',
    fxNeutral: 'fxNeutral',
    stocksEtfs: 'stocksEtfs',
    crypto: 'crypto',
    metals: 'metals',
    relativePortfolio: 'relativePortfolio',
    relativeStocksEtfs: 'relativeStocksEtfs',
    relativeCrypto: 'relativeCrypto',
    relativeMetals: 'relativeMetals',
    relativeInflationAdjusted: 'relativeInflationAdjusted',
} as const;

const FX_NEUTRAL_COLOR = 'hsl(280, 87%, 65%)';

function PerformanceEmptyState() {
    const { t } = useLanguage();
    const { refreshPrices, isRefreshingPrices } = usePortfolio();
    const isOnline = useOnlineStatus();
    return (
        <div className="space-y-6">
            <PageHeader title={t('performance.title')} icon={BarChart3} />
            <Card className="glass-regular">
                <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                    <BarChart3 className="h-10 w-10 text-muted-foreground" />
                    <div>
                        <p className="font-medium">{t('performance.emptyTitle')}</p>
                        <p className="text-sm text-muted-foreground max-w-md mt-1">
                            {t('performance.emptyDescription')}
                        </p>
                    </div>
                    <Button
                        onClick={refreshPrices}
                        disabled={isRefreshingPrices || !isOnline}
                        size="sm"
                        title={!isOnline ? t('portfolio.refreshPricesOffline') : undefined}
                    >
                        <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isRefreshingPrices ? "animate-spin" : ""}`} />
                        {t('portfolio.refreshPrices')}
                    </Button>
                    {!isOnline && (
                        <p className="text-xs text-muted-foreground max-w-md">
                            {t('portfolio.refreshPricesOffline')}
                        </p>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

export default function PerformancePage() {
    const { t, language } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";
    const [selectedPeriod, setSelectedPeriod] = useState<ChartPeriod>("all");
    const [showFxNeutral, setShowFxNeutral] = useState(false);

    const { data: portfolioPerformanceData, isLoading } = useQuery({
        queryKey: ["portfolio-performance", defaultCurrency, selectedPeriod],
        queryFn: () => apiClient.getPortfolioPerformance({ currency: defaultCurrency, period: selectedPeriod }),
        staleTime: 300_000,
        gcTime: 10 * 60_000,
        placeholderData: keepPreviousData,
    });

    const { data: sparkline1mData } = useQuery({
        queryKey: ["portfolio-performance", defaultCurrency, "1m"],
        queryFn: () => apiClient.getPortfolioPerformance({ currency: defaultCurrency, period: "1m" }),
        staleTime: 300_000,
        gcTime: 10 * 60_000,
    });

    const PERIOD_LABELS: Record<ChartPeriod, string> = {
        "1m": t('performance.period.1m'),
        "3m": t('performance.period.3m'),
        "6m": t('performance.period.6m'),
        "1y": t('performance.period.1y'),
        "3y": t('performance.period.3y'),
        "all": t('performance.period.all'),
    };

    const monthLabelLocale = useMemo(() => (language === "nl" ? "nl-NL" : "en-US"), [language]);

    const xTickFormatter = useMemo(() => {
        if (selectedPeriod === "1m" || selectedPeriod === "3m" || selectedPeriod === "6m") {
            return new Intl.DateTimeFormat(monthLabelLocale, { day: "numeric", month: "short" });
        }
        return new Intl.DateTimeFormat(monthLabelLocale, { month: "short", year: "2-digit" });
    }, [monthLabelLocale, selectedPeriod]);

    const snapshots = useMemo(() => portfolioPerformanceData?.snapshots ?? [], [portfolioPerformanceData]);
    const overallMetrics = portfolioPerformanceData?.metrics ?? null;
    const heatmapData = portfolioPerformanceData?.heatmap ?? { years: [] as number[], data: {} as Record<number, (number | null)[]>, maxAbsPct: 0 };
    const breakdownSummary = portfolioPerformanceData?.breakdownSummary ?? [];
    const liveTotals = portfolioPerformanceData?.totals;

    // FX attribution is only meaningful when some holding is in a foreign
    // currency AND the snapshots carry the FX-neutral series (migration 0039
    // applied + snapshots recomputed). All-EUR portfolios see neither.
    const hasFxNeutralSeries = useMemo(
        () => snapshots.some((s) => typeof s.value_fx_neutral === 'number'
            && Math.abs((s.value_fx_neutral ?? 0) - s.value) > 0.01),
        [snapshots],
    );
    const hasFxExposure = breakdownSummary.some((b) => b.currency && b.currency !== defaultCurrency);

    // Lightweight mapping of already-downsampled snapshots to chart format
    const chartData = useMemo(() => snapshots.map((s) => ({
        day: s.date,
        [CHART_KEYS.invested]: Math.round(s.invested * 100) / 100,
        [CHART_KEYS.inflationAdjusted]: Math.round(s.inflation_adjusted_value * 100) / 100,
        [CHART_KEYS.value]: Math.round(s.value * 100) / 100,
        [CHART_KEYS.fxNeutral]: typeof s.value_fx_neutral === 'number' ? Math.round(s.value_fx_neutral * 100) / 100 : undefined,
        [CHART_KEYS.stocksEtfs]: Math.round(s.stocks_etfs_value * 100) / 100,
        [CHART_KEYS.crypto]: Math.round(s.crypto_value * 100) / 100,
        [CHART_KEYS.metals]: Math.round(s.metals_value * 100) / 100,
    })), [snapshots]);

    const latestAssetSplit = useMemo(() => {
        if (snapshots.length === 0) return null;
        const last = snapshots[snapshots.length - 1];
        const total = last.stocks_etfs_value + last.crypto_value + last.metals_value;
        if (total <= 0) return null;
        return {
            stocksEtfs: { value: last.stocks_etfs_value, pct: (last.stocks_etfs_value / total) * 100 },
            crypto: { value: last.crypto_value, pct: (last.crypto_value / total) * 100 },
            metals: { value: last.metals_value, pct: (last.metals_value / total) * 100 },
        };
    }, [snapshots]);

    const sparklineData = useMemo(
        () => (sparkline1mData?.snapshots ?? []).map((s) => ({ day: s.date, value: s.value })),
        [sparkline1mData],
    );

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

    if (isLoading) {
        return (
            <div className="space-y-6">
                <PageHeader title={t('performance.title')} icon={BarChart3} />
                <Card className="glass-regular">
                    <CardContent className="flex items-center justify-center h-48">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (snapshots.length === 0) {
        return <PerformanceEmptyState />;
    }

    return (
        <div className="space-y-6">
            <PageHeader
                title={t('performance.title')}
                subtitle={t('performance.subtitle')}
                icon={BarChart3}
            />

            {/* Period selector */}
            <ChartPeriodSelector
                periods={CHART_PERIODS}
                value={selectedPeriod}
                onChange={setSelectedPeriod}
                labels={PERIOD_LABELS}
            />

            {/* Key metrics cards */}
            {overallMetrics && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:grid-rows-3">
                    <TotalValueCard
                        currentValue={overallMetrics.currentValue}
                        totalInvested={overallMetrics.totalInvested}
                        totalGainLoss={overallMetrics.totalGainLoss}
                        totalReturnPct={overallMetrics.totalReturnPct}
                        currency={defaultCurrency}
                        locale={locale}
                        assetSplit={latestAssetSplit}
                        sparklineData={sparklineData}
                        fxAttribution={hasFxExposure && liveTotals ? {
                            assetGain: liveTotals.totalAssetGain ?? 0,
                            fxGain: liveTotals.totalFxGain ?? 0,
                            fellBack: liveTotals.usedFallbackRate === true,
                        } : null}
                        labels={{
                            title: t('portfolio.portfolioValue'),
                            invested: t('portfolio.totalInvested'),
                            netPL: t('performance.netGainLoss'),
                            allocation: t('performance.allocation'),
                            last30Days: t('performance.last30Days'),
                            stocksEtfs: t('performance.relativeStocksEtfs'),
                            crypto: t('performance.crypto'),
                            metals: t('performance.metals'),
                            assetGain: t('portfolio.assetGain'),
                            fxEffect: t('portfolio.fxEffect'),
                            fxFallbackNote: t('portfolio.fxFallbackNote'),
                        }}
                    />
                    <CompactReturnCard
                        title={t('portfolio.totalReturn')}
                        value={`${overallMetrics.totalReturnPct >= 0 ? "+" : ""}${overallMetrics.totalReturnPct.toFixed(2)}%`}
                        subtitle={formatCurrency(overallMetrics.totalGainLoss, defaultCurrency, locale)}
                        icon={overallMetrics.totalReturnPct >= 0 ? TrendingUp : TrendingDown}
                        trend={overallMetrics.totalReturnPct >= 0}
                    />
                    <CompactReturnCard
                        title={t('portfolio.annualizedReturn')}
                        value={`${overallMetrics.annualizedReturn >= 0 ? "+" : ""}${overallMetrics.annualizedReturn.toFixed(2)}%`}
                        subtitle={t('performance.projectedYearly')}
                        icon={Activity}
                        trend={overallMetrics.annualizedReturn >= 0}
                    />
                    <CompactReturnCard
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
                <ChartCard
                    title={t('performance.valueOverTime')}
                    description={t('performance.chartDesc', { period: PERIOD_LABELS[selectedPeriod] })}
                    icon={BarChart3}
                    actions={hasFxNeutralSeries ? (
                        <button
                            onClick={() => setShowFxNeutral((v) => !v)}
                            title={t('performance.fxNeutralDesc')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-all shrink-0 ${
                                showFxNeutral
                                    ? "bg-background text-foreground shadow-sm border-border"
                                    : "text-muted-foreground hover:text-foreground border-transparent"
                            }`}
                        >
                            {t('performance.fxNeutral')}
                        </button>
                    ) : undefined}
                    legend={[
                        { label: t('portfolio.totalInvested'), color: 'hsl(var(--muted-foreground))', dashed: true },
                        { label: t('performance.inflationAdjusted'), color: 'hsl(30, 80%, 55%)' },
                        { label: t('performance.relativeStocksEtfs'), color: 'hsl(0, 72%, 51%)' },
                        { label: t('performance.crypto'), color: 'hsl(142, 76%, 36%)' },
                        { label: t('performance.metals'), color: 'hsl(45, 93%, 47%)' },
                        ...(showFxNeutral && hasFxNeutralSeries
                            ? [{ label: t('performance.fxNeutral'), color: FX_NEUTRAL_COLOR, dashed: true }]
                            : []),
                        { label: t('portfolio.portfolioValue'), color: 'hsl(var(--primary))' },
                    ]}
                >
                    <VisxAreaChart
                        scrubbable
                        data={chartData}
                        xAccessor={(d) => parseISO(d.day)}
                        series={[
                            { key: CHART_KEYS.invested, label: t('portfolio.totalInvested'), accessor: (d) => d.invested, color: 'hsl(var(--muted-foreground))', dashed: true, strokeWidth: 1.5 },
                            { key: CHART_KEYS.inflationAdjusted, label: t('performance.inflationAdjusted'), accessor: (d) => d.inflationAdjusted, color: 'hsl(30, 80%, 55%)', strokeWidth: 2 },
                            { key: CHART_KEYS.stocksEtfs, label: t('performance.relativeStocksEtfs'), accessor: (d) => d.stocksEtfs, color: 'hsl(0, 72%, 51%)', fillOpacity: 0, strokeWidth: 2 },
                            { key: CHART_KEYS.crypto, label: t('performance.crypto'), accessor: (d) => d.crypto, color: 'hsl(142, 76%, 36%)', fillOpacity: 0, strokeWidth: 2 },
                            { key: CHART_KEYS.metals, label: t('performance.metals'), accessor: (d) => d.metals, color: 'hsl(45, 93%, 47%)', fillOpacity: 0, strokeWidth: 2 },
                            ...(showFxNeutral && hasFxNeutralSeries ? [
                                { key: CHART_KEYS.fxNeutral, label: t('performance.fxNeutral'), accessor: (d: typeof chartData[number]) => d.fxNeutral, color: FX_NEUTRAL_COLOR, fillOpacity: 0, dashed: true, strokeWidth: 2 },
                            ] : []),
                            { key: CHART_KEYS.value, label: t('portfolio.portfolioValue'), accessor: (d) => d.value, color: 'hsl(var(--primary))', strokeWidth: 2.5 },
                        ]}
                        xIsDate={true}
                        xTickFormat={(v) => xTickFormatter.format(v as Date)}
                        yTickFormat={(v) => formatCurrency(v as number, defaultCurrency, locale)}
                        tooltipTitle={(d) => formatDate(parseISO(d.day), "dd MMM yyyy")}
                        tooltipValueFormat={(v) => formatCurrency(v, defaultCurrency, locale)}
                        height={360}
                        margin={{ top: 16, right: 24, bottom: 28, left: 110 }}
                    />
                </ChartCard>
            )}

            {/* Relative Performance chart */}
            {relativePerformanceData.length > 1 && (
                <ChartCard
                    title={t('performance.relativeTitle')}
                    description={t('performance.relativeDesc', { period: PERIOD_LABELS[selectedPeriod] })}
                    icon={Activity}
                    legend={[
                        { label: t('performance.relativePortfolio'), color: 'hsl(var(--primary))' },
                        { label: t('performance.relativeStocksEtfs'), color: 'hsl(0, 72%, 51%)' },
                        { label: t('performance.crypto'), color: 'hsl(142, 76%, 36%)' },
                        { label: t('performance.metals'), color: 'hsl(45, 93%, 47%)' },
                        { label: t('performance.inflationAdjusted'), color: 'hsl(30, 80%, 55%)', dashed: true },
                    ]}
                >
                    <VisxAreaChart
                        scrubbable
                        data={relativePerformanceData}
                        xAccessor={(d) => parseISO(d.day)}
                        series={[
                            { key: CHART_KEYS.relativePortfolio, label: t('performance.relativePortfolio'), accessor: (d) => d.relativePortfolio, color: 'hsl(var(--primary))', strokeWidth: 2.5 },
                            { key: CHART_KEYS.relativeStocksEtfs, label: t('performance.relativeStocksEtfs'), accessor: (d) => d.relativeStocksEtfs, color: 'hsl(0, 72%, 51%)', fillOpacity: 0, strokeWidth: 2 },
                            { key: CHART_KEYS.relativeCrypto, label: t('performance.crypto'), accessor: (d) => d.relativeCrypto, color: 'hsl(142, 76%, 36%)', fillOpacity: 0, strokeWidth: 2 },
                            { key: CHART_KEYS.relativeMetals, label: t('performance.metals'), accessor: (d) => d.relativeMetals, color: 'hsl(45, 93%, 47%)', fillOpacity: 0, strokeWidth: 2 },
                            { key: CHART_KEYS.relativeInflationAdjusted, label: t('performance.inflationAdjusted'), accessor: (d) => d.relativeInflationAdjusted, color: 'hsl(30, 80%, 55%)', fillOpacity: 0, dashed: true, strokeWidth: 2 },
                        ]}
                        xIsDate={true}
                        xTickFormat={(v) => xTickFormatter.format(v as Date)}
                        yTickFormat={(v) => `${(v as number) > 0 ? '+' : ''}${(v as number).toFixed(0)}%`}
                        tooltipTitle={(d) => formatDate(parseISO(d.day), "dd MMM yyyy")}
                        tooltipValueFormat={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`}
                        height={320}
                        margin={{ top: 16, right: 24, bottom: 28, left: 72 }}
                    />
                </ChartCard>
            )}

            <PerformanceBreakdown heatmapData={heatmapData} breakdownSummary={breakdownSummary} />
        </div>
    );
}

type IconType = React.ComponentType<{ className?: string }>;

function CompactReturnCard({
    title, value, subtitle, icon: Icon, trend,
}: {
    title: string; value: string; subtitle: string; icon: IconType; trend: boolean;
}) {
    const iconBg = trend
        ? "bg-gradient-to-br from-success/20 to-success/10 text-success"
        : "bg-gradient-to-br from-destructive/20 to-destructive/10 text-destructive";
    const trendGlassClass = trend ? "liquid-glass-trend-up" : "liquid-glass-trend-down";

    return (
        <Card
            className={`liquid-glass micro-lift ${trendGlassClass} relative overflow-hidden border shadow-md lg:col-span-2 lg:row-span-1`}
        >
            <CardContent className="flex items-center justify-between gap-3 py-3 px-4">
                <div className="min-w-0">
                    <p className="text-xs font-medium text-muted-foreground truncate">{title}</p>
                    <div className="text-xl font-bold text-foreground leading-tight">{value}</div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{subtitle}</p>
                </div>
                <div className={`h-9 w-9 shrink-0 rounded-xl flex items-center justify-center ${iconBg} shadow-sm`}>
                    <Icon className="h-4 w-4" />
                </div>
            </CardContent>
        </Card>
    );
}

type AssetSplit = {
    stocksEtfs: { value: number; pct: number };
    crypto: { value: number; pct: number };
    metals: { value: number; pct: number };
} | null;

interface TotalValueCardProps {
    currentValue: number;
    totalInvested: number;
    totalGainLoss: number;
    totalReturnPct: number;
    currency: string;
    locale: string;
    assetSplit: AssetSplit;
    sparklineData: Array<{ day: string; value: number }>;
    /** Gain decomposition (asset performance vs currency effect); null hides the line. */
    fxAttribution: { assetGain: number; fxGain: number; fellBack: boolean } | null;
    labels: {
        title: string;
        invested: string;
        netPL: string;
        allocation: string;
        last30Days: string;
        stocksEtfs: string;
        crypto: string;
        metals: string;
        assetGain: string;
        fxEffect: string;
        fxFallbackNote: string;
    };
}

function TotalValueCard({
    currentValue, totalInvested, totalGainLoss, totalReturnPct,
    currency, locale, assetSplit, sparklineData, fxAttribution, labels,
}: TotalValueCardProps) {
    const isGain = totalGainLoss >= 0;
    const trendGlassClass = isGain ? "liquid-glass-trend-up" : "liquid-glass-trend-down";
    const iconBg = isGain
        ? "bg-gradient-to-br from-success/20 to-success/10 text-success"
        : "bg-gradient-to-br from-destructive/20 to-destructive/10 text-destructive";
    const gainToneClass = isGain ? "text-success" : "text-destructive";

    return (
        <Card
            className={`liquid-glass micro-lift ${trendGlassClass} relative overflow-hidden border shadow-lg lg:col-span-2 lg:row-span-3`}
        >
            <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-20 -mt-20 pointer-events-none" />
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground">{labels.title}</CardTitle>
                <div className={`h-9 w-9 rounded-xl flex items-center justify-center ${iconBg} shadow-sm`}>
                    <DollarSign className="h-4 w-4" />
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                <div>
                    <div className="text-3xl font-bold text-foreground leading-tight">
                        <Money amount={currentValue} currency={currency} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
                        <span className="text-muted-foreground">
                            {labels.invested}: <span className="font-medium text-foreground"><Money amount={totalInvested} currency={currency} /></span>
                        </span>
                        <span className="text-muted-foreground">
                            {labels.netPL}:{" "}
                            <span className={`font-semibold ${gainToneClass}`}>
                                {isGain ? "+" : ""}<Money amount={totalGainLoss} currency={currency} />
                            </span>{" "}
                            <span className={`font-medium ${gainToneClass}`}>
                                ({isGain ? "+" : ""}{totalReturnPct.toFixed(2)}%)
                            </span>
                        </span>
                    </div>
                    {fxAttribution && (
                        <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                            {labels.assetGain}:{" "}
                            <span className={fxAttribution.assetGain >= 0 ? "text-success font-medium" : "text-destructive font-medium"}>
                                {fxAttribution.assetGain >= 0 ? "+" : ""}<Money amount={fxAttribution.assetGain} currency={currency} />
                            </span>
                            {" · "}{labels.fxEffect}:{" "}
                            <span className={fxAttribution.fxGain >= 0 ? "text-success font-medium" : "text-destructive font-medium"}>
                                {fxAttribution.fxGain >= 0 ? "+" : ""}<Money amount={fxAttribution.fxGain} currency={currency} />
                            </span>
                            {fxAttribution.fellBack && (
                                <span title={labels.fxFallbackNote} aria-label={labels.fxFallbackNote}> ⚠</span>
                            )}
                        </div>
                    )}
                </div>

                {sparklineData.length > 1 && (
                    <div>
                        <p className="text-[11px] font-medium text-muted-foreground mb-1">{labels.last30Days}</p>
                        <div className="-mx-1">
                            <Sparkline data={sparklineData.map((p) => p.value)} height={64} color="hsl(var(--primary))" fillArea strokeWidth={2} />
                        </div>
                    </div>
                )}

                {assetSplit && (
                    <AssetAllocationBar
                        split={assetSplit}
                        currency={currency}
                        locale={locale}
                        labels={{
                            allocation: labels.allocation,
                            stocksEtfs: labels.stocksEtfs,
                            crypto: labels.crypto,
                            metals: labels.metals,
                        }}
                    />
                )}
            </CardContent>
        </Card>
    );
}

interface AssetAllocationBarProps {
    split: NonNullable<AssetSplit>;
    currency: string;
    locale: string;
    labels: { allocation: string; stocksEtfs: string; crypto: string; metals: string };
}

function AssetAllocationBar({ split, currency, labels }: AssetAllocationBarProps) {
    const rows = [
        { key: "stocksEtfs", label: labels.stocksEtfs, pct: split.stocksEtfs.pct, value: split.stocksEtfs.value, color: "bg-rose-500" },
        { key: "crypto", label: labels.crypto, pct: split.crypto.pct, value: split.crypto.value, color: "bg-emerald-500" },
        { key: "metals", label: labels.metals, pct: split.metals.pct, value: split.metals.value, color: "bg-amber-500" },
    ].filter((r) => r.pct > 0);

    if (rows.length === 0) return null;

    return (
        <div>
            <p className="text-[11px] font-medium text-muted-foreground mb-1.5">{labels.allocation}</p>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
                {rows.map((r) => (
                    <div
                        key={r.key}
                        className={r.color}
                        style={{ width: `${r.pct}%` }}
                        aria-label={`${r.label} ${r.pct.toFixed(1)}%`}
                    />
                ))}
            </div>
            <ul className="mt-2 space-y-0.5">
                {rows.map((r) => (
                    <li key={r.key} className="flex items-center justify-between text-[11px]">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                            <span className={`inline-block h-2 w-2 rounded-full ${r.color}`} />
                            {r.label}
                        </span>
                        <span className="text-foreground font-medium tabular-nums">
                            <Money amount={r.value} currency={currency} />{" "}
                            <span className="text-muted-foreground font-normal">({r.pct.toFixed(1)}%)</span>
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
