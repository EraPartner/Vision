import { useEffect, useState } from "react";
import { MAX_NUMERIC_18_6, parseDecimal } from "@/lib/decimal";
import { useQueryClient } from "@tanstack/react-query";
import { watchlistKeys } from "@/lib/queryKeys";
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
import { SymbolSearchResultItem } from "@/components/shared/SymbolSearchResultItem";
import { useDebounce, SEARCH_DEBOUNCE_MS } from "@/hooks/useDebounce";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { toast } from "sonner";

import { createWatchlistItem, type MarketSearchResult } from "@/lib/api/market";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import {
    useMarketQuoteQuery,
    useMarketSearchQuery,
} from "./usePortfolioQueries";

type SearchResult = MarketSearchResult;
type AssetClass = "stock" | "etf" | "crypto" | "metals";

/**
 * An already-known security to seed the dialog with, skipping the search step.
 * Used by callers like Market Lookup where the user is already viewing a symbol.
 */
export interface WatchlistPrefill {
    symbol: string;
    name: string;
    type?: string;
    currency?: string;
    /** Current price — used as the default target so the add is one confirm away. */
    price?: number;
}

function detectAssetClass(type: string | undefined): AssetClass {
    const t = type?.toLowerCase() ?? "";
    if (t.includes("etf")) return "etf";
    if (t.includes("crypto") || t.includes("cryptocurrency")) return "crypto";
    return "stock";
}

interface AddToWatchlistDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** When set, the dialog opens pre-filled with this asset instead of a search. */
    prefill?: WatchlistPrefill;
}

export function AddToWatchlistDialog({
    open,
    onOpenChange,
    prefill,
}: AddToWatchlistDialogProps) {
    const formatPercent = usePercentFormatter();
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedAsset, setSelectedAsset] = useState<SearchResult | null>(
        null,
    );
    const [assetClass, setAssetClass] = useState<
        "stock" | "etf" | "crypto" | "metals"
    >("stock");
    const [targetPrice, setTargetPrice] = useState("");
    const [currency, setCurrency] = useState("USD");
    const [notes, setNotes] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const debouncedQuery = useDebounce(searchQuery, SEARCH_DEBOUNCE_MS);
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    const { data: searchResults, isLoading: isSearching } =
        useMarketSearchQuery(
            debouncedQuery,
            debouncedQuery.length >= 2 && !selectedAsset,
        );

    const { data: quoteData } = useMarketQuoteQuery(selectedAsset?.symbol);

    // Seed from a prefill when the dialog opens that way (e.g. from Market
    // Lookup), so the user lands straight on the target-price step.
    useEffect(() => {
        if (!open || !prefill) return;
        setSelectedAsset({
            symbol: prefill.symbol,
            name: prefill.name,
            type: prefill.type ?? "",
            exchange: "",
        });
        setAssetClass(detectAssetClass(prefill.type));
        if (prefill.currency) setCurrency(prefill.currency);
        setTargetPrice(
            prefill.price != null && Number.isFinite(prefill.price)
                ? String(prefill.price)
                : "",
        );
        setSearchQuery("");
        // Re-seed only when a new prefilled asset opens, not on every keystroke.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, prefill?.symbol]);

    const handleSelectAsset = (result: SearchResult) => {
        setSelectedAsset(result);
        setSearchQuery("");
        setAssetClass(detectAssetClass(result.type));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedAsset || !targetPrice) return;

        // parseDecimal's default 0-fallback would silently save a 0 target for
        // garbage input like "1e999"; validate explicitly instead.
        const targetValue = parseDecimal(targetPrice, NaN);
        if (
            !Number.isFinite(targetValue) ||
            targetValue <= 0 ||
            targetValue > MAX_NUMERIC_18_6
        ) {
            toast.error(t("addWatchlist.invalidTarget"));
            return;
        }

        setIsSubmitting(true);
        try {
            await createWatchlistItem({
                name: selectedAsset.name,
                symbol: selectedAsset.symbol,
                asset_class: assetClass,
                target_price: targetValue,
                currency,
                notes: notes || undefined,
                price_provider_id: selectedAsset.symbol,
                // Snapshot the live price so we can later show "had I bought when I added it".
                added_price:
                    quoteData &&
                    Number.isFinite(quoteData.price) &&
                    quoteData.price > 0
                        ? quoteData.price
                        : undefined,
            });

            queryClient.invalidateQueries({ queryKey: watchlistKeys.all });
            toast.success(t("addWatchlist.success"));
            handleClose();
        } catch {
            toast.error(t("addWatchlist.error"), {
                description: t("addWatchlist.failed"),
            });
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

    const handleOpenChange = (nextOpen: boolean) => {
        if (nextOpen) {
            onOpenChange(true);
        } else {
            handleClose();
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("addWatchlist.title")}</DialogTitle>
                    <DialogDescription className="sr-only">
                        {t("addWatchlist.title")}
                    </DialogDescription>
                </DialogHeader>

                {/* Real <form>: Enter in the target-price (or notes-adjacent) fields
            submits. In the search step handleSubmit's !selectedAsset guard makes
            Enter a no-op. Same block layout as the div it replaces. */}
                <form onSubmit={handleSubmit} className="space-y-4">
                    {!selectedAsset ? (
                        <div className="space-y-2">
                            <Label htmlFor="watchlist-search">
                                {t("addWatchlist.searchLabel")}
                            </Label>
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                    id="watchlist-search"
                                    placeholder={t(
                                        "addWatchlist.searchPlaceholder",
                                    )}
                                    value={searchQuery}
                                    onChange={(e) =>
                                        setSearchQuery(e.target.value)
                                    }
                                    className="pl-9"
                                />
                            </div>

                            {isSearching && (
                                <div className="flex items-center justify-center py-4">
                                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                                </div>
                            )}

                            {searchResults?.items &&
                                searchResults.items.length > 0 && (
                                    <div className="max-h-60 overflow-y-auto rounded-md border border-border p-1">
                                        {searchResults.items.map((result) => (
                                            <SymbolSearchResultItem
                                                key={result.symbol}
                                                item={result}
                                                onSelect={handleSelectAsset}
                                            />
                                        ))}
                                    </div>
                                )}
                        </div>
                    ) : (
                        <>
                            <div className="bg-muted/50 rounded-lg p-3">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="font-medium">
                                            {selectedAsset.name}
                                        </p>
                                        <Badge
                                            variant="outline"
                                            className="font-mono text-xs mt-1"
                                        >
                                            {selectedAsset.symbol}
                                        </Badge>
                                    </div>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setSelectedAsset(null)}
                                    >
                                        {t("addWatchlist.change")}
                                    </Button>
                                </div>
                                {quoteData &&
                                    Number.isFinite(quoteData.price) &&
                                    quoteData.price > 0 && (
                                        <p className="text-sm text-muted-foreground mt-2">
                                            {t("addWatchlist.currentPrice", {
                                                price: quoteData.price.toFixed(
                                                    2,
                                                ),
                                            })}
                                        </p>
                                    )}
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="watchlist-asset-class">
                                        {t("addWatchlist.assetClass")}
                                    </Label>
                                    <Select
                                        value={assetClass}
                                        onValueChange={(
                                            v:
                                                | "stock"
                                                | "etf"
                                                | "crypto"
                                                | "metals",
                                        ) => setAssetClass(v)}
                                    >
                                        <SelectTrigger id="watchlist-asset-class">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="stock">
                                                {t("addWatchlist.stock")}
                                            </SelectItem>
                                            <SelectItem value="etf">
                                                {t("addWatchlist.etf")}
                                            </SelectItem>
                                            <SelectItem value="crypto">
                                                {t("addWatchlist.crypto")}
                                            </SelectItem>
                                            <SelectItem value="metals">
                                                {t("addWatchlist.metals")}
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="watchlist-currency">
                                        {t("addWatchlist.currency")}
                                    </Label>
                                    <Select
                                        value={currency}
                                        onValueChange={setCurrency}
                                    >
                                        <SelectTrigger id="watchlist-currency">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="USD">
                                                USD
                                            </SelectItem>
                                            <SelectItem value="EUR">
                                                EUR
                                            </SelectItem>
                                            <SelectItem value="GBP">
                                                GBP
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="watchlist-target-price">
                                    {t("addWatchlist.targetPrice")}
                                </Label>
                                <Input
                                    id="watchlist-target-price"
                                    type="text"
                                    inputMode="decimal"
                                    pattern="^[0-9]+([.,][0-9]+)?$"
                                    placeholder={
                                        quoteData &&
                                        Number.isFinite(quoteData.price) &&
                                        quoteData.price > 0
                                            ? t("addWatchlist.currentPrice", {
                                                  price: quoteData.price.toFixed(
                                                      2,
                                                  ),
                                              })
                                            : t(
                                                  "addWatchlist.targetPlaceholder",
                                              )
                                    }
                                    value={targetPrice}
                                    onChange={(e) =>
                                        setTargetPrice(e.target.value)
                                    }
                                />
                                {quoteData &&
                                    Number.isFinite(quoteData.price) &&
                                    quoteData.price > 0 &&
                                    targetPrice && (
                                        <p className="text-xs text-muted-foreground">
                                            {parseDecimal(targetPrice) <
                                            quoteData.price
                                                ? t(
                                                      "addWatchlist.belowCurrent",
                                                      {
                                                          n: formatPercent(
                                                              (1 -
                                                                  parseDecimal(
                                                                      targetPrice,
                                                                  ) /
                                                                      quoteData.price) *
                                                                  100,
                                                              { digits: 1 },
                                                          ),
                                                      },
                                                  )
                                                : t(
                                                      "addWatchlist.aboveCurrent",
                                                      {
                                                          n: formatPercent(
                                                              (parseDecimal(
                                                                  targetPrice,
                                                              ) /
                                                                  quoteData.price -
                                                                  1) *
                                                                  100,
                                                              { digits: 1 },
                                                          ),
                                                      },
                                                  )}
                                        </p>
                                    )}
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="watchlist-notes">
                                    {t("addWatchlist.notesOptional")}
                                </Label>
                                <Textarea
                                    id="watchlist-notes"
                                    placeholder={t(
                                        "addWatchlist.notesPlaceholder",
                                    )}
                                    value={notes}
                                    onChange={(e) => setNotes(e.target.value)}
                                    rows={2}
                                />
                            </div>

                            <Button
                                type="submit"
                                className="w-full"
                                disabled={!targetPrice || isSubmitting}
                            >
                                {isSubmitting ? (
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                ) : null}
                                {t("addWatchlist.submit")}
                            </Button>
                        </>
                    )}
                </form>
            </DialogContent>
        </Dialog>
    );
}
