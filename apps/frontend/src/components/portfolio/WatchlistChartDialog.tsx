import { useEffect, useState } from "react";
import { MAX_NUMERIC_18_6, parseDecimal } from "@/lib/decimal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { AreaChart, type AreaSeries, type AreaReferenceLine } from "@/components/charts";
import { Target, TrendingUp, TrendingDown, Check } from "lucide-react";
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { formatDateWithAppSettings } from "@/components/shared/dateUtils";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { WatchlistItem } from "@/types/watchlist";

import { apiClient } from "@/lib/api";
import { watchlistKeys } from "@/lib/queryKeys";
import { RESEARCH_RANGES as RANGES } from "@/lib/research/ranges";

interface WatchlistChartDialogProps {
  item: WatchlistItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WatchlistChartDialog({ item, open, onOpenChange }: WatchlistChartDialogProps) {
  const { t } = useLanguage();
  const loadingSurfaceProps = useLoadingSurfaceProps();
  const { appSettings } = useAppSettings();
  const [selectedRange, setSelectedRange] = useState(RANGES[0]);
  const [editingPrice, setEditingPrice] = useState(false);
  const [newTargetPrice, setNewTargetPrice] = useState("");
  const queryClient = useQueryClient();
  // Shared cached currency formatter (app locale + showDecimalPlaces defaults).
  const formatDisplayCurrency = useCurrencyFormatter();

  // This dialog is persistent — it stays mounted and is reused for each item.
  // Reset the per-item view state when the item changes so range selection,
  // edit mode, and the draft target price don't leak across watchlist items.
  useEffect(() => {
    setSelectedRange(RANGES[0]);
    setEditingPrice(false);
    setNewTargetPrice("");
  }, [item?.id]);

  const { data: chartData, isLoading: isChartLoading } = useQuery({
    queryKey: ["watchlist-chart", item?.symbol, selectedRange.range],
    queryFn: async () => {
      if (!item?.symbol) return null;
      try {
        return await apiClient.getMarketChart(item.symbol, selectedRange.range, selectedRange.interval);
      } catch {
        return null;
      }
    },
    enabled: !!item?.symbol && open,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const { data: quoteData } = useQuery({
    queryKey: ["watchlist-quote", item?.symbol],
    queryFn: async () => {
      if (!item?.symbol) return null;
      try {
        const quotes = await apiClient.getMarketQuotes(item.symbol, { detail: "basic" });
        return quotes[0] ?? null;
      } catch {
        return null;
      }
    },
    enabled: !!item?.symbol && open,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const handleUpdateTargetPrice = async () => {
    if (!item || !newTargetPrice) return;

    // parseDecimal's default 0-fallback would silently save a 0 target for
    // garbage input like "1e999"; validate explicitly instead.
    const targetValue = parseDecimal(newTargetPrice, NaN);
    if (!Number.isFinite(targetValue) || targetValue <= 0 || targetValue > MAX_NUMERIC_18_6) {
      toast.error(t('watchlistChart.invalidTarget'));
      return;
    }

    try {
      await apiClient.updateWatchlistItem(item.id, { target_price: targetValue });

      queryClient.invalidateQueries({ queryKey: watchlistKeys.all });
      toast.success(t('watchlist.targetUpdated'));
      setEditingPrice(false);
      setNewTargetPrice("");
    } catch (e) {
      toast.error(t('watchlist.updateFailed'), { description: apiErrorToMessage(e, t) });
    }
  };

  if (!item) return null;

  const rawTargetPrice = Number(item.target_price);
  const targetPrice = Number.isFinite(rawTargetPrice) ? rawTargetPrice : 0;
  const hasValidTarget = Number.isFinite(rawTargetPrice) && rawTargetPrice > 0;
  const currentPrice = quoteData?.price ?? null;
  const isBelowTarget = currentPrice != null && hasValidTarget && currentPrice <= targetPrice;
  const priceDiff = currentPrice != null && hasValidTarget
    ? ((currentPrice - targetPrice) / targetPrice) * 100
    : null;

  // Format chart data
  const formattedData = chartData?.points?.map((p) => ({
    date: formatDateWithAppSettings(new Date(p.time), appSettings.dateFormat),
    price: p.close,
    time: p.time,
  })) || [];

  // Find min/max for chart domain
  const prices = formattedData
    .map((d) => d.price)
    .filter((p): p is number => Number.isFinite(p) && p > 0);
  const allPrices = hasValidTarget ? [...prices, targetPrice] : prices;
  const hasChartDomain = allPrices.length > 0;
  const minPrice = hasChartDomain ? Math.min(...allPrices) * 0.98 : 0;
  const maxPrice = hasChartDomain ? Math.max(...allPrices) * 1.02 : 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <DialogTitle className="text-xl">{item.name}</DialogTitle>
            {item.symbol && (
              <Badge variant="outline" className="font-mono">
                {item.symbol}
              </Badge>
            )}
          </div>
          <DialogDescription className="sr-only">{item.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Price Summary */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-muted/50 rounded-lg p-4">
                 <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                 <Target className="h-4 w-4" />
                 {t('watchlistChart.targetPrice')}
               </div>
              {editingPrice ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    step="0.01"
                    value={newTargetPrice}
                    onChange={(e) => setNewTargetPrice(e.target.value)}
                    placeholder={hasValidTarget ? targetPrice.toString() : "0"}
                    className="h-8"
                  />
                  <Button size="sm" onClick={handleUpdateTargetPrice}>
                    <Check className="h-4 w-4" />
                  </Button>
                   <Button size="sm" variant="ghost" onClick={() => setEditingPrice(false)}>
                     {t('watchlistChart.cancelEdit')}
                   </Button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setNewTargetPrice(targetPrice.toString());
                    setEditingPrice(true);
                  }}
                  className="text-2xl font-bold text-primary hover:underline text-left"
                >
                  {formatDisplayCurrency(targetPrice, item.currency)}
                </button>
              )}
            </div>

            <div className="bg-muted/50 rounded-lg p-4">
              <p className="text-muted-foreground text-sm mb-1">{t('watchlistChart.currentPrice')}</p>
              {currentPrice != null ? (
                <>
                  <p className="text-2xl font-bold">
                    {formatDisplayCurrency(currentPrice, item.currency)}
                  </p>
                  {priceDiff != null && (
                    <div className={cn(
                      "flex items-center gap-1 text-sm mt-1",
                      priceDiff > 0 ? "text-loss" : "text-gain"
                    )}>
                      {priceDiff > 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                      {Math.abs(priceDiff).toFixed(2)}% {priceDiff > 0 ? t('watchlistChart.aboveTarget', { n: Math.abs(priceDiff).toFixed(0) }) : t('watchlistChart.belowTarget', { n: Math.abs(priceDiff).toFixed(0) })}
                    </div>
                  )}
                </>
              ) : (
                <Skeleton {...loadingSurfaceProps} className="h-8 w-24" />
              )}
            </div>
          </div>

          {isBelowTarget && (
            <div className="bg-success/10 border border-success/30 text-success rounded-lg p-3 text-center font-medium">
              ✓ {t('watchlistChart.atTarget')}
            </div>
          )}

          {/* Range selector */}
            <div className="flex gap-2 justify-center">
              {RANGES.map((r) => (
                <Button
                  key={r.label}
                  variant={selectedRange.range === r.range ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedRange(r)}
                >
                  {r.label}
                </Button>
              ))}
            </div>

          {/* Chart */}
          <div className="h-80 w-full">
            {isChartLoading ? (
              <Skeleton {...loadingSurfaceProps} className="h-full w-full" />
            ) : formattedData.length > 0 ? (
              <AreaChart
                data={formattedData}
                height={320}
                xAccessor={(d) => d.time}
                xIsDate
                series={[{
                  key: "price",
                  label: t('watchlistChart.priceLabel'),
                  accessor: (d) => d.price,
                  color: "hsl(var(--primary))",
                  strokeWidth: 2,
                }] as AreaSeries<typeof formattedData[number]>[]}
                yDomain={[minPrice, maxPrice]}
                xTickFormat={(v) => formatDateWithAppSettings(v instanceof Date ? v : new Date(v), appSettings.dateFormat)}
                yTickFormat={(v) => formatDisplayCurrency(v, item.currency)}
                tooltipTitle={(d) => d.date}
                tooltipValueFormat={(v) => formatDisplayCurrency(v, item.currency)}
                referenceLines={[{
                  y: targetPrice,
                  label: t('watchlistChart.targetLabel', { currency: item.currency, price: formatDisplayCurrency(targetPrice, item.currency) }),
                  color: "hsl(var(--primary))",
                  dashed: true,
                }] as AreaReferenceLine[]}
                margin={{ top: 10, right: 16, bottom: 28, left: 64 }}
              />
            ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                {t('watchlistChart.noData')}
              </div>
              )}
            </div>

          {item.notes && (
            <div className="bg-muted/30 rounded-lg p-4">
              <Label className="text-muted-foreground text-xs">{t('watchlistChart.notes')}</Label>
              <p className="mt-1 text-sm">{item.notes}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
