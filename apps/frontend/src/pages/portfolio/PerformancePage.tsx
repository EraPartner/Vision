import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { usePortfolio } from "@/hooks/usePortfolio";
import { formatCurrency } from "@/utils/currency";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Legend, ReferenceLine,
} from "recharts";
import {
    TrendingUp, TrendingDown, BarChart3, Loader2, Percent,
    Calendar, DollarSign, Activity, Target,
} from "lucide-react";
import { format, parseISO, differenceInMonths, differenceInDays, startOfMonth, endOfMonth, isAfter, isBefore, subMonths, subYears } from "date-fns";

// ─── EU Inflation (Eurostat HICP annual avg, hardcoded for simplicity) ───
const EU_ANNUAL_INFLATION: Record<number, number> = {
    2018: 1.8, 2019: 1.2, 2020: 0.3, 2021: 2.6,
    2022: 8.4, 2023: 5.4, 2024: 2.4, 2025: 2.1, 2026: 2.0,
};

function getMonthlyInflation(year: number): number {
    const annual = EU_ANNUAL_INFLATION[year] ?? 2.0;
    return annual / 12 / 100; // monthly rate
}

type Period = "1m" | "3m" | "6m" | "1y" | "3y" | "all";

interface MonthlySnapshot {
    month: string; // YYYY-MM
    date: Date;
    invested: number;
    value: number;
    gainLoss: number;
    returnPct: number;
    inflationAdjustedValue: number;
    realReturnPct: number;
    cumulativeInflation: number;
}

const PERIOD_KEYS = ["1m", "3m", "6m", "1y", "3y", "all"] as const;

export default function PerformancePage() {
    const { t, language } = useLanguage();
    const { summaries, totalPortfolioValue, totalGainLoss, investments, transactions } = usePortfolio();
    const [selectedPeriod, setSelectedPeriod] = useState<Period>("all");

    const PERIOD_LABELS: Record<Period, string> = {
        "1m": t('performance.period.1m'),
        "3m": t('performance.period.3m'),
        "6m": t('performance.period.6m'),
        "1y": t('performance.period.1y'),
        "3y": t('performance.period.3y'),
        "all": t('performance.period.all'),
    };

    // ─── Compute monthly snapshots ───
    const allSnapshots: MonthlySnapshot[] = useMemo(() => {
        if (summaries.length === 0 || transactions.length === 0) return [];

        // Get all transaction dates sorted
        const allTxns = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
        if (allTxns.length === 0) return [];

        const firstDate = parseISO(allTxns[0].date);
        const now = new Date();
        const totalMonths = differenceInMonths(now, firstDate) + 1;

        const snapshots: MonthlySnapshot[] = [];
        let cumulativeInflation = 1;

        for (let i = 0; i < totalMonths; i++) {
            const monthStart = startOfMonth(new Date(firstDate.getFullYear(), firstDate.getMonth() + i, 1));
            const monthEnd = endOfMonth(monthStart);
            const monthKey = format(monthStart, "yyyy-MM");

            if (isAfter(monthStart, now)) break;

            // Calculate invested amount up to this month
            const txnsUpToMonth = allTxns.filter(
                (t) => !isAfter(parseISO(t.date), monthEnd)
            );

            let invested = 0;
            const unitsByInvestment: Record<number, number> = {};

            for (const t of txnsUpToMonth) {
                if (t.type === "buy") {
                    invested += Number(t.amount);
                    unitsByInvestment[t.investment_id] = (unitsByInvestment[t.investment_id] || 0) + (Number(t.units) || 0);
                } else if (t.type === "sell") {
                    invested -= Number(t.amount);
                    unitsByInvestment[t.investment_id] = (unitsByInvestment[t.investment_id] || 0) - (Number(t.units) || 0);
                }
            }

            // Estimate value at end of month
            // For current month, use current prices; for past months, use linear interpolation
            let value = 0;
            for (const inv of summaries) {
                const units = unitsByInvestment[inv.id] || 0;
                if (units <= 0) continue;

                if (["stock", "etf", "crypto"].includes(inv.assetClass) && inv.currentPrice) {
                    // Use current price as approximation (we don't have historical prices)
                    value += units * inv.currentPrice;
                } else {
                    // For real estate, savings etc., use proportional value
                    const invTxns = txnsUpToMonth.filter((t) => t.investment_id === inv.id);
                    const invBuys = invTxns.filter((t) => t.type === "buy").reduce((s, t) => s + Number(t.amount), 0);
                    const invSells = invTxns.filter((t) => t.type === "sell").reduce((s, t) => s + Number(t.amount), 0);
                    const invInterest = invTxns.filter((t) => t.type === "interest").reduce((s, t) => s + Number(t.amount), 0);
                    const invAppreciation = invTxns.filter((t) => t.type === "appreciation").reduce((s, t) => s + Number(t.amount), 0);
                    value += invBuys - invSells + invInterest + invAppreciation;
                }
            }

            // Inflation
            const monthlyInfl = getMonthlyInflation(monthStart.getFullYear());
            cumulativeInflation *= 1 + monthlyInfl;

            const gainLoss = value - invested;
            const returnPct = invested > 0 ? (gainLoss / invested) * 100 : 0;
            const inflationAdjustedValue = value / cumulativeInflation;
            const realReturnPct = invested > 0 ? ((inflationAdjustedValue - invested) / invested) * 100 : 0;

            snapshots.push({
                month: monthKey,
                date: monthStart,
                invested: Math.round(invested * 100) / 100,
                value: Math.round(value * 100) / 100,
                gainLoss: Math.round(gainLoss * 100) / 100,
                returnPct: Math.round(returnPct * 100) / 100,
                inflationAdjustedValue: Math.round(inflationAdjustedValue * 100) / 100,
                realReturnPct: Math.round(realReturnPct * 100) / 100,
                cumulativeInflation: Math.round((cumulativeInflation - 1) * 10000) / 100,
            });
        }

        return snapshots;
    }, [summaries, transactions]);

    // ─── Filter by period ───
    const filteredSnapshots = useMemo(() => {
        if (allSnapshots.length === 0) return [];
        const now = new Date();
        let cutoff: Date;
        switch (selectedPeriod) {
            case "1m": cutoff = subMonths(now, 1); break;
            case "3m": cutoff = subMonths(now, 3); break;
            case "6m": cutoff = subMonths(now, 6); break;
            case "1y": cutoff = subYears(now, 1); break;
            case "3y": cutoff = subYears(now, 3); break;
            default: return allSnapshots;
        }
        return allSnapshots.filter((s) => !isBefore(s.date, cutoff));
    }, [allSnapshots, selectedPeriod]);

    // ─── Period metrics ───
    const periodMetrics = useMemo(() => {
        if (filteredSnapshots.length < 1) return null;
        const first = filteredSnapshots[0];
        const last = filteredSnapshots[filteredSnapshots.length - 1];
        const periodReturn = last.returnPct - first.returnPct;
        const periodRealReturn = last.realReturnPct - first.realReturnPct;
        const valueChange = last.value - first.value;
        const investedChange = last.invested - first.invested;
        const days = differenceInDays(last.date, first.date) || 1;
        const annualizedReturn = filteredSnapshots.length > 1 && days > 30
            ? (Math.pow(last.value / (first.value || 1), 365 / days) - 1) * 100
            : periodReturn;

        return {
            periodReturn: Math.round(periodReturn * 100) / 100,
            periodRealReturn: Math.round(periodRealReturn * 100) / 100,
            annualizedReturn: Math.round(annualizedReturn * 100) / 100,
            valueChange: Math.round(valueChange * 100) / 100,
            investedChange: Math.round(investedChange * 100) / 100,
            currentValue: last.value,
            totalInvested: last.invested,
            totalGainLoss: last.gainLoss,
            totalReturnPct: last.returnPct,
            cumulativeInflation: last.cumulativeInflation,
        };
    }, [filteredSnapshots]);

    // ─── Monthly returns heatmap data ───
    const heatmapData = useMemo(() => {
        if (allSnapshots.length < 2) return { years: [], data: {} as Record<number, (number | null)[]> };

        const years = [...new Set(allSnapshots.map((s) => s.date.getFullYear()))].sort();
        const data: Record<number, (number | null)[]> = {};

        for (const year of years) {
            data[year] = Array(12).fill(null);
        }

        for (let i = 1; i < allSnapshots.length; i++) {
            const prev = allSnapshots[i - 1];
            const curr = allSnapshots[i];
            const monthIdx = curr.date.getMonth();
            const year = curr.date.getFullYear();

            if (prev.value > 0) {
                const monthlyReturn = ((curr.value - prev.value) / prev.value) * 100;
                data[year][monthIdx] = Math.round(monthlyReturn * 100) / 100;
            } else if (curr.value > 0 && curr.invested > 0) {
                data[year][monthIdx] = Math.round(((curr.value - curr.invested) / curr.invested) * 100 * 100) / 100;
            }
        }

        return { years, data };
    }, [allSnapshots]);

    // Locale-aware month abbreviations (no hardcoded English)
    const MONTH_LABELS = useMemo(() => {
        const locale = language === 'nl' ? 'nl-NL' : 'en-US';
        return Array.from({ length: 12 }, (_, i) =>
            new Date(2000, i, 1).toLocaleDateString(locale, { month: 'short' })
        );
    }, [language]);

    function getHeatColor(val: number | null): string {
        if (val === null) return "bg-muted/30";
        if (val > 5) return "bg-emerald-600 text-white";
        if (val > 2) return "bg-emerald-500 text-white";
        if (val > 0) return "bg-emerald-400/80 text-emerald-950";
        if (val === 0) return "bg-muted text-muted-foreground";
        if (val > -2) return "bg-rose-400/80 text-rose-950";
        if (val > -5) return "bg-rose-500 text-white";
        return "bg-rose-600 text-white";
    }

    // ─── Chart data ───
    const chartData = filteredSnapshots.map((s) => ({
        month: format(s.date, "MMM yy"),
        [t('portfolio.totalInvested')]: s.invested,
        [t('performance.inflationAdjusted')]: s.inflationAdjustedValue,
        [t('portfolio.portfolioValue')]: s.value,
    }));

    if (summaries.length === 0) {
        return (
            <div className="space-y-6">
                <h1 className="text-3xl font-bold text-foreground">{t('performance.title')}</h1>
                <Card>
                    <CardContent className="flex items-center justify-center h-48">
                        <p className="text-muted-foreground">{t('performance.noData')}</p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (allSnapshots.length === 0) {
        return (
            <div className="space-y-6">
                <h1 className="text-3xl font-bold text-foreground">{t('performance.title')}</h1>
                <Card>
                    <CardContent className="flex items-center justify-center h-48">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </CardContent>
                </Card>
            </div>
        );
    }

    const totalInvested = summaries.reduce((s, i) => s + i.totalInvested, 0);
    const totalReturnPct = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0;

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">{t('performance.title')}</h1>
                    <p className="text-muted-foreground mt-1">{t('performance.subtitle')}</p>
                </div>
            </div>

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
            {periodMetrics && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <MetricCard
                        title={t('portfolio.portfolioValue')}
                        value={formatCurrency(periodMetrics.currentValue, "EUR")}
                        subtitle={t('performance.inPeriod', { amount: formatCurrency(periodMetrics.valueChange, "EUR") })}
                        icon={DollarSign}
                        trend={periodMetrics.valueChange >= 0}
                    />
                    <MetricCard
                        title={t('portfolio.totalReturn')}
                        value={`${periodMetrics.totalReturnPct >= 0 ? "+" : ""}${periodMetrics.totalReturnPct.toFixed(2)}%`}
                        subtitle={formatCurrency(periodMetrics.totalGainLoss, "EUR")}
                        icon={periodMetrics.totalReturnPct >= 0 ? TrendingUp : TrendingDown}
                        trend={periodMetrics.totalReturnPct >= 0}
                    />
                    <MetricCard
                        title={t('portfolio.annualizedReturn')}
                        value={`${periodMetrics.annualizedReturn >= 0 ? "+" : ""}${periodMetrics.annualizedReturn.toFixed(2)}%`}
                        subtitle={t('performance.projectedYearly')}
                        icon={Activity}
                        trend={periodMetrics.annualizedReturn >= 0}
                    />
                    <MetricCard
                        title={t('portfolio.realReturn')}
                        value={`${periodMetrics.periodRealReturn >= 0 ? "+" : ""}${periodMetrics.periodRealReturn.toFixed(2)}%`}
                        subtitle={t('performance.cumulativeInflation', { n: periodMetrics.cumulativeInflation.toFixed(1) })}
                        icon={Percent}
                        trend={periodMetrics.periodRealReturn >= 0}
                    />
                </div>
            )}

            {/* Performance chart */}
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
                                <XAxis dataKey="month" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
                                <YAxis
                                    tick={{ fontSize: 12 }}
                                    className="fill-muted-foreground"
                                    tickFormatter={(v) => v >= 1000 ? `€${(v / 1000).toFixed(0)}k` : `€${v}`}
                                />
                                <Tooltip
                                    contentStyle={{
                                        backgroundColor: "hsl(var(--card))",
                                        border: "1px solid hsl(var(--border))",
                                        borderRadius: "8px",
                                        fontSize: "12px",
                                    }}
                                    formatter={(value: number) => [formatCurrency(value, "EUR")]}
                                />
                                <Legend />
                                <Area
                                    type="monotone"
                                    dataKey={t('portfolio.totalInvested')}
                                    stroke="hsl(var(--muted-foreground))"
                                    fill="url(#gradInvested)"
                                    strokeWidth={1.5}
                                    strokeDasharray="4 4"
                                />
                                <Area
                                    type="monotone"
                                    dataKey={t('performance.inflationAdjusted')}
                                    stroke="hsl(30, 80%, 55%)"
                                    fill="url(#gradInflAdj)"
                                    strokeWidth={2}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={t('portfolio.portfolioValue')}
                                    stroke="hsl(var(--primary))"
                                    fill="url(#gradValue)"
                                    strokeWidth={2.5}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>
            )}

            {/* Per-asset class breakdown */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {(() => {
                    const classes = [...new Set(summaries.map((s) => s.assetClass))];
                    return classes.map((cls) => {
                        const items = summaries.filter((s) => s.assetClass === cls);
                        const classValue = items.reduce((s, i) => s + i.currentValue, 0);
                        const classInvested = items.reduce((s, i) => s + i.totalInvested, 0);
                        const classGain = items.reduce((s, i) => s + i.gainLoss, 0);
                        const classPct = classInvested > 0 ? (classGain / classInvested) * 100 : 0;
                        const label = t(`performance.${cls}` as any) || cls;
                        const count = items.length;
                        return (
                            <Card key={cls} className="border shadow-sm">
                                <CardContent className="pt-4 pb-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-sm font-semibold text-muted-foreground">
                                            {label}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {count === 1
                                                ? t('performance.holdings', { count: String(count) })
                                                : t('performance.holdingsPlural', { count: String(count) })}
                                        </span>
                                    </div>
                                    <div className="text-xl font-bold text-foreground">
                                        {formatCurrency(classValue, "EUR")}
                                    </div>
                                    <div className={`text-sm font-medium mt-1 ${classGain >= 0 ? "text-accent" : "text-destructive"}`}>
                                        {classGain >= 0 ? "+" : ""}{formatCurrency(classGain, "EUR")} ({classPct >= 0 ? "+" : ""}{classPct.toFixed(1)}%)
                                    </div>
                                    <div className="text-xs text-muted-foreground mt-1">
                                        {t('portfolio.invested', { amount: formatCurrency(classInvested, "EUR") })}
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    });
                })()}
            </div>

            {/* Monthly Returns Heatmap */}
            {heatmapData.years.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Calendar className="h-5 w-5 text-primary" />
                            {t('performance.monthlyHeatmap')}
                        </CardTitle>
                        <CardDescription>{t('performance.heatmapDesc')}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr>
                                        <th className="text-left py-2 px-2 font-semibold text-muted-foreground w-16">{t('performance.year')}</th>
                                        {MONTH_LABELS.map((m) => (
                                            <th key={m} className="text-center py-2 px-1 font-semibold text-muted-foreground min-w-[48px]">
                                                {m}
                                            </th>
                                        ))}
                                         <th className="text-center py-2 px-2 font-semibold text-muted-foreground min-w-[56px]">{t('performance.ytd')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {heatmapData.years.map((year) => {
                                        const months = heatmapData.data[year];
                                        const validMonths = months.filter((v): v is number => v !== null);
                                        // Compound YTD return
                                        const ytd = validMonths.length > 0
                                            ? (validMonths.reduce((acc, v) => acc * (1 + v / 100), 1) - 1) * 100
                                            : null;

                                        return (
                                            <tr key={year}>
                                                <td className="py-1 px-2 font-bold text-foreground">{year}</td>
                                                {months.map((val, idx) => (
                                                    <td key={idx} className="py-1 px-1">
                                                        <div
                                                            className={`rounded-md py-1.5 px-1 text-center font-mono font-medium transition-colors ${getHeatColor(val)}`}
                                                            title={val !== null ? `${val.toFixed(2)}%` : t('common.noData2')}
                                                        >
                                                            {val !== null ? `${val > 0 ? "+" : ""}${val.toFixed(1)}` : "–"}
                                                        </div>
                                                    </td>
                                                ))}
                                                <td className="py-1 px-2">
                                                    <div
                                                        className={`rounded-md py-1.5 px-1 text-center font-mono font-bold transition-colors ${getHeatColor(ytd)}`}
                                                    >
                                                        {ytd !== null ? `${ytd > 0 ? "+" : ""}${ytd.toFixed(1)}` : "–"}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                         {/* Legend */}
                        <div className="flex items-center justify-center gap-2 mt-4 text-xs text-muted-foreground">
                             <span>{t('performance.loss')}</span>
                            <div className="flex gap-0.5">
                                <div className="w-6 h-4 rounded-sm bg-rose-600" />
                                <div className="w-6 h-4 rounded-sm bg-rose-500" />
                                <div className="w-6 h-4 rounded-sm bg-rose-400/80" />
                                <div className="w-6 h-4 rounded-sm bg-muted" />
                                <div className="w-6 h-4 rounded-sm bg-emerald-400/80" />
                                <div className="w-6 h-4 rounded-sm bg-emerald-500" />
                                <div className="w-6 h-4 rounded-sm bg-emerald-600" />
                            </div>
                            <span>{t('performance.gain')}</span>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Top/Bottom performers */}
            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-accent">
                            <TrendingUp className="h-5 w-5" />
                            {t('performance.topPerformers')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {[...summaries]
                                .sort((a, b) => b.gainLossPercent - a.gainLossPercent)
                                .slice(0, 5)
                                .map((inv) => (
                                    <div key={inv.id} className="flex items-center justify-between">
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-foreground truncate">{inv.name}</p>
                                            <p className="text-xs text-muted-foreground">{inv.symbol || inv.assetClass}</p>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className={`text-sm font-bold ${inv.gainLossPercent >= 0 ? "text-accent" : "text-destructive"}`}>
                                                {inv.gainLossPercent >= 0 ? "+" : ""}{inv.gainLossPercent.toFixed(1)}%
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {formatCurrency(inv.gainLoss, inv.currency)}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-destructive">
                            <TrendingDown className="h-5 w-5" />
                            {t('performance.bottomPerformers')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {[...summaries]
                                .sort((a, b) => a.gainLossPercent - b.gainLossPercent)
                                .slice(0, 5)
                                .map((inv) => (
                                    <div key={inv.id} className="flex items-center justify-between">
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-foreground truncate">{inv.name}</p>
                                            <p className="text-xs text-muted-foreground">{inv.symbol || inv.assetClass}</p>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className={`text-sm font-bold ${inv.gainLossPercent >= 0 ? "text-accent" : "text-destructive"}`}>
                                                {inv.gainLossPercent >= 0 ? "+" : ""}{inv.gainLossPercent.toFixed(1)}%
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {formatCurrency(inv.gainLoss, inv.currency)}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

// ─── Reusable metric card ───
function MetricCard({
    title, value, subtitle, icon: Icon, trend,
}: {
    title: string; value: string; subtitle: string;
    icon: any; trend: boolean;
}) {
    const gradient = trend
        ? "from-emerald-500/10 to-green-500/5"
        : "from-rose-500/10 to-red-500/5";
    const iconBg = trend
        ? "bg-gradient-to-br from-emerald-500/20 to-green-500/20 text-emerald-600 dark:text-emerald-400"
        : "bg-gradient-to-br from-rose-500/20 to-red-500/20 text-rose-600 dark:text-rose-300";

    return (
        <Card className={`relative overflow-hidden border-none shadow-lg bg-gradient-to-br ${gradient} backdrop-blur-sm`}>
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
