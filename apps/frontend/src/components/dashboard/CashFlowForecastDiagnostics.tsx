import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, Database } from "lucide-react";

import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from "@/components/ui/sheet";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Sparkline } from "@/components/charts/Sparkline";
import { getChartColor } from "@/components/charts/palette";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { getCashflowForecastAccuracy } from "@/lib/api/aggregations";
import type {
    ForecastDiagnostics,
    ForecastBacktestEntry,
    AccuracyHistoryPoint,
} from "@/lib/api/aggregations";

const METHOD_COLORS: Record<string, string> = {
    simple_avg: getChartColor(0),
    weighted_avg: getChartColor(1),
    ewma: getChartColor(2),
    holt_winters: getChartColor(3),
    prophet_lite: getChartColor(4),
    monte_carlo_parametric: getChartColor(5),
    monte_carlo_block_bootstrap: getChartColor(6),
};

function mapeLabel(mape: number): string {
    if (!Number.isFinite(mape) || mape > 9999) return "N/A";
    return `${mape.toFixed(1)}%`;
}

function RankBadge({ rank }: { rank: number }) {
    if (rank === 1) return <Badge className="text-[10px] px-1.5 py-0 h-4 bg-amber-500/20 text-amber-700 dark:text-amber-400 border-0">#{rank}</Badge>;
    if (rank === 2) return <Badge className="text-[10px] px-1.5 py-0 h-4 bg-slate-400/20 text-slate-600 dark:text-slate-400 border-0">#{rank}</Badge>;
    if (rank === 3) return <Badge className="text-[10px] px-1.5 py-0 h-4 bg-orange-400/20 text-orange-700 dark:text-orange-400 border-0">#{rank}</Badge>;
    return <span className="text-xs text-muted-foreground">#{rank}</span>;
}

interface MethodRowProps {
    entry: ForecastBacktestEntry & { rank: number };
    currency: string;
    locale: string;
    persistedHistory: AccuracyHistoryPoint[] | undefined;
}

function MethodRow({ entry, currency, locale, persistedHistory }: MethodRowProps) {
    const color = METHOD_COLORS[entry.method_id] ?? getChartColor(7);

    const maePoints = useMemo(() => {
        if (persistedHistory && persistedHistory.length > 1) {
            return persistedHistory.map((h) => h.mae);
        }
        return entry.per_month.map((m) => m.mae);
    }, [persistedHistory, entry.per_month]);

    return (
        <TableRow>
            <TableCell className="py-2">
                <div className="flex items-center gap-2">
                    <span
                        className="inline-block size-2.5 rounded-full flex-shrink-0"
                        style={{ background: color }}
                    />
                    <span className="text-sm font-medium">{entry.label}</span>
                </div>
            </TableCell>
            <TableCell className="py-2 text-right tabular-nums text-sm">
                {formatCurrency(entry.mae, currency, locale)}
            </TableCell>
            <TableCell className="py-2 text-right tabular-nums text-sm">
                {formatCurrency(entry.rmse, currency, locale)}
            </TableCell>
            <TableCell className="py-2 text-right tabular-nums text-sm">
                {mapeLabel(entry.mape)}
            </TableCell>
            <TableCell className="py-2 text-right tabular-nums text-xs text-muted-foreground">
                {entry.months}
            </TableCell>
            <TableCell className="py-2">
                <RankBadge rank={entry.rank} />
            </TableCell>
            <TableCell className="py-2 w-24">
                {maePoints.length > 1 ? (
                    <Sparkline data={maePoints} height={24} color={color} strokeWidth={1.5} />
                ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                )}
            </TableCell>
        </TableRow>
    );
}

export interface CashFlowForecastDiagnosticsProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly diagnostics: ForecastDiagnostics;
    readonly currency: string;
}

export function CashFlowForecastDiagnostics({
    open,
    onOpenChange,
    diagnostics,
    currency,
}: CashFlowForecastDiagnosticsProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);

    const { data: persistedData } = useQuery({
        queryKey: ["cashflow-forecast-accuracy"],
        queryFn: () => getCashflowForecastAccuracy({ limit_months: 24 }),
        staleTime: 10 * 60 * 1000,
        enabled: open,
        select: (res) => res.data,
    });

    const persistedByMethod = useMemo(() => {
        if (!persistedData) return new Map<string, AccuracyHistoryPoint[]>();
        return new Map(persistedData.methods.map((m) => [m.method_id, m.history]));
    }, [persistedData]);

    const hasPersistedData = persistedData && persistedData.methods.length > 0;

    const ranked = useMemo<(ForecastBacktestEntry & { rank: number })[]>(() => {
        const sorted = [...diagnostics.backtest].sort((a, b) => a.mae - b.mae);
        return sorted.map((e, i) => ({ ...e, rank: i + 1 }));
    }, [diagnostics.backtest]);

    const inverseWeights = useMemo(() => {
        const validEntries = ranked.filter((e) => Number.isFinite(e.mae) && e.mae > 0);
        const totalInvMSE = validEntries.reduce((s, e) => s + 1 / (e.mae * e.mae), 0);
        if (totalInvMSE === 0) return new Map<string, number>();
        return new Map(validEntries.map((e) => [e.method_id, (1 / (e.mae * e.mae)) / totalInvMSE]));
    }, [ranked]);

    const topWeight = Math.max(...Array.from(inverseWeights.values(), (v) => v), 0);

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
                <SheetHeader className="mb-6">
                    <div className="flex items-center gap-2">
                        <FlaskConical className="h-5 w-5 text-primary" />
                        <SheetTitle>{t("cashflow.diagnostics.title")}</SheetTitle>
                    </div>
                    <SheetDescription>
                        {t("cashflow.diagnostics.desc", { months: String(diagnostics.history_months) })}
                    </SheetDescription>
                </SheetHeader>

                <section className="mb-8">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-semibold text-foreground">
                            {t("cashflow.diagnostics.accuracy")}
                        </h3>
                        {hasPersistedData && (
                            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                <Database className="h-3 w-3" />
                                <span>{t("cashflow.diagnostics.persistedHistory")}</span>
                            </div>
                        )}
                    </div>
                    <div className="rounded-lg border overflow-hidden">
                        <Table>
                            <TableHeader>
                                <TableRow className="text-xs">
                                    <TableHead className="py-2">{t("cashflow.diagnostics.method")}</TableHead>
                                    <TableHead className="py-2 text-right">MAE</TableHead>
                                    <TableHead className="py-2 text-right">RMSE</TableHead>
                                    <TableHead className="py-2 text-right">MAPE</TableHead>
                                    <TableHead className="py-2 text-right">{t("cashflow.diagnostics.months")}</TableHead>
                                    <TableHead className="py-2">{t("cashflow.diagnostics.rank")}</TableHead>
                                    <TableHead className="py-2">{t("cashflow.diagnostics.maeTrend")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {ranked.map((entry) => (
                                    <MethodRow
                                        key={entry.method_id}
                                        entry={entry}
                                        currency={currency}
                                        locale={locale}
                                        persistedHistory={persistedByMethod.get(entry.method_id)}
                                    />
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                        {hasPersistedData
                            ? t("cashflow.diagnostics.backtestNoteWithHistory")
                            : t("cashflow.diagnostics.backtestNote")}
                    </p>
                </section>

                {inverseWeights.size > 0 && (
                    <section>
                        <h3 className="text-sm font-semibold mb-1 text-foreground">
                            {t("cashflow.diagnostics.suggestedWeights")}
                        </h3>
                        <p className="text-[11px] text-muted-foreground mb-3">
                            {t("cashflow.diagnostics.weightsNote")}
                        </p>
                        <div className="space-y-2">
                            {ranked
                                .filter((e) => inverseWeights.has(e.method_id))
                                .map((e) => {
                                    const w = inverseWeights.get(e.method_id) ?? 0;
                                    const pct = Math.round(w * 100);
                                    const barPct = topWeight > 0 ? (w / topWeight) * 100 : 0;
                                    const color = METHOD_COLORS[e.method_id] ?? getChartColor(7);
                                    return (
                                        <div key={e.method_id} className="flex items-center gap-3">
                                            <span
                                                className="inline-block size-2 rounded-full flex-shrink-0"
                                                style={{ background: color }}
                                            />
                                            <span className="text-xs w-44 truncate">{e.label}</span>
                                            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                                                <div
                                                    className="h-full rounded-full transition-all duration-300"
                                                    style={{
                                                        width: `${barPct}%`,
                                                        background: color,
                                                    }}
                                                />
                                            </div>
                                            <span className="text-xs tabular-nums w-8 text-right text-muted-foreground">
                                                {pct}%
                                            </span>
                                        </div>
                                    );
                                })}
                        </div>
                        <p className="mt-3 text-[11px] text-muted-foreground italic">
                            {t("cashflow.diagnostics.weightsReadOnly")}
                        </p>
                    </section>
                )}
            </SheetContent>
        </Sheet>
    );
}
