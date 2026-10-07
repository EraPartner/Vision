import { useMemo } from "react";
import { Money } from "@/components/shared/Money";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "@/components/ui/card";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { TrendingUp, TrendingDown } from "lucide-react";
import {
    appLanguageToLocale,
    formatMonthLabelWithLocale,
} from "@/lib/dateUtils";
import type { AssetClass } from "@/types/api";
import { getAssetClassLabel } from "@/types/portfolio";
import { cn } from "@/lib/utils";
import { TouchDisclosure } from "@/components/shared/TouchDisclosure";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";

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

type TranslateFn = (
    key: string,
    params?: Record<string, string | number>,
) => string;

// One row of the top/bottom performer lists. The two lists were byte-identical
// JSX differing only in which array they mapped, so they share this row.
function PerformerRow({
    inv,
    defaultCurrency,
    t,
}: {
    inv: BreakdownItem;
    defaultCurrency: string;
    t: TranslateFn;
}) {
    const formatPercent = usePercentFormatter();
    return (
        <div className="flex items-center justify-between">
            <div className="min-w-0">
                <p className="truncate type-body font-medium text-foreground">
                    {inv.name}
                </p>
                <p className="type-caption text-label-secondary">
                    {inv.symbol ||
                        getAssetClassLabel(t, inv.assetClass as AssetClass)}
                </p>
            </div>
            <div className="text-right shrink-0">
                <p
                    className={cn(
                        "type-body font-medium tabular-nums",
                        inv.gainLossPercent >= 0 ? "text-gain" : "text-loss",
                    )}
                >
                    {formatPercent(inv.gainLossPercent, {
                        digits: 1,
                        signed: true,
                    })}
                </p>
                <p className="type-caption tabular-nums text-label-secondary">
                    <Money amount={inv.gainLoss} currency={defaultCurrency} />
                    {typeof inv.fxGain === "number" &&
                        inv.currency !== defaultCurrency && (
                            <TouchDisclosure
                                label={t("portfolio.fxEffect")}
                                content={t("portfolio.fxEffect")}
                                className="ml-1.5"
                            >
                                {t("portfolio.fxShort")}{" "}
                                <Money
                                    amount={inv.fxGain}
                                    currency={defaultCurrency}
                                    signed
                                />
                            </TouchDisclosure>
                        )}
                </p>
            </div>
        </div>
    );
}

function getHeatColor(val: number | null, maxAbsPct: number): string {
    if (val === null) return "bg-foreground/[0.04]";
    if (val === 0) return "bg-foreground/[0.08] text-label-secondary";
    const absPct = Math.abs(val);
    if (absPct < 0.25) return "bg-foreground/[0.06] text-label-secondary";
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

export default function PerformanceBreakdown({
    heatmapData,
    breakdownSummary,
}: Props) {
    const formatPercent = usePercentFormatter();
    const { t, tc, language } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";

    const monthLabelLocale = useMemo(
        () => appLanguageToLocale(language),
        [language],
    );

    const MONTH_LABELS = useMemo(() => {
        return Array.from({ length: 12 }, (_, i) =>
            formatMonthLabelWithLocale(
                new Date(2000, i, 1),
                monthLabelLocale,
                "short",
            ),
        );
    }, [monthLabelLocale]);

    const assetClassBreakdown = useMemo(() => {
        const grouped = new Map<
            AssetClass,
            { count: number; value: number; invested: number; gain: number }
        >();
        for (const item of breakdownSummary) {
            const ac = item.assetClass as AssetClass;
            const existing = grouped.get(ac) || {
                count: 0,
                value: 0,
                invested: 0,
                gain: 0,
            };
            grouped.set(ac, {
                count: existing.count + 1,
                value: existing.value + item.currentValue,
                invested: existing.invested + item.totalInvested,
                gain: existing.gain + item.gainLoss,
            });
        }

        return Array.from(grouped.entries()).map(([assetClass, data]) => {
            const pct =
                data.invested > 0 ? (data.gain / data.invested) * 100 : 0;
            return {
                assetClass,
                label:
                    t(
                        `performance.${assetClass}` as `performance.${AssetClass}`,
                    ) || assetClass,
                count: data.count,
                classValue: data.value,
                classInvested: data.invested,
                classGain: data.gain,
                classPct: pct,
            };
        });
    }, [breakdownSummary, t]);

    const { topPerformers, bottomPerformers } = useMemo(() => {
        const sorted = [...breakdownSummary].sort(
            (a, b) => a.gainLossPercent - b.gainLossPercent,
        );
        return {
            topPerformers: sorted.slice(-5).reverse(),
            bottomPerformers: sorted.slice(0, 5),
        };
    }, [breakdownSummary]);

    const formatPct = (value: number) =>
        formatPercent(value, { digits: 2, signed: true });

    if (breakdownSummary.length === 0) return null;

    return (
        <>
            {/* Per-asset class breakdown */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {assetClassBreakdown.map(
                    ({
                        assetClass,
                        label,
                        count,
                        classValue,
                        classInvested,
                        classGain,
                        classPct,
                    }) => (
                        <Card key={assetClass}>
                            <CardContent variant="compact">
                                <div className="mb-2 flex items-center justify-between gap-2">
                                    <span className="type-caption text-label-tertiary">
                                        {label}
                                    </span>
                                    <span className="type-caption text-label-secondary">
                                        {tc("performance.holdings", count)}
                                    </span>
                                </div>
                                <div className="type-title-3 tabular-nums text-foreground">
                                    <Money
                                        amount={classValue}
                                        currency={defaultCurrency}
                                    />
                                </div>
                                <div
                                    className={cn(
                                        "mt-1 type-footnote tabular-nums",
                                        classGain >= 0
                                            ? "text-gain"
                                            : "text-loss",
                                    )}
                                >
                                    <Money
                                        amount={classGain}
                                        currency={defaultCurrency}
                                        signed
                                    />{" "}
                                    (
                                    {formatPercent(classPct, {
                                        digits: 1,
                                        signed: true,
                                    })}
                                    )
                                </div>
                                <div className="mt-1 type-caption tabular-nums text-label-secondary">
                                    {t("portfolio.invested", {
                                        amount: formatCurrency(
                                            classInvested,
                                            defaultCurrency,
                                            locale,
                                            appSettings.showDecimalPlaces ?? 2,
                                        ),
                                    })}
                                </div>
                            </CardContent>
                        </Card>
                    ),
                )}
            </div>

            {/* Monthly Returns Heatmap */}
            {heatmapData.years.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle>{t("performance.monthlyHeatmap")}</CardTitle>
                        <CardDescription>
                            {t("performance.heatmapDesc")}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <table className="w-full type-caption">
                                <thead>
                                    <tr>
                                        <th className="w-16 px-2 py-2 text-left font-medium text-label-secondary">
                                            {t("performance.year")}
                                        </th>
                                        {MONTH_LABELS.map((m) => (
                                            <th
                                                key={m}
                                                className="min-w-[48px] px-1 py-2 text-center font-medium text-label-secondary"
                                            >
                                                {m}
                                            </th>
                                        ))}
                                        <th className="min-w-[56px] px-2 py-2 text-center font-medium text-label-secondary">
                                            {t("performance.ytd")}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {heatmapData.years.map((year) => {
                                        const months = heatmapData.data[year];
                                        const validMonths = months.filter(
                                            (v): v is number => v !== null,
                                        );
                                        const ytd =
                                            validMonths.length > 0
                                                ? (validMonths.reduce(
                                                      (acc, v) =>
                                                          acc * (1 + v / 100),
                                                      1,
                                                  ) -
                                                      1) *
                                                  100
                                                : null;

                                        return (
                                            <tr key={year}>
                                                <td className="px-2 py-1 font-medium tabular-nums text-foreground">
                                                    {year}
                                                </td>
                                                {months.map((val, idx) => (
                                                    <td
                                                        key={idx}
                                                        className="py-1 px-1"
                                                    >
                                                        <div
                                                            className={cn(
                                                                "rounded-control px-1 py-1.5 text-center font-mono tabular-nums transition-colors",
                                                                getHeatColor(
                                                                    val,
                                                                    heatmapData.maxAbsPct,
                                                                ),
                                                            )}
                                                            title={
                                                                val !== null
                                                                    ? formatPct(
                                                                          val,
                                                                      )
                                                                    : t(
                                                                          "common.noData2",
                                                                      )
                                                            }
                                                        >
                                                            {val !== null
                                                                ? formatPct(val)
                                                                : "–"}
                                                        </div>
                                                    </td>
                                                ))}
                                                <td className="py-1 px-2">
                                                    <div
                                                        className={cn(
                                                            "rounded-control px-1 py-1.5 text-center font-mono font-medium tabular-nums transition-colors",
                                                            getHeatColor(
                                                                ytd,
                                                                heatmapData.maxAbsPct,
                                                            ),
                                                        )}
                                                    >
                                                        {ytd !== null
                                                            ? formatPct(ytd)
                                                            : "–"}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        <div className="mt-4 flex items-center justify-center gap-2 type-caption text-label-secondary">
                            <span>{t("performance.loss")}</span>
                            <div className="flex gap-0.5" aria-hidden="true">
                                <div className="h-4 w-6 rounded-chip bg-loss/70" />
                                <div className="h-4 w-6 rounded-chip bg-loss/45" />
                                <div className="h-4 w-6 rounded-chip bg-loss/20" />
                                <div className="h-4 w-6 rounded-chip bg-foreground/[0.08]" />
                                <div className="h-4 w-6 rounded-chip bg-gain/20" />
                                <div className="h-4 w-6 rounded-chip bg-gain/40" />
                                <div className="h-4 w-6 rounded-chip bg-gain/70" />
                            </div>
                            <span>{t("performance.gain")}</span>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Top/Bottom performers */}
            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle
                            variant="sm"
                            className="flex items-center gap-2"
                        >
                            <TrendingUp
                                className="h-5 w-5 text-gain"
                                aria-hidden
                            />
                            {t("performance.topPerformers")}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {topPerformers.map((inv) => (
                                <PerformerRow
                                    key={inv.id}
                                    inv={inv}
                                    defaultCurrency={defaultCurrency}
                                    t={t}
                                />
                            ))}
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle
                            variant="sm"
                            className="flex items-center gap-2"
                        >
                            <TrendingDown
                                className="h-5 w-5 text-loss"
                                aria-hidden
                            />
                            {t("performance.bottomPerformers")}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {bottomPerformers.map((inv) => (
                                <PerformerRow
                                    key={inv.id}
                                    inv={inv}
                                    defaultCurrency={defaultCurrency}
                                    t={t}
                                />
                            ))}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </>
    );
}
