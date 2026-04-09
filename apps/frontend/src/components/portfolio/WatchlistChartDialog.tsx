import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Target, TrendingUp, TrendingDown, Check } from "lucide-react";
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateWithAppSettings } from "@/components/shared/dateUtils";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { WatchlistItem } from "@/types/watchlist";

import { API_BASE_URL } from "@/lib/api";

const RANGES = [
  { label: "1M", range: "1mo", interval: "1d" },
  { label: "3M", range: "3mo", interval: "1d" },
  { label: "6M", range: "6mo", interval: "1d" },
  { label: "1Y", range: "1y", interval: "1wk" },
  { label: "5Y", range: "5y", interval: "1mo" },
];

interface ChartPoint {
  time: number;
  close: number;
}

interface WatchlistChartDialogProps {
  item: WatchlistItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WatchlistChartDialog({ item, open, onOpenChange }: WatchlistChartDialogProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const [selectedRange, setSelectedRange] = useState(RANGES[0]);
  const [editingPrice, setEditingPrice] = useState(false);
  const [newTargetPrice, setNewTargetPrice] = useState("");
  const queryClient = useQueryClient();

  const { data: chartData, isLoading: isChartLoading } = useQuery({
    queryKey: ["watchlist-chart", item?.symbol, selectedRange.range],
    queryFn: async () => {
      if (!item?.symbol) return null;
      const res = await fetch(
        `${API_BASE_URL}/api/market/chart?symbol=${item.symbol}&range=${selectedRange.range}&interval=${selectedRange.interval}`
      );
      if (!res.ok) return null;
      return res.json() as Promise<{ symbol: string; currency: string; points: ChartPoint[] }>;
    },
    enabled: !!item?.symbol && open,
  });

  const { data: quoteData } = useQuery({
    queryKey: ["watchlist-quote", item?.symbol],
    queryFn: async () => {
      if (!item?.symbol) return null;
      const res = await fetch(`${API_BASE_URL}/api/market/quote?symbols=${item.symbol}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.quotes?.[0] || null;
    },
    enabled: !!item?.symbol && open,
  });

  const handleUpdateTargetPrice = async () => {
    if (!item || !newTargetPrice) return;

    try {
      const res = await fetch(`${API_BASE_URL}/api/watchlist/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_price: parseFloat(newTargetPrice) }),
      });

      if (!res.ok) throw new Error("Failed to update");

      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
      toast.success(t('watchlist.targetUpdated'));
      setEditingPrice(false);
      setNewTargetPrice("");
    } catch {
      toast.error(t('common.error'), { description: t('watchlist.updateFailed') });
    }
  };

  if (!item) return null;

  const targetPrice = Number(item.target_price);
  const currentPrice = quoteData?.price ?? null;
  const isBelowTarget = currentPrice != null && currentPrice <= targetPrice;
  const priceDiff = currentPrice != null ? ((currentPrice - targetPrice) / targetPrice) * 100 : null;
  const formatDisplayCurrency = (value: number, currency: string) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: appSettings.showDecimalPlaces,
      maximumFractionDigits: appSettings.showDecimalPlaces,
    }).format(value);

  // Format chart data
  const formattedData = chartData?.points?.map((p) => ({
    date: formatDateWithAppSettings(new Date(p.time), appSettings.dateFormat),
    price: p.close,
    time: p.time,
  })) || [];

  // Find min/max for chart domain
  const prices = formattedData.map((d) => d.price).filter(Boolean);
  const allPrices = [...prices, targetPrice];
  const minPrice = Math.min(...allPrices) * 0.98;
  const maxPrice = Math.max(...allPrices) * 1.02;

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
                    placeholder={item.target_price.toString()}
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
                    <div className={cn(
                      "flex items-center gap-1 text-sm mt-1",
                      priceDiff! > 0 ? "text-red-500" : "text-green-500"
                    )}>
                    {priceDiff! > 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                    {Math.abs(priceDiff!).toFixed(2)}% {priceDiff! > 0 ? t('watchlistChart.aboveTarget', { n: Math.abs(priceDiff!).toFixed(0) }) : t('watchlistChart.belowTarget', { n: Math.abs(priceDiff!).toFixed(0) })}
                  </div>
                </>
              ) : (
                <Skeleton className="h-8 w-24" />
              )}
            </div>
          </div>

          {isBelowTarget && (
            <div className="bg-green-500/10 border border-green-500/30 text-green-600 dark:text-green-400 rounded-lg p-3 text-center font-medium">
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
              <Skeleton className="h-full w-full" />
            ) : formattedData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={formattedData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    tickFormatter={(value) => {
                      const date = new Date(value);
                      return formatDateWithAppSettings(date, appSettings.dateFormat);
                    }}
                    minTickGap={50}
                  />
                  <YAxis
                    domain={[minPrice, maxPrice]}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    tickFormatter={(value) => formatDisplayCurrency(value, item.currency)}
                    width={60}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--background))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                    }}
                    formatter={(value: number) => [
                      formatDisplayCurrency(value, item.currency),
                      t('watchlistChart.priceLabel'),
                    ]}
                  />
                  <ReferenceLine
                    y={targetPrice}
                    stroke="hsl(var(--primary))"
                    strokeDasharray="5 5"
                    strokeWidth={2}
                    label={{
                      value: t('watchlistChart.targetLabel', { currency: item.currency, price: formatDisplayCurrency(targetPrice, item.currency) }),
                      position: "insideTopRight",
                      fill: "hsl(var(--primary))",
                      fontSize: 12,
                      fontWeight: "bold",
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="price"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fill="url(#colorPrice)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
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
