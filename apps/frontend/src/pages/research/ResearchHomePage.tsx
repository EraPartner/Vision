import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Search, Telescope, GitCompareArrows, LineChart, Target, ArrowRight,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useDebounce } from "@/hooks/useDebounce";
import { apiClient } from "@/lib/api";
import { PageHeader } from "@/components/shared/PageHeader";
import { ResearchUnavailableNote } from "@/components/research/ResearchUnavailableNote";

export default function ResearchHomePage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [searchText, setSearchText] = useState("");
  const debouncedSearch = useDebounce(searchText.trim(), 300);

  const { data: searchResult, isFetching } = useQuery({
    queryKey: ["research-search", debouncedSearch],
    queryFn: () => apiClient.searchResearch(debouncedSearch),
    enabled: debouncedSearch.length >= 1,
    staleTime: 60_000,
  });

  const items = searchResult?.data.items ?? [];
  const searchUnavailable = searchResult?.meta.source === "unavailable";

  const { data: watchlist } = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => apiClient.getWatchlist(),
    staleTime: 60_000,
  });
  const watchlistPreview = useMemo(() => watchlist?.items?.slice(0, 6) ?? [], [watchlist]);

  const goToSymbol = (symbol: string) => {
    navigate(`/research/symbol/${encodeURIComponent(symbol)}`);
  };

  return (
    <div className="space-y-6 animate-in">
      <PageHeader title={t('research.title')} subtitle={t('research.subtitle')} icon={Telescope} />

      {/* Prominent search */}
      <div className="relative max-w-2xl">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
        <Input
          autoFocus
          placeholder={t('research.searchPlaceholder')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="h-14 pl-12 text-base glass-regular"
          aria-label={t('research.searchPlaceholder')}
        />
        {debouncedSearch.length >= 1 && searchText.length > 0 && (
          <Card className="absolute z-50 top-full mt-2 w-full shadow-lg border border-border glass-elevated">
            <CardContent className="p-1">
              {searchUnavailable ? (
                <div className="px-3 py-3">
                  <ResearchUnavailableNote provider={searchResult?.meta.provider ?? null} />
                </div>
              ) : items.length > 0 ? (
                items.map((item) => (
                  <button
                    key={`${item.symbol}-${item.exchange}`}
                    onClick={() => goToSymbol(item.symbol)}
                    className="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-md hover:bg-muted/70 transition-colors"
                  >
                    <span className="font-mono font-bold text-sm text-foreground min-w-[5rem]">
                      {item.symbol}
                    </span>
                    <span className="text-sm text-muted-foreground truncate flex-1">{item.name}</span>
                    <Badge variant="outline" className="text-[10px] shrink-0">{item.type}</Badge>
                    <span className="text-xs text-muted-foreground shrink-0">{item.exchange}</span>
                  </button>
                ))
              ) : !isFetching ? (
                <p className="px-3 py-3 text-sm text-muted-foreground">{t('research.noResults')}</p>
              ) : null}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Entry points */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
          icon={Target}
          title={t('nav.watchlist')}
          desc={t('research.entry.watchlist')}
          onClick={() => navigate("/research/watchlist")}
        />
      </div>

      {/* Watchlist preview */}
      {watchlistPreview.length > 0 && (
        <Card className="glass-regular">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Target className="h-4 w-4" /> {t('research.watchlistPreview')}
              </CardTitle>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => navigate("/research/watchlist")}>
                {t('research.viewAll')} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {watchlistPreview.map((item) => (
                <button
                  key={item.id}
                  onClick={() => item.symbol && goToSymbol(item.symbol)}
                  disabled={!item.symbol}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/70 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {item.symbol && <span className="font-mono font-semibold">{item.symbol}</span>}
                  <span className="text-muted-foreground truncate max-w-[10rem]">{item.name}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
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
      className="text-left rounded-xl border border-border glass-regular p-4 hover:border-primary/50 hover:shadow-md transition-all group"
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
