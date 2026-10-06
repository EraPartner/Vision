import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Money } from "@/components/shared/Money";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { appLanguageToLocale } from "@/lib/dateUtils";
import { cn } from "@/lib/utils";
import { useMonthToDate, useRestOfMonthPlanned } from "./useHomeQueries";

interface MonthToDateHeroProps {
    currency: string;
    className?: string;
}

const CHART_W = 600;
const CHART_H = 140;
const PAD_X = 4;
const PAD_Y = 8;

/**
 * Home hero (ADR-181): what was spent this month so far, how that compares
 * with a typical month, and the money still expected in and out before the
 * month ends. The chart draws the cumulative spend against a straight
 * "typical month" guide so the pace reads at a glance.
 */
export function MonthToDateHero({ currency, className }: MonthToDateHeroProps) {
    const { t, language } = useLanguage();
    const { appSettings } = useAppSettings();
    const fmt = useCurrencyFormatter();
    const { data, isLoading } = useMonthToDate(currency);
    const { data: planned } = useRestOfMonthPlanned();

    const monthName = useMemo(
        () =>
            new Date().toLocaleDateString(appLanguageToLocale(language), {
                month: "long",
            }),
        [language],
    );

    const chart = useMemo(() => {
        if (!data) return null;
        const { daily_data, days_elapsed, days_in_month, total_spending } =
            data.current_month;
        const typical = data.past_6_months.avg_monthly_spending;
        const projected = data.comparison.projected_monthly_total;
        const byDay = new Map<number, number>();
        for (const point of daily_data) {
            const day = Number(point.date.slice(8, 10));
            byDay.set(day, (byDay.get(day) ?? 0) + point.spending);
        }
        const points: Array<[number, number]> = [[0, 0]];
        let running = 0;
        for (let day = 1; day <= Math.max(1, days_elapsed); day++) {
            running += byDay.get(day) ?? 0;
            points.push([day, running]);
        }
        const yMax = Math.max(total_spending, typical, projected, 1) * 1.08;
        const x = (day: number) =>
            PAD_X + (day / Math.max(days_in_month, 1)) * (CHART_W - 2 * PAD_X);
        const y = (value: number) =>
            CHART_H - PAD_Y - (value / yMax) * (CHART_H - 2 * PAD_Y);
        const spendPath = points
            .map(([d, v], i) => `${i === 0 ? "M" : "L"}${x(d).toFixed(1)},${y(v).toFixed(1)}`)
            .join(" ");
        const last = points[points.length - 1];
        const projectedPath =
            projected > 0 && days_elapsed < days_in_month
                ? `M${x(last[0]).toFixed(1)},${y(last[1]).toFixed(1)} L${x(days_in_month).toFixed(1)},${y(projected).toFixed(1)}`
                : "";
        const typicalPath =
            typical > 0
                ? `M${x(0).toFixed(1)},${y(0).toFixed(1)} L${x(days_in_month).toFixed(1)},${y(typical).toFixed(1)}`
                : "";
        return { spendPath, projectedPath, typicalPath, last: { cx: x(last[0]), cy: y(last[1]) } };
    }, [data]);

    const incomeSoFar = useMemo(
        () => data?.current_month.daily_data.reduce((sum, d) => sum + d.income, 0) ?? 0,
        [data],
    );

    const pace = (() => {
        if (!data) return "";
        const { total_spending } = data.current_month;
        const { projected_monthly_total: projected, avg_monthly_spending: typical } =
            data.comparison;
        if (total_spending <= 0) return t("home.pace.nothingYet");
        if (data.past_6_months.months_counted === 0 || typical <= 0)
            return t("home.pace.noHistory", {
                projected: fmt(projected, { currency }),
            });
        const diff = projected - typical;
        const vars = {
            projected: fmt(projected, { currency }),
            diff: fmt(Math.abs(diff), { currency }),
        };
        if (Math.abs(diff) < Math.max(typical * 0.03, 1)) return t("home.pace.even", vars);
        return t(diff < 0 ? "home.pace.under" : "home.pace.over", vars);
    })();

    const showDecimals = appSettings.showDecimalPlaces ?? 2;
    const trio = [
        { key: "income", label: t("home.incomeSoFar"), amount: incomeSoFar, tone: "text-gain" },
        {
            key: "in",
            label: t("home.plannedIn"),
            amount: planned?.incomingTotal ?? 0,
            tone: "text-gain",
        },
        {
            key: "out",
            label: t("home.plannedOut"),
            amount: planned?.outgoingTotal ?? 0,
            tone: "text-foreground",
        },
    ];

    return (
        <Card className={cn("overflow-hidden", className)}>
            <CardContent className="grid gap-6 p-6 lg:grid-cols-5">
                <div className="space-y-3 lg:col-span-2">
                    <p className="eyebrow">{t("home.spentSoFar", { month: monthName })}</p>
                    {isLoading || !data ? (
                        <Skeleton className="h-12 w-48" />
                    ) : (
                        <p className="type-large-title tabular-nums text-foreground">
                            <Money
                                amount={data.current_month.total_spending}
                                currency={currency}
                                fractionDigits={showDecimals}
                            />
                        </p>
                    )}
                    <p className="max-w-prose type-callout text-label-secondary">{pace}</p>
                    <dl className="grid grid-cols-3 gap-3 pt-2">
                        {trio.map((item) => (
                            <div key={item.key} className="min-w-0">
                                <dt className="truncate type-caption text-label-tertiary">
                                    {item.label}
                                </dt>
                                <dd className={cn("truncate type-headline tabular-nums", item.tone)}>
                                    <Money amount={item.amount} currency={currency} signed={item.amount > 0} />
                                </dd>
                            </div>
                        ))}
                    </dl>
                </div>
                <div className="flex flex-col gap-2 lg:col-span-3">
                    {chart ? (
                        <svg
                            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                            preserveAspectRatio="none"
                            className="h-36 w-full"
                            role="img"
                            aria-label={t("home.chart.aria")}
                        >
                            {chart.typicalPath && (
                                <path
                                    d={chart.typicalPath}
                                    fill="none"
                                    stroke="hsl(var(--muted-foreground))"
                                    strokeOpacity="0.5"
                                    strokeWidth="1.5"
                                    strokeDasharray="4 4"
                                    vectorEffect="non-scaling-stroke"
                                />
                            )}
                            {chart.projectedPath && (
                                <path
                                    d={chart.projectedPath}
                                    fill="none"
                                    stroke="hsl(var(--primary))"
                                    strokeOpacity="0.45"
                                    strokeWidth="2"
                                    strokeDasharray="2 4"
                                    vectorEffect="non-scaling-stroke"
                                />
                            )}
                            <path
                                d={chart.spendPath}
                                fill="none"
                                stroke="hsl(var(--primary))"
                                strokeWidth="2.5"
                                strokeLinejoin="round"
                                strokeLinecap="round"
                                vectorEffect="non-scaling-stroke"
                            />
                            <circle
                                cx={chart.last.cx}
                                cy={chart.last.cy}
                                r="4"
                                fill="hsl(var(--primary))"
                            />
                        </svg>
                    ) : (
                        <Skeleton className="h-36 w-full" />
                    )}
                    <div className="flex flex-wrap items-center gap-4 type-caption text-label-secondary">
                        <span className="flex items-center gap-1.5">
                            <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-primary" />
                            {t("home.chart.thisMonth")}
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span
                                aria-hidden="true"
                                className="h-0 w-4 border-t border-dashed border-muted-foreground"
                            />
                            {t("home.chart.typical")}
                        </span>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
