import { useMemo, useState, type ReactNode } from "react";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { Money } from "@/components/shared/Money";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { useChartKeyboardNav } from "@/components/charts/keyboardNav";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { appLanguageToLocale } from "@/lib/dateUtils";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatPeriodLabel } from "./statisticsUtils";
import type { StatisticsData } from "@/hooks/useStatistics";
import { cn } from "@/lib/utils";
import { CompactValueDisclosure } from "@/components/shared/TouchDisclosure";

/**
 * The Insights page's opening statement: the shape of the months.
 *
 * The headline is the latest month's net (scrub the strip to walk back through
 * the series), and the three facts underneath are extremes and a hit-rate that
 * exist nowhere else in the app. The month still in progress is labelled
 * "so far" and left out of the best/worst comparison, because a half month
 * is not a month.
 *
 * Arithmetic is read straight off `data.monthlyData` — the same rows the
 * monthly/net charts below plot; nothing is re-derived or re-signed here.
 */

interface MonthlyRhythmProps {
    data: StatisticsData;
    /** The month in progress as `YYYY-MM`; defaults to today. Injectable for tests. */
    currentPeriod?: string;
}

function periodOfToday(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function MonthlyRhythm({ data, currentPeriod }: MonthlyRhythmProps) {
    const { t, language } = useLanguage();
    const { formatCompact } = useChartCurrencyFormatter();
    const monthLocale = appLanguageToLocale(language);

    const months = data.monthlyData;
    const lastIndex = months.length - 1;
    const partialPeriod = currentPeriod ?? periodOfToday();

    // Hovering / arrowing the strip walks the headline back through the series;
    // leaving or Escape snaps it to the most recent month.
    const [activeIndex, setActiveIndex] = useState<number | null>(null);

    const { onKeyDown, onBlur } = useChartKeyboardNav({
        pointCount: months.length,
        index: activeIndex,
        onIndexChange: setActiveIndex,
        onClear: () => setActiveIndex(null),
    });

    const labelFor = (period: string) => {
        const label = formatPeriodLabel(period, monthLocale);
        return period === partialPeriod
            ? `${label} ${t("statsPage.rhythm.soFar")}`
            : label;
    };

    const extremes = useMemo(() => {
        if (months.length === 0) return undefined;
        // Best and worst compare complete months only; the month in progress
        // can only drop out when there is at least one complete month.
        const complete = months.filter((m) => m.period !== partialPeriod);
        const pool = complete.length > 0 ? complete : months;
        let best = pool[0];
        let worst = pool[0];
        for (const m of pool) {
            if (m.net > best.net) best = m;
            if (m.net < worst.net) worst = m;
        }
        let positive = 0;
        for (const m of months) if (m.net >= 0) positive += 1;
        return { best, worst, positive };
    }, [months, partialPeriod]);

    if (months.length === 0 || !extremes) return null;

    const shownIndex = activeIndex ?? lastIndex;
    const shown = months[shownIndex];
    const previous = shownIndex > 0 ? months[shownIndex - 1] : undefined;
    const delta = previous ? shown.net - previous.net : undefined;

    const netCompact = formatCompact(shown.net);
    const deltaCompact =
        delta !== undefined ? formatCompact(delta, true) : undefined;

    const shownLabel = labelFor(shown.period);
    const maxAbsNet = Math.max(...months.map((m) => Math.abs(m.net)), 1);

    const scrubbing = activeIndex !== null;

    return (
        <Card className="relative overflow-hidden">
            <CardContent variant="headerless" className="relative">
                <div className="grid gap-6 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] lg:gap-10">
                    {/* ── Headline: the scrubbed month's net ───────────────────────── */}
                    <div className="flex flex-col">
                        <CardTitle variant="label">
                            {t("statsPage.rhythm.title")}
                        </CardTitle>

                        <div className="mt-3 flex flex-wrap items-end gap-3">
                            <CompactValueDisclosure
                                className={cn(
                                    "type-large-title tabular-nums",
                                    shown.net >= 0 ? "text-gain" : "text-loss",
                                )}
                                display={
                                    <RollingNumber parts={netCompact.parts} />
                                }
                                fullValue={
                                    netCompact.isCompact
                                        ? netCompact.full
                                        : undefined
                                }
                            />
                            {delta !== undefined && deltaCompact && (
                                <CompactValueDisclosure
                                    display={
                                        <DeltaPill
                                            value={delta}
                                            label={deltaCompact.display}
                                        />
                                    }
                                    fullValue={
                                        deltaCompact.isCompact
                                            ? deltaCompact.full
                                            : undefined
                                    }
                                    className="mb-1.5"
                                />
                            )}
                        </div>

                        <p className="mt-1.5 type-callout text-label-secondary">
                            {t("statsPage.rhythm.netIn", { month: shownLabel })}
                            {previous && (
                                <span className="text-label-tertiary">
                                    {" · "}
                                    {t("statsPage.rhythm.vsPrevious")}
                                </span>
                            )}
                        </p>

                        {/* Detail figures render exact (Money); only the hero abbreviates. */}
                        <dl className="mt-5 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-border/50 pt-4">
                            <div>
                                <dt className="eyebrow">
                                    {t("statsPage.rhythm.typicalIn")}
                                </dt>
                                <dd className="type-headline tabular-nums text-gain">
                                    <Money amount={data.averageMonthlyIncome} />
                                </dd>
                            </div>
                            <div>
                                <dt className="eyebrow">
                                    {t("statsPage.rhythm.typicalOut")}
                                </dt>
                                <dd className="type-headline tabular-nums text-loss">
                                    <Money
                                        amount={data.averageMonthlySpending}
                                    />
                                </dd>
                            </div>
                        </dl>
                    </div>

                    {/* ── The strip: one net bar per month, above/below zero ────────── */}
                    <div
                        className="flex cursor-crosshair select-none flex-col justify-end rounded-control focus-ring"
                        role="group"
                        tabIndex={0}
                        aria-label={t("statsPage.rhythm.stripAria", {
                            n: months.length,
                        })}
                        onKeyDown={onKeyDown}
                        onBlur={onBlur}
                        onPointerLeave={() => setActiveIndex(null)}
                    >
                        <div className="relative h-32">
                            <div
                                className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-foreground/15"
                                aria-hidden
                            />
                            <div className="absolute inset-0 flex items-stretch gap-[3px]">
                                {months.map((m, i) => {
                                    const pct =
                                        (Math.abs(m.net) / maxAbsNet) * 50;
                                    const isLatest = i === lastIndex;
                                    const active =
                                        scrubbing && i === shownIndex;
                                    return (
                                        <div
                                            key={m.period}
                                            className="relative min-w-[3px] flex-1"
                                            onPointerEnter={() =>
                                                setActiveIndex(i)
                                            }
                                            aria-hidden
                                        >
                                            <div
                                                className={cn(
                                                    "absolute left-0 right-0 transition-opacity duration-fast",
                                                    m.net >= 0
                                                        ? "bottom-1/2 rounded-t-[3px] bg-gain"
                                                        : "top-1/2 rounded-b-[3px] bg-loss",
                                                    // At rest the latest month reads brightest — it is the
                                                    // one the headline is showing. Scrubbing dims the rest.
                                                    active ||
                                                        (!scrubbing && isLatest)
                                                        ? "opacity-100"
                                                        : scrubbing
                                                          ? "opacity-35"
                                                          : "opacity-70",
                                                )}
                                                style={{
                                                    height: `${Math.max(pct, 1.5)}%`,
                                                }}
                                            />
                                            {active && (
                                                <div className="absolute inset-y-0 -inset-x-px rounded-[4px] ring-1 ring-inset ring-primary/45" />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="mt-2 flex items-center justify-between type-caption tabular-nums text-label-tertiary">
                            <span>{labelFor(months[0].period)}</span>
                            <span
                                className={cn(
                                    "font-medium",
                                    scrubbing
                                        ? "text-foreground"
                                        : "text-label-secondary",
                                )}
                            >
                                {scrubbing
                                    ? shownLabel
                                    : t("statsPage.rhythm.scrubHint")}
                            </span>
                            <span>{labelFor(months[lastIndex].period)}</span>
                        </div>
                    </div>
                </div>

                {/* ── Three facts only this page can tell ─────────────────────────── */}
                <div className="mt-6 grid gap-4 border-t border-border/50 pt-4 sm:grid-cols-3">
                    <Fact
                        label={t("statsPage.rhythm.strongest")}
                        value={<Money amount={extremes.best.net} signed />}
                        valueClassName={
                            extremes.best.net >= 0 ? "text-gain" : "text-loss"
                        }
                        hint={labelFor(extremes.best.period)}
                    />
                    <Fact
                        label={t("statsPage.rhythm.toughest")}
                        value={<Money amount={extremes.worst.net} signed />}
                        valueClassName={
                            extremes.worst.net >= 0 ? "text-gain" : "text-loss"
                        }
                        hint={labelFor(extremes.worst.period)}
                    />
                    <Fact
                        label={t("statsPage.rhythm.inTheBlack")}
                        value={`${extremes.positive}/${months.length}`}
                        valueClassName="text-primary"
                        hint={t("statsPage.rhythm.inTheBlackHint")}
                    />
                </div>
            </CardContent>
        </Card>
    );
}

function Fact({
    label,
    value,
    valueClassName,
    hint,
}: {
    label: string;
    value: ReactNode;
    valueClassName?: string;
    hint: string;
}) {
    return (
        <div>
            <p className="eyebrow">{label}</p>
            <p className={cn("mt-0.5 type-title-3 tabular-nums", valueClassName)}>
                {value}
            </p>
            <p className="type-caption text-label-tertiary">{hint}</p>
        </div>
    );
}
