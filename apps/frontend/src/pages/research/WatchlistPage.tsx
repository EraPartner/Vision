import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { loadingSurfaceProps } from "@/lib/loadingSurface";
import { Plus, TrendingUp, Target, Trash2, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { AddToWatchlistDialog } from "@/components/portfolio/AddToWatchlistDialog";
import { WatchlistChartDialog } from "@/components/portfolio/WatchlistChartDialog";
import type { WatchlistItem } from "@/types/watchlist";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { onActivateKeyDown } from "@/utils/a11y";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useMarketQuotesQuery } from "@/hooks/useMarketQuotesQuery";
import { toast } from "sonner";

import { apiClient } from "@/lib/api";
import { watchlistKeys } from "@/lib/queryKeys";

const ASSET_CLASS_COLORS: Record<string, string> = {
  stock: "bg-chart-3/10 text-chart-3 border-chart-3/20",
  etf: "bg-chart-1/10 text-chart-1 border-chart-1/20",
  crypto: "bg-warning/10 text-warning border-warning/20",
};

export default function WatchlistPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const isOnline = useOnlineStatus();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<WatchlistItem | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: watchlistKeys.all,
    queryFn: () => apiClient.getWatchlist(),
  });

  const symbols = data?.items?.map((i) => i.symbol).filter(Boolean).join(",") || "";
  const { data: quotesData, isError: quotesError } = useMarketQuotesQuery(["watchlist-quotes", symbols], symbols);
  const quotesUnavailable = !isOnline || quotesError;

  const priceMap = new Map(quotesData?.map((q) => [q.symbol, q]) || []);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiClient.deleteWatchlistItem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: watchlistKeys.all });
      toast.success(t('watchlist.removedSuccess'));
    },
  });

  const handleDoubleClick = (item: WatchlistItem) => {
    setSelectedItem(item);
  };

  const handleNameDoubleClick = (item: WatchlistItem) => {
    if (!item.symbol) {
      setSelectedItem(item);
      return;
    }
    navigate(`/research/market?symbol=${encodeURIComponent(item.symbol)}`);
  };

  // Shared cached currency formatter (app locale + showDecimalPlaces defaults).
  const formatDisplayCurrency = useCurrencyFormatter();

  const watchlistEmptyLines = t('watchlist.empty').split('\n');
  const watchlistEmptyTitle = watchlistEmptyLines[0] ?? t('watchlist.empty');
  const watchlistEmptyDescriptionLines = watchlistEmptyLines.slice(1);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('watchlist.title')}
        subtitle={t('watchlist.subtitle')}
        icon={Target}
        actions={
        <Button onClick={() => setAddDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          {t('watchlist.addButton')}
        </Button>
        }
      />

      {quotesUnavailable && data?.items && data.items.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <WifiOff className="h-4 w-4 mt-0.5 text-warning shrink-0" />
          <div className="flex-1 text-foreground/80">
            {t('watchlist.quotesOffline')}
          </div>
        </div>
      )}

      {isLoading ? (
        <div {...loadingSurfaceProps} className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : !data?.items?.length ? (
        <Card>
          <CardContent className="pt-0">
            <EmptyState
              icon={Target}
              title={watchlistEmptyTitle}
              description={watchlistEmptyDescriptionLines.length > 0 ? (
                <>
                  {watchlistEmptyDescriptionLines.map((line, i) => (
                    <span key={i}>
                      {line}
                      {i < watchlistEmptyDescriptionLines.length - 1 && <br />}
                    </span>
                  ))}
                </>
              ) : undefined}
              action={
                <Button onClick={() => setAddDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  {t('watchlist.addButton')}
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.items.map((item) => {
            const quote = item.symbol ? priceMap.get(item.symbol) : null;
            const currentPrice = quote?.price ?? null;
            const priceDiff = currentPrice != null ? ((currentPrice - item.target_price) / item.target_price) * 100 : null;
            const isBelowTarget = currentPrice != null && currentPrice <= item.target_price;
            // What-if backtest (ADR-097): return since the day it was added, using the
            // price snapshotted at add time. Only when both prices are known.
            const addedPrice = item.added_price ?? null;
            const sinceAddedPct = addedPrice != null && addedPrice > 0 && currentPrice != null
              ? ((currentPrice - addedPrice) / addedPrice) * 100
              : null;
            const addedDate = new Date(item.created_at).toLocaleDateString(locale);

            return (
              <Card
                key={item.id}
                role="button"
                tabIndex={0}
                aria-label={item.name}
                className={cn(
                  // cv-auto: skip layout + the backdrop-filter blur composite for
                  // off-screen cards in this uncapped grid (compositor cost scales
                  // with visible count, not total). Appearance unchanged on screen.
                  // Lifts on hover, so it settles on press: `press-feedback`
                  // supplies the scale (and outranks micro-lift's hover
                  // transform), `active:translate-y-0` cancels Card's
                  // Tailwind hover lift, which rides the separate `translate`
                  // property in Tailwind v4 and so is not cancelled by it.
                  "cv-auto glass-regular premium-frame micro-lift press-feedback active:translate-y-0 cursor-pointer transition-[box-shadow,border-color] hover:shadow-glass-soft hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  isBelowTarget && "ring-2 ring-success/50"
                )}
                onDoubleClick={() => handleDoubleClick(item)}
                onKeyDown={onActivateKeyDown(() => handleDoubleClick(item))}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle
                        className="text-lg cursor-pointer hover:underline"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          handleNameDoubleClick(item);
                        }}
                      >
                        {item.name}
                      </CardTitle>
                      {item.symbol && (
                        <Badge variant="outline" className="font-mono text-xs">
                          {item.symbol}
                        </Badge>
                      )}
                    </div>
                    <Badge className={cn("text-xs", ASSET_CLASS_COLORS[item.asset_class])}>
                      {item.asset_class.toUpperCase()}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                       <p className="text-xs text-muted-foreground">{t('watchlist.targetPrice')}</p>
                      <p className="text-xl font-semibold text-primary">
                        {formatDisplayCurrency(item.target_price, item.currency)}
                      </p>
                    </div>
                    {currentPrice != null && (
                      <div className="text-right">
                        {priceDiff! > 0 ? (
                          // Above target: show percentage
                          <div className={cn(
                            "flex items-center text-sm gap-1 text-loss"
                          )}>
                            <TrendingUp className="h-4 w-4" />
                            {Math.abs(priceDiff!).toFixed(1)}% {t('watchlist.aboveTarget')}
                          </div>
                        ) : (
                          // At or below target: show current price
                          <>
                            <p className="text-xs text-muted-foreground">{t('watchlist.currentPrice')}</p>
                            <p className="text-lg font-medium">
                              {formatDisplayCurrency(currentPrice, item.currency)}
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {isBelowTarget && (
                    <div className="bg-success/10 text-success text-xs px-2 py-1 rounded text-center font-medium">
                      {t('watchlist.atTarget')}
                    </div>
                  )}

                  {sinceAddedPct != null && (
                    <div className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1.5 text-xs">
                      <span className="text-muted-foreground">{t('watchlist.sinceAdded', { date: addedDate })}</span>
                      <span className={cn('font-medium tabular-nums', sinceAddedPct >= 0 ? 'amount-gain' : 'amount-loss')}>
                        {sinceAddedPct >= 0 ? '+' : ''}{sinceAddedPct.toFixed(1)}%
                      </span>
                    </div>
                  )}

                  {item.notes && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{item.notes}</p>
                  )}

                  <div className="flex items-center justify-between pt-2 border-t border-border/50">
                      <p className="text-xs text-muted-foreground">{t('watchlist.doubleClickChart')}</p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="icon-touch-target text-muted-foreground hover:text-destructive"
                      aria-label={t('aria.removeFromWatchlist')}
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteMutation.mutate(item.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AddToWatchlistDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
      <WatchlistChartDialog
        item={selectedItem}
        open={!!selectedItem}
        onOpenChange={(open) => !open && setSelectedItem(null)}
      />
    </div>
  );
}
