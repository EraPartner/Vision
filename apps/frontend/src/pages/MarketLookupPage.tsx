import { useState, useCallback } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Search, TrendingUp, TrendingDown, BarChart3, ArrowUpDown,
  Building2, DollarSign, Activity, Clock, Newspaper, ExternalLink, Plus, Users,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar,
} from "recharts";
import { useDebounce } from "@/hooks/useDebounce";
import { cn } from "@/lib/utils";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentFromMarketDialog } from "@/components/portfolio/AddInvestmentFromMarketDialog";

import { API_BASE_URL } from "@/lib/api";

interface NewsArticle {
  title: string;
  link: string;
  publisher: string;
  publishedAt: number | null;
  thumbnail: string | null;
  relatedSymbols: string[];
}

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

interface SearchResult {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
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
  if (/buy|outperform|overweight|accumulate/.test(g)) return "text-green-500 dark:text-green-400";
  if (/sell|underperform|underweight|reduce/.test(g)) return "text-destructive";
  return "text-yellow-500 dark:text-yellow-400";
}

function fmtDate(ts: number, range: string) {
  const d = new Date(ts);
  if (range === "1d" || range === "5d") {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (range === "1mo" || range === "3mo") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

export default function MarketLookupPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const fmtNum = (val: number | null | undefined, opts?: Intl.NumberFormatOptions) => {
    if (val == null || isNaN(val)) return "—";
    return new Intl.NumberFormat(locale, opts).format(val);
  };
  const fmtPrice = (val: number | null | undefined, currency = "USD") => {
    if (val == null || isNaN(val)) return "—";
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(val);
  };
  const fmtLargeNum = (val: number | null | undefined) => {
    if (val == null || isNaN(val)) return "—";
    if (val >= 1e12) return `${(val / 1e12).toFixed(2)}T`;
    if (val >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
    return fmtNum(val, { maximumFractionDigits: 0 });
  };
  const [searchText, setSearchText] = useState("");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState(RANGES[2]); // 1M default
  const debouncedSearch = useDebounce(searchText, 300);
  const { summaries } = usePortfolio();

  // Search
  const { data: searchResults, isFetching: isSearching } = useQuery({
    queryKey: ["market-search", debouncedSearch],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/market/search?q=${encodeURIComponent(debouncedSearch)}`);
      if (!res.ok) return { items: [] };
      return res.json() as Promise<{ items: SearchResult[] }>;
    },
    enabled: debouncedSearch.length >= 1,
    staleTime: 60_000,
  });

  // Quote
  const { data: quoteData, isFetching: isQuoteLoading } = useQuery({
    queryKey: ["market-quote", selectedSymbol],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/market/quote?symbols=${encodeURIComponent(selectedSymbol!)}`);
      if (!res.ok) throw new Error("Quote fetch failed");
      const data = await res.json() as { quotes: Quote[] };
      return data.quotes[0] || null;
    },
    enabled: !!selectedSymbol,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Chart
  const { data: chartData, isFetching: isChartLoading } = useQuery({
    queryKey: ["market-chart", selectedSymbol, selectedRange.range, selectedRange.interval],
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE_URL}/api/market/chart?symbol=${encodeURIComponent(selectedSymbol!)}&range=${selectedRange.range}&interval=${selectedRange.interval}`
      );
      if (!res.ok) throw new Error("Chart fetch failed");
      return res.json() as Promise<{ symbol: string; currency: string; points: ChartPoint[] }>;
    },
    enabled: !!selectedSymbol,
    staleTime: 60_000,
  });

  // News
  const { data: newsData, isFetching: isNewsLoading } = useQuery({
    queryKey: ["market-news", selectedSymbol],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/market/news?symbols=${encodeURIComponent(selectedSymbol!)}&count=10`);
      if (!res.ok) throw new Error("News fetch failed");
      return res.json() as Promise<{ articles: NewsArticle[] }>;
    },
    enabled: !!selectedSymbol,
    staleTime: 120_000,
  });

  const handleSelect = useCallback((symbol: string) => {
    setSelectedSymbol(symbol);
    setSearchText("");
  }, []);

  const quote = quoteData;
  const isPositive = (quote?.change ?? 0) >= 0;

  // Check if this asset already exists in portfolio
  const existingInvestment = quote ? summaries.find(s =>
    s.symbol?.toLowerCase() === quote.symbol.toLowerCase()
  ) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">{t('marketLookup.title')}</h1>
      </div>

      {/* Search */}
      <div className="relative max-w-xl">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('market.searchPlaceholder')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="pl-10"
        />
        {debouncedSearch.length >= 1 && searchResults?.items && searchResults.items.length > 0 && searchText.length > 0 && (
          <Card className="absolute z-50 top-full mt-1 w-full shadow-lg border border-border">
            <CardContent className="p-1">
              {searchResults.items.map((item) => (
                <button
                  key={item.symbol}
                  onClick={() => handleSelect(item.symbol)}
                  className="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-md hover:bg-muted/70 transition-colors"
                >
                  <span className="font-mono font-bold text-sm text-foreground min-w-[5rem]">
                    {item.symbol}
                  </span>
                  <span className="text-sm text-muted-foreground truncate flex-1">{item.name}</span>
                  <Badge variant="outline" className="text-[10px] shrink-0">{item.type}</Badge>
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

      {/* No selection state */}
      {!selectedSymbol && (
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
      {selectedSymbol && (
        <>
          {/* Header */}
          {isQuoteLoading ? (
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
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      <span>{t('market.autoRefresh')}</span>
                    </div>
                    {quote && (
                      <AddInvestmentFromMarketDialog
                        quote={quote}
                        existingInvestment={existingInvestment}
                      />
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {t('market.noQuote', { symbol: selectedSymbol })}
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
              {isChartLoading ? (
                <Skeleton className="h-[320px] w-full rounded-lg" />
              ) : chartData?.points && chartData.points.length > 0 ? (
                <div className="space-y-4">
                  <ResponsiveContainer width="100%" height={320}>
                    <AreaChart data={chartData.points}>
                      <defs>
                        <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={isPositive ? "hsl(var(--accent))" : "hsl(var(--destructive))"} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={isPositive ? "hsl(var(--accent))" : "hsl(var(--destructive))"} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="time"
                        tickFormatter={(ts) => fmtDate(ts, selectedRange.range)}
                        tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                        axisLine={false}
                        tickLine={false}
                        minTickGap={40}
                      />
                      <YAxis
                        domain={["auto", "auto"]}
                        tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v) => fmtNum(v, { maximumFractionDigits: 2 })}
                        width={70}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "var(--radius)",
                          color: "hsl(var(--card-foreground))",
                          fontSize: 12,
                        }}
                        labelFormatter={(ts) => new Date(ts).toLocaleString()}
                        formatter={(value: number) => [fmtPrice(value, chartData.currency || "USD"), t('market.priceChart')]}
                      />
                      <Area
                        type="monotone"
                        dataKey="close"
                        stroke={isPositive ? "hsl(var(--accent))" : "hsl(var(--destructive))"}
                        strokeWidth={2}
                        fill="url(#priceGrad)"
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>

                  {/* Volume bars */}
                  <ResponsiveContainer width="100%" height={60}>
                    <BarChart data={chartData.points}>
                      <Bar dataKey="volume" fill="hsl(var(--muted-foreground))" opacity={0.3} radius={[2, 2, 0, 0]} />
                      <XAxis dataKey="time" hide />
                      <YAxis hide />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "var(--radius)",
                          color: "hsl(var(--card-foreground))",
                          fontSize: 12,
                        }}
                        labelFormatter={(ts) => new Date(ts).toLocaleString()}
                        formatter={(value: number) => [fmtLargeNum(value), t('market.volume')]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-[320px] flex items-center justify-center text-sm text-muted-foreground">
                  {t('market.noChartData')}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Key Metrics */}
          {quote && (
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
                    {[
                      { label: t('market.marketCap'), value: fmtLargeNum(quote.marketCap) },
                      { label: t('market.pe'), value: quote.pe ? quote.pe.toFixed(2) : "—" },
                      { label: t('market.forwardPE'), value: quote.forwardPE ? quote.forwardPE.toFixed(2) : "—" },
                      { label: t('market.eps'), value: quote.eps ? fmtPrice(quote.eps, quote.currency) : "—" },
                      { label: t('market.divYield'), value: quote.dividendYield ? `${(quote.dividendYield * 100).toFixed(2)}%` : "—" },
                      { label: t('market.beta'), value: quote.beta != null ? quote.beta.toFixed(2) : "—" },
                      { label: t('market.priceBook'), value: quote.priceToBook != null ? quote.priceToBook.toFixed(2) : "—" },
                      { label: t('market.52wRange'), value: `${fmtPrice(quote.low52w, quote.currency)} – ${fmtPrice(quote.high52w, quote.currency)}` },
                    ].map(({ label, value }) => (
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
              bullPct >= 0.45 ? "text-green-500 dark:text-green-400"
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
                        { label: t('market.strongBuy'), count: strongBuy, barClass: "bg-green-600" },
                        { label: t('market.buy'), count: buy, barClass: "bg-green-400" },
                        { label: t('market.hold'), count: hold, barClass: "bg-yellow-400" },
                        { label: t('market.sell'), count: sell, barClass: "bg-red-400" },
                        { label: t('market.strongSell'), count: strongSell, barClass: "bg-red-600" },
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
                        {quote.recentAnalystActions.map((action, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            {action.action === "up"
                              ? <TrendingUp className="h-3 w-3 text-green-500 dark:text-green-400 shrink-0" />
                              : action.action === "down"
                                ? <TrendingDown className="h-3 w-3 text-destructive shrink-0" />
                                : <ArrowUpDown className="h-3 w-3 text-muted-foreground shrink-0" />}
                            <span className="text-muted-foreground shrink-0 w-14">
                              {new Date(action.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
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

          {/* News */}
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
                  {newsData.articles.map((article, i) => (
                    <a
                      key={i}
                      href={article.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex gap-3 p-2 -mx-2 rounded-md hover:bg-muted/70 transition-colors group"
                    >
                      {article.thumbnail && (
                        <img
                          src={article.thumbnail}
                          alt=""
                          className="h-16 w-24 object-cover rounded shrink-0"
                          loading="lazy"
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
                              <span>{new Date(article.publishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                            </>
                          )}
                          <ExternalLink className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">{t('market.noNews')}</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
