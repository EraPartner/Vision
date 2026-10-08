import { useEffect, useState } from "react";
import { MAX_NUMERIC_18_6, parseDecimal } from "@/lib/decimal";
import { useQueryClient } from "@tanstack/react-query";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Tooltip,
    TooltipTrigger,
    TooltipContent,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    AreaChart,
    type AreaSeries,
    type AreaReferenceLine,
} from "@/components/charts";
import { Target, TrendingUp, TrendingDown, Check } from "lucide-react";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { formatDateWithAppSettings } from "@/lib/dateUtils";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { WatchlistItem } from "@/types/watchlist";

import { apiClient } from "@/lib/api";
import { watchlistKeys } from "@/lib/queryKeys";
import { RESEARCH_RANGES as RANGES } from "@/lib/research/ranges";
import { ResearchRangeSelector } from "@/components/charts/ResearchRangeSelector";
import { useWatchlistMarketQueries } from "./usePortfolioQueries";
import { formatEditableNumber } from "@/utils/currency";

interface WatchlistChartDialogProps {
    item: WatchlistItem | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function WatchlistChartDialog({
    item,
    open,
    onOpenChange,
}: WatchlistChartDialogProps) {
    const formatPercent = usePercentFormatter();
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

    const { chart: chartQuery, quote: quoteQuery } = useWatchlistMarketQueries(
        item?.symbol,
        selectedRange.range,
        selectedRange.interval,
        open,
    );
    const { data: chartData, isLoading: isChartLoading } = chartQuery;
    const { data: quoteData } = quoteQuery;

    const handleUpdateTargetPrice = async () => {
        if (!item || !newTargetPrice) return;

        // parseDecimal's default 0-fallback would silently save a 0 target for
        // garbage input like "1e999"; validate explicitly instead.
        const targetValue = parseDecimal(
            newTargetPrice,
            appSettings.numberFormat,
            NaN,
        );
        if (
            !Number.isFinite(targetValue) ||
            targetValue <= 0 ||
            targetValue > MAX_NUMERIC_18_6
        ) {
            toast.error(t("watchlistChart.invalidTarget"));
            return;
        }

        try {
            await apiClient.updateWatchlistItem(item.id, {
                target_price: targetValue,
            });

            queryClient.invalidateQueries({ queryKey: watchlistKeys.all });
            toast.success(t("watchlist.targetUpdated"));
            setEditingPrice(false);
            setNewTargetPrice("");
        } catch (e) {
            toast.error(t("watchlist.updateFailed"), {
                description: apiErrorToMessage(e, t),
            });
        }
    };

    if (!item) return null;

    const rawTargetPrice = Number(item.target_price);
    const targetPrice = Number.isFinite(rawTargetPrice) ? rawTargetPrice : 0;
    const hasValidTarget =
        Number.isFinite(rawTargetPrice) && rawTargetPrice > 0;
    const currentPrice = quoteData?.price ?? null;
    const isBelowTarget =
        currentPrice != null && hasValidTarget && currentPrice <= targetPrice;
    const priceDiff =
        currentPrice != null && hasValidTarget
            ? ((currentPrice - targetPrice) / targetPrice) * 100
            : null;

    // Format chart data
    const formattedData =
        chartData?.points?.map((p) => ({
            date: formatDateWithAppSettings(
                new Date(p.time),
                appSettings.dateFormat,
            ),
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
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <div className="flex items-center gap-3">
                        <DialogTitle>{item.name}</DialogTitle>
                        {item.symbol && (
                            <Badge variant="outline" className="font-mono">
                                {item.symbol}
                            </Badge>
                        )}
                    </div>
                    <DialogDescription className="sr-only">
                        {item.name}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-6">
                    {/* Price Summary */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="rounded-card corner-continuous bg-foreground/[0.04] p-4">
                            <div className="mb-1 flex items-center gap-2 type-caption text-label-secondary">
                                <Target
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                                {t("watchlistChart.targetPrice")}
                            </div>
                            {editingPrice ? (
                                <form
                                    className="flex items-center gap-2"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        void handleUpdateTargetPrice();
                                    }}
                                >
                                    <Input
                                        id="watchlist-target-price"
                                        autoFocus
                                        aria-label={`${t("watchlistChart.targetPrice")}: ${item.name} (${item.symbol})`}
                                        type="text"
                                        inputMode="decimal"
                                        value={newTargetPrice}
                                        onChange={(e) =>
                                            setNewTargetPrice(e.target.value)
                                        }
                                        placeholder={
                                            hasValidTarget
                                                ? formatEditableNumber(
                                                      targetPrice,
                                                      appSettings.numberFormat,
                                                  )
                                                : "0"
                                        }
                                        className="h-8"
                                    />
                                    <Button
                                        size="sm"
                                        type="submit"
                                        aria-label={t("common.save")}
                                    >
                                        <Check className="h-4 w-4" />
                                    </Button>
                                    <Button
                                        size="sm"
                                        type="button"
                                        variant="ghost"
                                        onClick={() => setEditingPrice(false)}
                                    >
                                        {t("watchlistChart.cancelEdit")}
                                    </Button>
                                </form>
                            ) : (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            type="button"
                                            variant="link"
                                            aria-label={`${t("common.edit")}: ${t("watchlistChart.targetPrice")}, ${item.name} (${item.symbol}), ${formatDisplayCurrency(targetPrice, { currency: item.currency })}`}
                                            onClick={() => {
                                                setNewTargetPrice(
                                                    formatEditableNumber(
                                                        targetPrice,
                                                        appSettings.numberFormat,
                                                    ),
                                                );
                                                setEditingPrice(true);
                                            }}
                                            className="h-auto p-0 text-left type-title-1 tabular-nums"
                                        >
                                            {formatDisplayCurrency(
                                                targetPrice,
                                                {
                                                    currency: item.currency,
                                                },
                                            )}
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>{`${t("common.edit")}: ${t("watchlistChart.targetPrice")}, ${item.name} (${item.symbol})`}</TooltipContent>
                                </Tooltip>
                            )}
                        </div>

                        <div className="rounded-card corner-continuous bg-foreground/[0.04] p-4">
                            <p className="mb-1 type-caption text-label-secondary">
                                {t("watchlistChart.currentPrice")}
                            </p>
                            {currentPrice != null ? (
                                <>
                                    <p className="type-title-1 tabular-nums">
                                        {formatDisplayCurrency(currentPrice, {
                                            currency: item.currency,
                                        })}
                                    </p>
                                    {priceDiff != null && (
                                        <div
                                            className={cn(
                                                "mt-1 flex items-center gap-1 type-footnote tabular-nums",
                                                priceDiff > 0
                                                    ? "text-loss"
                                                    : "text-gain",
                                            )}
                                        >
                                            {priceDiff > 0 ? (
                                                <TrendingUp className="h-4 w-4" />
                                            ) : (
                                                <TrendingDown className="h-4 w-4" />
                                            )}
                                            {formatPercent(
                                                Math.abs(priceDiff),
                                                { digits: 2 },
                                            )}{" "}
                                            {priceDiff > 0
                                                ? t(
                                                      "watchlistChart.aboveTarget",
                                                  )
                                                : t(
                                                      "watchlistChart.belowTarget",
                                                  )}
                                        </div>
                                    )}
                                </>
                            ) : (
                                <Skeleton
                                    {...loadingSurfaceProps}
                                    className="h-8 w-24"
                                />
                            )}
                        </div>
                    </div>

                    {isBelowTarget && (
                        <Alert variant="success">
                            <AlertDescription className="text-center font-medium">
                                {t("watchlistChart.atTarget")}
                            </AlertDescription>
                        </Alert>
                    )}

                    {/* Range selector */}
                    <ResearchRangeSelector
                        options={RANGES}
                        value={selectedRange.range}
                        onChange={setSelectedRange}
                        className="mx-auto"
                        size="md"
                    />

                    {/* Chart */}
                    <div className="h-80 w-full">
                        {isChartLoading ? (
                            <Skeleton
                                {...loadingSurfaceProps}
                                className="h-full w-full"
                            />
                        ) : formattedData.length > 0 ? (
                            <AreaChart
                                data={formattedData}
                                height={320}
                                xAccessor={(d) => d.time}
                                xIsDate
                                series={
                                    [
                                        {
                                            key: "price",
                                            label: t(
                                                "watchlistChart.priceLabel",
                                            ),
                                            accessor: (d) => d.price,
                                            color: "hsl(var(--primary))",
                                            strokeWidth: 2,
                                        },
                                    ] as AreaSeries<
                                        (typeof formattedData)[number]
                                    >[]
                                }
                                yDomain={[minPrice, maxPrice]}
                                xTickFormat={(v) =>
                                    formatDateWithAppSettings(
                                        v instanceof Date ? v : new Date(v),
                                        appSettings.dateFormat,
                                    )
                                }
                                yTickFormat={(v) =>
                                    formatDisplayCurrency(v, {
                                        currency: item.currency,
                                    })
                                }
                                tooltipTitle={(d) => d.date}
                                tooltipValueFormat={(v) =>
                                    formatDisplayCurrency(v, {
                                        currency: item.currency,
                                    })
                                }
                                referenceLines={
                                    [
                                        {
                                            y: targetPrice,
                                            label: t(
                                                "watchlistChart.targetLabel",
                                                {
                                                    currency: item.currency,
                                                    price: formatDisplayCurrency(
                                                        targetPrice,
                                                        {
                                                            currency:
                                                                item.currency,
                                                        },
                                                    ),
                                                },
                                            ),
                                            color: "hsl(var(--primary))",
                                            dashed: true,
                                        },
                                    ] as AreaReferenceLine[]
                                }
                                margin={{
                                    top: 10,
                                    right: 16,
                                    bottom: 28,
                                    left: 64,
                                }}
                            />
                        ) : (
                            <div className="flex h-full items-center justify-center type-footnote text-label-secondary">
                                {t("watchlistChart.noData")}
                            </div>
                        )}
                    </div>

                    {item.notes && (
                        <div className="rounded-card corner-continuous bg-foreground/[0.04] p-4">
                            <p className="type-caption font-medium text-label-secondary">
                                {t("watchlistChart.notes")}
                            </p>
                            <p className="mt-1 type-body">{item.notes}</p>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
