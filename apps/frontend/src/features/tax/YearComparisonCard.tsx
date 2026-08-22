/**
 * YearComparisonCard
 *
 * Side-by-side delta view comparing the currently-viewed income year against another
 * year the user picks from the available-years list. Surfaces PIT, effective rate,
 * gross taxable income, and net take-home with absolute + percent change.
 *
 * Always sources via `displayCalculationForYear` so filed/frozen years contribute their
 * frozen numbers — same engine-drift protection as the rest of the historical surfaces
 * (ADR-059).
 *
 * The card hides itself when fewer than two years are available, since there's nothing
 * meaningful to compare. The page is responsible for wrapping in widget visibility
 * gating if applicable.
 */
import { useMemo, useState, useEffect } from 'react';
import { ArrowDownRight, ArrowUpRight, GitCompare, Lock, Minus, Snowflake } from 'lucide-react';
import { useBelgianTaxProfile } from '@/contexts/BelgianTaxProfileContext';
import { useAvailableTaxYears } from '@/hooks/useAvailableTaxYears';
import { useLanguage } from '@/contexts/LanguageContext';
import { useCurrencyFormatter } from '@/hooks/useCurrencyFormatter';
import { formatPercent } from '@/utils/currency';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface YearComparisonCardProps {
    className?: string;
}

interface MetricRow {
    key: string;
    label: string;
    /** A higher value is "good" for the user — used to colour deltas (e.g. net take-home: more is better; PIT: more is worse). */
    higherIsBetter: boolean;
    valueA: number;
    valueB: number;
    /** Display formatter. */
    format: (val: number) => string;
}

export function YearComparisonCard({ className }: YearComparisonCardProps) {
    const { t } = useLanguage();
    const { viewedYear, displayCalculationForYear } = useBelgianTaxProfile();
    const years = useAvailableTaxYears();

    const defaultCompareYear = useMemo(() => {
        // Pick the year immediately preceding viewedYear that's in the available list.
        const preceding = years.find((y) => y.year < viewedYear);
        if (preceding) return preceding.year;
        // Otherwise pick any non-viewed year.
        const other = years.find((y) => y.year !== viewedYear);
        return other?.year ?? null;
    }, [years, viewedYear]);

    const [compareYear, setCompareYear] = useState<number | null>(defaultCompareYear);

    // Keep `compareYear` valid when viewedYear or the available list shifts.
    useEffect(() => {
        if (compareYear == null || compareYear === viewedYear || !years.some((y) => y.year === compareYear)) {
            setCompareYear(defaultCompareYear);
        }
    }, [compareYear, viewedYear, years, defaultCompareYear]);

    // Shared cached currency formatter; whole-euro amounts (decimals pinned to
    // 0, same rendering as the old maximumFractionDigits: 0 formatter).
    const fmtBase = useCurrencyFormatter();
    const fmtCurrency = (val: number) => fmtBase(val, undefined, 0);
    // Unsigned 1dp — these rows are rate readouts (effective rate), not deltas.
    function fmtPercent(val: number) {
        return formatPercent(val, { digits: 1 });
    }

    const rows: MetricRow[] | null = useMemo(() => {
        if (compareYear == null) return null;
        const calcA = displayCalculationForYear(viewedYear);
        const calcB = displayCalculationForYear(compareYear);
        return [
            {
                key: 'grossIncome',
                label: t('tax.comparison.row.grossIncome'),
                higherIsBetter: true,
                valueA: calcA.grossIncome,
                valueB: calcB.grossIncome,
                format: fmtCurrency,
            },
            {
                key: 'totalPIT',
                label: t('tax.comparison.row.totalPIT'),
                higherIsBetter: false,
                valueA: calcA.totalPIT,
                valueB: calcB.totalPIT,
                format: fmtCurrency,
            },
            {
                key: 'effectiveRate',
                label: t('tax.comparison.row.effectiveRate'),
                higherIsBetter: false,
                valueA: calcA.effectiveRate,
                valueB: calcB.effectiveRate,
                format: fmtPercent,
            },
            {
                key: 'netTakeHome',
                label: t('tax.comparison.row.netTakeHome'),
                higherIsBetter: true,
                valueA: calcA.netTakeHome,
                valueB: calcB.netTakeHome,
                format: fmtCurrency,
            },
        ];
        // fmtCurrency wraps the shared formatter, whose identity carries the
        // locale/currency/decimals settings.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [compareYear, viewedYear, displayCalculationForYear, t, fmtBase]);

    if (years.length < 2 || compareYear == null || rows == null) {
        return null;
    }

    const compareEntry = years.find((y) => y.year === compareYear);

    return (
        <Card className={className}>
            <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <GitCompare className="h-4 w-4 text-muted-foreground" />
                            {t('tax.comparison.title', { year: String(viewedYear) })}
                        </CardTitle>
                        <CardDescription className="text-xs mt-1">
                            {t('tax.comparison.description')}
                        </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                            {t('tax.comparison.versus')}
                        </span>
                        <Select
                            value={String(compareYear)}
                            onValueChange={(v) => setCompareYear(Number(v))}
                        >
                            <SelectTrigger
                                aria-label={t('tax.comparison.selectYear')}
                                className="h-8 w-28 text-xs"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {years
                                    .filter((y) => y.year !== viewedYear)
                                    .map((y) => (
                                        <SelectItem key={y.year} value={String(y.year)} className="text-xs">
                                            <span className="flex items-center gap-1.5">
                                                <span className="tabular-nums">{y.year}</span>
                                                {y.isFiled && (
                                                    <Lock className="h-2.5 w-2.5 text-warning" />
                                                )}
                                                {!y.isFiled && y.hasFrozenCalculation && (
                                                    <Snowflake className="h-2.5 w-2.5 text-sky-600" />
                                                )}
                                            </span>
                                        </SelectItem>
                                    ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                <div className="rounded-md border border-border overflow-hidden">
                    <table className="w-full text-sm">
                        <thead className="bg-muted/40">
                            <tr className="text-xs text-muted-foreground">
                                <th className="text-left font-medium px-3 py-2">
                                    {t('tax.comparison.header.metric')}
                                </th>
                                <th className="text-right font-medium px-3 py-2 tabular-nums">
                                    <span className="flex items-center justify-end gap-1.5">
                                        {viewedYear}
                                    </span>
                                </th>
                                <th className="text-right font-medium px-3 py-2 tabular-nums">
                                    <span className="flex items-center justify-end gap-1.5">
                                        {compareYear}
                                        {compareEntry?.isFiled && (
                                            <Lock className="h-3 w-3 text-warning" />
                                        )}
                                        {!compareEntry?.isFiled && compareEntry?.hasFrozenCalculation && (
                                            <Snowflake className="h-3 w-3 text-sky-600" />
                                        )}
                                    </span>
                                </th>
                                <th className="text-right font-medium px-3 py-2">
                                    {t('tax.comparison.header.delta')}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => {
                                const delta = row.valueA - row.valueB;
                                const pct =
                                    row.valueB === 0 ? null : ((row.valueA - row.valueB) / Math.abs(row.valueB)) * 100;
                                const zero = Math.abs(delta) < 0.005;
                                const favorable = zero
                                    ? null
                                    : row.higherIsBetter
                                      ? delta > 0
                                      : delta < 0;
                                const DeltaIcon = zero
                                    ? Minus
                                    : delta > 0
                                      ? ArrowUpRight
                                      : ArrowDownRight;

                                return (
                                    <tr key={row.key} className="border-t border-border/60">
                                        <td className="px-3 py-2">{row.label}</td>
                                        <td className="px-3 py-2 text-right font-medium tabular-nums">
                                            {row.format(row.valueA)}
                                        </td>
                                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                                            {row.format(row.valueB)}
                                        </td>
                                        <td
                                            className={cn(
                                                'px-3 py-2 text-right tabular-nums font-medium',
                                                zero && 'text-muted-foreground',
                                                favorable === true && 'text-accent',
                                                favorable === false && 'text-destructive',
                                            )}
                                        >
                                            <span className="inline-flex items-center justify-end gap-1">
                                                <DeltaIcon className="h-3 w-3" />
                                                {row.format(Math.abs(delta))}
                                                {pct != null && !zero && (
                                                    <span className="text-[11px] opacity-70">
                                                        ({formatPercent(pct, { digits: 1, signed: true })})
                                                    </span>
                                                )}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </CardContent>
        </Card>
    );
}
