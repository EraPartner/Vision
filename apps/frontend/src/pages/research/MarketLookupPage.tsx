import { useState, useCallback, useMemo } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import {
  formatDateStringWithAppSettings,
  formatDateTimeWithAppSettings,
  formatDateWithAppSettings,
} from "@/components/shared/dateUtils";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp, TrendingDown, BarChart3, ArrowUpDown,
  DollarSign, Activity, Clock, Newspaper, ExternalLink, Users,
} from "lucide-react";
import { AreaChart, BarChart, type AreaSeries, type BarSeries } from "@/components/charts";
import { useDebounce } from "@/hooks/useDebounce";
import { cn } from "@/lib/utils";
import { usePortfolio } from "@/hooks/usePortfolio";
import { getInvestmentPriceHistory } from "@/lib/api/portfolio";
import { AddInvestmentFromMarketDialog } from "@/components/portfolio/AddInvestmentFromMarketDialog";
import { RemoteNewsImage } from "@/components/shared/RemoteNewsImage";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/shared/PageHeader";
import { SymbolSearchResultItem } from "@/components/shared/SymbolSearchResultItem";
import { SymbolSearchBox } from "@/components/shared/SymbolSearchBox";

import { apiClient } from "@/lib/api";

const RANGES = [
  { label: "1D", range: "1d", interval: "5m" },
  { label: "5D", range: "5d", interval: "15m" },
  { label: "1M", range: "1mo", interval: "1d" },
  { label: "3M", range: "3mo", interval: "1d" },
  { label: "6M", range: "6mo", interval: "1d" },
  { label: "1Y", range: "1y", interval: "1wk" },
  { label: "5Y", range: "5y", interval: "1mo" },
  { label: "MAX", range: "max", interval: "1mo" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

// Lower bound (epoch ms) for a range, used when serving the chart from an
// investment's own price provider instead of Yahoo. 'max' returns 0 (all data).
function rangeToFromMs(range: string): number {
  const now = Date.now();
  switch (range) {
    case "1d": return now - 1 * DAY_MS;
    case "5d": return now - 5 * DAY_MS;
    case "1mo": return now - 30 * DAY_MS;
    case "3mo": return now - 91 * DAY_MS;
    case "6mo": return now - 182 * DAY_MS;
    case "1y": return now - 365 * DAY_MS;
    case "5y": return now - 5 * 365 * DAY_MS;
    case "max": return 0;
    default: return now - 30 * DAY_MS;
  }
}

interface AnalystConsensus {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

interface AnalystAction {
  date: string;
  firm: string;
  toGrade: string;
  fromGrade: string | null;
  action: string;
  priceTarget: number | null;
}

interface Quote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  currency: string;
  exchange: string;
  type: string;
  open: number;
  dayHigh: number;
  dayLow: number;
  prevClose: number;
  volume: number;
  avgVolume: number;
  high52w: number;
  low52w: number;
  marketCap: number;
  pe: number;
  forwardPE: number;
  dividendYield: number;
  eps: number;
  beta?: number;
  priceToBook?: number;
  analystConsensus: AnalystConsensus | null;
  recentAnalystActions: AnalystAction[];
}

interface ChartPoint {
  time: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

function gradeColor(grade: string): string {
  const g = grade.toLowerCase();
  if (/buy|outperform|overweight|accumulate/.test(g)) return "text-success";
  if (/sell|underperform|underweight|reduce/.test(g)) return "text-destructive";
  return "text-yellow-500 dark:text-yellow-400";
}

function fmtDate(ts: number, range: string, appDateFormat: string, locale: string) {
  const d = new Date(ts);
  if (range === "1d" || range === "5d") {
    return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  return formatDateWithAppSettings(d, appDateFormat);
}

export default function MarketLookupPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const fmtNum = useCallback((val: number | null | undefined, opts?: Intl.NumberFormatOptions) => {
    if (val == null || isNaN(val)) return "—";
    return new Intl.NumberFormat(locale, opts).format(val);
  }, [locale]);
  const fmtPrice = useCallback((val: number | null | undefined, currency = "USD") => {
    if (val == null || isNaN(val)) return "—";
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(val);
  }, [locale]);
  const fmtLargeNum = useCallback((val: number | null | undefined) => {
    if (val == null || isNaN(val)) return "—";
    if (val >= 1e12) return `${(val / 1e12).toFixed(2)}T`;
    if (val >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
    return fmtNum(val, { maximumFractionDigits: 0 });
  }, [fmtNum]);
  const [searchText, setSearchText] = useState("");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState(RANGES[2]); // 1M default
  const [searchParams] = useSearchParams();
  const symbolFromQuery = searchParams.get("symbol")?.trim().toUpperCase();
  const effectiveSelectedSymbol = selectedSymbol || symbolFromQuery || null;
  const debouncedSearch = useDebounce(searchText, 300);
  const { summaries, isLoading: isPortfolioLoading } = usePortfolio();

  // When the page is opened from a portfolio holding (double-click), the URL
  // carries its investmentId. If that holding prices via a non-Yahoo provider
  // (Kinesis/custom/binance), Yahoo has no data for the symbol — so we serve the
  // chart + a minimal price header from the holding's own stored history instead.
  const investmentId = searchParams.get("investmentId");
  const providerInvestment = useMemo(
    () => (investmentId ? summaries.find((s) => String(s.id) === investmentId) : undefined),
    [investmentId, summaries],
  );
  // Still waiting to learn which provider this holding uses — don't fire Yahoo yet.
  const resolvingProvider = !!investmentId && !providerInvestment && isPortfolioLoading;
  const isProviderAsset = !!providerInvestment
    && !!providerInvestment.price_provider
    && providerInvestment.price_provider !== "yahoo";
  const useYahoo = !!effectiveSelectedSymbol && !isProviderAsset && !resolvingProvider;

  // Search
  const { data: searchResults, isFetching: isSearching } = useQuery({
    queryKey: ["market-search", debouncedSearch],
    queryFn: () => apiClient.searchMarket(debouncedSearch),
    enabled: debouncedSearch.length >= 1,
    staleTime: 60_000,
  });

  // Quote
  const { data: quoteData, isFetching: isQuoteLoading } = useQuery({
    queryKey: ["market-quote", effectiveSelectedSymbol],
    queryFn: async () => {
      const { quotes } = await apiClient.getMarketQuotes<Quote>(effectiveSelectedSymbol!);
      return quotes[0] ?? null;
    },
    enabled: useYahoo,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Chart
  const { data: chartData, isFetching: isChartLoading } = useQuery({
    queryKey: ["market-chart", effectiveSelectedSymbol, selectedRange.range, selectedRange.interval],
    queryFn: () =>
      apiClient.getMarketChart(effectiveSelectedSymbol!, selectedRange.range, selectedRange.interval),
    enabled: useYahoo,
    staleTime: 60_000,
  });

  // Provider-aware chart — served from the holding's own price provider when
  // Yahoo can't (Kinesis/custom/binance). Points carry only a price, so high/low
  // collapse to close and volume is omitted (no volume bars in this mode).
  const { data: providerChartData, isFetching: isProviderChartLoading } = useQuery({
    queryKey: ["provider-chart", providerInvestment?.id, selectedRange.range],
    queryFn: async () => {
      const res = await getInvestmentPriceHistory(providerInvestment!.id, {
        from_ms: rangeToFromMs(selectedRange.range),
        db_only: false,
      });
      const points: ChartPoint[] = res.points.map((p) => ({
        time: p.timestampMs,
        close: p.price,
        high: p.price,
        low: p.price,
        volume: 0,
      }));
      return {
        symbol: providerInvestment!.symbol ?? effectiveSelectedSymbol ?? "",
        currency: providerInvestment!.currency,
        points,
      };
    },
    enabled: isProviderAsset && !!providerInvestment,
    staleTime: 60_000,
  });

  // News
  const { data: newsData, isFetching: isNewsLoading } = useQuery({
    queryKey: ["market-news", effectiveSelectedSymbol],
    queryFn: () => apiClient.getMarketNews([effectiveSelectedSymbol!], 10),
    enabled: useYahoo,
    staleTime: 120_000,
  });

  // Fundamentals — merged FMP + Yahoo (FMP preferred, Yahoo fills gaps) via the
  // research aggregator, so this card matches the Compare/Symbol fundamentals.
  // Backend caches 12h; staleTime mirrors that. The display falls back to the
  // Yahoo quote's own fields when unavailable (e.g. indices/ETFs FMP omits).
  const { data: fundamentalsResult } = useQuery({
    queryKey: ["market-fundamentals", effectiveSelectedSymbol],
    queryFn: () => apiClient.getResearchFundamentals(effectiveSelectedSymbol!),
    enabled: useYahoo,
    staleTime: 12 * 60 * 60 * 1000,
  });

  const handleSelect = useCallback((symbol: string) => {
    setSelectedSymbol(symbol);
    setSearchText("");
  }, []);

  // Minimal quote synthesized from provider history: price = latest point,
  // change = move across the visible range. Fundamentals/news don't exist for
  // these assets, so those sections are hidden in provider mode.
  const providerQuote = useMemo<Quote | null>(() => {
    if (!isProviderAsset || !providerInvestment) return null;
    const pts = providerChartData?.points ?? [];
    if (pts.length === 0) return null;
    const last = pts[pts.length - 1].close;
    const first = pts[0].close;
    const change = last - first;
    const changePercent = first ? (change / first) * 100 : 0;
    return {
      symbol: providerInvestment.symbol ?? effectiveSelectedSymbol ?? "",
      name: providerInvestment.name,
      price: last,
      change,
      changePercent,
      currency: providerInvestment.currency,
      exchange: "",
      type: (providerInvestment.price_provider ?? "").toUpperCase(),
    } as Quote;
  }, [isProviderAsset, providerInvestment, providerChartData, effectiveSelectedSymbol]);

  const quote = isProviderAsset ? providerQuote : quoteData;
  // Merged FMP+Yahoo fundamentals; the card prefers these over the quote's own.
  const fundamentals = fundamentalsResult?.data ?? null;
  const displayChart = isProviderAsset ? providerChartData : chartData;
  const isChartBusy = isProviderAsset ? isProviderChartLoading : isChartLoading;
  const isQuoteBusy = isProviderAsset ? isProviderChartLoading : isQuoteLoading;
  const isPositive = (quote?.change ?? 0) >= 0;

  // Check if this asset already exists in portfolio
  const existingInvestment = useMemo(
    () => (quote
      ? summaries.find(s => s.symbol?.toLowerCase() === quote.symbol.toLowerCase())
      : null),
    [quote, summaries],
  );

  return (
    <div className="space-y-6 animate-in">
      <PageHeader title={t('marketLookup.title')} icon={BarChart3} />

      {/* Search */}
      <SymbolSearchBox
        className="max-w-2xl"
        placeholder={t('market.searchPlaceholder')}
        value={searchText}
        onChange={setSearchText}
        loading={isSearching && searchText.length > 0}
        open={debouncedSearch.length >= 1 && searchText.length > 0 && (searchResults?.items?.length ?? 0) > 0}
      >
        {searchResults?.items?.map((item) => (
          <SymbolSearchResultItem
            key={item.symbol}
            item={item}
            onSelect={(it) => handleSelect(it.symbol)}
          />
        ))}
      </SymbolSearchBox>

      {/* No selection state */}
      {!effectiveSelectedSymbol && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20 text-center">
            <BarChart3 className="h-14 w-14 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-1">{t('market.searchTicker')}</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              {t('market.searchHint')}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Quote + Chart */}
      {effectiveSelectedSymbol && (
        <>
          {/* Header */}
          {isQuoteBusy ? (
            <Card>
              <CardContent className="py-6 space-y-3">
                <Skeleton className="h-8 w-64" />
                <Skeleton className="h-12 w-40" />
                <Skeleton className="h-5 w-32" />
              </CardContent>
            </Card>
          ) : quote ? (
            <Card>
              <CardContent className="py-6">
                <div className="flex items-start justify-between flex-wrap gap-4">
                  <div>
                    <div className="flex items-center gap-3 mb-1">
                      <h2 className="text-2xl font-bold text-foreground">{quote.symbol}</h2>
                      <Badge variant="secondary" className="text-xs">{quote.type}</Badge>
                      <span className="text-sm text-muted-foreground">{quote.exchange}</span>
                    </div>
                    <p className="text-sm text-muted-foreground mb-3">{quote.name}</p>
                    <div className="flex items-baseline gap-3">
                      <span className="text-4xl font-bold tabular-nums text-foreground">
                        {fmtPrice(quote.price, quote.currency)}
                      </span>
                      <span className={cn(
                        "text-lg font-semibold tabular-nums flex items-center gap-1",
                        isPositive ? "text-accent" : "text-destructive"
                      )}>
                        {isPositive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                        {isPositive ? "+" : ""}{fmtPrice(quote.change, quote.currency)}
                        <span className="text-sm">
                          ({isPositive ? "+" : ""}{quote.changePercent?.toFixed(2)}%)
                        </span>
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!isProviderAsset && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span>{t('market.autoRefresh')}</span>
                      </div>
                    )}
                    {quote && !isProviderAsset && (
                      <AddInvestmentFromMarketDialog
                        quote={quote}
                        existingInvestment={existingInvestment ?? undefined}
                      />
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {t('market.noQuote', { symbol: effectiveSelectedSymbol })}
              </CardContent>
            </Card>
          )}

          {/* Chart */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{t('market.priceChart')}</CardTitle>
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
              {isChartBusy ? (
                <Skeleton className="h-[320px] w-full rounded-lg" />
              ) : displayChart?.points && displayChart.points.length > 0 ? (
                <div className="space-y-4">
                  <AreaChart
                    data={displayChart.points}
                    xAccessor={(d) => new Date(d.time)}
                    xIsDate
                    height={320}
                    xTickFormat={(v) => fmtDate((v as Date).getTime(), selectedRange.range, appSettings.dateFormat, locale)}
                    yTickFormat={(v) => fmtNum(v, { maximumFractionDigits: 2 })}
                    tooltipTitle={(d) => formatDateTimeWithAppSettings(new Date(d.time), appSettings.dateFormat, locale)}
                    tooltipValueFormat={(v) => fmtPrice(v, displayChart.currency || "USD")}
                    series={[
                      {
                        key: "close",
                        label: t('market.priceChart'),
                        accessor: (d) => d.close,
                        color: isPositive ? "hsl(var(--accent))" : "hsl(var(--destructive))",
                        strokeWidth: 2,
                      },
                    ] as AreaSeries<typeof displayChart.points[number]>[]}
                  />

                  {/* Volume bars — Yahoo only; provider history carries no volume. */}
                  {!isProviderAsset && (
                    <BarChart
                      data={displayChart.points}
                      categoryAccessor={(d) => String(d.time)}
                      height={60}
                      barRadius={2}
                      margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
                      categoryTickFormat={() => ""}
                      valueTickFormat={() => ""}
                      tooltipTitle={(d) => formatDateTimeWithAppSettings(new Date(d.time), appSettings.dateFormat, locale)}
                      tooltipValueFormat={(v) => fmtLargeNum(v)}
                      series={[
                        {
                          key: "volume",
                          label: t('market.volume'),
                          accessor: (d) => d.volume,
                          color: "hsl(var(--muted-foreground))",
                        },
                      ] as BarSeries<typeof displayChart.points[number]>[]}
                    />
                  )}
                </div>
              ) : (
                <div className="h-[320px] flex items-center justify-center text-sm text-muted-foreground">
                  {t('market.noChartData')}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Key Metrics */}
          {quote && !isProviderAsset && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
                    <Activity className="h-4 w-4" /> {t('market.tradingInfo')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2.5">
                    {[
                      { label: t('market.open'), value: fmtPrice(quote.open, quote.currency) },
                      { label: t('market.dayHigh'), value: fmtPrice(quote.dayHigh, quote.currency) },
                      { label: t('market.dayLow'), value: fmtPrice(quote.dayLow, quote.currency) },
                      { label: t('market.prevClose'), value: fmtPrice(quote.prevClose, quote.currency) },
                      { label: t('market.volume'), value: fmtLargeNum(quote.volume) },
                      { label: t('market.avgVolume'), value: fmtLargeNum(quote.avgVolume) },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex justify-between items-center py-1 border-b border-border/50 last:border-0">
                        <span className="text-sm text-muted-foreground">{label}</span>
                        <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
                    <DollarSign className="h-4 w-4" /> {t('market.fundamentals')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2.5">
                    {(() => {
                      // FMP-preferred merged fundamentals, falling back per field
                      // to the Yahoo quote. 52-week range is a price field only
                      // the quote carries.
                      const marketCap = fundamentals?.marketCap ?? quote.marketCap;
                      const pe = fundamentals?.pe ?? quote.pe;
                      const forwardPE = fundamentals?.forwardPE ?? quote.forwardPE;
                      const eps = fundamentals?.eps ?? quote.eps;
                      const dividendYield = fundamentals?.dividendYield ?? quote.dividendYield;
                      const beta = fundamentals?.beta ?? quote.beta;
                      const priceToBook = fundamentals?.priceToBook ?? quote.priceToBook;
                      const currency = fundamentals?.currency || quote.currency;
                      return [
                        { label: t('market.marketCap'), value: fmtLargeNum(marketCap) },
                        { label: t('market.pe'), value: pe ? pe.toFixed(2) : "—" },
                        { label: t('market.forwardPE'), value: forwardPE ? forwardPE.toFixed(2) : "—" },
                        { label: t('market.eps'), value: eps ? fmtPrice(eps, currency) : "—" },
                        { label: t('market.divYield'), value: dividendYield ? `${(dividendYield * 100).toFixed(2)}%` : "—" },
                        { label: t('market.beta'), value: beta != null ? beta.toFixed(2) : "—" },
                        { label: t('market.priceBook'), value: priceToBook != null ? priceToBook.toFixed(2) : "—" },
                        { label: t('market.52wRange'), value: `${fmtPrice(quote.low52w, quote.currency)} – ${fmtPrice(quote.high52w, quote.currency)}` },
                      ];
                    })().map(({ label, value }) => (
                      <div key={label} className="flex justify-between items-center py-1 border-b border-border/50 last:border-0">
                        <span className="text-sm text-muted-foreground">{label}</span>
                        <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Analyst Ratings */}
          {quote?.analystConsensus && (() => {
            const { strongBuy, buy, hold, sell, strongSell } = quote.analystConsensus!;
            const total = strongBuy + buy + hold + sell + strongSell;
            if (total === 0) return null;
            const bullish = strongBuy + buy;
            const bearish = sell + strongSell;
            const bullPct = bullish / total;
            const bearPct = bearish / total;
            const verdict =
              bullPct >= 0.6 ? t('market.strongBuy')
                : bullPct >= 0.45 ? t('market.buy')
                  : bearPct >= 0.6 ? t('market.strongSell')
                    : bearPct >= 0.45 ? t('market.sell')
                      : t('market.hold');
            const verdictColor =
              bullPct >= 0.45 ? "text-success"
                : bearPct >= 0.45 ? "text-destructive"
                  : "text-yellow-500 dark:text-yellow-400";
            return (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="h-4 w-4" /> {t('market.analystRatings')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-start gap-6">
                    <div className="text-center shrink-0">
                      <div className={cn("text-2xl font-bold", verdictColor)}>{verdict}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {total !== 1 ? t('market.analystCountPlural', { n: total }) : t('market.analystCount', { n: total })}
                      </div>
                    </div>
                    <div className="flex-1 space-y-2">
                      {([
                        { label: t('market.strongBuy'), count: strongBuy, barClass: "bg-success" },
                        { label: t('market.buy'), count: buy, barClass: "bg-success/60" },
                        { label: t('market.hold'), count: hold, barClass: "bg-yellow-400" },
                        { label: t('market.sell'), count: sell, barClass: "bg-destructive/60" },
                        { label: t('market.strongSell'), count: strongSell, barClass: "bg-destructive" },
                      ] as { label: string; count: number; barClass: string }[]).map(({ label, count, barClass }) => (
                        <div key={label} className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground w-20 shrink-0">{label}</span>
                          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className={cn("h-full rounded-full", barClass)}
                              style={{ width: `${(count / total) * 100}%` }}
                            />
                          </div>
                          <span className="w-4 text-right tabular-nums text-muted-foreground">{count}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {quote.recentAnalystActions && quote.recentAnalystActions.length > 0 && (
                    <div className="border-t border-border pt-3">
                      <p className="text-xs font-medium text-muted-foreground mb-2">{t('market.recentActions')}</p>
                      <div className="space-y-2">
                        {quote.recentAnalystActions.map((action) => (
                          <div key={`${action.date}-${action.firm}`} className="flex items-center gap-2 text-xs">
                            {action.action === "up"
                              ? <TrendingUp className="h-3 w-3 text-success shrink-0" />
                              : action.action === "down"
                                ? <TrendingDown className="h-3 w-3 text-destructive shrink-0" />
                                : <ArrowUpDown className="h-3 w-3 text-muted-foreground shrink-0" />}
                            <span className="text-muted-foreground shrink-0 w-20 tabular-nums whitespace-nowrap">
                              {formatDateStringWithAppSettings(action.date, appSettings.dateFormat)}
                            </span>
                            <span className="font-medium text-foreground truncate flex-1">{action.firm}</span>
                            <span className={cn("shrink-0", gradeColor(action.toGrade))}>
                              {action.toGrade}
                              {action.fromGrade && action.fromGrade !== action.toGrade && (
                                <span className="text-muted-foreground font-normal"> ← {action.fromGrade}</span>
                              )}
                            </span>
                            {action.priceTarget != null && (
                              <span className="shrink-0 text-muted-foreground ml-2">
                                PT {fmtPrice(action.priceTarget, quote.currency)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })()}

          {/* News — Yahoo only; provider-priced assets have no news feed. */}
          {!isProviderAsset && (
          <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Newspaper className="h-4 w-4" /> {t('market.latestNews')}
                </CardTitle>
            </CardHeader>
            <CardContent>
              {isNewsLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="flex gap-3">
                      <Skeleton className="h-16 w-24 rounded shrink-0" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-3 w-2/3" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : newsData?.articles && newsData.articles.length > 0 ? (
                <div className="space-y-3">
                  {newsData.articles.map((article) => {
                    const safeHref = /^https?:\/\//i.test(article.link) ? article.link : undefined;
                    return (
                    <a
                      key={article.link}
                      href={safeHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex gap-3 p-2 -mx-2 rounded-md hover:bg-muted/70 transition-colors group"
                    >
                      {article.thumbnail && (
                        <RemoteNewsImage
                          src={article.thumbnail}
                          alt={article.title}
                          className="h-16 w-24 rounded shrink-0"
                          fallbackClassName="hidden"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground line-clamp-2 group-hover:text-primary transition-colors">
                          {article.title}
                        </p>
                        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                          <span>{article.publisher}</span>
                          {article.publishedAt && (
                            <>
                              <span>·</span>
                              <span>{formatDateWithAppSettings(new Date(article.publishedAt * 1000), appSettings.dateFormat)}</span>
                            </>
                          )}
                          <ExternalLink className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </div>
                    </a>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">{t('market.noNews')}</p>
              )}
            </CardContent>
          </Card>
          )}
        </>
      )}
    </div>
  );
}
