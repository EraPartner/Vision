import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Telescope, GitCompareArrows, LineChart, Target, ArrowRight,
  CandlestickChart, TrendingUp, TrendingDown, Activity, Plus, Globe,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { useSymbolSearch } from "@/hooks/useSymbolSearch";
import { useMarketQuotesQuery } from "@/hooks/useMarketQuotesQuery";
import { apiClient } from "@/lib/api";
import { watchlistKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import { PortfolioNewsFeed } from "@/components/portfolio/PortfolioNewsFeed";
import { ResearchUnavailableNote } from "@/components/research/ResearchUnavailableNote";
import { SymbolSearchResultItem } from "@/components/shared/SymbolSearchResultItem";
import { SymbolSearchBox } from "@/components/shared/SymbolSearchBox";

// Global-mix market snapshot (ADR-079 Research home). Yahoo index/crypto
// symbols; labels are proper nouns kept out of i18n. Index prices are points,
// not a currency, so the strip renders a plain locale-formatted number.
const BENCHMARKS: ReadonlyArray<{ symbol: string; label: string }> = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^STOXX50E", label: "Euro Stoxx 50" },
  { symbol: "^FTSE", label: "FTSE 100" },
  { symbol: "^BFX", label: "BEL 20" },
  { symbol: "BTC-USD", label: "Bitcoin" },
];
const BENCHMARK_SYMBOLS = BENCHMARKS.map((b) => b.symbol).join(",");

export default function ResearchHomePage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const navigate = useNavigate();
  const { searchText, setSearchText, searchResult, isFetching, isOpen } = useSymbolSearch(
    apiClient.searchResearch,
    { queryKey: "research-search" },
  );

  const numberFmt = useMemo(
    () => new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    [locale],
  );

  const items = searchResult?.data.items ?? [];
  const searchUnavailable = searchResult?.meta.source === "unavailable";

  // Live benchmark strip. 60s polling mirrors the watchlist quote cadence.
  const { data: benchmarkData } = useMarketQuotesQuery(["research-benchmarks", BENCHMARK_SYMBOLS], BENCHMARK_SYMBOLS, { staleTime: 60_000 });
  const benchmarkMap = useMemo(
    () => new Map((benchmarkData ?? []).map((q) => [q.symbol, q])),
    [benchmarkData],
  );

  const { data: watchlist } = useQuery({
    queryKey: watchlistKeys.all,
    queryFn: () => apiClient.getWatchlist(),
    staleTime: 60_000,
  });
  const watchlistItems = useMemo(() => watchlist?.items ?? [], [watchlist]);
  const watchlistPreview = useMemo(() => watchlistItems.slice(0, 9), [watchlistItems]);

  // Same key construction as WatchlistPage so the two pages share the cache.
  const watchlistSymbols = useMemo(
    () => watchlistItems.map((i) => i.symbol).filter(Boolean).join(","),
    [watchlistItems],
  );
  const { data: watchlistQuotes } = useMarketQuotesQuery(["watchlist-quotes", watchlistSymbols], watchlistSymbols, { staleTime: 60_000 });
  const watchlistPriceMap = useMemo(
    () => new Map((watchlistQuotes ?? []).map((q) => [q.symbol, q])),
    [watchlistQuotes],
  );

  // News seeds from watchlist symbols; an empty list yields general headlines.
  const newsSymbols = useMemo(
    () => watchlistItems.map((i) => i.symbol).filter((s): s is string => !!s).slice(0, 10),
    [watchlistItems],
  );

  const goToSymbol = (symbol: string) => {
    navigate(`/research/market?symbol=${encodeURIComponent(symbol)}`);
  };

  // Shared cached currency formatter (app locale + showDecimalPlaces defaults).
  const formatPrice = useCurrencyFormatter();

  return (
    <div className="space-y-6">
      <PageHeader title={t('research.title')} subtitle={t('research.subtitle')} icon={Telescope} />

      {/* Prominent search */}
      <SymbolSearchBox
        autoFocus
        className="max-w-2xl"
        placeholder={t('research.searchPlaceholder')}
        value={searchText}
        onChange={setSearchText}
        open={isOpen}
      >
        {searchUnavailable ? (
          <div className="px-3 py-3">
            <ResearchUnavailableNote provider={searchResult?.meta.provider ?? null} />
          </div>
        ) : items.length > 0 ? (
          items.map((item) => (
            <SymbolSearchResultItem
              key={`${item.symbol}-${item.exchange}`}
              item={item}
              onSelect={(it) => goToSymbol(it.symbol)}
            />
          ))
        ) : !isFetching ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">{t('research.noResults')}</p>
        ) : null}
      </SymbolSearchBox>

      {/* Market snapshot strip */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Activity className="h-4 w-4" /> {t('research.marketSnapshot')}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {BENCHMARKS.map((b) => {
            const quote = benchmarkMap.get(b.symbol);
            const pct = quote?.changePercent;
            const up = (pct ?? 0) >= 0;
            return (
              <Card key={b.symbol} className="glass-regular micro-lift">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-muted-foreground">{b.label}</span>
                    {pct != null && (
                      up
                        ? <TrendingUp className="h-3.5 w-3.5 shrink-0 text-gain" />
                        : <TrendingDown className="h-3.5 w-3.5 shrink-0 text-loss" />
                    )}
                  </div>
                  {quote ? (
                    <>
                      <p className="mt-2 text-lg font-bold tabular-nums">{numberFmt.format(quote.price)}</p>
                      <p className={cn("text-xs font-medium tabular-nums", up ? "amount-gain" : "amount-loss")}>
                        {up ? '+' : ''}{numberFmt.format(quote.change)} ({up ? '+' : ''}{pct!.toFixed(2)}%)
                      </p>
                    </>
                  ) : (
                    <p className="mt-2 text-lg font-bold text-muted-foreground/40 tabular-nums">—</p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Entry points — all five research tools */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <EntryCard
          icon={Globe}
          title={t('nav.markets')}
          desc={t('research.entry.markets')}
          onClick={() => navigate("/research/markets")}
        />
        <EntryCard
          icon={LineChart}
          title={t('nav.marketLookup')}
          desc={t('research.entry.market')}
          onClick={() => navigate("/research/market")}
        />
        <EntryCard
          icon={GitCompareArrows}
          title={t('nav.compare')}
          desc={t('research.entry.compare')}
          onClick={() => navigate("/research/compare")}
        />
        <EntryCard
          icon={CandlestickChart}
          title={t('research.builder.title')}
          desc={t('research.entry.charts')}
          onClick={() => navigate("/research/charts")}
        />
        <EntryCard
          icon={TrendingUp}
          title={t('research.forecast.title')}
          desc={t('research.entry.forecast')}
          onClick={() => navigate("/research/forecast")}
        />
        <EntryCard
          icon={Target}
          title={t('nav.watchlist')}
          desc={t('research.entry.watchlist')}
          onClick={() => navigate("/research/watchlist")}
        />
      </div>

      {/* Watchlist + News */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-stretch">
        <div className="h-full min-h-0 lg:col-span-2">
          <Card className="flex h-full flex-col glass-regular">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Target className="h-4 w-4" /> {t('research.watchlistPreview')}
                </CardTitle>
                {watchlistPreview.length > 0 && (
                  <Button variant="ghost" size="sm" className="text-xs" onClick={() => navigate("/research/watchlist")}>
                    {t('research.viewAll')} <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">
              {watchlistPreview.length > 0 ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {watchlistPreview.map((item) => {
                    const quote = item.symbol ? watchlistPriceMap.get(item.symbol) : undefined;
                    const pct = quote?.changePercent;
                    const up = (pct ?? 0) >= 0;
                    return (
                      <button
                        key={item.id}
                        onClick={() => item.symbol && goToSymbol(item.symbol)}
                        disabled={!item.symbol}
                        className="press-feedback rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <div className="flex items-center gap-2">
                          {item.symbol
                            ? <span className="font-mono text-sm font-bold">{item.symbol}</span>
                            : <span className="text-sm font-semibold truncate">{item.name}</span>}
                          {pct != null && (
                            <span className={cn("ml-auto text-xs font-medium tabular-nums", up ? "amount-gain" : "amount-loss")}>
                              {up ? '+' : ''}{pct.toFixed(2)}%
                            </span>
                          )}
                        </div>
                        {item.symbol && (
                          <p className="mt-1 truncate text-xs text-muted-foreground">{item.name}</p>
                        )}
                        <p className="mt-1 text-sm font-semibold tabular-nums">
                          {quote ? formatPrice(quote.price, item.currency) : <span className="text-muted-foreground/40">—</span>}
                        </p>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <Target className="mb-3 h-10 w-10 text-muted-foreground/30" />
                  <p className="mb-3 text-sm text-muted-foreground">{t('research.watchlistEmpty')}</p>
                  <Button size="sm" variant="outline" onClick={() => navigate("/research/watchlist")}>
                    <Plus className="mr-1.5 h-4 w-4" /> {t('research.watchlistEmptyCta')}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="h-full min-h-0 lg:col-span-1">
          <PortfolioNewsFeed symbols={newsSymbols} />
        </div>
      </div>
    </div>
  );
}

interface EntryCardProps {
  icon: typeof LineChart;
  title: string;
  desc: string;
  onClick: () => void;
}

function EntryCard({ icon: Icon, title, desc, onClick }: EntryCardProps) {
  return (
    <button
      onClick={onClick}
      className="press-feedback text-left rounded-xl border border-border glass-regular p-4 hover:border-primary/50 hover:shadow-glass-soft transition-[border-color,box-shadow] group"
    >
      <div className="flex items-center gap-3 mb-2">
        <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
          <Icon className="h-4 w-4" />
        </div>
        <span className="font-semibold text-foreground">{title}</span>
        <ArrowRight className="h-4 w-4 ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
      <p className="text-sm text-muted-foreground">{desc}</p>
    </button>
  );
}
