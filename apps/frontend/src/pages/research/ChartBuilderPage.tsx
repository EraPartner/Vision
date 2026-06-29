import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CandlestickChart, LineChart as LineChartIcon, Plus, Trash2, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateWithAppSettings } from "@/components/shared/dateUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { ComposedChart, LineChart, getChartColor, type ComposedSeries, type LineSeries } from "@/components/charts";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { SymbolSearchResultItem } from "@/components/shared/SymbolSearchResultItem";
import { SymbolSearchBox } from "@/components/shared/SymbolSearchBox";
import { useDebounce, SEARCH_DEBOUNCE_MS } from "@/hooks/useDebounce";
import { apiClient } from "@/lib/api";
import { sma, ema, bollinger, rsi, macd } from "@/lib/research/indicators";
import type { MacroProvider, MacroSeriesItem, ResearchChartPoint, ResearchRange } from "@/types/research";

const RANGES: { label: string; range: ResearchRange }[] = [
  { label: "1M", range: "1mo" },
  { label: "3M", range: "3mo" },
  { label: "6M", range: "6mo" },
  { label: "1Y", range: "1y" },
  { label: "5Y", range: "5y" },
];
const PROVIDERS = ["", "yahoo", "twelve_data", "finnhub", "fmp", "alpha_vantage"];
const MAX_SERIES = 5;
const STORAGE_KEY = "research.chartBuilder.v1";

type SeriesType = "line" | "area" | "candlestick" | "bar";
type Field = "price" | "volume";

interface BuilderSeries {
  id: string;
  symbol: string;
  field: Field;
  type: SeriesType;
  axis: "left" | "right";
  provider: string;
  /** Set when this is a macroeconomic series (ADR-082); provider-pinned, fetched via getMacroSeries. */
  macro?: { provider: MacroProvider; seriesId: string; title: string };
}

/** Stable fetch/cache key for a series — distinct (symbol,provider) for tickers, (provider,seriesId) for macro. */
function seriesKey(s: Pick<BuilderSeries, "symbol" | "provider" | "macro">): string {
  return s.macro ? `m|${s.macro.provider}|${s.macro.seriesId}` : `c|${s.symbol}|${s.provider}`;
}

/** Display label for a series (macro uses its title; tickers use the symbol). */
function seriesLabel(s: BuilderSeries): string {
  return s.macro ? s.macro.title : s.symbol;
}

type IndicatorType = "sma" | "ema" | "bollinger";
interface BuilderIndicator {
  id: string;
  type: IndicatorType;
  period: number;
  seriesId: string;
}
type Oscillator = "none" | "rsi" | "macd";

interface BuilderState {
  range: ResearchRange;
  logLeft: boolean;
  rebase: boolean;
  series: BuilderSeries[];
  indicators: BuilderIndicator[];
  oscillator: Oscillator;
  oscillatorSeriesId: string | null;
}

const DEFAULT_STATE: BuilderState = {
  range: "1y",
  logLeft: false,
  rebase: false,
  series: [],
  indicators: [],
  oscillator: "none",
  oscillatorSeriesId: null,
};

type Row = { time: number } & Record<string, number | null>;

function loadState(): BuilderState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_STATE;
}

export default function ChartBuilderPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);

  const idRef = useRef(1);
  const uid = () => `s${idRef.current++}`;

  const [state, setState] = useState<BuilderState>(loadState);
  const { range, logLeft, rebase: rebaseAll, series, indicators, oscillator, oscillatorSeriesId } = state;
  const patch = (p: Partial<BuilderState>) => setState((s) => ({ ...s, ...p }));

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }, [state]);

  // Symbol search picker.
  const [searchText, setSearchText] = useState("");
  const debouncedSearch = useDebounce(searchText.trim(), SEARCH_DEBOUNCE_MS);
  const { data: searchResult } = useQuery({
    queryKey: ["research-search", debouncedSearch],
    queryFn: () => apiClient.searchResearch(debouncedSearch),
    enabled: debouncedSearch.length >= 1,
    staleTime: 60_000,
  });
  // Macro search runs alongside the ticker search; results merge into one
  // dropdown, tagged "Economic" (ADR-082). Keyless providers always respond;
  // FRED contributes only when its key is configured.
  const { data: macroResult } = useQuery({
    queryKey: ["macro-search", debouncedSearch],
    queryFn: () => apiClient.searchMacro(debouncedSearch),
    enabled: debouncedSearch.length >= 1,
    staleTime: 60_000,
  });

  const addSeries = (symbol: string) => {
    const s = symbol.toUpperCase();
    setState((prev) => {
      if (prev.series.length >= MAX_SERIES) return prev;
      const id = uid();
      const next = [...prev.series, { id, symbol: s, field: "price" as Field, type: "line" as SeriesType, axis: "left" as const, provider: "" }];
      return { ...prev, series: next, oscillatorSeriesId: prev.oscillatorSeriesId ?? id };
    });
    setSearchText("");
  };

  const addMacroSeries = (item: MacroSeriesItem) => {
    setState((prev) => {
      if (prev.series.length >= MAX_SERIES) return prev;
      const id = uid();
      const next: BuilderSeries[] = [...prev.series, {
        id,
        symbol: item.seriesId,
        field: "price",
        type: "line",
        axis: "left",
        provider: item.provider,
        macro: { provider: item.provider, seriesId: item.seriesId, title: item.title },
      }];
      return { ...prev, series: next, oscillatorSeriesId: prev.oscillatorSeriesId ?? id };
    });
    setSearchText("");
  };
  const updateSeries = (id: string, p: Partial<BuilderSeries>) =>
    patch({ series: series.map((s) => (s.id === id ? { ...s, ...p } : s)) });
  const removeSeries = (id: string) =>
    patch({
      series: series.filter((s) => s.id !== id),
      indicators: indicators.filter((i) => i.seriesId !== id),
      oscillatorSeriesId: oscillatorSeriesId === id ? null : oscillatorSeriesId,
    });

  const addIndicator = (type: IndicatorType) => {
    const base = series.find((s) => s.field === "price");
    if (!base) return;
    patch({ indicators: [...indicators, { id: uid(), type, period: type === "bollinger" ? 20 : type === "ema" ? 12 : 50, seriesId: base.id }] });
  };
  const updateIndicator = (id: string, p: Partial<BuilderIndicator>) =>
    patch({ indicators: indicators.map((i) => (i.id === id ? { ...i, ...p } : i)) });
  const removeIndicator = (id: string) => patch({ indicators: indicators.filter((i) => i.id !== id) });

  // ── Fetch chart data per distinct series key (ticker or macro) ──
  const fetchKeys = useMemo(() => {
    const seen = new Set<string>();
    const keys: { key: string; symbol: string; provider: string; macro?: BuilderSeries["macro"] }[] = [];
    for (const s of series) {
      const key = seriesKey(s);
      if (!seen.has(key)) { seen.add(key); keys.push({ key, symbol: s.symbol, provider: s.provider, macro: s.macro }); }
    }
    return keys;
  }, [series]);

  const chartQueries = useQueries({
    queries: fetchKeys.map((fk) => ({
      queryKey: ["research-chart", fk.key, range],
      queryFn: () => (fk.macro
        ? apiClient.getMacroSeries(fk.macro.provider, fk.macro.seriesId, range)
        : apiClient.getResearchChart(fk.symbol, range, undefined, fk.provider || undefined)),
      enabled: fk.macro ? true : !!fk.symbol,
      staleTime: 60_000,
    })),
  });

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
    for (const s of series) pointsBySeries.set(s.id, pointsByKey.get(seriesKey(s)) ?? []);

    // Per-series rebase factor (close-based), applied to price values & OHLC.
    const factor = new Map<string, number>();
    for (const s of series) {
      const pts = pointsBySeries.get(s.id) ?? [];
      const firstClose = pts.find((p) => Number.isFinite(p.close) && p.close > 0)?.close;
      factor.set(s.id, rebaseAll && firstClose ? 100 / firstClose : 1);
    }

    const timeSet = new Set<number>();
    for (const pts of pointsBySeries.values()) for (const p of pts) timeSet.add(p.time);
    const times = Array.from(timeSet).sort((a, b) => a - b);

    const byTime = new Map<string, Map<number, ResearchChartPoint>>();
    for (const s of series) byTime.set(s.id, new Map((pointsBySeries.get(s.id) ?? []).map((p) => [p.time, p])));

    const rows: Row[] = times.map((time) => {
      const row: Row = { time };
      for (const s of series) {
        const p = byTime.get(s.id)!.get(time);
        const f = factor.get(s.id)!;
        if (s.field === "volume") {
          row[`${s.id}`] = p ? p.volume : null;
        } else {
          row[`${s.id}`] = p && Number.isFinite(p.close) ? p.close * f : null;
          row[`${s.id}_o`] = p && Number.isFinite(p.close) ? p.close * f : null; // open ~ prev close fallback
          row[`${s.id}_h`] = p && Number.isFinite(p.high) ? p.high * f : null;
          row[`${s.id}_l`] = p && Number.isFinite(p.low) ? p.low * f : null;
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
      const closes = pts.map((p) => (Number.isFinite(p.close) ? p.close * f : NaN));
      const assign = (key: string, values: (number | null)[]) => {
        const m = new Map<number, number | null>();
        pts.forEach((p, i) => m.set(p.time, values[i] ?? null));
        for (const row of rows) row[key] = m.get(row.time) ?? null;
      };
      if (ind.type === "sma") assign(ind.id, sma(closes, ind.period));
      else if (ind.type === "ema") assign(ind.id, ema(closes, ind.period));
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
          key: s.id, label: seriesLabel(s), type: "candlestick", axis: s.axis,
          open: (d) => d[`${s.id}_o`], high: (d) => d[`${s.id}_h`], low: (d) => d[`${s.id}_l`], close: (d) => d[`${s.id}`],
        });
      } else {
        composed.push({
          key: s.id,
          label: s.field === "volume" ? `${seriesLabel(s)} ${t("research.builder.volume")}` : seriesLabel(s),
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
      const labelBase = ind.type === "bollinger" ? `BB(${ind.period})` : `${ind.type.toUpperCase()}(${ind.period})`;
      composed.push({ key: ind.id, label: labelBase, type: "line", axis: "left", color, strokeWidth: 1.5, accessor: (d) => d[ind.id] });
      if (ind.type === "bollinger") {
        composed.push({ key: `${ind.id}_u`, label: `${labelBase} ↑`, type: "line", axis: "left", color, strokeWidth: 1, dashed: true, accessor: (d) => d[`${ind.id}_u`] });
        composed.push({ key: `${ind.id}_l`, label: `${labelBase} ↓`, type: "line", axis: "left", color, strokeWidth: 1, dashed: true, accessor: (d) => d[`${ind.id}_l`] });
      }
    });

    return { rows, composed };
  }, [series, indicators, pointsByKey, rebaseAll, t]);

  // ── Oscillator panel (RSI / MACD) computed on the chosen source series ──
  const { oscRows, oscSeries, oscRefs } = useMemo(() => {
    const srcId = oscillatorSeriesId ?? series[0]?.id;
    const src = series.find((s) => s.id === srcId);
    if (oscillator === "none" || !src) return { oscRows: [] as Row[], oscSeries: [] as LineSeries<Row>[], oscRefs: [] };
    const pts = (pointsByKey.get(seriesKey(src)) ?? []);
    const closes = pts.map((p) => p.close);
    const oscRows: Row[] = pts.map((p) => ({ time: p.time }));
    if (oscillator === "rsi") {
      const r = rsi(closes, 14);
      oscRows.forEach((row, i) => { row.rsi = r[i] ?? null; });
      return {
        oscRows,
        oscSeries: [{ key: "rsi", label: "RSI(14)", accessor: (d: Row) => d.rsi, color: "hsl(var(--primary))", strokeWidth: 1.5 }],
        oscRefs: [{ y: 70, label: "70", dashed: true }, { y: 30, label: "30", dashed: true }],
      };
    }
    const m = macd(closes);
    oscRows.forEach((row, i) => { row.macd = m.macd[i] ?? null; row.signal = m.signal[i] ?? null; row.hist = m.histogram[i] ?? null; });
    return {
      oscRows,
      oscSeries: [
        { key: "macd", label: "MACD", accessor: (d: Row) => d.macd, color: "hsl(var(--primary))", strokeWidth: 1.5 },
        { key: "signal", label: "Signal", accessor: (d: Row) => d.signal, color: "hsl(var(--accent))", strokeWidth: 1.5, dashed: true },
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
      const volume: BuilderSeries = { id: uid(), symbol: volBase.symbol, field: "volume", type: "bar", axis: "right", provider: volBase.provider };
      patch({ series: [...priceOnly.map((s) => ({ ...s, type: "line" as SeriesType })), volume], indicators: [], oscillator: "none" });
    } else if (preset === "sma") {
      patch({
        indicators: [
          { id: uid(), type: "sma", period: 50, seriesId: primary.id },
          { id: uid(), type: "sma", period: 200, seriesId: primary.id },
        ],
        series: priceOnly.map((s) => ({ ...s, type: "line" as SeriesType })),
        oscillator: "none",
      });
    } else if (preset === "bollinger") {
      patch({ indicators: [{ id: uid(), type: "bollinger", period: 20, seriesId: primary.id }], series: priceOnly.map((s) => ({ ...s, type: "line" as SeriesType })), oscillator: "none" });
    } else if (preset === "rsi") {
      patch({ oscillator: "rsi", oscillatorSeriesId: primary.id });
    } else if (preset === "macd") {
      patch({ oscillator: "macd", oscillatorSeriesId: primary.id });
    } else if (preset === "rebased") {
      patch({ rebase: true, series: priceOnly.map((s) => ({ ...s, type: "line" as SeriesType, axis: "left" as const })) });
    }
  };

  const searchItems = searchResult?.data.items ?? [];
  const macroItems = macroResult?.data.items ?? [];
  const priceSeries = series.filter((s) => s.field === "price");
  // Lift the Series card above the chart/oscillator cards below it while the
  // results dropdown is open, so its overflowing rows aren't painted behind
  // those later glass cards (each forms its own backdrop-filter stacking context).
  const searchOpen = debouncedSearch.length >= 1 && searchText.length > 0 && (searchItems.length > 0 || macroItems.length > 0);

  return (
    <div className="space-y-6 animate-in">
      <PageHeader title={t("research.builder.title")} subtitle={t("research.builder.subtitle")} icon={CandlestickChart} />

      {/* Toolbar */}
      <Card className="glass-regular">
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("research.builder.range")}</Label>
            <div className="flex gap-1">
              {RANGES.map((r) => (
                <Button key={r.label} size="sm" variant={range === r.range ? "default" : "ghost"} className="h-8 px-2.5 text-xs" onClick={() => patch({ range: r.range })}>
                  {r.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="log" checked={logLeft} onCheckedChange={(v) => patch({ logLeft: v })} />
            <Label htmlFor="log" className="text-xs">{t("research.builder.logScale")}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="rebase" checked={rebaseAll} onCheckedChange={(v) => patch({ rebase: v })} />
            <Label htmlFor="rebase" className="text-xs">{t("research.builder.rebase")}</Label>
          </div>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <span className="self-center text-xs text-muted-foreground">{t("research.builder.presets")}:</span>
            {["priceVolume", "sma", "bollinger", "rsi", "macd", "rebased"].map((p) => (
              <Button key={p} size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={priceSeries.length === 0} onClick={() => applyPreset(p)}>
                {t(`research.builder.preset.${p}`)}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Series builder */}
      <Card className={`glass-regular ${searchOpen ? "relative z-20" : ""}`}>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t("research.builder.series")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {series.map((s, i) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 p-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: getChartColor(i) }} />
              {s.macro ? (
                <span className="min-w-[4.5rem] max-w-[18rem] truncate text-sm font-medium" title={s.macro.title}>{s.macro.title}</span>
              ) : (
                <span className="min-w-[4.5rem] font-mono font-semibold">{s.symbol}</span>
              )}
              {s.field === "volume" ? (
                <Badge variant="secondary" className="text-xs">{t("research.builder.volume")}</Badge>
              ) : (
                <Select value={s.type} onValueChange={(v) => updateSeries(s.id, { type: v as SeriesType })}>
                  <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="line">{t("research.builder.type.line")}</SelectItem>
                    <SelectItem value="area">{t("research.builder.type.area")}</SelectItem>
                    {!s.macro && <SelectItem value="candlestick">{t("research.builder.type.candlestick")}</SelectItem>}
                  </SelectContent>
                </Select>
              )}
              <Select value={s.axis} onValueChange={(v) => updateSeries(s.id, { axis: v as "left" | "right" })}>
                <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="left">{t("research.builder.axisLeft")}</SelectItem>
                  <SelectItem value="right">{t("research.builder.axisRight")}</SelectItem>
                </SelectContent>
              </Select>
              {s.macro ? (
                <Badge variant="outline" className="h-8 px-2.5 text-xs capitalize">{s.macro.provider}</Badge>
              ) : (
                <Select value={s.provider || "auto"} onValueChange={(v) => updateSeries(s.id, { provider: v === "auto" ? "" : v })}>
                  <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p || "auto"} value={p || "auto"}>
                        {p ? p.replace("_", " ") : t("research.builder.providerAuto")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button size="icon" variant="ghost" className="ml-auto h-8 w-8" onClick={() => removeSeries(s.id)} aria-label={t("research.builder.removeSeries")}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}

          {series.length < MAX_SERIES && (
            <>
            <SymbolSearchBox
              className="max-w-2xl"
              placeholder={t("research.builder.addSeries")}
              value={searchText}
              onChange={setSearchText}
              open={searchOpen}
            >
              {searchItems.length > 0 && macroItems.length > 0 && (
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("research.builder.groupMarkets")}
                </div>
              )}
              {searchItems.map((item) => (
                <SymbolSearchResultItem
                  key={`${item.symbol}-${item.exchange}`}
                  item={item}
                  onSelect={(it) => addSeries(it.symbol)}
                  leadingIcon={<Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                />
              ))}
              {macroItems.length > 0 && (
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("research.builder.groupEconomic")}
                </div>
              )}
              {macroItems.map((item) => (
                <SymbolSearchResultItem
                  key={`macro-${item.provider}-${item.seriesId}`}
                  item={{ symbol: item.region ?? "", name: item.title, type: item.source ?? "", exchange: item.units ?? "" }}
                  onSelect={() => addMacroSeries(item)}
                  leadingIcon={<Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                />
              ))}
            </SymbolSearchBox>
            <p className="px-1 text-[11px] text-muted-foreground">{t("research.builder.economicHint")}</p>
            </>
          )}

          {/* Indicators */}
          {priceSeries.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
              <span className="text-xs text-muted-foreground">{t("research.builder.indicators")}:</span>
              {(["sma", "ema", "bollinger"] as IndicatorType[]).map((typ) => (
                <Button key={typ} size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => addIndicator(typ)}>
                  <Plus className="mr-1 h-3 w-3" />{typ.toUpperCase()}
                </Button>
              ))}
              {indicators.map((ind) => (
                <Badge key={ind.id} variant="secondary" className="gap-1.5 py-1">
                  <span>{ind.type === "bollinger" ? `BB` : ind.type.toUpperCase()}</span>
                  <input
                    type="number"
                    value={ind.period}
                    min={2}
                    onChange={(e) => updateIndicator(ind.id, { period: Math.max(2, Number(e.target.value) || 2) })}
                    className="w-12 bg-transparent text-center tabular-nums outline-none"
                  />
                  <button onClick={() => removeIndicator(ind.id)} aria-label={t("research.builder.removeIndicator")}>
                    <X className="h-3 w-3 hover:text-destructive" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Chart */}
      {series.length === 0 ? (
        <EmptyState icon={LineChartIcon} title={t("research.builder.emptyTitle")} description={t("research.builder.emptyHint")} />
      ) : (
        <Card className="glass-regular">
          <CardContent className="pt-6">
            {isLoading ? (
              <Skeleton className="h-[400px] w-full rounded-lg" />
            ) : rows.length > 0 ? (
              <ComposedChart<Row>
                data={rows}
                xAccessor={(d) => new Date(d.time)}
                xIsDate
                height={400}
                logLeft={logLeft}
                series={composed}
                xTickFormat={(v) => formatDateWithAppSettings(v as Date, appSettings.dateFormat)}
                leftTickFormat={(v) => (rebaseAll ? v.toFixed(0) : v.toLocaleString(locale))}
                rightTickFormat={(v) => v.toLocaleString(locale)}
                tooltipTitle={(d) => formatDateWithAppSettings(new Date(d.time), appSettings.dateFormat)}
                tooltipValueFormat={(v) => v.toLocaleString(locale, { maximumFractionDigits: 2 })}
              />
            ) : (
              <div className="flex h-[400px] items-center justify-center text-sm text-muted-foreground">{t("market.noChartData")}</div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Oscillator */}
      {series.length > 0 && (
        <Card className="glass-regular">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{t("research.builder.oscillator")}</CardTitle>
              <Select value={oscillator} onValueChange={(v) => patch({ oscillator: v as Oscillator })}>
                <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("research.builder.oscNone")}</SelectItem>
                  <SelectItem value="rsi">RSI</SelectItem>
                  <SelectItem value="macd">MACD</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          {oscillator !== "none" && (
            <CardContent>
              {oscRows.length > 0 ? (
                <LineChart<Row>
                  data={oscRows}
                  xAccessor={(d) => new Date(d.time)}
                  xIsDate
                  height={160}
                  series={oscSeries}
                  referenceLines={oscRefs}
                  yDomain={oscillator === "rsi" ? [0, 100] : undefined}
                  xTickFormat={(v) => formatDateWithAppSettings(v as Date, appSettings.dateFormat)}
                  yTickFormat={(v) => v.toFixed(oscillator === "rsi" ? 0 : 2)}
                  tooltipValueFormat={(v) => v.toFixed(2)}
                />
              ) : (
                <Skeleton className="h-[160px] w-full rounded-lg" />
              )}
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}
