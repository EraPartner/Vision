/**
 * YearComparisonCard
 *
 * Side-by-side delta view comparing the currently-viewed income year against another
 * year the user picks from the available-years list. Surfaces income tax, effective
 * rate, gross taxable income, and net take-home with absolute + percent change.
 *
 * Always sources via `displayCalculationForYear` so filed/frozen years contribute their
 * frozen numbers — same engine-drift protection as the rest of the historical surfaces
 * (ADR-059).
 *
 * The card hides itself when fewer than two years are available, since there's nothing
 * meaningful to compare. The page is responsible for wrapping in widget visibility
 * gating if applicable.
 */
import { useMemo, useState, useEffect } from "react";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { resolveBelgianTaxCalculation } from "@/stores/belgianTaxStore";
import { useAvailableTaxYears } from "@/hooks/useAvailableTaxYears";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { TaxYearStatusIcon } from "./TaxYearStatusIcon";

interface YearComparisonCardProps {
    className?: string;
}

interface MetricRow {
    key: string;
    label: string;
    /** A higher value is "good" for the user — used to colour deltas (e.g. net take-home: more is better; income tax: more is worse). */
    higherIsBetter: boolean;
    valueA: number;
    valueB: number;
    /** Display formatter. */
    format: (val: number) => string;
    /** Currency rows use the shared signed-money formatter for their delta. */
    isCurrency?: boolean;
}

export function YearComparisonCard({ className }: YearComparisonCardProps) {
    const { t } = useLanguage();
    const { viewedYear, profile, snapshots, snapshotMetas } =
        useBelgianTaxProfile((state) => ({
            viewedYear: state.viewedYear,
            profile: state.profile,
            snapshots: state.snapshots,
            snapshotMetas: state.snapshotMetas,
        }));
    const years = useAvailableTaxYears();

    const defaultCompareYear = useMemo(() => {
        // Pick the year immediately preceding viewedYear that's in the available list.
        const preceding = years.find((y) => y.year < viewedYear);
        if (preceding) return preceding.year;
        // Otherwise pick any non-viewed year.
        const other = years.find((y) => y.year !== viewedYear);
        return other?.year ?? null;
    }, [years, viewedYear]);

    const [compareYear, setCompareYear] = useState<number | null>(
        defaultCompareYear,
    );

    // Keep `compareYear` valid when viewedYear or the available list shifts.
    useEffect(() => {
        if (
            compareYear == null ||
            compareYear === viewedYear ||
            !years.some((y) => y.year === compareYear)
        ) {
            setCompareYear(defaultCompareYear);
        }
    }, [compareYear, viewedYear, years, defaultCompareYear]);

    // Shared cached currency formatter; whole-euro amounts (decimals pinned to
    // 0, same rendering as the old maximumFractionDigits: 0 formatter).
    const fmtBase = useCurrencyFormatter();
    const formatPercent = usePercentFormatter();
    const fmtCurrency = (val: number) => fmtBase(val, { decimals: 0 });
    // Unsigned 1dp — these rows are rate readouts (effective rate), not deltas.
    function fmtPercent(val: number) {
        return formatPercent(val, { digits: 1 });
    }

    const rows: MetricRow[] | null = useMemo(() => {
        if (compareYear == null) return null;
        const taxState = { profile, snapshots, snapshotMetas };
        const calcA = resolveBelgianTaxCalculation(taxState, viewedYear);
        const calcB = resolveBelgianTaxCalculation(taxState, compareYear);
        return [
            {
                key: "grossIncome",
                label: t("tax.comparison.row.grossIncome"),
                higherIsBetter: true,
                valueA: calcA.grossIncome,
                valueB: calcB.grossIncome,
                format: fmtCurrency,
                isCurrency: true,
            },
            {
                key: "totalPIT",
                label: t("tax.comparison.row.totalPIT"),
                higherIsBetter: false,
                valueA: calcA.totalPIT,
                valueB: calcB.totalPIT,
                format: fmtCurrency,
                isCurrency: true,
            },
            {
                key: "effectiveRate",
                label: t("tax.comparison.row.effectiveRate"),
                higherIsBetter: false,
                valueA: calcA.effectiveRate,
                valueB: calcB.effectiveRate,
                format: fmtPercent,
            },
            {
                key: "netTakeHome",
                label: t("tax.comparison.row.netTakeHome"),
                higherIsBetter: true,
                valueA: calcA.netTakeHome,
                valueB: calcB.netTakeHome,
                format: fmtCurrency,
                isCurrency: true,
            },
        ];
        // fmtCurrency wraps the shared formatter, whose identity carries the
        // locale/currency/decimals settings.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        compareYear,
        viewedYear,
        profile,
        snapshots,
        snapshotMetas,
        t,
        fmtBase,
    ]);

    if (years.length < 2 || compareYear == null || rows == null) {
        return null;
    }

    const compareEntry = years.find((y) => y.year === compareYear);

    return (
        <Card className={className}>
            <CardHeader className="pb-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <CardTitle variant="sm">
                            {t("tax.comparison.title", {
                                year: String(viewedYear),
                            })}
                        </CardTitle>
                        <CardDescription className="mt-0.5">
                            {t("tax.comparison.description")}
                        </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                        <Label
                            htmlFor="tax-comparison-year"
                            className="text-label-secondary"
                        >
                            {t("tax.comparison.versus")}
                        </Label>
                        <Select
                            value={String(compareYear)}
                            onValueChange={(v) => setCompareYear(Number(v))}
                        >
                            <SelectTrigger
                                id="tax-comparison-year"
                                aria-label={t("tax.comparison.selectYear")}
                                className="w-32 tabular-nums"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {years
                                    .filter((y) => y.year !== viewedYear)
                                    .map((y) => (
                                        <SelectItem
                                            key={y.year}
                                            value={String(y.year)}
                                        >
                                            <span className="flex items-center gap-1.5">
                                                <span className="tabular-nums">
                                                    {y.year}
                                                </span>
                                                <TaxYearStatusIcon
                                                    isFiled={y.isFiled}
                                                    hasFrozenCalculation={
                                                        y.hasFrozenCalculation
                                                    }
                                                    className="h-3 w-3"
                                                />
                                            </span>
                                        </SelectItem>
                                    ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>
                                {t("tax.comparison.header.metric")}
                            </TableHead>
                            <TableHead className="text-right tabular-nums">
                                {viewedYear}
                            </TableHead>
                            <TableHead className="text-right tabular-nums">
                                <span className="inline-flex items-center justify-end gap-1.5">
                                    {compareYear}
                                    <TaxYearStatusIcon
                                        isFiled={compareEntry?.isFiled}
                                        hasFrozenCalculation={
                                            compareEntry?.hasFrozenCalculation
                                        }
                                        className="h-3 w-3"
                                    />
                                </span>
                            </TableHead>
                            <TableHead className="text-right">
                                {t("tax.comparison.header.delta")}
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => {
                            const delta = row.valueA - row.valueB;
                            const pct =
                                row.valueB === 0
                                    ? null
                                    : ((row.valueA - row.valueB) /
                                          Math.abs(row.valueB)) *
                                      100;
                            const zero = Math.abs(delta) < 0.005;
                            const pillValue = zero ? 0 : delta;
                            const deltaAmount = row.isCurrency
                                ? fmtBase(delta, {
                                      decimals: 0,
                                      signed: true,
                                  })
                                : row.format(Math.abs(delta));
                            const deltaLabel = `${deltaAmount}${
                                pct != null && !zero
                                    ? ` (${formatPercent(pct, { digits: 1, signed: true })})`
                                    : ""
                            }`;

                            return (
                                <TableRow key={row.key}>
                                    <TableCell>{row.label}</TableCell>
                                    <TableCell className="text-right font-medium tabular-nums">
                                        {row.format(row.valueA)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums text-label-secondary">
                                        {row.format(row.valueB)}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <DeltaPill
                                            value={pillValue}
                                            invert={!row.higherIsBetter}
                                            label={deltaLabel}
                                        />
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
}
