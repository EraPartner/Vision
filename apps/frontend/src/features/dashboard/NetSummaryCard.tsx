import { useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkline as ChartSparkline } from "@/components/charts";
import { useChartKeyboardNav } from "@/components/charts/keyboardNav";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { CardSheen } from "@/components/shared/CardSheen";
import { TrendHue } from "@/components/shared/TrendHue";
import { ArrowUpRight, Banknote, TrendingDown } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatPercent, numberFormatToLocale } from "@/utils/currency";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatMonthYearWithAppSettings } from "@/lib/dateUtils";
import type { NetHistoryPoint } from "@/hooks/useFilteredDashboardStats";
import { cn } from "@/lib/utils";
import { CompactValueDisclosure } from "@/components/shared/TouchDisclosure";

interface NetSummaryCardProps {
    netBalance: number;
    income: number;
    spending: number;
    history: NetHistoryPoint[];
    animateNumber?: boolean;
}

export function NetSummaryCard({
    netBalance,
    income,
    spending,
    history,
    animateNumber = true,
}: NetSummaryCardProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const { formatCurrency, formatCompact } = useChartCurrencyFormatter();

    // Scrubbing the sparkline drives the hero number through netHistory;
    // releasing/leaving snaps back to the live month. Card-level tint and the
    // header icon deliberately stay bound to the live value so the whole card
    // doesn't strobe while scrubbing.
    const [scrubIndex, setScrubIndex] = useState<number | undefined>(undefined);
    const scrubPoint =
        scrubIndex !== undefined ? history[scrubIndex] : undefined;

    // The plot rect can't change mid-scrub, so measure it once on pointerdown and
    // reuse it for every pointermove instead of a getBoundingClientRect per move.
    const scrubRectRef = useRef<DOMRect | null>(null);

    const scrubFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
        if (history.length < 2) return;
        const rect =
            scrubRectRef.current ?? e.currentTarget.getBoundingClientRect();
        scrubRectRef.current = rect;
        if (rect.width === 0) return;
        const frac = (e.clientX - rect.left) / rect.width;
        const idx = Math.round(frac * (history.length - 1));
        setScrubIndex(Math.max(0, Math.min(history.length - 1, idx)));
    };

    const endScrub = () => {
        scrubRectRef.current = null;
        setScrubIndex(undefined);
    };

    // Keyboard path: same ←/→ · Home/End · Escape map as the chart primitives,
    // driving the same scrubIndex the pointer does (readout + hero number).
    const { onKeyDown: scrubKeyDown, onBlur: scrubBlur } = useChartKeyboardNav({
        pointCount: history.length > 1 ? history.length : 0,
        index: scrubIndex ?? null,
        onIndexChange: setScrubIndex,
        onClear: endScrub,
    });

    const isPositive = netBalance >= 0;

    const savingsRate =
        income > 0 ? ((income - spending) / income) * 100 : null;
    const incomeTotal = Math.max(income, 0);
    const spendingTotal = Math.max(spending, 0);
    const splitTotal = incomeTotal + spendingTotal;
    const incomePct = splitTotal > 0 ? (incomeTotal / splitTotal) * 100 : 50;
    const spendingPct =
        splitTotal > 0 ? (spendingTotal / splitTotal) * 100 : 50;

    const chartData = useMemo(
        () =>
            history.map((p) => ({
                label: formatMonthYearWithAppSettings(
                    new Date(p.year, p.month - 1, 1),
                    appSettings.dateFormat,
                    locale,
                ),
                net: p.net,
            })),
        [history, appSettings.dateFormat, locale],
    );

    const areaStroke = isPositive ? "hsl(var(--gain))" : "hsl(var(--loss))";

    const shownNet = scrubPoint ? scrubPoint.net : netBalance;
    const netColor = shownNet >= 0 ? "text-gain" : "text-loss";
    const netCompact = formatCompact(shownNet);
    const incomeCompact = formatCompact(incomeTotal);
    const spendingCompact = formatCompact(spendingTotal);
    const splitBarLabel = [
        `${t("dashboard.stat.income")}: ${formatCurrency(incomeTotal)} (${formatPercent(incomePct, { digits: 1, locale })})`,
        `${t("dashboard.stat.spending")}: ${formatCurrency(spendingTotal)} (${formatPercent(spendingPct, { digits: 1, locale })})`,
    ].join("; ");

    return (
        <Card
            variant="interactive"
            className="glass-elevated group relative overflow-hidden flex flex-col h-full"
        >
            <TrendHue tone={isPositive ? "gain" : "loss"} />
            <CardSheen tier="hero" animated />

            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <div>
                    <CardTitle variant="label">
                        {t("dashboard.stat.lastMonthNet")}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">
                        {isPositive
                            ? t("dashboard.stat.positiveCashFlow")
                            : t("dashboard.stat.negativeCashFlow")}
                    </p>
                </div>
                <div
                    className={cn(
                        "h-11 w-11 rounded-xl flex items-center justify-center icon-tile-glow transition-transform duration-normal group-hover:scale-105 bg-gradient-to-br",
                        isPositive
                            ? "from-gain/20 to-gain/10 text-gain"
                            : "from-loss/20 to-loss/10 text-loss",
                    )}
                >
                    <Banknote className="h-5 w-5" />
                </div>
            </CardHeader>

            <CardContent className="flex flex-1 flex-col gap-4">
                <div className="flex items-end gap-3 flex-wrap">
                    <div
                        className={cn(
                            "text-4xl md:text-5xl font-bold tabular-nums",
                            netColor,
                        )}
                    >
                        <CompactValueDisclosure
                            display={
                                <RollingNumber
                                    parts={netCompact.parts}
                                    animate={animateNumber}
                                />
                            }
                            fullValue={
                                netCompact.isCompact
                                    ? netCompact.full
                                    : undefined
                            }
                        />
                    </div>
                    {savingsRate !== null && (
                        <Badge
                            variant="outline"
                            className="font-semibold text-xs"
                        >
                            {t("dashboard.stat.savingsRate")}:{" "}
                            {formatPercent(savingsRate, { digits: 1, locale })}
                        </Badge>
                    )}
                </div>

                <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{t("dashboard.stat.incomeVsSpending")}</span>
                    </div>
                    <div
                        role="img"
                        aria-label={splitBarLabel}
                        className="h-2.5 w-full overflow-hidden rounded-full bg-muted/50 flex"
                    >
                        <div
                            aria-hidden="true"
                            className="h-full bg-gain transition-[width] duration-reveal"
                            style={{ width: `${incomePct}%` }}
                        />
                        <div
                            aria-hidden="true"
                            className="h-full bg-loss transition-[width] duration-reveal"
                            style={{ width: `${spendingPct}%` }}
                        />
                    </div>
                    <div className="flex items-center justify-between text-xs">
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                            <ArrowUpRight className="h-3.5 w-3.5 text-gain" />
                            <CompactValueDisclosure
                                className="tabular-nums text-foreground"
                                display={incomeCompact.display}
                                fullValue={
                                    incomeCompact.isCompact
                                        ? incomeCompact.full
                                        : undefined
                                }
                            />
                        </span>
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                            <CompactValueDisclosure
                                className="tabular-nums text-foreground"
                                display={spendingCompact.display}
                                fullValue={
                                    spendingCompact.isCompact
                                        ? spendingCompact.full
                                        : undefined
                                }
                            />
                            <TrendingDown className="h-3.5 w-3.5 text-loss" />
                        </span>
                    </div>
                </div>

                {chartData.length > 1 && (
                    <div
                        className="mt-auto cursor-crosshair select-none"
                        style={{ touchAction: "pan-y" }}
                        role="group"
                        aria-label={t("dashboard.stat.netTrend", {
                            n: chartData.length,
                        })}
                        tabIndex={0}
                        onKeyDown={scrubKeyDown}
                        onBlur={scrubBlur}
                        onPointerMove={scrubFromEvent}
                        onPointerDown={(e) => {
                            e.currentTarget.setPointerCapture(e.pointerId);
                            scrubFromEvent(e);
                        }}
                        onPointerUp={endScrub}
                        onPointerCancel={endScrub}
                        onPointerLeave={endScrub}
                    >
                        <p
                            className={cn(
                                "text-xs mb-1",
                                scrubPoint
                                    ? "font-medium text-foreground"
                                    : "text-muted-foreground",
                            )}
                        >
                            {scrubPoint && scrubIndex !== undefined
                                ? chartData[scrubIndex].label
                                : t("dashboard.stat.netTrend", {
                                      n: chartData.length,
                                  })}
                        </p>
                        <ChartSparkline
                            data={chartData.map((d) => d.net)}
                            height={80}
                            color={areaStroke}
                            fillArea
                            strokeWidth={2}
                            activeIndex={scrubIndex}
                        />
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
