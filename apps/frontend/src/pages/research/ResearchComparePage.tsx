import { useCallback, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateWithAppSettings, formatDateTimeWithAppSettings } from "@/components/shared/dateUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { GitCompareArrows, Plus, Search, X } from "lucide-react";
import { LineChart, getChartColor, type LineSeries } from "@/components/charts";
import { useDebounce } from "@/hooks/useDebounce";
import { cn } from "@/lib/utils";
import { apiClient } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import type { ResearchChartPoint, ResearchRange } from "@/types/research";

const RANGES: { label: string; range: ResearchRange }[] = [
  { label: "1M", range: "1mo" },
  { label: "3M", range: "3mo" },
  { label: "6M", range: "6mo" },
  { label: "1Y", range: "1y" },
  { label: "5Y", range: "5y" },
];

const MAX_SYMBOLS = 6;

interface SymbolStats {
  symbol: string;
  totalReturn: number | null;
  volatility: number | null;
  maxDrawdown: number | null;
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

/** Rebase each series' closes to start at 100 so different price levels overlay. */
function rebaseTo100(points: ResearchChartPoint[]): { time: number; value: number }[] {
  const valid = points.filter((p) => Number.isFinite(p.close) && p.close > 0);
  if (valid.length === 0) return [];
  const base = valid[0].close;
  return valid.map((p) => ({ time: p.time, value: (p.close / base) * 100 }));
}

export default function ResearchComparePage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [searchText, setSearchText] = useState("");
  const [selectedRange, setSelectedRange] = useState(RANGES[3]); // 1Y
  const debouncedSearch = useDebounce(searchText.trim(), 300);

  const fmtPct = useCallback((val: number | null) =>
    val == null ? "—" : `${val >= 0 ? "+" : ""}${(val * 100).toFixed(2)}%`, []);

  const { data: searchResult, isFetching: isSearching } = useQuery({
    queryKey: ["research-search", debouncedSearch],
    queryFn: () => apiClient.searchResearch(debouncedSearch),
    enabled: debouncedSearch.length >= 1,
    staleTime: 60_000,
  });
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

  const isLoading = chartQueries.some((q) => q.isFetching && !q.data);

  // Build the rebased overlay: union of all time points keyed by timestamp.
  const { chartData, series, statsRows } = useMemo(() => {
    const perSymbol = symbols.map((symbol, i) => {
      const points = chartQueries[i]?.data?.data.points ?? [];
      return { symbol, rebased: rebaseTo100(points), stats: computeStats(symbol, points) };
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

    return {
      chartData: data,
      series: lineSeries,
      statsRows: perSymbol.map((s, i) => ({ ...s.stats, color: getChartColor(i) })),
    };
  }, [symbols, chartQueries]);

  return (
    <div className="space-y-6 animate-in">
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
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('research.compare.addPlaceholder')}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="pl-10"
            />
            {debouncedSearch.length >= 1 && searchText.length > 0 && searchItems.length > 0 && (
              <Card className="absolute z-50 top-full mt-1 w-full shadow-lg border border-border">
                <CardContent className="p-1">
                  {searchItems.map((item) => (
                    <button
                      key={`${item.symbol}-${item.exchange}`}
                      onClick={() => addSymbol(item.symbol)}
                      className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-md hover:bg-muted/70 transition-colors"
                    >
                      <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="font-mono font-bold text-sm min-w-[4.5rem]">{item.symbol}</span>
                      <span className="text-sm text-muted-foreground truncate flex-1">{item.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{item.exchange}</span>
                    </button>
                  ))}
                </CardContent>
              </Card>
            )}
            {isSearching && searchText.length > 0 && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            )}
          </div>
        )}
      </div>

      {symbols.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20 text-center">
            <GitCompareArrows className="h-14 w-14 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-1">{t('research.compare.startTitle')}</h3>
            <p className="text-sm text-muted-foreground max-w-md">{t('research.compare.startHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Rebased overlay chart */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-base">{t('research.compare.rebased')}</CardTitle>
                <div className="flex gap-1">
                  {RANGES.map((r) => (
                    <Button
                      key={r.label}
                      variant={selectedRange.range === r.range ? "default" : "ghost"}
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => setSelectedRange(r)}
                    >
                      {r.label}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-[340px] w-full rounded-lg" />
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
          <Card>
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
                        row.totalReturn == null ? "" : row.totalReturn >= 0 ? "text-accent" : "text-destructive")}>
                        {fmtPct(row.totalReturn)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(row.volatility)}</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">{fmtPct(row.maxDrawdown)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
