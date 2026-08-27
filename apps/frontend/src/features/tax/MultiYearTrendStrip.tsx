/**
 * MultiYearTrendStrip
 *
 * Compact horizontal strip of per-year tiles surfacing each tracked year's headline tax
 * numbers at a glance. Distinct from the page's large yearly chart — this is a
 * navigation/comparison aid, not a data-viz primary surface.
 *
 * Each tile shows: year, total PIT, effective rate, and a normalized bar comparing PIT
 * against the maximum across visible years. Filed/frozen status surfaces as inline
 * indicators (lock / snowflake). The currently-viewed year is visually emphasized.
 * Clicking a tile sets `viewedYear`.
 *
 * Uses `displayCalculationForYear` so filed/frozen years render their "as-filed"
 * numbers rather than today's live recomputation (engine-drift protection — ADR-059).
 */
import { useMemo } from "react";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useAvailableTaxYears } from "@/hooks/useAvailableTaxYears";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { formatPercent } from "@/utils/currency";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { TaxYearStatusIcon } from "./TaxYearStatusIcon";

interface MultiYearTrendStripProps {
    className?: string;
    /**
     * Maximum number of years to render. Newest first. Defaults to 8 — beyond that the
     * strip becomes a horizontal scroll which we explicitly *don't* do here (overflow is
     * the bigger Yearly chart's job).
     */
    maxYears?: number;
}

const DEFAULT_MAX_YEARS = 8;

export function MultiYearTrendStrip({
    className,
    maxYears = DEFAULT_MAX_YEARS,
}: MultiYearTrendStripProps) {
    const { t } = useLanguage();
    const { viewedYear, setViewedYear, displayCalculationForYear } =
        useBelgianTaxProfile();
    const years = useAvailableTaxYears();
    // Shared cached currency formatter; whole-euro tiles (decimals pinned to 0,
    // same rendering as the old maximumFractionDigits: 0 formatter).
    const fmtBase = useCurrencyFormatter();
    const fmtCurrency = (val: number) => fmtBase(val, undefined, 0);

    const tiles = useMemo(() => {
        const limited = years.slice(0, maxYears);
        const rows = limited.map((entry) => {
            const calc = displayCalculationForYear(entry.year);
            return {
                ...entry,
                totalPIT: calc.totalPIT,
                effectiveRate: calc.effectiveRate,
                netTakeHome: calc.netTakeHome,
            };
        });
        const maxPIT = rows.reduce((m, r) => Math.max(m, r.totalPIT), 0);
        return rows.map((r) => ({
            ...r,
            barRatio: maxPIT > 0 ? Math.max(0.04, r.totalPIT / maxPIT) : 0,
        }));
    }, [years, maxYears, displayCalculationForYear]);

    if (tiles.length <= 1) return null;

    return (
        <Card className={cn("overflow-hidden", className)}>
            <CardHeader className="pb-3">
                <CardTitle variant="sm">{t("tax.trendStrip.title")}</CardTitle>
                <CardDescription className="text-xs">
                    {t("tax.trendStrip.description")}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div
                    className="grid gap-2"
                    style={{
                        gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))`,
                    }}
                >
                    {tiles.map((tile) => {
                        const isActive = tile.year === viewedYear;
                        return (
                            <button
                                key={tile.year}
                                type="button"
                                onClick={() => setViewedYear(tile.year)}
                                className={cn(
                                    "group flex flex-col items-stretch rounded-lg border px-2.5 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    isActive
                                        ? "border-primary/60 bg-primary/5"
                                        : "border-border hover:border-primary/40 hover:bg-accent/40",
                                )}
                                aria-pressed={isActive}
                            >
                                <span className="flex items-center justify-between gap-1">
                                    <span
                                        className={cn(
                                            "text-xs font-semibold tabular-nums",
                                            isActive
                                                ? "text-primary"
                                                : "text-foreground",
                                        )}
                                    >
                                        {tile.year}
                                    </span>
                                    <span className="flex items-center gap-0.5">
                                        <TaxYearStatusIcon
                                            isFiled={tile.isFiled}
                                            hasFrozenCalculation={
                                                tile.hasFrozenCalculation
                                            }
                                            className="h-3 w-3"
                                        />
                                    </span>
                                </span>
                                <span className="mt-1 text-sm font-bold text-foreground tabular-nums">
                                    {fmtCurrency(tile.totalPIT)}
                                </span>
                                <span className="eyebrow">
                                    {formatPercent(tile.effectiveRate, {
                                        digits: 1,
                                    })}{" "}
                                    {t("tax.trendStrip.effective")}
                                </span>
                                <div className="mt-2 h-1 w-full rounded-full bg-muted">
                                    <div
                                        className={cn(
                                            "h-full rounded-full transition-[width]",
                                            isActive
                                                ? "bg-primary"
                                                : "bg-primary/40",
                                        )}
                                        style={{
                                            width: `${tile.barRatio * 100}%`,
                                        }}
                                    />
                                </div>
                            </button>
                        );
                    })}
                </div>
            </CardContent>
        </Card>
    );
}
