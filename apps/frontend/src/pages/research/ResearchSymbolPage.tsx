import { useCallback, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import {
  formatDateTimeWithAppSettings,
  formatDateWithAppSettings,
} from "@/components/shared/dateUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ArrowLeft, TrendingUp, TrendingDown, BarChart3, Link2,
} from "lucide-react";
import { AreaChart, type AreaSeries } from "@/components/charts";
import { cn } from "@/lib/utils";
import { apiClient } from "@/lib/api";
import { ProvenanceBadge } from "@/components/research/ProvenanceBadge";
import { ResearchUnavailableNote } from "@/components/research/ResearchUnavailableNote";
import { ResearchFundamentalsTab } from "@/components/research/ResearchFundamentalsTab";
import { ResearchAnalystTab } from "@/components/research/ResearchAnalystTab";
import { ResearchNewsTab } from "@/components/research/ResearchNewsTab";
import { ResearchMappingDialog } from "@/components/research/ResearchMappingDialog";
import type { ResearchRange } from "@/types/research";

const RANGES: { label: string; range: ResearchRange }[] = [
  { label: "1D", range: "1d" },
  { label: "5D", range: "5d" },
  { label: "1M", range: "1mo" },
  { label: "3M", range: "3mo" },
  { label: "6M", range: "6mo" },
  { label: "1Y", range: "1y" },
  { label: "5Y", range: "5y" },
  { label: "MAX", range: "max" },
];

function fmtAxisDate(ts: number, range: ResearchRange, appDateFormat: string, locale: string) {
  const d = new Date(ts);
  if (range === "1d" || range === "5d") {
    return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  return formatDateWithAppSettings(d, appDateFormat);
}

export default function ResearchSymbolPage() {
  const { symbol: rawSymbol } = useParams<{ symbol: string }>();
  const symbol = (rawSymbol ?? "").toUpperCase();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const [selectedRange, setSelectedRange] = useState<{ label: string; range: ResearchRange }>(RANGES[2]);
  const [activeTab, setActiveTab] = useState("fundamentals");
  const [mappingOpen, setMappingOpen] = useState(false);

  const fmtPrice = useCallback((val: number | null | undefined, currency = "USD") => {
    if (val == null || isNaN(val)) return "—";
    return new Intl.NumberFormat(locale, {
      style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(val);
  }, [locale]);
  const fmtNum = useCallback((val: number | null | undefined, opts?: Intl.NumberFormatOptions) => {
    if (val == null || isNaN(val)) return "—";
    return new Intl.NumberFormat(locale, opts).format(val);
  }, [locale]);

  const { data: quoteResult, isFetching: isQuoteLoading } = useQuery({
    queryKey: ["research-quote", symbol],
    queryFn: () => apiClient.getResearchQuote(symbol),
    enabled: !!symbol,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const quote = quoteResult?.data ?? null;
  const quoteUnavailable = quoteResult?.meta.source === "unavailable";

  const { data: chartResult, isFetching: isChartLoading } = useQuery({
    queryKey: ["research-chart", symbol, selectedRange.range],
    queryFn: () => apiClient.getResearchChart(symbol, selectedRange.range),
    enabled: !!symbol,
    staleTime: 60_000,
  });
  const chart = chartResult?.data;
  const chartUnavailable = chartResult?.meta.source === "unavailable";

  const isPositive = (quote?.change ?? 0) >= 0;
  const currency = quote?.currency || chart?.currency || "USD";

  return (
    <div className="space-y-6 animate-in">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> {t('research.back')}
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">{symbol}</h1>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setMappingOpen(true)}>
          <Link2 className="h-4 w-4" /> {t('research.mapping.button')}
        </Button>
      </div>

      {/* Quote header */}
      {isQuoteLoading && !quote ? (
        <Card>
          <CardContent className="py-6 space-y-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-12 w-40" />
          </CardContent>
        </Card>
      ) : quoteUnavailable ? (
        <ResearchUnavailableNote provider={quoteResult?.meta.provider ?? null} />
      ) : quote ? (
        <Card>
          <CardContent className="py-6">
            <div className="flex items-start justify-between flex-wrap gap-4">
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h2 className="text-2xl font-bold text-foreground">{quote.symbol}</h2>
                  {quote.type && <Badge variant="secondary" className="text-xs">{quote.type}</Badge>}
                  {quote.exchange && <span className="text-sm text-muted-foreground">{quote.exchange}</span>}
                  <ProvenanceBadge meta={quoteResult?.meta} />
                </div>
                <p className="text-sm text-muted-foreground mb-3">{quote.name}</p>
                <div className="flex items-baseline gap-3">
                  <span className="text-4xl font-bold tabular-nums text-foreground">
                    {fmtPrice(quote.price, currency)}
                  </span>
                  <span className={cn(
                    "text-lg font-semibold tabular-nums flex items-center gap-1",
                    isPositive ? "text-accent" : "text-destructive",
                  )}>
                    {isPositive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                    {isPositive ? "+" : ""}{fmtPrice(quote.change, currency)}
                    <span className="text-sm">({isPositive ? "+" : ""}{quote.changePercent?.toFixed(2)}%)</span>
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {t('market.noQuote', { symbol })}
          </CardContent>
        </Card>
      )}

      {/* Chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('market.priceChart')}</CardTitle>
            <div className="flex gap-1 flex-wrap">
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
          {isChartLoading && !chart ? (
            <Skeleton className="h-[320px] w-full rounded-lg" />
          ) : chartUnavailable ? (
            <div className="py-8">
              <ResearchUnavailableNote provider={chartResult?.meta.provider ?? null} />
            </div>
          ) : chart?.points && chart.points.length > 0 ? (
            <AreaChart
              data={chart.points}
              xAccessor={(d) => new Date(d.time)}
              xIsDate
              height={320}
              xTickFormat={(v) => fmtAxisDate((v as Date).getTime(), selectedRange.range, appSettings.dateFormat, locale)}
              yTickFormat={(v) => fmtNum(v, { maximumFractionDigits: 2 })}
              tooltipTitle={(d) => formatDateTimeWithAppSettings(new Date(d.time), appSettings.dateFormat, locale)}
              tooltipValueFormat={(v) => fmtPrice(v, currency)}
              series={[
                {
                  key: "close",
                  label: t('market.priceChart'),
                  accessor: (d) => d.close,
                  color: isPositive ? "hsl(var(--accent))" : "hsl(var(--destructive))",
                  strokeWidth: 2,
                },
              ] as AreaSeries<typeof chart.points[number]>[]}
            />
          ) : (
            <div className="h-[320px] flex items-center justify-center text-sm text-muted-foreground">
              {t('market.noChartData')}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lazy per-tab sections — each fetches its endpoint only when opened */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4" /> {t('research.details')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="fundamentals">{t('market.fundamentals')}</TabsTrigger>
              <TabsTrigger value="analyst">{t('market.analystRatings')}</TabsTrigger>
              <TabsTrigger value="news">{t('market.latestNews')}</TabsTrigger>
            </TabsList>
            <TabsContent value="fundamentals" className="pt-4">
              <ResearchFundamentalsTab symbol={symbol} enabled={activeTab === "fundamentals"} />
            </TabsContent>
            <TabsContent value="analyst" className="pt-4">
              <ResearchAnalystTab symbol={symbol} enabled={activeTab === "analyst"} />
            </TabsContent>
            <TabsContent value="news" className="pt-4">
              <ResearchNewsTab symbol={symbol} enabled={activeTab === "news"} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <ResearchMappingDialog
        open={mappingOpen}
        onOpenChange={setMappingOpen}
        instrumentKey={symbol}
        keyType="internal"
        query={symbol}
        displayName={quote?.name ?? symbol}
      />
    </div>
  );
}
