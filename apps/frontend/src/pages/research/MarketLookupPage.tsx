import { useState, useCallback, useMemo } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { formatCompactNumber } from "@/utils/formatCompactNumber";
import {
  formatDateTimeWithAppSettings,
  formatDateWithAppSettings,
} from "@/components/shared/dateUtils";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SegmentedButtons } from "@/components/shared/SegmentedButtons";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  TrendingUp, TrendingDown, BarChart3, Activity, Clock, Star, Link2,
} from "lucide-react";
import { AreaChart, BarChart, type AreaSeries, type BarSeries } from "@/components/charts";
import { useSymbolSearch } from "@/hooks/useSymbolSearch";
import { cn } from "@/lib/utils";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { getInvestmentPriceHistory } from "@/lib/api/portfolio";
import { AddInvestmentFromMarketDialog } from "@/components/portfolio/AddInvestmentFromMarketDialog";
import { AddToWatchlistDialog } from "@/components/portfolio/AddToWatchlistDialog";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/shared/PageHeader";
import { SymbolSearchResultItem } from "@/components/shared/SymbolSearchResultItem";
import { SymbolSearchBox } from "@/components/shared/SymbolSearchBox";
import { ResearchFundamentalsTab } from "@/components/research/ResearchFundamentalsTab";
import { ResearchAnalystTab } from "@/components/research/ResearchAnalystTab";
import { ResearchNewsTab } from "@/components/research/ResearchNewsTab";
import { ResearchMappingDialog } from "@/components/research/ResearchMappingDialog";

import { apiClient } from "@/lib/api";

import { LOOKUP_RANGES as RANGES } from "@/lib/research/ranges";

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
  // Shared cached currency formatter; quotes pin 2 decimals regardless of the
  // showDecimalPlaces setting (unchanged behavior).
  const fmtCurrency = useCurrencyFormatter("USD");
  const fmtPrice = useCallback((val: number | null | undefined, currency = "USD") => {
    if (val == null || isNaN(val)) return "—";
    return fmtCurrency(val, currency, 2);
  }, [fmtCurrency]);
  const fmtLargeNum = useCallback(
    (val: number | null | undefined) =>
      formatCompactNumber(val, (v) => fmtNum(v, { maximumFractionDigits: 0 })),
    [fmtNum],
  );
  const [watchlistOpen, setWatchlistOpen] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("fundamentals");
  const [selectedRange, setSelectedRange] = useState(RANGES[2]); // 1M default
  const [searchParams, setSearchParams] = useSearchParams();
  // The selected symbol lives entirely in the URL, so a looked-up view is
  // shareable and survives reload. Picking a result (handleSelect) rewrites it.
  const effectiveSelectedSymbol = searchParams.get("symbol")?.trim().toUpperCase() || null;
  const { summaries, isLoading: isPortfolioLoading } = usePortfolio();
  const isOnline = useOnlineStatus();

  // When the page is opened from a portfolio holding (double-click), the URL
  // carries its investmentId. If that holding prices via a non-Yahoo provider
  // (Kinesis/custom/binance), Yahoo has no data for the symbol — so we serve the
  // chart + a minimal price header from the holding's own stored history instead.
  const investmentId = searchParams.get("investmentId");
  const mappingInvestmentId = useMemo(() => {
    const n = Number(investmentId);
    return investmentId && Number.isInteger(n) && n > 0 ? n : undefined;
  }, [investmentId]);
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

  // Search — trim: false keeps the query text (and so the "market-search"
  // cache keys) byte-identical with the historical inline wiring and with
  // AddToWatchlistDialog, which shares this cache scope.
  const { searchText, setSearchText, searchResult: searchResults, isFetching: isSearching, isOpen } =
    useSymbolSearch(apiClient.searchMarket, { queryKey: "market-search", trim: false });

  // Quote — price-only (detail=basic); the rich fundamentals/analyst/news now
  // come from the multi-provider research tabs below, so the quoteSummary fetch
  // is no longer needed here.
  const { data: quoteData, isFetching: isQuoteLoading } = useQuery({
    queryKey: ["market-quote", effectiveSelectedSymbol],
    queryFn: async () => {
      const { quotes } = await apiClient.getMarketQuotes<Quote>(effectiveSelectedSymbol!, { detail: "basic" });
      return quotes[0] ?? null;
    },
    enabled: useYahoo && isOnline,
    staleTime: 30_000,
    // Don't keep polling a failing quote endpoint while offline (matches the
    // sibling research pages that gate their price polls on online state).
    refetchInterval: isOnline ? 60_000 : false,
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

  const handleSelect = useCallback((symbol: string) => {
    // Drive the selection off the URL so the view is shareable/reload-safe, and
    // drop investmentId: a fresh symbol pick must query the newly-searched
    // symbol, not keep serving the previously deep-linked holding's data.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("symbol", symbol);
      next.delete("investmentId");
      return next;
    });
    setSearchText("");
  }, [setSearchParams, setSearchText]);

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
        open={isOpen && (searchResults?.items?.length ?? 0) > 0}
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
        <Card className="glass-regular">
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
            <Card className="glass-regular">
              <CardContent className="py-6 space-y-3">
                <Skeleton className="h-8 w-64" />
                <Skeleton className="h-12 w-40" />
                <Skeleton className="h-5 w-32" />
              </CardContent>
            </Card>
          ) : quote ? (
            <Card className="glass-regular">
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
                        isPositive ? "amount-gain" : "amount-loss"
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
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setWatchlistOpen(true)}
                      >
                        <Star className="h-4 w-4" />
                        {t('addWatchlist.title')}
                      </Button>
                    )}
                    {quote && !isProviderAsset && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setMappingOpen(true)}
                      >
                        <Link2 className="h-4 w-4" />
                        {t('research.mapping.button')}
                      </Button>
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
            <Card className="glass-regular">
              <CardContent className="py-8 text-center text-muted-foreground">
                {t('market.noQuote', { symbol: effectiveSelectedSymbol })}
              </CardContent>
            </Card>
          )}

          {/* Quick add-to-watchlist for the symbol being looked up */}
          {quote && !isProviderAsset && (
            <AddToWatchlistDialog
              open={watchlistOpen}
              onOpenChange={setWatchlistOpen}
              prefill={{
                symbol: quote.symbol,
                name: quote.name,
                type: quote.type,
                currency: quote.currency,
                price: quote.price,
              }}
            />
          )}

          {/* Chart */}
          <Card className="glass-regular">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{t('market.priceChart')}</CardTitle>
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

          {/* Trading info (Yahoo symbols only) */}
          {quote && !isProviderAsset && (
            <Card className="glass-regular">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
                  <Activity className="h-4 w-4" /> {t('market.tradingInfo')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-x-8 gap-y-2.5 sm:grid-cols-3">
                  {[
                    { label: t('market.open'), value: fmtPrice(quote.open, quote.currency) },
                    { label: t('market.dayHigh'), value: fmtPrice(quote.dayHigh, quote.currency) },
                    { label: t('market.dayLow'), value: fmtPrice(quote.dayLow, quote.currency) },
                    { label: t('market.prevClose'), value: fmtPrice(quote.prevClose, quote.currency) },
                    { label: t('market.volume'), value: fmtLargeNum(quote.volume) },
                    { label: t('market.avgVolume'), value: fmtLargeNum(quote.avgVolume) },
                    { label: t('market.52wRange'), value: `${fmtPrice(quote.low52w, quote.currency)} – ${fmtPrice(quote.high52w, quote.currency)}` },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between items-center gap-2 py-1 border-b border-border/50">
                      <span className="text-sm text-muted-foreground">{label}</span>
                      <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Details — multi-provider scorecard + graded fundamentals, analyst
              consensus, and news (lazy per tab). Hidden for provider-priced
              assets, which Yahoo/FMP don't cover. */}
          {effectiveSelectedSymbol && !isProviderAsset && (
            <Card className="glass-regular">
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
                    <ResearchFundamentalsTab symbol={effectiveSelectedSymbol} enabled={activeTab === "fundamentals"} />
                  </TabsContent>
                  <TabsContent value="analyst" className="pt-4">
                    <ResearchAnalystTab symbol={effectiveSelectedSymbol} enabled={activeTab === "analyst"} />
                  </TabsContent>
                  <TabsContent value="news" className="pt-4">
                    <ResearchNewsTab symbol={effectiveSelectedSymbol} enabled={activeTab === "news"} />
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          )}

          {/* Cross-provider symbol mapping (matches the retired symbol page) */}
          {effectiveSelectedSymbol && !isProviderAsset && (
            <ResearchMappingDialog
              open={mappingOpen}
              onOpenChange={setMappingOpen}
              instrumentKey={effectiveSelectedSymbol}
              keyType="internal"
              query={effectiveSelectedSymbol}
              displayName={quote?.name ?? effectiveSelectedSymbol}
              investmentId={mappingInvestmentId}
            />
          )}
        </>
      )}
    </div>
  );
}
