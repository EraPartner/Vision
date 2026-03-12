import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Search, Loader2 } from "lucide-react";
import { useDebounce } from "@/hooks/useDebounce";
import { useLanguage } from '@/contexts/LanguageContext';
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

import { API_BASE_URL } from "@/lib/api";

interface SearchResult {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
}

interface AddToWatchlistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddToWatchlistDialog({ open, onOpenChange }: AddToWatchlistDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<SearchResult | null>(null);
  const [assetClass, setAssetClass] = useState<"stock" | "etf" | "crypto">("stock");
  const [targetPrice, setTargetPrice] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const debouncedQuery = useDebounce(searchQuery, 300);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { t } = useLanguage();

  const { data: searchResults, isLoading: isSearching } = useQuery({
    queryKey: ["market-search", debouncedQuery],
    queryFn: async () => {
      if (!debouncedQuery || debouncedQuery.length < 2) return { items: [] };
      const res = await fetch(`${API_BASE_URL}/api/market/search?q=${encodeURIComponent(debouncedQuery)}`);
      if (!res.ok) return { items: [] };
      return res.json() as Promise<{ items: SearchResult[] }>;
    },
    enabled: debouncedQuery.length >= 2 && !selectedAsset,
  });

  // Fetch current price when asset is selected
  const { data: quoteData } = useQuery({
    queryKey: ["quote", selectedAsset?.symbol],
    queryFn: async () => {
      if (!selectedAsset?.symbol) return null;
      const res = await fetch(`${API_BASE_URL}/api/market/quote?symbols=${selectedAsset.symbol}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.quotes?.[0] || null;
    },
    enabled: !!selectedAsset?.symbol,
  });

  const handleSelectAsset = (result: SearchResult) => {
    setSelectedAsset(result);
    setSearchQuery("");
    // Auto-detect asset class
    const type = result.type?.toLowerCase() || "";
    if (type.includes("etf")) setAssetClass("etf");
    else if (type.includes("crypto") || type.includes("cryptocurrency")) setAssetClass("crypto");
    else setAssetClass("stock");
  };

  const handleSubmit = async () => {
    if (!selectedAsset || !targetPrice) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: selectedAsset.name,
          symbol: selectedAsset.symbol,
          asset_class: assetClass,
          target_price: parseFloat(targetPrice),
          currency,
          notes: notes || null,
          price_provider_id: selectedAsset.symbol,
        }),
      });

      if (!res.ok) throw new Error("Failed to add to watchlist");

      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
      toast({ title: t('addWatchlist.success') });
      handleClose();
    } catch (err) {
      toast({ title: t('addWatchlist.error'), description: t('addWatchlist.failed'), variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setSelectedAsset(null);
    setSearchQuery("");
    setTargetPrice("");
    setNotes("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('addWatchlist.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {!selectedAsset ? (
              <div className="space-y-2">
                <Label>{t('addWatchlist.searchLabel')}</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                  placeholder={t('addWatchlist.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>

              {isSearching && (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}

              {searchResults?.items && searchResults.items.length > 0 && (
                <div className="border rounded-md max-h-60 overflow-y-auto">
                  {searchResults.items.map((result) => (
                    <button
                      key={result.symbol}
                      onClick={() => handleSelectAsset(result)}
                      className="w-full text-left px-3 py-2 hover:bg-muted transition-colors border-b last:border-b-0"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-medium">{result.symbol}</span>
                          <span className="text-muted-foreground ml-2 text-sm">{result.name}</span>
                        </div>
                        <Badge variant="outline" className="text-xs">
                          {result.type}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{result.exchange}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="bg-muted/50 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{selectedAsset.name}</p>
                    <Badge variant="outline" className="font-mono text-xs mt-1">
                      {selectedAsset.symbol}
                    </Badge>
                  </div>
                      <Button variant="ghost" size="sm" onClick={() => setSelectedAsset(null)}>
                        {t('addWatchlist.change')}
                      </Button>
                    </div>
                    {quoteData && (
                      <p className="text-sm text-muted-foreground mt-2">
                        {t('addWatchlist.currentPrice', { price: quoteData.price?.toFixed(2) })}
                      </p>
                    )}
                  </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                    <Label>{t('addWatchlist.assetClass')}</Label>
                  <Select value={assetClass} onValueChange={(v) => setAssetClass(v as any)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stock">{t('addWatchlist.stock')}</SelectItem>
                      <SelectItem value="etf">{t('addWatchlist.etf')}</SelectItem>
                      <SelectItem value="crypto">{t('addWatchlist.crypto')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>{t('addWatchlist.currency')}</Label>
                  <Select value={currency} onValueChange={setCurrency}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="EUR">EUR</SelectItem>
                      <SelectItem value="GBP">GBP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

                <div className="space-y-2">
                  <Label>{t('addWatchlist.targetPrice')}</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder={quoteData ? t('addWatchlist.currentPrice', { price: quoteData.price?.toFixed(2) }) : t('addWatchlist.targetPlaceholder')}
                    value={targetPrice}
                    onChange={(e) => setTargetPrice(e.target.value)}
                  />
                {quoteData && targetPrice && (
                  <p className="text-xs text-muted-foreground">
                    {parseFloat(targetPrice) < quoteData.price
                      ? t('addWatchlist.belowCurrent', { n: ((1 - parseFloat(targetPrice) / quoteData.price) * 100).toFixed(1) })
                      : t('addWatchlist.aboveCurrent', { n: ((parseFloat(targetPrice) / quoteData.price - 1) * 100).toFixed(1) })}
                  </p>
                )}
                </div>

              <div className="space-y-2">
                <Label>{t('addWatchlist.notesOptional')}</Label>
                <Textarea
                  placeholder={t('addWatchlist.notesPlaceholder')}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                />
              </div>

              <Button
                className="w-full"
                onClick={handleSubmit}
                disabled={!targetPrice || isSubmitting}
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {t('addWatchlist.submit')}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
