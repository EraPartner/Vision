import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { useQueries } from "@tanstack/react-query";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatPercent, numberFormatToLocale } from "@/utils/currency";
import { formatCompactNumber } from "@/utils/formatCompactNumber";
import { formatDateWithAppSettings, formatDateTimeWithAppSettings } from "@/components/shared/dateUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SegmentedButtons } from "@/components/shared/SegmentedButtons";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ArrowDown, ArrowUp, GitCompareArrows, Plus, X } from "lucide-react";
import { LineChart, getChartColor, type LineSeries } from "@/components/charts";
import { useSymbolSearch } from "@/hooks/useSymbolSearch";
import { cn } from "@/lib/utils";
import { apiClient } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { ProvenanceBadge } from "@/features/research/ProvenanceBadge";
import { ScorecardGradeBadge } from "@/features/research/ResearchScorecard";
import { SymbolSearchResultItem } from "@/components/shared/SymbolSearchResultItem";
import { SymbolSearchBox } from "@/components/shared/SymbolSearchBox";
import type {
  ResearchChartPoint, ResearchFundamentals, ResearchMeta, ResearchScorecard,
  ScorecardSeverity,
} from "@/types/research";
import { RESEARCH_RANGES as RANGES } from "@/lib/research/ranges";
import { useTabParam } from "@/hooks/useTabParam";

const COMPARE_TABS = ["performance", "fundamentals"] as const;

const MAX_SYMBOLS = 6;

interface SymbolStats {
  symbol: string;
  totalReturn: number | null;
  volatility: number | null;
  maxDrawdown: number | null;
}

/** A symbol's daily log returns keyed by the closing timestamp, for correlation alignment. */
interface ReturnSeries {
  symbol: string;
  byTime: Map<number, number>;
}

/** Daily log returns keyed by the point's timestamp (paired close → return at the later time). */
function dailyReturnsByTime(points: ResearchChartPoint[]): Map<number, number> {
  const valid = points
    .filter((p) => Number.isFinite(p.close) && p.close > 0 && Number.isFinite(p.time))
    .sort((a, b) => a.time - b.time);
  const out = new Map<number, number>();
  for (let i = 1; i < valid.length; i++) {
    out.set(valid[i].time, Math.log(valid[i].close / valid[i - 1].close));
  }
  return out;
}

/** Annualized stdev of daily log returns (approximate, 252 trading days). */
function computeStats(symbol: string, points: ResearchChartPoint[]): SymbolStats {
  const closes = points.map((p) => p.close).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 2) return { symbol, totalReturn: null, volatility: null, maxDrawdown: null };

  const totalReturn = (closes[closes.length - 1] - closes[0]) / closes[0];

  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const volatility = Math.sqrt(variance) * Math.sqrt(252);

  let peak = closes[0];
  let maxDrawdown = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  return { symbol, totalReturn, volatility, maxDrawdown };
}

/**
 * Pearson correlation of two return series, aligned on shared timestamps.
 *
 * Returns are keyed by their closing timestamp, so two symbols are paired only on
 * dates where both traded (intersection of the maps). This is more correct than
 * index-alignment: a holiday/half-day that one exchange observes but the other
 * does not would otherwise shift every later return by one and corrupt the result.
 * Needs ≥ 2 overlapping points and non-zero variance on both sides, else null.
 */
function pearsonOnTime(a: Map<number, number>, b: Map<number, number>): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [time, av] of a) {
    const bv = b.get(time);
    if (bv !== undefined) { xs.push(av); ys.push(bv); }
  }
  const n = xs.length;
  if (n < 2) return null;

  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

/** Diverging green (+1) → muted (0) → red (-1) background for a correlation cell. */
function correlationCellStyle(value: number | null): CSSProperties {
  if (value == null) return {};
  const v = Math.max(-1, Math.min(1, value));
  // Positive → green hue 145, negative → red hue 0; alpha scales with magnitude.
  const hue = v >= 0 ? 145 : 0;
  const alpha = Math.abs(v) * 0.32;
  return { backgroundColor: `hsl(${hue} 70% 45% / ${alpha})` };
}

/** Metrics shown side-by-side in the fundamentals comparison. */
type FundamentalsMetricKey =
  | "pe" | "forwardPE" | "marketCap" | "dividendYield" | "eps"
  | "beta" | "priceToBook" | "profitMargin" | "returnOnEquity" | "revenue"
  | "debtToEquity" | "currentRatio" | "revenueGrowth" | "fcfYield";

interface FundamentalsMetric {
  key: FundamentalsMetricKey;
  labelKey: string;
  format: "ratio" | "largeNum" | "pct";
  /** Sort direction when this column is chosen — most "favourable" first. */
  betterWhenHigher: boolean;
}

/**
 * Per-cell health tint for the fundamentals table. Reuses the scorecard's
 * severity verdicts — the same popular-standard thresholds (current ratio < 1,
 * negative margins, D/E, P/E, etc.) that drive the Health grade — so the
 * colours stay consistent with the scorecard. Good → green, caution/warn →
 * amber, risk → red. Metrics the scorecard doesn't grade (market cap, revenue,
 * forward P/E, EPS, beta) carry no flag and stay neutral.
 */
const SEVERITY_TEXT: Record<ScorecardSeverity, string> = {
  ok: "text-success",
  caution: "text-warning",
  warn: "text-warning",
  risk: "text-destructive",
};

const FUNDAMENTALS_METRICS: FundamentalsMetric[] = [
  { key: "pe", labelKey: "market.pe", format: "ratio", betterWhenHigher: false },
  { key: "forwardPE", labelKey: "market.forwardPE", format: "ratio", betterWhenHigher: false },
  { key: "marketCap", labelKey: "market.marketCap", format: "largeNum", betterWhenHigher: true },
  { key: "dividendYield", labelKey: "market.divYield", format: "pct", betterWhenHigher: true },
  { key: "eps", labelKey: "market.eps", format: "ratio", betterWhenHigher: true },
  { key: "beta", labelKey: "market.beta", format: "ratio", betterWhenHigher: false },
  { key: "priceToBook", labelKey: "market.priceBook", format: "ratio", betterWhenHigher: false },
  { key: "profitMargin", labelKey: "research.fundamentals.profitMargin", format: "pct", betterWhenHigher: true },
  { key: "returnOnEquity", labelKey: "research.fundamentals.roe", format: "pct", betterWhenHigher: true },
  { key: "revenue", labelKey: "research.fundamentals.revenue", format: "largeNum", betterWhenHigher: true },
  { key: "debtToEquity", labelKey: "research.metric.debtToEquity", format: "ratio", betterWhenHigher: false },
  { key: "currentRatio", labelKey: "research.metric.currentRatio", format: "ratio", betterWhenHigher: true },
  { key: "revenueGrowth", labelKey: "research.metric.revenueGrowth", format: "pct", betterWhenHigher: true },
  { key: "fcfYield", labelKey: "research.metric.fcfYield", format: "pct", betterWhenHigher: true },
];


/** Rebase each series' closes to start at 100 so different price levels overlay. */
function rebaseTo100(points: ResearchChartPoint[]): { time: number; value: number }[] {
  const valid = points.filter((p) => Number.isFinite(p.close) && p.close > 0);
  if (valid.length === 0) return [];
  const base = valid[0].close;
  return valid.map((p) => ({ time: p.time, value: (p.close / base) * 100 }));
}

export default function ResearchComparePage() {
  const { t } = useLanguage();
  const loadingSurfaceProps = useLoadingSurfaceProps();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useTabParam(COMPARE_TABS, "performance");
  const [selectedRange, setSelectedRange] = useState(RANGES[3]); // 1Y
  const [sortMetric, setSortMetric] = useState<FundamentalsMetricKey | null>(null);
  const { searchText, setSearchText, searchResult, isFetching: isSearching, isOpen } = useSymbolSearch(
    apiClient.searchResearch,
    { queryKey: "research-search" },
  );

  const fmtPct = useCallback((val: number | null | undefined) =>
    val == null || isNaN(val) ? "—" : formatPercent(val * 100, { digits: 2, signed: true }), []);
  const fmtRatio = useCallback((val: number | null | undefined) =>
    val == null || isNaN(val) ? "—" : val.toFixed(2), []);

  const searchItems = searchResult?.data.items ?? [];

  const addSymbol = (symbol: string) => {
    const s = symbol.toUpperCase();
    setSymbols((prev) => (prev.includes(s) || prev.length >= MAX_SYMBOLS ? prev : [...prev, s]));
    setSearchText("");
  };
  const removeSymbol = (symbol: string) =>
    setSymbols((prev) => prev.filter((s) => s !== symbol));

  const chartQueries = useQueries({
    queries: symbols.map((symbol) => ({
      queryKey: ["research-chart", symbol, selectedRange.range],
      queryFn: () => apiClient.getResearchChart(symbol, selectedRange.range),
      enabled: !!symbol,
      staleTime: 60_000,
    })),
  });

  const fundamentalsQueries = useQueries({
    queries: symbols.map((symbol) => ({
      queryKey: ["research-scorecard", symbol],
      queryFn: () => apiClient.getResearchScorecard(symbol),
      enabled: !!symbol,
      staleTime: 24 * 60 * 60 * 1000,
    })),
  });

  const isLoading = chartQueries.some((q) => q.isFetching && !q.data);

  // Build the rebased overlay, per-symbol stats, and time-aligned return series.
  const { chartData, series, statsRows, correlation } = useMemo(() => {
    const perSymbol = symbols.map((symbol, i) => {
      const points = chartQueries[i]?.data?.data.points ?? [];
      return {
        symbol,
        rebased: rebaseTo100(points),
        stats: computeStats(symbol, points),
        returns: dailyReturnsByTime(points),
      };
    });

    const timeSet = new Set<number>();
    for (const s of perSymbol) for (const p of s.rebased) timeSet.add(p.time);
    const times = Array.from(timeSet).sort((a, b) => a - b);

    const lookup = perSymbol.map((s) => new Map(s.rebased.map((p) => [p.time, p.value])));
    const data = times.map((time) => {
      const row: Record<string, number | null> & { time: number } = { time };
      perSymbol.forEach((s, i) => { row[s.symbol] = lookup[i].get(time) ?? null; });
      return row;
    });

    const lineSeries: LineSeries<typeof data[number]>[] = perSymbol.map((s, i) => ({
      key: s.symbol,
      label: s.symbol,
      accessor: (d) => d[s.symbol] as number | null,
      color: getChartColor(i),
      connectNulls: true,
      strokeWidth: 2,
    }));

    // Pairwise Pearson correlation matrix (symmetric, 1.0 on the diagonal).
    const returnSeries: ReturnSeries[] = perSymbol.map((s) => ({ symbol: s.symbol, byTime: s.returns }));
    const matrix: (number | null)[][] = returnSeries.map((a, i) =>
      returnSeries.map((b, j) => (i === j ? 1 : pearsonOnTime(a.byTime, b.byTime))),
    );

    return {
      chartData: data,
      series: lineSeries,
      statsRows: perSymbol.map((s, i) => ({ ...s.stats, color: getChartColor(i) })),
      correlation: { symbols: returnSeries.map((r) => r.symbol), matrix },
    };
  }, [symbols, chartQueries]);

  // Fundamentals comparison rows (one per selected symbol), sortable by a metric.
  const fundamentalsRows = useMemo(() => {
    const rows = symbols.map((symbol, i) => {
      const q = fundamentalsQueries[i];
      const meta: ResearchMeta | undefined = q?.data?.meta;
      const payload = q?.data?.data ?? null;
      const data: ResearchFundamentals | null = payload?.fundamentals ?? null;
      const scorecard: ResearchScorecard | null = payload?.scorecard ?? null;
      return {
        symbol,
        color: getChartColor(i),
        meta,
        data,
        scorecard,
        unavailable: meta?.source === "unavailable",
        loading: !!q?.isFetching && !q?.data,
      };
    });
    if (!sortMetric) return rows;
    const metric = FUNDAMENTALS_METRICS.find((m) => m.key === sortMetric);
    if (!metric) return rows;
    const dir = metric.betterWhenHigher ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = a.data?.[sortMetric];
      const bv = b.data?.[sortMetric];
      const an = av == null || isNaN(av);
      const bn = bv == null || isNaN(bv);
      if (an && bn) return 0;
      if (an) return 1; // missing always sorts last
      if (bn) return -1;
      return (av! - bv!) * dir;
    });
  }, [symbols, fundamentalsQueries, sortMetric]);

  const fundamentalsLoading = fundamentalsQueries.some((q) => q.isFetching && !q.data);

  const fmtMetric = useCallback((metric: FundamentalsMetric, val: number | null | undefined) => {
    if (metric.format === "largeNum") return formatCompactNumber(val);
    if (metric.format === "pct") return val == null || isNaN(val) ? "—" : formatPercent(val * 100, { digits: 2 });
    return fmtRatio(val);
  }, [fmtRatio]);

  const toggleSort = (key: FundamentalsMetricKey) =>
    setSortMetric((prev) => (prev === key ? null : key));

  return (
    <div className="space-y-6">
      <PageHeader title={t('research.compare.title')} subtitle={t('research.compare.subtitle')} icon={GitCompareArrows} />

      {/* Symbol picker */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {symbols.map((s, i) => (
            <Badge key={s} variant="secondary" className="gap-1.5 py-1 pl-2.5 pr-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: getChartColor(i) }} />
              <span className="font-mono">{s}</span>
              <button onClick={() => removeSymbol(s)} aria-label={t('research.compare.removeSymbol', { symbol: s })}>
                <X className="h-3 w-3 hover:text-destructive" />
              </button>
            </Badge>
          ))}
          {symbols.length === 0 && (
            <span className="text-sm text-muted-foreground">{t('research.compare.empty')}</span>
          )}
        </div>

        {symbols.length < MAX_SYMBOLS && (
          <SymbolSearchBox
            className="max-w-2xl"
            placeholder={t('research.compare.addPlaceholder')}
            value={searchText}
            onChange={setSearchText}
            loading={isSearching && searchText.length > 0}
            open={isOpen && searchItems.length > 0}
          >
            {searchItems.map((item) => (
              <SymbolSearchResultItem
                key={`${item.symbol}-${item.exchange}`}
                item={item}
                onSelect={(it) => addSymbol(it.symbol)}
                leadingIcon={<Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              />
            ))}
          </SymbolSearchBox>
        )}
      </div>

      {symbols.length === 0 ? (
        <EmptyState icon={GitCompareArrows} title={t('research.compare.startTitle')} description={t('research.compare.startHint')} />
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="performance">{t('research.compare.tabPerformance')}</TabsTrigger>
            <TabsTrigger value="fundamentals">{t('research.compare.tabFundamentals')}</TabsTrigger>
          </TabsList>

          <TabsContent value="performance" className="space-y-6 pt-4">
            {/* Rebased overlay chart */}
            <Card className="glass-regular">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <CardTitle className="text-base">{t('research.compare.rebased')}</CardTitle>
                  <SegmentedButtons
                    options={RANGES}
                    getKey={(r) => r.label}
                    getLabel={(r) => r.label}
                    isSelected={(r) => selectedRange.range === r.range}
                    onSelect={setSelectedRange}
                    buttonClassName="h-7 px-2.5 text-xs"
                  />
                </div>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton {...loadingSurfaceProps} className="h-[340px] w-full rounded-lg" />
                ) : chartData.length > 0 ? (
                  <LineChart
                    data={chartData}
                    xAccessor={(d) => new Date(d.time)}
                    xIsDate
                    height={340}
                    series={series}
                    referenceLines={[{ y: 100, label: "100", dashed: true }]}
                    xTickFormat={(v) => formatDateWithAppSettings(v as Date, appSettings.dateFormat)}
                    yTickFormat={(v) => v.toFixed(0)}
                    tooltipTitle={(d) => formatDateTimeWithAppSettings(new Date(d.time), appSettings.dateFormat, locale)}
                    tooltipValueFormat={(v) => v.toFixed(2)}
                  />
                ) : (
                  <div className="h-[340px] flex items-center justify-center text-sm text-muted-foreground">
                    {t('market.noChartData')}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Stats table */}
            <Card className="glass-regular">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('research.compare.metrics')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('research.compare.symbol')}</TableHead>
                      <TableHead className="text-right">{t('research.compare.return')}</TableHead>
                      <TableHead className="text-right">{t('research.compare.volatility')}</TableHead>
                      <TableHead className="text-right">{t('research.compare.maxDrawdown')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statsRows.map((row) => (
                      <TableRow key={row.symbol}>
                        <TableCell className="font-medium">
                          <span className="inline-flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: row.color }} />
                            <span className="font-mono">{row.symbol}</span>
                          </span>
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums",
                          row.totalReturn == null ? "" : row.totalReturn >= 0 ? "amount-gain" : "amount-loss")}>
                          {fmtPct(row.totalReturn)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtPct(row.volatility)}</TableCell>
                        <TableCell className="text-right tabular-nums text-loss">{fmtPct(row.maxDrawdown)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Correlation matrix — needs at least two symbols. */}
            {symbols.length >= 2 && (
              <Card className="glass-regular">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{t('research.compare.correlation')}</CardTitle>
                  <p className="text-xs text-muted-foreground">{t('research.compare.correlationHint')}</p>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <Skeleton {...loadingSurfaceProps} className="h-40 w-full rounded-lg" />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm border-separate border-spacing-1">
                        <thead>
                          <tr>
                            <th className="p-1.5" />
                            {correlation.symbols.map((s, i) => (
                              <th key={s} className="p-1.5 text-center font-mono text-xs">
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="h-2 w-2 rounded-full" style={{ background: getChartColor(i) }} />
                                  {s}
                                </span>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {correlation.symbols.map((rowSym, i) => (
                            <tr key={rowSym}>
                              <th className="p-1.5 text-left font-mono text-xs whitespace-nowrap">
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="h-2 w-2 rounded-full" style={{ background: getChartColor(i) }} />
                                  {rowSym}
                                </span>
                              </th>
                              {correlation.matrix[i].map((value, j) => (
                                <td
                                  key={`${rowSym}-${correlation.symbols[j]}`}
                                  className="p-1.5 text-center tabular-nums rounded-md"
                                  style={correlationCellStyle(value)}
                                >
                                  {value == null ? "—" : value.toFixed(2)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="fundamentals" className="space-y-4 pt-4">
            <Card className="glass-regular">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('research.compare.tabFundamentals')}</CardTitle>
                <p className="text-xs text-muted-foreground">{t('research.compare.fundamentalsHint')}</p>
              </CardHeader>
              <CardContent>
                {fundamentalsLoading ? (
                  <Skeleton {...loadingSurfaceProps} className="h-48 w-full rounded-lg" />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="whitespace-nowrap">{t('research.compare.symbol')}</TableHead>
                          <TableHead className="whitespace-nowrap">{t('research.scorecard.health')}</TableHead>
                          {FUNDAMENTALS_METRICS.map((m) => (
                            <TableHead key={m.key} className="text-right whitespace-nowrap p-0">
                              <button
                                type="button"
                                onClick={() => toggleSort(m.key)}
                                className={cn(
                                  "inline-flex items-center gap-1 px-3 py-2 w-full justify-end hover:text-foreground transition-colors",
                                  sortMetric === m.key ? "text-foreground font-semibold" : "text-muted-foreground",
                                )}
                                aria-label={t('research.compare.sortBy', { metric: t(m.labelKey) })}
                              >
                                {t(m.labelKey)}
                                {sortMetric === m.key && (
                                  m.betterWhenHigher
                                    ? <ArrowDown className="h-3 w-3" />
                                    : <ArrowUp className="h-3 w-3" />
                                )}
                              </button>
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {fundamentalsRows.map((row) => (
                          <TableRow key={row.symbol}>
                            <TableCell className="font-medium whitespace-nowrap">
                              <span className="inline-flex items-center gap-2">
                                <span className="h-2.5 w-2.5 rounded-full" style={{ background: row.color }} />
                                <span className="font-mono">{row.symbol}</span>
                                {row.unavailable ? (
                                  <Badge variant="outline" className="text-[10px] border-warning/40 text-warning">
                                    {t('research.unavailable')}
                                  </Badge>
                                ) : (
                                  <ProvenanceBadge meta={row.meta} />
                                )}
                              </span>
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {row.scorecard && row.scorecard.evaluated > 0
                                ? <ScorecardGradeBadge scorecard={row.scorecard} />
                                : <span className="text-muted-foreground">—</span>}
                            </TableCell>
                            {FUNDAMENTALS_METRICS.map((m) => {
                              const flag = row.unavailable ? undefined : row.scorecard?.flags.find((f) => f.metric === m.key);
                              return (
                                <TableCell
                                  key={m.key}
                                  title={flag?.reason}
                                  className={cn(
                                    "text-right tabular-nums",
                                    flag && SEVERITY_TEXT[flag.severity],
                                    sortMetric === m.key && "bg-muted/40 font-medium",
                                  )}
                                >
                                  {row.unavailable ? "—" : fmtMetric(m, row.data?.[m.key])}
                                </TableCell>
                              );
                            })}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
