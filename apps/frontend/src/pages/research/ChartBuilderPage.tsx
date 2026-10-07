import { PAGE_ICONS } from "@/lib/pageIcons";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    Copy,
    FilePlus2,
    LineChart as LineChartIcon,
    MoreHorizontal,
    Plus,
    Save,
    Trash2,
} from "lucide-react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateWithAppSettings } from "@/lib/dateUtils";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { undoToast } from "@/lib/undoToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ResearchRangeSelector } from "@/components/charts/ResearchRangeSelector";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
} from "@/components/ui/select";
import {
    ComposedChart,
    LineChart,
    getChartColor,
    type ComposedSeries,
    type LineSeries,
} from "@/components/charts";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { SymbolSearchResultItem } from "@/components/shared/SymbolSearchResultItem";
import { SymbolSearchBox } from "@/components/shared/SymbolSearchBox";
import { useSymbolSearch } from "@/hooks/useSymbolSearch";
import { apiClient } from "@/lib/api";
import { sma, ema, bollinger, rsi, macd } from "@/lib/research/indicators";
import type { MacroSeriesItem, ResearchChartPoint } from "@/types/research";
import { RESEARCH_RANGES as RANGES } from "@/lib/research/ranges";
import { cn } from "@/lib/utils";
import {
    DEFAULT_STATE,
    type BuilderIndicator,
    type BuilderSeries,
    type BuilderState,
    type Field,
    type IndicatorType,
    type Oscillator,
    type SeriesType,
} from "./chartBuilderState";
import {
    createChartBuilderLayout,
    decodeSharedChart,
    deleteActiveChartBuilderLayout,
    encodeSharedChart,
    getActiveBuilderState,
    loadChartBuilderLibrary,
    MAX_CHART_INDICATORS,
    saveChartBuilderLibrary,
    setActiveBuilderState,
    type ChartBuilderLibrary,
} from "./chartBuilderLayouts";
import { IndicatorPeriodInput } from "./IndicatorPeriodInput";
import { PageShell } from "@/components/shared/PageShell";
import {
    useChartBuilderSeriesQueries,
    useMacroSearchQuery,
} from "@/features/research/useResearchQueries";

const PROVIDERS = [
    "",
    "yahoo",
    "twelve_data",
    "finnhub",
    "fmp",
    "alpha_vantage",
];
const MAX_SERIES = 5;

/** Stable fetch/cache key for a series — distinct (symbol,provider) for tickers, (provider,seriesId) for macro. */
function seriesKey(
    s: Pick<BuilderSeries, "symbol" | "provider" | "macro">,
): string {
    return s.macro
        ? `m|${s.macro.provider}|${s.macro.seriesId}`
        : `c|${s.symbol}|${s.provider}`;
}

/** Display label for a series (macro uses its title; tickers use the symbol). */
function seriesLabel(s: BuilderSeries): string {
    return s.macro ? s.macro.title : s.symbol;
}

type Row = { time: number } & Record<string, number | null>;

export default function ChartBuilderPage() {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);

    const [searchParams, setSearchParams] = useSearchParams();
    const sharedChart = searchParams.get("chart");
    const [library, setLibrary] = useState<ChartBuilderLibrary>(
        loadChartBuilderLibrary,
    );
    const [saveDialogOpen, setSaveDialogOpen] = useState(false);
    const [layoutName, setLayoutName] = useState("");
    const [confirmAction, setConfirmAction] = useState<
        "new" | "share" | null
    >(null);
    const [pendingSharedState, setPendingSharedState] =
        useState<BuilderState | null>(null);
    const storageFailureShown = useRef(false);
    const [persistedLibrary, setPersistedLibrary] =
        useState<ChartBuilderLibrary | null>(null);
    const [storageFailed, setStorageFailed] = useState(false);
    const handledSharedChart = useRef<string | null>(null);
    const state = getActiveBuilderState(library);
    const activeLayout = library.activeLayoutId
        ? library.layouts.find((layout) => layout.id === library.activeLayoutId)
        : undefined;
    const uid = () => crypto.randomUUID();
    const setState = (
        updater: BuilderState | ((previous: BuilderState) => BuilderState),
    ) => {
        setLibrary((previousLibrary) => {
            const previousState = getActiveBuilderState(previousLibrary);
            const nextState =
                typeof updater === "function"
                    ? updater(previousState)
                    : updater;
            return setActiveBuilderState(previousLibrary, nextState);
        });
    };
    const {
        range,
        logLeft,
        rebase: rebaseAll,
        series,
        indicators,
        oscillator,
        oscillatorSeriesId,
    } = state;
    const patch = (p: Partial<BuilderState>) =>
        setState((s) => ({ ...s, ...p }));

    useEffect(() => {
        const saved = saveChartBuilderLibrary(library);
        setStorageFailed(!saved);
        if (saved) setPersistedLibrary(library);
        if (!saved && !storageFailureShown.current) {
            storageFailureShown.current = true;
            toast.error(t("research.builder.storageFailed"));
        } else if (saved) {
            storageFailureShown.current = false;
        }
    }, [library, t]);

    useEffect(() => {
        if (!sharedChart) {
            handledSharedChart.current = null;
            return;
        }
        if (handledSharedChart.current === sharedChart) return;
        handledSharedChart.current = sharedChart;
        const imported = decodeSharedChart(sharedChart);
        if (imported) {
            if (
                JSON.stringify(library.draft) === JSON.stringify(DEFAULT_STATE)
            ) {
                setLibrary((previous) => ({
                    ...previous,
                    activeLayoutId: null,
                    draft: imported,
                }));
                toast.success(t("research.builder.shareImported"));
            } else {
                setPendingSharedState(imported);
                setConfirmAction("share");
            }
        } else {
            toast.error(t("research.builder.shareInvalid"));
        }
        setSearchParams(
            (previous) => {
                const next = new URLSearchParams(previous);
                next.delete("chart");
                return next;
            },
            { replace: true },
        );
    }, [library.draft, setSearchParams, sharedChart, t]);

    const applySharedChart = () => {
        if (!pendingSharedState) return;
        setLibrary((previous) => ({
            ...previous,
            activeLayoutId: null,
            draft: pendingSharedState,
        }));
        setPendingSharedState(null);
        setConfirmAction(null);
        toast.success(t("research.builder.shareImported"));
    };

    const startNewLayout = () => {
        setLibrary((previous) => ({
            ...previous,
            activeLayoutId: null,
            draft: DEFAULT_STATE,
        }));
        setConfirmAction(null);
    };

    const requestNewLayout = () => {
        const isEmptyDraft =
            !activeLayout &&
            JSON.stringify(state) === JSON.stringify(DEFAULT_STATE);
        if (isEmptyDraft) startNewLayout();
        else setConfirmAction("new");
    };

    const saveAsLayout = () => {
        const result = createChartBuilderLayout(
            library,
            layoutName,
            state,
            crypto.randomUUID(),
        );
        if (!result.ok) {
            toast.error(t(`research.builder.saveError.${result.reason}`));
            return;
        }
        if (!saveChartBuilderLibrary(result.library)) {
            toast.error(t("research.builder.storageFailed"));
            return;
        }
        setLibrary(result.library);
        setLayoutName("");
        setSaveDialogOpen(false);
        toast.success(t("research.builder.layoutSaved"));
    };

    // A saved layout is deleted at once; Undo writes the previous library
    // back (ADR-179 "forgive, don't warn"), so no confirmation is needed.
    const deleteLayout = () => {
        const previous = library;
        const next = deleteActiveChartBuilderLayout(library);
        if (!saveChartBuilderLibrary(next)) {
            toast.error(t("research.builder.storageFailed"));
            return;
        }
        setLibrary(next);
        undoToast({
            message: t("research.builder.layoutDeleted"),
            undoLabel: t("common.undo"),
            undo: () => {
                if (!saveChartBuilderLibrary(previous)) {
                    toast.error(t("research.builder.storageFailed"));
                    return;
                }
                setLibrary(previous);
            },
        });
    };

    const copyShareLink = async () => {
        try {
            const url = new URL(window.location.href);
            url.searchParams.set("chart", encodeSharedChart(state));
            await navigator.clipboard.writeText(url.toString());
            toast.success(t("research.builder.shareCopied"));
        } catch {
            toast.error(t("research.builder.shareFailed"));
        }
    };

    // Symbol search picker.
    const {
        searchText,
        setSearchText,
        debouncedSearch,
        searchResult,
        isFetching: symbolSearching,
        isError: symbolFailed,
        isOpen,
    } = useSymbolSearch(apiClient.searchResearch, {
        queryKey: "research-search",
    });
    // Macro search runs alongside the ticker search; results merge into one
    // dropdown, tagged "Economic" (ADR-082). Keyless providers always respond;
    // FRED contributes only when its key is configured.
    const {
        data: macroResult,
        isFetching: macroSearching,
        isError: macroFailed,
    } = useMacroSearchQuery(debouncedSearch);

    const addSeries = (symbol: string) => {
        const s = symbol.toUpperCase();
        setState((prev) => {
            if (prev.series.length >= MAX_SERIES) return prev;
            const id = uid();
            const next = [
                ...prev.series,
                {
                    id,
                    symbol: s,
                    field: "price" as Field,
                    type: "line" as SeriesType,
                    axis: "left" as const,
                    provider: "",
                },
            ];
            return {
                ...prev,
                series: next,
                oscillatorSeriesId: prev.oscillatorSeriesId ?? id,
            };
        });
        setSearchText("");
    };

    const addMacroSeries = (item: MacroSeriesItem) => {
        setState((prev) => {
            if (prev.series.length >= MAX_SERIES) return prev;
            const id = uid();
            const next: BuilderSeries[] = [
                ...prev.series,
                {
                    id,
                    symbol: item.seriesId,
                    field: "price",
                    type: "line",
                    axis: "left",
                    provider: item.provider,
                    macro: {
                        provider: item.provider,
                        seriesId: item.seriesId,
                        title: item.title,
                    },
                },
            ];
            return {
                ...prev,
                series: next,
                oscillatorSeriesId: prev.oscillatorSeriesId ?? id,
            };
        });
        setSearchText("");
    };
    const updateSeries = (id: string, p: Partial<BuilderSeries>) =>
        patch({
            series: series.map((s) => (s.id === id ? { ...s, ...p } : s)),
        });
    const removeSeries = (id: string) =>
        patch({
            series: series.filter((s) => s.id !== id),
            indicators: indicators.filter((i) => i.seriesId !== id),
            oscillatorSeriesId:
                oscillatorSeriesId === id ? null : oscillatorSeriesId,
        });

    const addIndicator = (type: IndicatorType) => {
        if (indicators.length >= MAX_CHART_INDICATORS) return;
        const base = series.find((s) => s.field === "price");
        if (!base) return;
        patch({
            indicators: [
                ...indicators,
                {
                    id: uid(),
                    type,
                    period:
                        type === "bollinger" ? 20 : type === "ema" ? 12 : 50,
                    seriesId: base.id,
                },
            ],
        });
    };
    const updateIndicator = (id: string, p: Partial<BuilderIndicator>) =>
        patch({
            indicators: indicators.map((i) =>
                i.id === id ? { ...i, ...p } : i,
            ),
        });
    const removeIndicator = (id: string) =>
        patch({ indicators: indicators.filter((i) => i.id !== id) });

    // ── Fetch chart data per distinct series key (ticker or macro) ──
    const fetchKeys = useMemo(() => {
        const seen = new Set<string>();
        const keys: {
            key: string;
            symbol: string;
            provider: string;
            macro?: BuilderSeries["macro"];
        }[] = [];
        for (const s of series) {
            const key = seriesKey(s);
            if (!seen.has(key)) {
                seen.add(key);
                keys.push({
                    key,
                    symbol: s.symbol,
                    provider: s.provider,
                    macro: s.macro,
                });
            }
        }
        return keys;
    }, [series]);

    const chartQueries = useChartBuilderSeriesQueries(fetchKeys, range);

    const pointsByKey = useMemo(() => {
        const map = new Map<string, ResearchChartPoint[]>();
        fetchKeys.forEach((fk, i) => {
            map.set(fk.key, chartQueries[i]?.data?.data.points ?? []);
        });
        return map;
    }, [fetchKeys, chartQueries]);

    const isLoading = chartQueries.some((q) => q.isFetching && !q.data);

    // ── Build the unified row set + ComposedChart series ──
    const { rows, composed } = useMemo(() => {
        const pointsBySeries = new Map<string, ResearchChartPoint[]>();
        for (const s of series)
            pointsBySeries.set(s.id, pointsByKey.get(seriesKey(s)) ?? []);

        // Per-series rebase factor (close-based), applied to price values & OHLC.
        const factor = new Map<string, number>();
        for (const s of series) {
            const pts = pointsBySeries.get(s.id) ?? [];
            const firstClose = pts.find(
                (p) => Number.isFinite(p.close) && p.close > 0,
            )?.close;
            factor.set(s.id, rebaseAll && firstClose ? 100 / firstClose : 1);
        }

        const timeSet = new Set<number>();
        for (const pts of pointsBySeries.values())
            for (const p of pts) timeSet.add(p.time);
        const times = Array.from(timeSet).sort((a, b) => a - b);

        const byTime = new Map<string, Map<number, ResearchChartPoint>>();
        for (const s of series)
            byTime.set(
                s.id,
                new Map(
                    (pointsBySeries.get(s.id) ?? []).map((p) => [p.time, p]),
                ),
            );

        const rows: Row[] = times.map((time) => {
            const row: Row = { time };
            for (const s of series) {
                const p = byTime.get(s.id)!.get(time);
                const f = factor.get(s.id)!;
                if (s.field === "volume") {
                    row[`${s.id}`] = p ? p.volume : null;
                } else {
                    row[`${s.id}`] =
                        p && Number.isFinite(p.close) ? p.close * f : null;
                    row[`${s.id}_o`] =
                        p && Number.isFinite(p.close) ? p.close * f : null; // open ~ prev close fallback
                    row[`${s.id}_h`] =
                        p && Number.isFinite(p.high) ? p.high * f : null;
                    row[`${s.id}_l`] =
                        p && Number.isFinite(p.low) ? p.low * f : null;
                }
            }
            return row;
        });
        // Candlestick open = previous row's close of that series (chart endpoint has no open).
        for (const s of series) {
            if (s.type !== "candlestick") continue;
            let prev: number | null = null;
            for (const row of rows) {
                const close = row[`${s.id}`];
                row[`${s.id}_o`] = prev ?? close;
                prev = close ?? prev;
            }
        }

        // Indicators (computed on each indicator's source series, aligned by time).
        for (const ind of indicators) {
            const pts = pointsBySeries.get(ind.seriesId) ?? [];
            const f = factor.get(ind.seriesId) ?? 1;
            const closes = pts.map((p) =>
                Number.isFinite(p.close) ? p.close * f : NaN,
            );
            const assign = (key: string, values: (number | null)[]) => {
                const m = new Map<number, number | null>();
                pts.forEach((p, i) => m.set(p.time, values[i] ?? null));
                for (const row of rows) row[key] = m.get(row.time) ?? null;
            };
            if (ind.type === "sma") assign(ind.id, sma(closes, ind.period));
            else if (ind.type === "ema")
                assign(ind.id, ema(closes, ind.period));
            else if (ind.type === "bollinger") {
                const b = bollinger(closes, ind.period, 2);
                assign(ind.id, b.middle);
                assign(`${ind.id}_u`, b.upper);
                assign(`${ind.id}_l`, b.lower);
            }
        }

        const composed: ComposedSeries<Row>[] = [];
        series.forEach((s, i) => {
            const color = getChartColor(i);
            if (s.type === "candlestick" && s.field === "price") {
                composed.push({
                    key: s.id,
                    label: seriesLabel(s),
                    type: "candlestick",
                    axis: s.axis,
                    open: (d) => d[`${s.id}_o`],
                    high: (d) => d[`${s.id}_h`],
                    low: (d) => d[`${s.id}_l`],
                    close: (d) => d[`${s.id}`],
                });
            } else {
                composed.push({
                    key: s.id,
                    label:
                        s.field === "volume"
                            ? `${seriesLabel(s)} ${t("research.builder.volume")}`
                            : seriesLabel(s),
                    type: s.type === "candlestick" ? "line" : s.type,
                    axis: s.axis,
                    color,
                    fillOpacity: s.field === "volume" ? 0.4 : undefined,
                    accessor: (d) => d[`${s.id}`],
                });
            }
        });
        // Indicator overlay series (left axis, dashed/muted).
        indicators.forEach((ind, i) => {
            const color = getChartColor(series.length + i);
            const labelBase =
                ind.type === "bollinger"
                    ? `BB(${ind.period})`
                    : `${ind.type.toUpperCase()}(${ind.period})`;
            composed.push({
                key: ind.id,
                label: labelBase,
                type: "line",
                axis: "left",
                color,
                strokeWidth: 1.5,
                accessor: (d) => d[ind.id],
            });
            if (ind.type === "bollinger") {
                composed.push({
                    key: `${ind.id}_u`,
                    label: `${labelBase} ↑`,
                    type: "line",
                    axis: "left",
                    color,
                    strokeWidth: 1,
                    dashed: true,
                    accessor: (d) => d[`${ind.id}_u`],
                });
                composed.push({
                    key: `${ind.id}_l`,
                    label: `${labelBase} ↓`,
                    type: "line",
                    axis: "left",
                    color,
                    strokeWidth: 1,
                    dashed: true,
                    accessor: (d) => d[`${ind.id}_l`],
                });
            }
        });

        return { rows, composed };
    }, [series, indicators, pointsByKey, rebaseAll, t]);

    // ── Oscillator panel (RSI / MACD) computed on the chosen source series ──
    const { oscRows, oscSeries, oscRefs } = useMemo(() => {
        const srcId = oscillatorSeriesId ?? series[0]?.id;
        const src = series.find((s) => s.id === srcId);
        if (oscillator === "none" || !src)
            return {
                oscRows: [] as Row[],
                oscSeries: [] as LineSeries<Row>[],
                oscRefs: [],
            };
        const pts = pointsByKey.get(seriesKey(src)) ?? [];
        const closes = pts.map((p) => p.close);
        const oscRows: Row[] = pts.map((p) => ({ time: p.time }));
        if (oscillator === "rsi") {
            const r = rsi(closes, 14);
            oscRows.forEach((row, i) => {
                row.rsi = r[i] ?? null;
            });
            return {
                oscRows,
                oscSeries: [
                    {
                        key: "rsi",
                        label: "RSI(14)",
                        accessor: (d: Row) => d.rsi,
                        color: "hsl(var(--primary))",
                        strokeWidth: 1.5,
                    },
                ],
                oscRefs: [
                    { y: 70, label: "70", dashed: true },
                    { y: 30, label: "30", dashed: true },
                ],
            };
        }
        const m = macd(closes);
        oscRows.forEach((row, i) => {
            row.macd = m.macd[i] ?? null;
            row.signal = m.signal[i] ?? null;
            row.hist = m.histogram[i] ?? null;
        });
        return {
            oscRows,
            oscSeries: [
                {
                    key: "macd",
                    label: "MACD",
                    accessor: (d: Row) => d.macd,
                    color: "hsl(var(--primary))",
                    strokeWidth: 1.5,
                },
                {
                    key: "signal",
                    label: "Signal",
                    accessor: (d: Row) => d.signal,
                    color: "hsl(var(--accent))",
                    strokeWidth: 1.5,
                    dashed: true,
                },
            ] as LineSeries<Row>[],
            oscRefs: [{ y: 0, dashed: true }],
        };
    }, [oscillator, oscillatorSeriesId, series, pointsByKey]);

    // ── Presets ──
    const applyPreset = (preset: string) => {
        const primary = series.find((s) => s.field === "price");
        if (!primary) return;
        const priceOnly = series.filter((s) => s.field === "price");
        if (preset === "priceVolume") {
            // Macro series carry no volume — base the volume overlay on a ticker.
            const volBase = series.find((s) => s.field === "price" && !s.macro);
            if (!volBase) return;
            const volume: BuilderSeries = {
                id: uid(),
                symbol: volBase.symbol,
                field: "volume",
                type: "bar",
                axis: "right",
                provider: volBase.provider,
            };
            patch({
                series: [
                    ...priceOnly.map((s) => ({
                        ...s,
                        type: "line" as SeriesType,
                    })),
                    volume,
                ],
                indicators: [],
                oscillator: "none",
            });
        } else if (preset === "sma") {
            patch({
                indicators: [
                    {
                        id: uid(),
                        type: "sma",
                        period: 50,
                        seriesId: primary.id,
                    },
                    {
                        id: uid(),
                        type: "sma",
                        period: 200,
                        seriesId: primary.id,
                    },
                ],
                series: priceOnly.map((s) => ({
                    ...s,
                    type: "line" as SeriesType,
                })),
                oscillator: "none",
            });
        } else if (preset === "bollinger") {
            patch({
                indicators: [
                    {
                        id: uid(),
                        type: "bollinger",
                        period: 20,
                        seriesId: primary.id,
                    },
                ],
                series: priceOnly.map((s) => ({
                    ...s,
                    type: "line" as SeriesType,
                })),
                oscillator: "none",
            });
        } else if (preset === "rsi") {
            patch({ oscillator: "rsi", oscillatorSeriesId: primary.id });
        } else if (preset === "macd") {
            patch({ oscillator: "macd", oscillatorSeriesId: primary.id });
        } else if (preset === "rebased") {
            patch({
                rebase: true,
                series: priceOnly.map((s) => ({
                    ...s,
                    type: "line" as SeriesType,
                    axis: "left" as const,
                })),
            });
        }
    };

    const searchItems = searchResult?.data.items ?? [];
    const macroItems = macroResult?.data.items ?? [];
    const priceSeries = series.filter((s) => s.field === "price");
    // Lift the Series card above the chart/oscillator cards below it while the
    // results dropdown is open, so its overflowing rows aren't painted behind
    // those later glass cards (each forms its own backdrop-filter stacking context).
    const searchOpen = isOpen;
    const seriesName = (s: BuilderSeries) =>
        `${s.macro?.title ?? s.symbol}${s.field === "volume" ? ` (${t("research.builder.volume")})` : ""}`;
    const indicatorName = (ind: BuilderIndicator) =>
        ind.type === "bollinger" ? "BB" : ind.type.toUpperCase();
    const activeOptions = [
        logLeft && t("research.builder.logScale"),
        rebaseAll && t("research.builder.rebase"),
    ].filter(Boolean);

    return (
        <PageShell className="">
            <PageHeader
                title={t("research.builder.title")}
                subtitle={t("research.builder.subtitle")}
                icon={PAGE_ICONS["/research/charts"]}
                actions={
                    <>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    aria-label={t("research.builder.menu")}
                                >
                                    <MoreHorizontal />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={requestNewLayout}>
                                    <FilePlus2 className="mr-2 h-4 w-4 text-label-secondary" />
                                    {t("research.builder.newChart")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onSelect={() => void copyShareLink()}
                                >
                                    <Copy className="mr-2 h-4 w-4 text-label-secondary" />
                                    {t("research.builder.copyLink")}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    disabled={!activeLayout}
                                    className="text-destructive focus:text-destructive"
                                    onSelect={deleteLayout}
                                >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    {t("research.builder.deleteSavedLayout")}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Button onClick={() => setSaveDialogOpen(true)}>
                            <Save />
                            {t("research.builder.saveAs")}
                        </Button>
                    </>
                }
            />

            {/* Series builder */}
            <Card className={cn(searchOpen && "relative z-20")}>
                <CardHeader className="pb-4">
                    <CardTitle variant="sm">
                        {t("research.builder.series")}
                    </CardTitle>
                    <CardDescription>
                        {t("research.builder.startHelp")}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {series.length > 0 && (
                        <List>
                            {series.map((s, i) => (
                                <li
                                    key={s.id}
                                    className="flex min-h-11 flex-wrap items-center gap-2 px-4 py-2.5"
                                >
                                    <span
                                        aria-hidden="true"
                                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                                        style={{ background: getChartColor(i) }}
                                    />
                                    {s.macro ? (
                                        <span
                                            className="min-w-[4.5rem] max-w-[18rem] truncate type-body font-medium text-foreground"
                                            title={s.macro.title}
                                        >
                                            {s.macro.title}
                                        </span>
                                    ) : (
                                        <span className="min-w-[4.5rem] font-mono type-body font-medium text-foreground">
                                            {s.symbol}
                                        </span>
                                    )}
                                    {s.field === "volume" ? (
                                        <Badge variant="secondary" size="sm">
                                            {t("research.builder.volume")}
                                        </Badge>
                                    ) : (
                                        <Select
                                            value={s.type}
                                            onValueChange={(v) =>
                                                updateSeries(s.id, {
                                                    type: v as SeriesType,
                                                })
                                            }
                                        >
                                            <SelectTrigger
                                                className="h-8 w-32"
                                                aria-label={`${t("customChart.chartType")}: ${s.macro?.title ?? s.symbol}`}
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="line">
                                                    {t(
                                                        "research.builder.type.line",
                                                    )}
                                                </SelectItem>
                                                <SelectItem value="area">
                                                    {t(
                                                        "research.builder.type.area",
                                                    )}
                                                </SelectItem>
                                                {!s.macro && (
                                                    <SelectItem value="candlestick">
                                                        {t(
                                                            "research.builder.type.candlestick",
                                                        )}
                                                    </SelectItem>
                                                )}
                                            </SelectContent>
                                        </Select>
                                    )}
                                    <Select
                                        value={s.axis}
                                        onValueChange={(v) =>
                                            updateSeries(s.id, {
                                                axis: v as "left" | "right",
                                            })
                                        }
                                    >
                                        <SelectTrigger
                                            className="h-8 w-28"
                                            aria-label={`${t("research.builder.axisLabel")}: ${seriesName(s)}`}
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="left">
                                                {t("research.builder.axisLeft")}
                                            </SelectItem>
                                            <SelectItem value="right">
                                                {t("research.builder.axisRight")}
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                    {s.macro ? (
                                        <Badge
                                            variant="outline"
                                            size="sm"
                                            className="capitalize"
                                        >
                                            {s.macro.provider}
                                        </Badge>
                                    ) : (
                                        <Select
                                            value={s.provider || "auto"}
                                            onValueChange={(v) =>
                                                updateSeries(s.id, {
                                                    provider:
                                                        v === "auto" ? "" : v,
                                                })
                                            }
                                        >
                                            <SelectTrigger
                                                className="h-8 w-36"
                                                aria-label={`${t("research.builder.providerLabel")}: ${seriesName(s)}`}
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {PROVIDERS.map((p) => (
                                                    <SelectItem
                                                        key={p || "auto"}
                                                        value={p || "auto"}
                                                    >
                                                        {p
                                                            ? p.replace(
                                                                  "_",
                                                                  " ",
                                                              )
                                                            : t(
                                                                  "research.builder.providerAuto",
                                                              )}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    )}
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="ml-auto h-8 w-8 text-label-secondary"
                                                aria-label={t(
                                                    "research.builder.seriesMenu",
                                                    { name: seriesName(s) },
                                                )}
                                            >
                                                <MoreHorizontal />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                className="text-destructive focus:text-destructive"
                                                onSelect={() =>
                                                    removeSeries(s.id)
                                                }
                                            >
                                                <Trash2 className="mr-2 h-4 w-4" />
                                                {t(
                                                    "research.builder.removeSeries",
                                                )}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </li>
                            ))}
                        </List>
                    )}

                    {series.length < MAX_SERIES && (
                        <>
                            <SymbolSearchBox
                                className="max-w-2xl"
                                placeholder={t("research.builder.addSeries")}
                                value={searchText}
                                onChange={setSearchText}
                                open={searchOpen}
                                onDismiss={() => setSearchText("")}
                            >
                                {!symbolSearching &&
                                    !macroSearching &&
                                    searchItems.length === 0 &&
                                    macroItems.length === 0 && (
                                        <p
                                            role="status"
                                            className="px-3 py-3 type-callout text-label-secondary"
                                        >
                                            {t(
                                                symbolFailed ||
                                                    macroFailed ||
                                                    searchResult?.meta
                                                        .source ===
                                                        "unavailable"
                                                    ? "research.searchFailed"
                                                    : "research.noResults",
                                            )}
                                        </p>
                                    )}
                                {searchItems.length > 0 &&
                                    macroItems.length > 0 && (
                                        <div className="px-3 pb-1 pt-2 type-caption text-label-tertiary">
                                            {t("research.builder.groupMarkets")}
                                        </div>
                                    )}
                                {searchItems.map((item) => (
                                    <SymbolSearchResultItem
                                        key={`${item.symbol}-${item.exchange}`}
                                        item={item}
                                        onSelect={(it) => addSeries(it.symbol)}
                                        leadingIcon={
                                            <Plus className="h-3.5 w-3.5 shrink-0 text-label-secondary" />
                                        }
                                    />
                                ))}
                                {macroItems.length > 0 && (
                                    <div className="px-3 pb-1 pt-2 type-caption text-label-tertiary">
                                        {t("research.builder.groupEconomic")}
                                    </div>
                                )}
                                {macroItems.map((item) => (
                                    <SymbolSearchResultItem
                                        key={`macro-${item.provider}-${item.seriesId}`}
                                        item={{
                                            symbol: item.region ?? "",
                                            name: item.title,
                                            type: item.source ?? "",
                                            exchange: item.units ?? "",
                                        }}
                                        onSelect={() => addMacroSeries(item)}
                                        leadingIcon={
                                            <Plus className="h-3.5 w-3.5 shrink-0 text-label-secondary" />
                                        }
                                    />
                                ))}
                            </SymbolSearchBox>
                            <details className="type-footnote text-label-secondary">
                                <summary className="cursor-pointer rounded-chip focus-ring">
                                    {t("research.builder.sourceHelp")}
                                </summary>
                                <p className="mt-2 max-w-2xl">
                                    {t("research.builder.economicHint")}
                                </p>
                            </details>
                        </>
                    )}

                    {/* Indicators */}
                    {priceSeries.length > 0 && (
                        <section className="space-y-3 border-t border-border/50 pt-4">
                            <div className="space-y-1">
                                <h3 className="type-headline text-foreground">
                                    {t("research.builder.indicators")}
                                </h3>
                                <p className="type-footnote text-label-secondary">
                                    {t("research.builder.indicatorHelp")}
                                </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {(
                                    [
                                        "sma",
                                        "ema",
                                        "bollinger",
                                    ] as IndicatorType[]
                                ).map((typ) => (
                                    <Button
                                        key={typ}
                                        size="sm"
                                        variant="outline"
                                        disabled={
                                            indicators.length >=
                                            MAX_CHART_INDICATORS
                                        }
                                        onClick={() => addIndicator(typ)}
                                    >
                                        <Plus aria-hidden="true" />
                                        {typ.toUpperCase()}
                                    </Button>
                                ))}
                            </div>
                            {indicators.length > 0 && (
                                <List>
                                    {indicators.map((ind) => {
                                        const name = indicatorName(ind);
                                        return (
                                            <ListRow
                                                key={ind.id}
                                                title={
                                                    <span className="font-mono font-medium">
                                                        {name}
                                                    </span>
                                                }
                                                trailing={
                                                    <>
                                                        <span className="type-footnote">
                                                            {t(
                                                                "research.builder.period",
                                                            )}
                                                        </span>
                                                        <IndicatorPeriodInput
                                                            indicator={name}
                                                            period={ind.period}
                                                            onChange={(e) =>
                                                                updateIndicator(
                                                                    ind.id,
                                                                    {
                                                                        period: Math.max(
                                                                            2,
                                                                            Number(
                                                                                e
                                                                                    .target
                                                                                    .value,
                                                                            ) ||
                                                                                2,
                                                                        ),
                                                                    },
                                                                )
                                                            }
                                                        />
                                                        <DropdownMenu>
                                                            <DropdownMenuTrigger
                                                                asChild
                                                            >
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-8 w-8 text-label-secondary"
                                                                    aria-label={t(
                                                                        "research.builder.indicatorMenu",
                                                                        {
                                                                            indicator: `${name} (${ind.period})`,
                                                                        },
                                                                    )}
                                                                >
                                                                    <MoreHorizontal />
                                                                </Button>
                                                            </DropdownMenuTrigger>
                                                            <DropdownMenuContent align="end">
                                                                <DropdownMenuItem
                                                                    className="text-destructive focus:text-destructive"
                                                                    onSelect={() =>
                                                                        removeIndicator(
                                                                            ind.id,
                                                                        )
                                                                    }
                                                                >
                                                                    <Trash2 className="mr-2 h-4 w-4" />
                                                                    {t(
                                                                        "research.builder.removeIndicator",
                                                                    )}
                                                                </DropdownMenuItem>
                                                            </DropdownMenuContent>
                                                        </DropdownMenu>
                                                    </>
                                                }
                                            />
                                        );
                                    })}
                                </List>
                            )}
                        </section>
                    )}
                </CardContent>
            </Card>

            {/* Layout, range and options */}
            <Card>
                <CardContent variant="headerless" className="space-y-4">
                    <div className="flex flex-wrap items-end gap-4">
                        <div className="min-w-52 space-y-1.5">
                            <Label htmlFor="chart-builder-layout">
                                {t("research.builder.layout")}
                            </Label>
                            <Select
                                value={library.activeLayoutId ?? "__draft__"}
                                onValueChange={(value) =>
                                    setLibrary((previous) => ({
                                        ...previous,
                                        activeLayoutId:
                                            value === "__draft__"
                                                ? null
                                                : value,
                                    }))
                                }
                            >
                                <SelectTrigger id="chart-builder-layout">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="__draft__">
                                        {t("research.builder.unnamedDraft")}
                                    </SelectItem>
                                    {library.layouts.map((layout) => (
                                        <SelectItem
                                            key={layout.id}
                                            value={layout.id}
                                        >
                                            {layout.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <p
                                id="chart-builder-range-label"
                                className="type-body font-medium text-foreground"
                            >
                                {t("research.builder.range")}
                            </p>
                            <ResearchRangeSelector
                                aria-labelledby="chart-builder-range-label"
                                options={RANGES}
                                value={range}
                                onChange={(option) =>
                                    patch({ range: option.range })
                                }
                            />
                        </div>
                        <p
                            role="status"
                            className="self-center type-footnote text-label-secondary sm:ml-auto"
                        >
                            {t(
                                storageFailed
                                    ? "research.builder.storageFailed"
                                    : persistedLibrary === library
                                      ? "research.builder.savedLocally"
                                      : "research.builder.savingLocally",
                            )}
                        </p>
                    </div>
                    <details className="rounded-card corner-continuous border border-border/60">
                        <summary className="cursor-pointer rounded-card px-4 py-3 type-body font-medium text-foreground marker:text-label-tertiary focus-ring">
                            {t("research.builder.options")}
                            {activeOptions.length > 0 && (
                                <span className="ml-2 type-footnote font-normal text-label-secondary">
                                    {activeOptions.join(" · ")}
                                </span>
                            )}
                        </summary>
                        <div className="space-y-4 border-t border-border/50 p-4">
                            <List>
                                <ListRow
                                    title={
                                        <Label htmlFor="log">
                                            {t("research.builder.logScale")}
                                        </Label>
                                    }
                                    trailing={
                                        <Switch
                                            id="log"
                                            checked={logLeft}
                                            onCheckedChange={(v) =>
                                                patch({ logLeft: v })
                                            }
                                        />
                                    }
                                />
                                <ListRow
                                    title={
                                        <Label htmlFor="rebase">
                                            {t("research.builder.rebase")}
                                        </Label>
                                    }
                                    trailing={
                                        <Switch
                                            id="rebase"
                                            checked={rebaseAll}
                                            onCheckedChange={(v) =>
                                                patch({ rebase: v })
                                            }
                                        />
                                    }
                                />
                            </List>
                            <div className="space-y-2">
                                <p className="type-footnote text-label-secondary">
                                    {t("research.builder.presets")}
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    {[
                                        "priceVolume",
                                        "sma",
                                        "bollinger",
                                        "rsi",
                                        "macd",
                                        "rebased",
                                    ].map((p) => (
                                        <Button
                                            key={p}
                                            size="sm"
                                            variant="outline"
                                            disabled={priceSeries.length === 0}
                                            onClick={() => applyPreset(p)}
                                        >
                                            {t(`research.builder.preset.${p}`)}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </details>
                </CardContent>
            </Card>

            {/* Chart */}
            {series.length === 0 ? (
                <Card>
                    <CardContent variant="state">
                        <EmptyState
                            icon={LineChartIcon}
                            title={t("research.builder.emptyTitle")}
                            description={t("research.builder.emptyHint")}
                        />
                    </CardContent>
                </Card>
            ) : (
                <Card>
                    <CardContent variant="headerless">
                        <p className="mb-4 type-callout text-label-secondary">
                            {t("research.builder.chartHelp")}
                        </p>
                        {isLoading ? (
                            <Skeleton
                                {...loadingSurfaceProps}
                                className="h-[400px] w-full"
                            />
                        ) : rows.length > 0 ? (
                            <ComposedChart<Row>
                                data={rows}
                                xAccessor={(d) => new Date(d.time)}
                                xIsDate
                                height={400}
                                logLeft={logLeft}
                                series={composed}
                                xTickFormat={(v) =>
                                    formatDateWithAppSettings(
                                        v as Date,
                                        appSettings.dateFormat,
                                    )
                                }
                                leftTickFormat={(v) =>
                                    rebaseAll
                                        ? v.toFixed(0)
                                        : v.toLocaleString(locale)
                                }
                                rightTickFormat={(v) =>
                                    v.toLocaleString(locale)
                                }
                                tooltipTitle={(d) =>
                                    formatDateWithAppSettings(
                                        new Date(d.time),
                                        appSettings.dateFormat,
                                    )
                                }
                                tooltipValueFormat={(v) =>
                                    v.toLocaleString(locale, {
                                        maximumFractionDigits: 2,
                                    })
                                }
                            />
                        ) : (
                            <div className="flex h-[400px] items-center justify-center type-callout text-label-secondary">
                                {t("market.noChartData")}
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* Oscillator */}
            {series.length > 0 && (
                <Card>
                    <CardHeader className="pb-2">
                        <div className="flex items-center justify-between gap-2">
                            <CardTitle variant="sm">
                                {t("research.builder.oscillator")}
                            </CardTitle>
                            <Select
                                value={oscillator}
                                onValueChange={(v) =>
                                    patch({ oscillator: v as Oscillator })
                                }
                            >
                                <SelectTrigger
                                    className="h-8 w-32"
                                    aria-label={t(
                                        "research.builder.oscillator",
                                    )}
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="none">
                                        {t("research.builder.oscNone")}
                                    </SelectItem>
                                    <SelectItem value="rsi">RSI</SelectItem>
                                    <SelectItem value="macd">MACD</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </CardHeader>
                    {oscillator !== "none" && (
                        <CardContent>
                            {isLoading ? (
                                <Skeleton className="h-[160px] w-full" />
                            ) : oscRows.length > 0 ? (
                                <LineChart<Row>
                                    data={oscRows}
                                    xAccessor={(d) => new Date(d.time)}
                                    xIsDate
                                    height={160}
                                    series={oscSeries}
                                    referenceLines={oscRefs}
                                    yDomain={
                                        oscillator === "rsi"
                                            ? [0, 100]
                                            : undefined
                                    }
                                    xTickFormat={(v) =>
                                        formatDateWithAppSettings(
                                            v as Date,
                                            appSettings.dateFormat,
                                        )
                                    }
                                    yTickFormat={(v) =>
                                        v.toFixed(oscillator === "rsi" ? 0 : 2)
                                    }
                                    tooltipValueFormat={(v) => v.toFixed(2)}
                                />
                            ) : (
                                <div className="flex h-[160px] items-center justify-center type-callout text-label-secondary">
                                    {t("market.noChartData")}
                                </div>
                            )}
                        </CardContent>
                    )}
                </Card>
            )}

            <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {t("research.builder.saveAsTitle")}
                        </DialogTitle>
                        <DialogDescription>
                            {t("research.builder.saveAsDescription")}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        <Label htmlFor="chart-layout-name">
                            {t("research.builder.layoutName")}
                        </Label>
                        <Input
                            id="chart-layout-name"
                            value={layoutName}
                            maxLength={80}
                            autoFocus
                            onChange={(event) =>
                                setLayoutName(event.target.value)
                            }
                            onKeyDown={(event) => {
                                if (event.key === "Enter") saveAsLayout();
                            }}
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setSaveDialogOpen(false)}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button
                            disabled={!layoutName.trim()}
                            onClick={saveAsLayout}
                        >
                            {t("research.builder.saveLayout")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <AlertDialog
                open={confirmAction !== null}
                onOpenChange={(open) => {
                    if (!open) setConfirmAction(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {confirmAction === "share"
                                ? t("research.builder.shareReplaceTitle")
                                : t("research.builder.newTitle")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirmAction === "share"
                                ? t("research.builder.shareReplaceDescription")
                                : t("research.builder.newDescription")}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>
                            {t("common.cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            onClick={
                                confirmAction === "share"
                                    ? applySharedChart
                                    : startNewLayout
                            }
                        >
                            {confirmAction === "share"
                                ? t("research.builder.openShared")
                                : t("research.builder.newChart")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </PageShell>
    );
}
