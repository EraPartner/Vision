import { useMemo } from "react";
import { Money } from "@/components/shared/Money";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatCurrency, formatPercent, numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { TrendingUp, TrendingDown, Calendar } from "lucide-react";
import { appLanguageToLocale, formatMonthLabelWithLocale } from "@/components/shared/dateUtils";
import type { AssetClass } from "@/types/api";
import { cn } from "@/lib/utils";

interface BreakdownItem {
    id: number;
    name: string;
    symbol: string;
    assetClass: string;
    currency: string;
    currentValue: number;
    totalInvested: number;
    gainLoss: number;
    gainLossPercent: number;
    assetGain?: number;
    fxGain?: number;
    nativeCurrentValue?: number;
    usedFallbackRate?: boolean;
}

interface Props {
    heatmapData: {
        years: number[];
        data: Record<number, (number | null)[]>;
        maxAbsPct: number;
    };
    breakdownSummary: BreakdownItem[];
}

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

// One row of the top/bottom performer lists. The two lists were byte-identical
// JSX differing only in which array they mapped, so they share this row.
function PerformerRow({ inv, defaultCurrency, t }: { inv: BreakdownItem; defaultCurrency: string; t: TranslateFn }) {
    return (
        <div className="flex items-center justify-between">
            <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{inv.name}</p>
                <p className="text-xs text-muted-foreground">{inv.symbol || inv.assetClass}</p>
            </div>
            <div className="text-right shrink-0">
                <p className={cn("text-sm font-bold", inv.gainLossPercent >= 0 ? "amount-gain" : "amount-loss")}>
                    {formatPercent(inv.gainLossPercent, { digits: 1, signed: true })}
                </p>
                <p className="text-xs text-muted-foreground">
                    <Money amount={inv.gainLoss} currency={defaultCurrency} />
                    {typeof inv.fxGain === 'number' && inv.currency !== defaultCurrency && (
                        <span className="ml-1.5" title={t('portfolio.fxEffect')}>
                            {t('portfolio.fxShort')} {inv.fxGain >= 0 ? "+" : ""}<Money amount={inv.fxGain} currency={defaultCurrency} />
                        </span>
                    )}
                </p>
            </div>
        </div>
    );
}

function getHeatColor(val: number | null, maxAbsPct: number): string {
    if (val === null) return "bg-muted/30";
    if (val === 0) return "bg-muted text-muted-foreground";
    const absPct = Math.abs(val);
    if (absPct < 0.25) return "bg-muted/70 text-muted-foreground";
    const scale = Math.max(maxAbsPct, 1);
    const ratio = absPct / scale;
    const strongMove = absPct >= 2.5 || ratio > 0.72;
    const mediumMove = absPct >= 1.0 || ratio > 0.42;
    if (val > 0 && strongMove) return "bg-gain/70 text-foreground";
    if (val > 0 && mediumMove) return "bg-gain/40 text-foreground";
    if (val > 0) return "bg-gain/20 text-foreground";
    if (strongMove) return "bg-loss/70 text-foreground";
    if (mediumMove) return "bg-loss/45 text-foreground";
    return "bg-loss/20 text-foreground";
}

export default function PerformanceBreakdown({ heatmapData, breakdownSummary }: Props) {
    const { t, tc, language } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";

    const monthLabelLocale = useMemo(() => appLanguageToLocale(language), [language]);

    const MONTH_LABELS = useMemo(() => {
        return Array.from({ length: 12 }, (_, i) =>
            formatMonthLabelWithLocale(new Date(2000, i, 1), monthLabelLocale, "short")
        );
    }, [monthLabelLocale]);

    const assetClassBreakdown = useMemo(() => {
        const grouped = new Map<AssetClass, { count: number; value: number; invested: number; gain: number }>();
        for (const item of breakdownSummary) {
            const ac = item.assetClass as AssetClass;
            const existing = grouped.get(ac) || { count: 0, value: 0, invested: 0, gain: 0 };
            grouped.set(ac, {
                count: existing.count + 1,
                value: existing.value + item.currentValue,
                invested: existing.invested + item.totalInvested,
                gain: existing.gain + item.gainLoss,
            });
        }

        return Array.from(grouped.entries()).map(([assetClass, data]) => {
            const pct = data.invested > 0 ? (data.gain / data.invested) * 100 : 0;
            return {
                assetClass,
                label: t(`performance.${assetClass}` as `performance.${AssetClass}`) || assetClass,
                count: data.count,
                classValue: data.value,
                classInvested: data.invested,
                classGain: data.gain,
                classPct: pct,
            };
        });
    }, [breakdownSummary, t]);

    const { topPerformers, bottomPerformers } = useMemo(() => {
        const sorted = [...breakdownSummary].sort((a, b) => a.gainLossPercent - b.gainLossPercent);
        return {
            topPerformers: sorted.slice(-5).reverse(),
            bottomPerformers: sorted.slice(0, 5),
        };
    }, [breakdownSummary]);

    const formatPct = (value: number) => formatPercent(value, { digits: 2, signed: true });

    if (breakdownSummary.length === 0) return null;

    return (
        <>
            {/* Per-asset class breakdown */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {assetClassBreakdown.map(({ assetClass, label, count, classValue, classInvested, classGain, classPct }) => (
                    <Card key={assetClass} className="glass-regular border shadow-sm">
                        <CardContent className="pt-4 pb-4">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-sm font-semibold text-muted-foreground">{label}</span>
                                <span className="text-xs text-muted-foreground">
                                    {tc('performance.holdings', count)}
                                </span>
                            </div>
                            <div className="text-xl font-bold text-foreground">
                                <Money amount={classValue} currency={defaultCurrency} />
                            </div>
                            <div className={cn("text-sm font-medium mt-1", classGain >= 0 ? "amount-gain" : "amount-loss")}>
                                {classGain >= 0 ? "+" : ""}<Money amount={classGain} currency={defaultCurrency} /> ({formatPercent(classPct, { digits: 1, signed: true })})
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                                {t('portfolio.invested', { amount: formatCurrency(classInvested, defaultCurrency, locale) })}
                            </div>
                        </CardContent>
                    </Card>
                ))}
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
                                            <th key={m} className="text-center py-2 px-1 font-semibold text-muted-foreground min-w-[48px]">{m}</th>
                                        ))}
                                        <th className="text-center py-2 px-2 font-semibold text-muted-foreground min-w-[56px]">{t('performance.ytd')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {heatmapData.years.map((year) => {
                                        const months = heatmapData.data[year];
                                        const validMonths = months.filter((v): v is number => v !== null);
                                        const ytd = validMonths.length > 0
                                            ? ((validMonths.reduce((acc, v) => acc * (1 + (v / 100)), 1) - 1) * 100)
                                            : null;

                                        return (
                                            <tr key={year}>
                                                <td className="py-1 px-2 font-bold text-foreground">{year}</td>
                                                {months.map((val, idx) => (
                                                    <td key={idx} className="py-1 px-1">
                                                        <div
                                                            className={cn("rounded-md py-1.5 px-1 text-center font-mono font-medium transition-colors", getHeatColor(val, heatmapData.maxAbsPct))}
                                                            title={val !== null ? formatPct(val) : t('common.noData2')}
                                                        >
                                                            {val !== null ? formatPct(val) : "–"}
                                                        </div>
                                                    </td>
                                                ))}
                                                <td className="py-1 px-2">
                                                    <div
                                                        className={cn("rounded-md py-1.5 px-1 text-center font-mono font-bold transition-colors", getHeatColor(ytd, heatmapData.maxAbsPct))}
                                                    >
                                                        {ytd !== null ? formatPct(ytd) : "–"}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        <div className="flex items-center justify-center gap-2 mt-4 text-xs text-muted-foreground">
                            <span>{t('performance.loss')}</span>
                            <div className="flex gap-0.5">
                                <div className="w-6 h-4 rounded-sm bg-loss/70" />
                                <div className="w-6 h-4 rounded-sm bg-loss/45" />
                                <div className="w-6 h-4 rounded-sm bg-loss/20" />
                                <div className="w-6 h-4 rounded-sm bg-muted" />
                                <div className="w-6 h-4 rounded-sm bg-gain/20" />
                                <div className="w-6 h-4 rounded-sm bg-gain/40" />
                                <div className="w-6 h-4 rounded-sm bg-gain/70" />
                            </div>
                            <span>{t('performance.gain')}</span>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Top/Bottom performers */}
            <div className="grid gap-4 lg:grid-cols-2">
                <Card className="glass-regular">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-accent">
                            <TrendingUp className="h-5 w-5" />
                            {t('performance.topPerformers')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {topPerformers.map((inv) => (
                                <PerformerRow key={inv.id} inv={inv} defaultCurrency={defaultCurrency} t={t} />
                            ))}
                        </div>
                    </CardContent>
                </Card>

                <Card className="glass-regular">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-destructive">
                            <TrendingDown className="h-5 w-5" />
                            {t('performance.bottomPerformers')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {bottomPerformers.map((inv) => (
                                <PerformerRow key={inv.id} inv={inv} defaultCurrency={defaultCurrency} t={t} />
                            ))}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </>
    );
}
