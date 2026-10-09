import { PageError } from "@/components/shared/PageError";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { List, ListRow } from "@/components/ui/list";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { RowMenu } from "@/components/shared/RowMenu";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { Check, LineChart, Plus, Search, Trash2, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { AddToWatchlistDialog } from "@/features/portfolio/AddToWatchlistDialog";
import { WatchlistChartDialog } from "@/features/portfolio/WatchlistChartDialog";
import type { WatchlistItem } from "@/types/watchlist";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useMarketQuotesQuery } from "@/hooks/useMarketQuotesQuery";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { TextLink } from "@/components/shared/TextLink";

import { watchlistKeys } from "@/lib/queryKeys";
import {
    useDeleteWatchlistItem,
    useWatchlist,
} from "@/features/research/useWatchlistData";
import { PageShell } from "@/components/shared/PageShell";

const ASSET_CLASS_ICON: Record<WatchlistItem["asset_class"], LucideIcon> = {
    stock: PAGE_ICONS["/portfolio/stocks"],
    etf: PAGE_ICONS["/portfolio/stocks"],
    crypto: PAGE_ICONS["/portfolio/crypto"],
    metals: PAGE_ICONS["/portfolio/metals"],
};

const ASSET_CLASS_LABEL_KEY: Record<WatchlistItem["asset_class"], string> = {
    stock: "addWatchlist.stock",
    etf: "addWatchlist.etf",
    crypto: "addWatchlist.crypto",
    metals: "addWatchlist.metals",
};

/**
 * Watchlist: one row per prospective investment with its current and target
 * price; the row opens its chart, the ••• menu holds Market lookup and the
 * confirmed removal (notes and the target price have no restore endpoint).
 */
export default function WatchlistPage() {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const navigate = useNavigate();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const isOnline = useOnlineStatus();
    const [addDialogOpen, setAddDialogOpen] = useState(false);
    const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const { data, isLoading, error: loadError, refetch } = useWatchlist();
    const selectedItem =
        data?.items.find((item) => item.id === selectedItemId) ?? null;

    const symbols =
        data?.items
            ?.map((i) => i.symbol)
            .filter(Boolean)
            .join(",") || "";
    const { data: quotesData, isError: quotesError } = useMarketQuotesQuery(
        watchlistKeys.quotes(symbols),
        symbols,
    );
    const quotesUnavailable = !isOnline || quotesError;

    const priceMap = new Map(quotesData?.map((q) => [q.symbol, q]) || []);

    const deleteMutation = useDeleteWatchlistItem();

    // Removal destroys the user's notes and target price with no undo, so it goes
    // through the same confirm every other destructive surface in the app uses.
    const handleRemove = async (item: WatchlistItem) => {
        const ok = await confirm({
            title: t("watchlist.removeTitle"),
            description: t("watchlist.removeDesc", {
                name: item.name || item.symbol || "",
            }),
            confirmLabel: t("watchlist.removeConfirm"),
            variant: "destructive",
        });
        if (ok) deleteMutation.mutate(item.id);
    };

    // Shared cached currency formatter (app locale + showDecimalPlaces defaults).
    const formatDisplayCurrency = useCurrencyFormatter();

    const watchlistEmptyLines = t("watchlist.empty").split("\n");
    const watchlistEmptyTitle = watchlistEmptyLines[0] ?? t("watchlist.empty");
    const watchlistEmptyDescriptionLines = watchlistEmptyLines.slice(1);

    /* The row surface opens the chart; the symbol link sits inside it, so its
       events must not fall through to the row. */

    const addButton = (
        <Button onClick={() => setAddDialogOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("watchlist.addButton")}
        </Button>
    );

    return (
        <PageShell className="">
            <PageHeader
                title={t("watchlist.title")}
                subtitle={t("watchlist.subtitle")}
                icon={PAGE_ICONS["/research/watchlist"]}
                actions={addButton}
            />

            {quotesUnavailable && data?.items && data.items.length > 0 && (
                <Alert variant="warning">
                    <WifiOff className="h-4 w-4" aria-hidden="true" />
                    <AlertDescription>
                        {t("watchlist.quotesOffline")}
                    </AlertDescription>
                </Alert>
            )}

            {loadError && data && (
                <PageError
                    message={t("common.loadFailedRetry")}
                    onRetry={() => void refetch()}
                />
            )}
            {loadError && !data ? (
                <PageError
                    message={t("common.loadFailedRetry")}
                    onRetry={() => void refetch()}
                />
            ) : isLoading ? (
                <div {...loadingSurfaceProps} className="space-y-2">
                    {[1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-14 w-full" />
                    ))}
                </div>
            ) : !data?.items?.length ? (
                <Card>
                    <CardContent variant="state">
                        <EmptyState
                            icon={PAGE_ICONS["/research/watchlist"]}
                            title={watchlistEmptyTitle}
                            description={
                                watchlistEmptyDescriptionLines.length > 0 ? (
                                    <>
                                        {watchlistEmptyDescriptionLines.map(
                                            (line, i) => (
                                                <span key={i}>
                                                    {line}
                                                    {i <
                                                        watchlistEmptyDescriptionLines.length -
                                                            1 && <br />}
                                                </span>
                                            ),
                                        )}
                                    </>
                                ) : undefined
                            }
                            action={addButton}
                        />
                    </CardContent>
                </Card>
            ) : (
                <List className="@container">
                    {data.items.map((item) => {
                        const quote = item.symbol
                            ? priceMap.get(item.symbol)
                            : null;
                        const currentPrice = quote?.price ?? null;
                        const priceDiff =
                            currentPrice != null
                                ? ((currentPrice - item.target_price) /
                                      item.target_price) *
                                  100
                                : null;
                        const isBelowTarget =
                            currentPrice != null &&
                            currentPrice <= item.target_price;
                        // What-if backtest (ADR-097): return since the day it was added, using the
                        // price snapshotted at add time. Only when both prices are known.
                        const addedPrice = item.added_price ?? null;
                        const sinceAddedPct =
                            addedPrice != null &&
                            addedPrice > 0 &&
                            currentPrice != null
                                ? ((currentPrice - addedPrice) / addedPrice) *
                                  100
                                : null;
                        const addedDate = formatDateStringWithAppSettings(
                            item.created_at,
                            appSettings.dateFormat,
                        );
                        const Icon = ASSET_CLASS_ICON[item.asset_class];
                        const name = item.name || item.symbol || "";
                        const subtitle = (
                            <>
                                {t(ASSET_CLASS_LABEL_KEY[item.asset_class])}
                                {sinceAddedPct != null && (
                                    <>
                                        {" · "}
                                        {t("watchlist.sinceAdded", {
                                            date: addedDate,
                                        })}{" "}
                                        <DeltaPill
                                            value={sinceAddedPct}
                                            label={formatPercent(
                                                sinceAddedPct,
                                                { digits: 1, signed: true },
                                            )}
                                        />
                                    </>
                                )}
                                {item.notes ? ` · ${item.notes}` : null}
                            </>
                        );
                        const openChart = () => setSelectedItemId(item.id);

                        return (
                            <ListRow
                                key={item.id}
                                className={cn(
                                    "[&_.truncate]:overflow-visible [&_.truncate]:whitespace-normal [&_.truncate]:break-words [&>div]:flex-wrap [&>div>span:last-child]:basis-full @[36rem]:[&>div]:flex-nowrap @[36rem]:[&>div>span:last-child]:basis-auto",
                                    isBelowTarget && "bg-success/[0.06]",
                                )}
                                leading={Icon ? <Icon /> : undefined}
                                title={
                                    <span className="flex max-w-full flex-wrap items-baseline gap-x-2 gap-y-1">
                                        {item.symbol ? (
                                            <TextLink
                                                className="min-w-0 whitespace-normal break-words"
                                                to={`/research/market?symbol=${encodeURIComponent(item.symbol)}`}
                                            >
                                                {name}
                                            </TextLink>
                                        ) : (
                                            <span className="min-w-0 whitespace-normal break-words">
                                                {name}
                                            </span>
                                        )}
                                        {item.symbol && (
                                            <Badge
                                                variant="outline"
                                                size="sm"
                                                className="font-mono"
                                            >
                                                {item.symbol}
                                            </Badge>
                                        )}
                                    </span>
                                }
                                subtitle={subtitle}
                                trailing={
                                    <>
                                        <span className="flex w-full min-w-0 flex-col items-start gap-1 tabular-nums @[36rem]:w-48 @[36rem]:items-end">
                                            <span className="text-foreground">
                                                {currentPrice != null
                                                    ? formatDisplayCurrency(
                                                          currentPrice,
                                                          {
                                                              currency:
                                                                  item.currency,
                                                          },
                                                      )
                                                    : t(
                                                          "watchlist.quoteUnavailable",
                                                      )}
                                            </span>
                                            <span className="flex w-full flex-wrap items-center justify-start gap-1.5 type-footnote @[36rem]:justify-end">
                                                {t("watchlist.targetPrice")}{" "}
                                                {formatDisplayCurrency(
                                                    item.target_price,
                                                    { currency: item.currency },
                                                )}
                                            </span>
                                            <span className="flex min-h-5 items-center justify-end type-footnote">
                                                {isBelowTarget ? (
                                                    <Badge
                                                        variant="success"
                                                        size="sm"
                                                        className="gap-1"
                                                        title={t(
                                                            "watchlist.atTarget",
                                                        )}
                                                    >
                                                        <Check
                                                            className="h-3 w-3"
                                                            aria-hidden="true"
                                                        />
                                                        {t(
                                                            "watchlist.atTargetShort",
                                                        )}
                                                    </Badge>
                                                ) : priceDiff != null &&
                                                  priceDiff > 0 ? (
                                                    <DeltaPill
                                                        value={priceDiff}
                                                        invert
                                                        label={`${formatPercent(
                                                            Math.abs(priceDiff),
                                                            { digits: 1 },
                                                        )} ${t("watchlist.aboveTarget")}`}
                                                    />
                                                ) : null}
                                            </span>
                                        </span>
                                    </>
                                }
                                actions={
                                    <>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={openChart}
                                            aria-label={`${t("watchlist.openChart")}: ${name}`}
                                        >
                                            <LineChart className="h-4 w-4" />
                                        </Button>
                                        <RowMenu
                                            label={t("watchlist.rowMenu", {
                                                name,
                                            })}
                                        >
                                            <DropdownMenuItem
                                                onSelect={openChart}
                                            >
                                                <LineChart className="mr-2 h-4 w-4 text-label-secondary" />
                                                {t("watchlist.openChart")}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                disabled={!item.symbol}
                                                onSelect={() =>
                                                    item.symbol &&
                                                    navigate(
                                                        `/research/market?symbol=${encodeURIComponent(item.symbol)}`,
                                                    )
                                                }
                                            >
                                                <Search className="mr-2 h-4 w-4 text-label-secondary" />
                                                {t("watchlist.openLookup")}
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                variant="destructive"
                                                onSelect={() =>
                                                    void handleRemove(item)
                                                }
                                            >
                                                <Trash2 className="mr-2 h-4 w-4" />
                                                {t("aria.removeFromWatchlist")}
                                            </DropdownMenuItem>
                                        </RowMenu>
                                    </>
                                }
                            />
                        );
                    })}
                </List>
            )}

            <AddToWatchlistDialog
                open={addDialogOpen}
                onOpenChange={setAddDialogOpen}
            />
            <WatchlistChartDialog
                item={selectedItem}
                open={!!selectedItem}
                onOpenChange={(open) => !open && setSelectedItemId(null)}
            />
            <ConfirmDialog />
        </PageShell>
    );
}
