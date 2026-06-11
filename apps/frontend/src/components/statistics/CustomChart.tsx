import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Pencil, Trash2, TrendingUp } from "lucide-react";
import {
  LineChart, type LineSeries,
  BarChart, type BarSeries,
  StackedBarChart, type StackedBarSeries,
  AreaChart, type AreaSeries,
  ChartLegend, type ChartLegendItem,
} from "@/components/charts";
import { formatDate, parseISO } from "@/components/shared/dateUtils";
import type { StatisticsData } from "@/hooks/useStatistics";
import { useRecipientPivot } from "@/hooks/useRecipientPivot";
import type { SavedChart } from "@/lib/api/types";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { getCurrencySymbol, numberFormatToLocale } from "@/utils/currency";

const CHART_COLORS = Array.from({ length: 16 }, (_, i) => `hsl(var(--chart-${(i % 8) + 1}))`);

interface ChartDatum {
  period: string;
  periodLabel: string;
  date: Date;
  values: Record<string, number>;
}

type SeriesMeta = { key: string; label: string; color: string };

function formatPeriod(period: string, bucket: 'monthly' | 'yearly'): string {
  try {
    if (bucket === 'yearly') return period;
    return formatDate(parseISO(`${period}-01`), "MMM yy");
  } catch {
    return period;
  }
}

function parseDate(period: string, bucket: 'monthly' | 'yearly'): Date {
  try {
    // Slice the year first so a stray 'YYYY-MM' key under a yearly bucket can't
    // produce 'YYYY-MM-01-01' → Invalid Date (which blanked yearly line/area charts).
    return bucket === 'yearly' ? parseISO(`${period.slice(0, 4)}-01-01`) : parseISO(`${period}-01`);
  } catch {
    return new Date();
  }
}

interface CustomChartProps {
  savedChart: SavedChart;
  data: StatisticsData;
  onEdit?: (chart: SavedChart) => void;
  onDelete?: (chart: SavedChart) => void;
}

export function CustomChart({ savedChart, data, onEdit, onDelete }: CustomChartProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const formatCurrency = (val: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }).format(val);
  const currencySymbol = getCurrencySymbol(appSettings.defaultCurrency || "EUR");

  const bucket = savedChart.time_bucket;
  const hasRecipients = savedChart.recipient_ids.length > 0;
  const { recipientData, isLoading: recipientLoading } = useRecipientPivot(savedChart);

  // Resolve the selected categories once — this was recomputed three times per
  // render (allPeriods, seriesMeta, chartData) with an O(n) `.includes` lookup
  // against category_ids on every row.
  const catData = useMemo(() => {
    const selected = new Set(savedChart.category_ids);
    const filtered = data.categoryPivot.filter(
      (c) => c.categoryId !== null && selected.has(c.categoryId)
    );
    if (bucket !== 'yearly') return filtered;
    // The category pivot only ever returns monthly ('YYYY-MM') keys, but recipient
    // data respects the saved bucket ('YYYY' for yearly). Re-bucket category months
    // to year keys so both sources share keys and yearly charts aren't blank.
    return filtered.map((c) => {
      const months: Record<string, number> = {};
      for (const [p, v] of Object.entries(c.months)) {
        const y = p.slice(0, 4);
        months[y] = (months[y] ?? 0) + v;
      }
      return { ...c, months };
    });
  }, [data.categoryPivot, savedChart.category_ids, bucket]);

  // Collect all periods from both sources, apply date filter
  const allPeriods = useMemo(() => {
    const periodSet = new Set<string>();

    for (const cat of catData) {
      for (const p of Object.keys(cat.months)) periodSet.add(p);
    }
    for (const rec of recipientData) {
      for (const p of Object.keys(rec.months)) periodSet.add(p);
    }

    let periods = Array.from(periodSet).sort();

    // Compare each period against the date bound on a COMMON prefix: yearly
    // periods are 'YYYY' (length 4), monthly 'YYYY-MM' (length 7). Slicing the
    // bound to 7 always made a yearly '2026' < '2026-01' lexicographically, so a
    // yearly chart silently dropped its own start year.
    if (savedChart.date_range_start) {
      const s = savedChart.date_range_start;
      periods = periods.filter((p) => p >= (p.length === 4 ? s.slice(0, 4) : s.slice(0, 7)));
    }
    if (savedChart.date_range_end) {
      const e = savedChart.date_range_end;
      periods = periods.filter((p) => p <= (p.length === 4 ? e.slice(0, 4) : e.slice(0, 7)));
    }

    return periods;
  }, [catData, recipientData, savedChart.date_range_start, savedChart.date_range_end]);

  // Build unified series metadata
  const seriesMeta = useMemo<SeriesMeta[]>(() => {
    const result: SeriesMeta[] = [];
    let colorIdx = 0;

    for (const cat of catData) {
      result.push({ key: `cat:${cat.categoryId}`, label: cat.categoryName, color: CHART_COLORS[colorIdx++ % CHART_COLORS.length] });
    }

    for (const rec of recipientData) {
      result.push({ key: `rec:${rec.recipientId}`, label: rec.name, color: CHART_COLORS[colorIdx++ % CHART_COLORS.length] });
    }

    return result;
  }, [catData, recipientData]);

  const chartData = useMemo<ChartDatum[]>(() => {
    const recDataMap = new Map(recipientData.map((r) => [r.recipientId, r]));

    return allPeriods.map((period) => {
      const values: Record<string, number> = {};
      for (const cat of catData) {
        values[`cat:${cat.categoryId}`] = Math.abs(cat.months[period] ?? 0);
      }
      for (const recId of savedChart.recipient_ids) {
        const rec = recDataMap.get(recId);
        values[`rec:${recId}`] = Math.abs(rec?.months[period] ?? 0);
      }
      return {
        period,
        periodLabel: formatPeriod(period, bucket),
        date: parseDate(period, bucket),
        values,
      };
    });
  }, [allPeriods, catData, recipientData, savedChart.recipient_ids, bucket]);

  // Memoised so the chart components and legend get stable array identities
  // instead of a fresh `.map()` result on every render.
  const legendItems = useMemo<ChartLegendItem[]>(
    () => seriesMeta.map((s) => ({ label: s.label, color: s.color })),
    [seriesMeta]
  );
  // Series definitions for bar-family charts (no stroke) and line-family
  // charts (with stroke). Built once per seriesMeta change.
  const barSeries = useMemo<BarSeries<ChartDatum>[]>(
    () => seriesMeta.map((s) => ({
      key: s.key,
      label: s.label,
      accessor: (d: ChartDatum) => d.values[s.key] ?? 0,
      color: s.color,
    })),
    [seriesMeta]
  );
  const lineSeries = useMemo<LineSeries<ChartDatum>[]>(
    () => seriesMeta.map((s) => ({
      key: s.key,
      label: s.label,
      accessor: (d: ChartDatum) => d.values[s.key] ?? 0,
      color: s.color,
      strokeWidth: 2,
    })),
    [seriesMeta]
  );
  const yTick = (v: number) => `${currencySymbol}${(v / 1000).toFixed(0)}k`;
  const xTickFmt = (v: unknown) => formatDate(v as Date, bucket === 'yearly' ? 'yyyy' : 'MMM yy');

  const isEmpty = seriesMeta.length === 0;
  const isLoading = hasRecipients && recipientLoading;

  const chartType = savedChart.chart_type;
  const chartVariant = savedChart.chart_variant;

  const seriesCount = seriesMeta.length;
  const descKey = seriesCount === 0
    ? 'customChart.noSeries'
    : seriesCount === 1
      ? 'customChart.oneSeries'
      : 'customChart.nSeries';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-3">
        <div className="flex-1 min-w-0">
          <CardTitle className="truncate">{savedChart.name}</CardTitle>
          <CardDescription>
            {t(descKey, { n: seriesCount })}
          </CardDescription>
        </div>
        {(onEdit || onDelete) && (
          <div className="flex items-center gap-1 shrink-0">
            {onEdit && (
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => onEdit(savedChart)}>
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            {onDelete && (
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => onDelete(savedChart)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </CardHeader>

      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[350px] w-full" />
        ) : isEmpty ? (
          <div className="flex items-center justify-center h-[300px] text-muted-foreground">
            <div className="text-center space-y-2">
              <TrendingUp className="h-8 w-8 mx-auto opacity-40" />
              <p className="text-sm">{t('customChart.noSeriesPrompt')}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {chartType === 'bar' && chartVariant === 'stacked' ? (
              <StackedBarChart<ChartDatum>
                data={chartData}
                categoryAccessor={(d) => d.periodLabel}
                series={barSeries as StackedBarSeries<ChartDatum>[]}
                height={350}
                valueTickFormat={yTick}
                tooltipTitle={(d) => d.periodLabel}
                tooltipValueFormat={(v) => formatCurrency(v)}
              />
            ) : chartType === 'bar' ? (
              <BarChart<ChartDatum>
                data={chartData}
                categoryAccessor={(d) => d.periodLabel}
                series={barSeries}
                height={350}
                valueTickFormat={yTick}
                tooltipTitle={(d) => d.periodLabel}
                tooltipValueFormat={(v) => formatCurrency(v)}
              />
            ) : chartType === 'area' ? (
              <AreaChart<ChartDatum>
                data={chartData}
                xAccessor={(d) => d.date}
                series={lineSeries as AreaSeries<ChartDatum>[]}
                height={350}
                stacked={chartVariant === 'stacked'}
                xTickFormat={xTickFmt}
                yTickFormat={yTick}
                tooltipTitle={(d) => d.periodLabel}
                tooltipValueFormat={(v) => formatCurrency(v)}
              />
            ) : (
              <LineChart<ChartDatum>
                data={chartData}
                xAccessor={(d) => d.date}
                series={lineSeries}
                height={350}
                xTickFormat={xTickFmt}
                yTickFormat={yTick}
                tooltipTitle={(d) => d.periodLabel}
                tooltipValueFormat={(v) => formatCurrency(v)}
              />
            )}
            <ChartLegend items={legendItems} align="center" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
