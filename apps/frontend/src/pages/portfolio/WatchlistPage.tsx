import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, TrendingUp, TrendingDown, Target, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { AddToWatchlistDialog } from "@/components/portfolio/AddToWatchlistDialog";
import { WatchlistChartDialog } from "@/components/portfolio/WatchlistChartDialog";
import type { WatchlistItem } from "@/types/watchlist";

import { API_BASE_URL } from "@/lib/api";

const ASSET_CLASS_COLORS: Record<string, string> = {
  stock: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  etf: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  crypto: "bg-amber-500/10 text-amber-500 border-amber-500/20",
};

export default function WatchlistPage() {
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<WatchlistItem | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["watchlist"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/watchlist`);
      if (!res.ok) throw new Error("Failed to fetch watchlist");
      return res.json() as Promise<{ items: WatchlistItem[]; total: number }>;
    },
  });

  // Fetch current prices for all symbols
  const symbols = data?.items?.map((i) => i.symbol).filter(Boolean).join(",") || "";
  const { data: quotesData } = useQuery({
    queryKey: ["watchlist-quotes", symbols],
    queryFn: async () => {
      if (!symbols) return { quotes: [] };
      const res = await fetch(`${API_BASE_URL}/api/market/quote?symbols=${symbols}`);
      if (!res.ok) return { quotes: [] };
      return res.json() as Promise<{ quotes: Array<{ symbol: string; price: number; change: number; changePercent: number }> }>;
    },
    enabled: !!symbols,
    refetchInterval: 60_000, // Refresh every minute
  });

  const priceMap = new Map(quotesData?.quotes?.map((q) => [q.symbol, q]) || []);

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API_BASE_URL}/api/watchlist/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
      toast({ title: "Removed from watchlist" });
    },
  });

  const handleDoubleClick = (item: WatchlistItem) => {
    setSelectedItem(item);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Watchlist</h1>
          <p className="text-muted-foreground mt-1">
            Track prospective investments with target buy prices
          </p>
        </div>
        <Button onClick={() => setAddDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add to Watchlist
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : !data?.items?.length ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Target className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground text-center">
              No prospective investments yet.<br />
              Add stocks, ETFs, or crypto you're watching.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.items.map((item) => {
            const quote = item.symbol ? priceMap.get(item.symbol) : null;
            const currentPrice = quote?.price ?? null;
            const priceDiff = currentPrice != null ? ((currentPrice - item.target_price) / item.target_price) * 100 : null;
            const isBelowTarget = currentPrice != null && currentPrice <= item.target_price;

            return (
              <Card
                key={item.id}
                className={cn(
                  "cursor-pointer transition-all hover:shadow-md hover:border-primary/50",
                  isBelowTarget && "ring-2 ring-green-500/50"
                )}
                onDoubleClick={() => handleDoubleClick(item)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="text-lg">{item.name}</CardTitle>
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
                      <p className="text-xs text-muted-foreground">Target Price</p>
                      <p className="text-xl font-semibold text-primary">
                        {item.currency} {item.target_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                    </div>
                    {currentPrice != null && (
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Current</p>
                        <p className="text-lg font-medium">
                          {item.currency} {currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                        <div className={cn(
                          "flex items-center text-xs gap-1",
                          priceDiff! > 0 ? "text-red-500" : "text-green-500"
                        )}>
                          {priceDiff! > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                          {Math.abs(priceDiff!).toFixed(1)}% {priceDiff! > 0 ? "above" : "below"} target
                        </div>
                      </div>
                    )}
                  </div>

                  {isBelowTarget && (
                    <div className="bg-green-500/10 text-green-600 dark:text-green-400 text-xs px-2 py-1 rounded text-center font-medium">
                      ✓ Price is at or below your target!
                    </div>
                  )}

                  {item.notes && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{item.notes}</p>
                  )}

                  <div className="flex items-center justify-between pt-2 border-t border-border/50">
                    <p className="text-xs text-muted-foreground">Double-click for chart</p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
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
