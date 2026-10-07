import { useState, useCallback, useMemo } from "react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { numberFormatToLocale } from "@/utils/currency";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { formatCompactNumber } from "@/utils/formatCompactNumber";
import { formatDateTimeWithAppSettings } from "@/lib/dateUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResearchRangeSelector } from "@/components/charts/ResearchRangeSelector";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { List, ListRow } from "@/components/ui/list";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/shared/EmptyState";
import { StateBlock } from "@/components/shared/StateBlock";
import { Clock, Link2, MoreHorizontal, Star } from "lucide-react";
import {
    AreaChart,
    BarChart,
    type AreaSeries,
    type BarSeries,
} from "@/components/charts";
import { useSymbolSearch } from "@/hooks/useSymbolSearch";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentFromMarketDialog } from "@/features/portfolio/AddInvestmentFromMarketDialog";
import { AddToWatchlistDialog } from "@/features/portfolio/AddToWatchlistDialog";
import { useSearchParams } from "react-router";
import { useTabParam } from "@/hooks/useTabParam";
import { PageHeader } from "@/components/shared/PageHeader";
import { SymbolSearchResultItem } from "@/components/shared/SymbolSearchResultItem";
import { SymbolSearchBox } from "@/components/shared/SymbolSearchBox";
import { ResearchFundamentalsTab } from "@/features/research/ResearchFundamentalsTab";
import { ResearchAnalystTab } from "@/features/research/ResearchAnalystTab";
import { ResearchNewsTab } from "@/features/research/ResearchNewsTab";
import { ResearchMappingDialog } from "@/features/research/ResearchMappingDialog";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { PAGE_ICONS } from "@/lib/pageIcons";

import { apiClient } from "@/lib/api";

import { LOOKUP_RANGES as RANGES } from "@/lib/research/ranges";
import { PageShell } from "@/components/shared/PageShell";
import { formatMarketChartTick } from "@/features/research/marketChartTicks";
import { useMarketLookupData } from "@/features/research/useMarketLookupData";

const MARKET_TABS = ["fundamentals", "analyst", "news"] as const;

interface AnalystConsensus {
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
}

interface AnalystAction {
    date: string;
    firm: string;
    toGrade: string;
    fromGrade: string | null;
    action: string;
    priceTarget: number | null;
}

interface Quote {
    symbol: string;
    name: string;
    price: number;
    change: number;
    changePercent: number;
    currency: string;
    exchange: string;
    type: string;
    open: number;
    dayHigh: number;
    dayLow: number;
    prevClose: number;
    volume: number;
    avgVolume: number;
    high52w: number;
    low52w: number;
    marketCap: number;
    pe: number;
    forwardPE: number;
    dividendYield: number;
    eps: number;
    beta?: number;
    priceToBook?: number;
    analystConsensus: AnalystConsensus | null;
    recentAnalystActions: AnalystAction[];
}

export default function MarketLookupPage() {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    // One Intl.NumberFormat per (locale, options) instead of one per formatted
    // value: this feeds the price chart's y-axis tick formatter, so it ran at
    // hover/redraw rate and paid the ~50-200µs constructor cost every tick. The
    // options objects come from a handful of literal call sites, so serializing
    // them is a stable cache key. Cache lives inside the memo — a locale change
    // replaces it wholesale.
    const fmtNum = useMemo(() => {
        const cache = new Map<string, Intl.NumberFormat>();
        return (
            val: number | null | undefined,
            opts?: Intl.NumberFormatOptions,
        ) => {
            if (val == null || isNaN(val)) return "—";
            const key = opts ? JSON.stringify(opts) : "";
            let formatter = cache.get(key);
            if (!formatter) {
                formatter = new Intl.NumberFormat(locale, opts);
                cache.set(key, formatter);
            }
            return formatter.format(val);
        };
    }, [locale]);
    // Shared cached currency formatter; quotes pin 2 decimals regardless of the
    // showDecimalPlaces setting (unchanged behavior).
    const fmtCurrency = useCurrencyFormatter("USD");
    const fmtPrice = useCallback(
        (val: number | null | undefined, currency = "USD", signed = false) => {
            if (val == null || isNaN(val)) return "—";
            return fmtCurrency(val, { currency, decimals: 2, signed });
        },
        [fmtCurrency],
    );
    const fmtLargeNum = useCallback(
        (val: number | null | undefined) =>
            formatCompactNumber(val, (v) =>
                fmtNum(v, { maximumFractionDigits: 0 }),
            ),
        [fmtNum],
    );
    const [watchlistOpen, setWatchlistOpen] = useState(false);
    const [mappingOpen, setMappingOpen] = useState(false);
    // Mirrors the symbol's URL-first treatment below: a shared /research/market
    // link reopens the same tab the sender was reading.
    const [activeTab, setActiveTab] = useTabParam(MARKET_TABS, "fundamentals");
    const [searchParams, setSearchParams] = useSearchParams();
    const selectedRange =
        RANGES.find((option) => option.range === searchParams.get("range")) ??
        RANGES[2]; // 1M default
    const setSelectedRange = (option: (typeof RANGES)[number]) => {
        setSearchParams(
            (previous) => {
                const next = new URLSearchParams(previous);
                if (option.range === RANGES[2].range) next.delete("range");
                else next.set("range", option.range);
                return next;
            },
            { replace: true },
        );
    };
    // The selected symbol lives entirely in the URL, so a looked-up view is
    // shareable and survives reload. Picking a result (handleSelect) rewrites it.
    const effectiveSelectedSymbol =
        searchParams.get("symbol")?.trim().toUpperCase() || null;
    const { summaries, isLoading: isPortfolioLoading } = usePortfolio();

    // When the page is opened from a portfolio holding (double-click), the URL
    // carries its investmentId. If that holding prices via a non-Yahoo provider
    // (Kinesis/custom/binance), Yahoo has no data for the symbol — so we serve the
    // chart + a minimal price header from the holding's own stored history instead.
    const investmentId = searchParams.get("investmentId");
    const mappingInvestmentId = useMemo(() => {
        const n = Number(investmentId);
        return investmentId && Number.isInteger(n) && n > 0 ? n : undefined;
    }, [investmentId]);
    const providerInvestment = useMemo(
        () =>
            investmentId
                ? summaries.find((s) => String(s.id) === investmentId)
                : undefined,
        [investmentId, summaries],
    );
    // Still waiting to learn which provider this holding uses — don't fire Yahoo yet.
    const resolvingProvider =
        !!investmentId && !providerInvestment && isPortfolioLoading;
    const isProviderAsset =
        !!providerInvestment &&
        !!providerInvestment.price_provider &&
        providerInvestment.price_provider !== "yahoo";
    const useYahoo =
        !!effectiveSelectedSymbol && !isProviderAsset && !resolvingProvider;

    // Search — trim: false keeps the query text (and so the "market-search"
    // cache keys) byte-identical with the historical inline wiring and with
    // AddToWatchlistDialog, which shares this cache scope.
    const {
        searchText,
        setSearchText,
        searchResult: searchResults,
        isFetching: isSearching,
        isError: searchFailed,
        isOpen,
    } = useSymbolSearch(apiClient.searchMarket, {
        queryKey: "market-search",
        trim: false,
    });

    const {
        quoteData,
        isQuoteLoading,
        chartData,
        isChartLoading,
        providerChartData,
        isProviderChartLoading,
    } = useMarketLookupData<Quote>({
        symbol: effectiveSelectedSymbol,
        range: selectedRange.range,
        interval: selectedRange.interval,
        providerInvestment,
        isProviderAsset,
        useYahoo,
    });

    // Minimal quote synthesized from provider history: price = latest point,
    // change = move across the visible range. Fundamentals/news don't exist for
    // these assets, so those sections are hidden in provider mode.
    const providerQuote = useMemo<Quote | null>(() => {
        if (!isProviderAsset || !providerInvestment) return null;
        const pts = providerChartData?.points ?? [];
        if (pts.length === 0) return null;
        const last = pts[pts.length - 1].close;
        const first = pts[0].close;
        const change = last - first;
        const changePercent = first ? (change / first) * 100 : 0;
        return {
            symbol: providerInvestment.symbol ?? effectiveSelectedSymbol ?? "",
            name: providerInvestment.name,
            price: last,
            change,
            changePercent,
            currency: providerInvestment.currency,
            exchange: "",
            type: (providerInvestment.price_provider ?? "").toUpperCase(),
        } as Quote;
    }, [
        isProviderAsset,
        providerInvestment,
        providerChartData,
        effectiveSelectedSymbol,
    ]);

    const quote = isProviderAsset ? providerQuote : quoteData;
    const displayChart = isProviderAsset ? providerChartData : chartData;
    const isChartBusy = isProviderAsset
        ? isProviderChartLoading
        : isChartLoading;
    const isQuoteBusy = isProviderAsset
        ? isProviderChartLoading
        : isQuoteLoading;
    const isPositive = (quote?.change ?? 0) >= 0;

    // Check if this asset already exists in portfolio
    const existingInvestment = useMemo(
        () =>
            quote
                ? summaries.find(
                      (s) =>
                          s.symbol?.toLowerCase() ===
                          quote.symbol.toLowerCase(),
                  )
                : null,
        [quote, summaries],
    );

    // Trading figures in two inset lists so the grid keeps its two-column rhythm.
    const tradingInfo = quote
        ? [
              {
                  label: t("market.open"),
                  value: fmtPrice(quote.open, quote.currency),
              },
              {
                  label: t("market.dayHigh"),
                  value: fmtPrice(quote.dayHigh, quote.currency),
              },
              {
                  label: t("market.dayLow"),
                  value: fmtPrice(quote.dayLow, quote.currency),
              },
              {
                  label: t("market.prevClose"),
                  value: fmtPrice(quote.prevClose, quote.currency),
              },
              {
                  label: t("market.volume"),
                  value: fmtLargeNum(quote.volume),
              },
              {
                  label: t("market.avgVolume"),
                  value: fmtLargeNum(quote.avgVolume),
              },
              {
                  label: t("market.52wRange"),
                  value: `${fmtPrice(quote.low52w, quote.currency)} – ${fmtPrice(quote.high52w, quote.currency)}`,
              },
          ]
        : [];
    const tradingInfoColumns = [
        tradingInfo.slice(0, 4),
        tradingInfo.slice(4),
    ].filter((column) => column.length > 0);

    const quoteActions = quote && !isProviderAsset;

    return (
        <PageShell className="">
            <PageHeader
                title={t("marketLookup.title")}
                icon={PAGE_ICONS["/research/market"]}
                actions={
                    quoteActions ? (
                        <>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        aria-label={t("marketLookup.menu")}
                                    >
                                        <MoreHorizontal />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem
                                        onSelect={() => setWatchlistOpen(true)}
                                    >
                                        <Star className="mr-2 h-4 w-4 text-label-secondary" />
                                        {t("addWatchlist.title")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onSelect={() => setMappingOpen(true)}
                                    >
                                        <Link2 className="mr-2 h-4 w-4 text-label-secondary" />
                                        {t("research.mapping.button")}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <AddInvestmentFromMarketDialog
                                quote={quote}
                                existingInvestment={
                                    existingInvestment ?? undefined
                                }
                            />
                        </>
                    ) : undefined
                }
            />

            {/* Search */}
            <SymbolSearchBox
                className="max-w-2xl"
                placeholder={t("market.searchPlaceholder")}
                value={searchText}
                onChange={setSearchText}
                loading={isSearching && searchText.length > 0}
                open={isOpen}
                onDismiss={() => setSearchText("")}
            >
                {!isSearching && (searchResults?.items?.length ?? 0) === 0 && (
                    <p
                        role="status"
                        className="px-3 py-3 type-callout text-label-secondary"
                    >
                        {t(
                            searchFailed
                                ? "research.searchFailed"
                                : "research.noResults",
                        )}
                    </p>
                )}
                {searchResults?.items?.map((item) => (
                    <SymbolSearchResultItem
                        key={item.symbol}
                        item={item}
                        to={(() => {
                            const next = new URLSearchParams(searchParams);
                            next.set("symbol", item.symbol);
                            next.delete("investmentId");
                            return `/research/market?${next.toString()}`;
                        })()}
                        onClick={(event) => {
                            if (
                                event.button === 0 &&
                                !event.metaKey &&
                                !event.ctrlKey &&
                                !event.shiftKey &&
                                !event.altKey
                            ) {
                                setSearchText("");
                            }
                        }}
                    />
                ))}
            </SymbolSearchBox>

            {/* No selection state */}
            {!effectiveSelectedSymbol && (
                <Card>
                    <CardContent variant="state">
                        <EmptyState
                            icon={PAGE_ICONS["/research/market"]}
                            title={t("market.searchTicker")}
                            description={t("market.searchHint")}
                        />
                    </CardContent>
                </Card>
            )}

            {/* Quote + Chart */}
            {effectiveSelectedSymbol && (
                <>
                    {/* Quote hero */}
                    {isQuoteBusy ? (
                        <Card>
                            <CardContent
                                {...loadingSurfaceProps}
                                variant="headerless"
                                className="space-y-3"
                            >
                                <Skeleton className="h-8 w-64" />
                                <Skeleton className="h-12 w-40" />
                                <Skeleton className="h-5 w-32" />
                            </CardContent>
                        </Card>
                    ) : quote ? (
                        <Card>
                            <CardContent variant="headerless">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <h2 className="type-title-1 text-foreground">
                                                {quote.symbol}
                                            </h2>
                                            {quote.type && (
                                                <Badge
                                                    variant="secondary"
                                                    size="sm"
                                                >
                                                    {quote.type}
                                                </Badge>
                                            )}
                                            {quote.exchange && (
                                                <span className="type-footnote text-label-secondary">
                                                    {quote.exchange}
                                                </span>
                                            )}
                                        </div>
                                        <p className="mt-0.5 type-body text-label-secondary">
                                            {quote.name}
                                        </p>
                                        <div className="mt-4 flex flex-wrap items-baseline gap-3">
                                            <span className="type-large-title tabular-nums text-foreground">
                                                {fmtPrice(
                                                    quote.price,
                                                    quote.currency,
                                                )}
                                            </span>
                                            <DeltaPill
                                                value={
                                                    quote.changePercent ??
                                                    quote.change
                                                }
                                                label={`${fmtPrice(
                                                    quote.change,
                                                    quote.currency,
                                                    true,
                                                )}${
                                                    quote.changePercent != null
                                                        ? ` (${formatPercent(
                                                              quote.changePercent,
                                                              {
                                                                  digits: 2,
                                                                  signed: true,
                                                              },
                                                          )})`
                                                        : ""
                                                }`}
                                            />
                                        </div>
                                    </div>
                                    {!isProviderAsset && (
                                        <p className="flex items-center gap-1.5 type-footnote text-label-secondary">
                                            <Clock
                                                className="h-3.5 w-3.5"
                                                aria-hidden="true"
                                            />
                                            {t("market.autoRefresh")}
                                        </p>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    ) : (
                        <Card>
                            <CardContent variant="flush">
                                <StateBlock
                                    size="compact"
                                    icon={PAGE_ICONS["/research/market"]}
                                    title={t("market.noQuote", {
                                        symbol: effectiveSelectedSymbol,
                                    })}
                                />
                            </CardContent>
                        </Card>
                    )}

                    {/* Quick add-to-watchlist for the symbol being looked up */}
                    {quote && !isProviderAsset && (
                        <AddToWatchlistDialog
                            open={watchlistOpen}
                            onOpenChange={setWatchlistOpen}
                            prefill={{
                                symbol: quote.symbol,
                                name: quote.name,
                                type: quote.type,
                                currency: quote.currency,
                                price: quote.price,
                            }}
                        />
                    )}

                    {/* Chart */}
                    <Card>
                        <CardHeader className="pb-2">
                            <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <CardTitle variant="sm">
                                    {t("market.priceChart")}
                                </CardTitle>
                                <ResearchRangeSelector
                                    options={RANGES}
                                    value={selectedRange.range}
                                    onChange={setSelectedRange}
                                />
                            </div>
                        </CardHeader>
                        <CardContent>
                            {isChartBusy ? (
                                <Skeleton
                                    {...loadingSurfaceProps}
                                    className="h-[320px] w-full"
                                />
                            ) : displayChart?.points &&
                              displayChart.points.length > 0 ? (
                                <div className="space-y-4">
                                    <AreaChart
                                        data={displayChart.points}
                                        xAccessor={(d) => new Date(d.time)}
                                        xIsDate
                                        height={320}
                                        xTickFormat={(v) =>
                                            formatMarketChartTick(
                                                (v as Date).getTime(),
                                                selectedRange.range,
                                                locale,
                                            )
                                        }
                                        yTickFormat={(v) =>
                                            fmtNum(v, {
                                                maximumFractionDigits: 2,
                                            })
                                        }
                                        tooltipTitle={(d) =>
                                            formatDateTimeWithAppSettings(
                                                new Date(d.time),
                                                appSettings.dateFormat,
                                                locale,
                                            )
                                        }
                                        tooltipValueFormat={(v) =>
                                            fmtPrice(
                                                v,
                                                displayChart.currency || "USD",
                                            )
                                        }
                                        series={
                                            [
                                                {
                                                    key: "close",
                                                    label: t(
                                                        "market.priceChart",
                                                    ),
                                                    accessor: (d) => d.close,
                                                    color: isPositive
                                                        ? "hsl(var(--accent))"
                                                        : "hsl(var(--destructive))",
                                                    strokeWidth: 2,
                                                },
                                            ] as AreaSeries<
                                                (typeof displayChart.points)[number]
                                            >[]
                                        }
                                    />

                                    {/* Volume bars — Yahoo only; provider history carries no volume. */}
                                    {!isProviderAsset && (
                                        <BarChart
                                            data={displayChart.points}
                                            categoryAccessor={(d) =>
                                                String(d.time)
                                            }
                                            height={60}
                                            barRadius={2}
                                            margin={{
                                                top: 4,
                                                right: 0,
                                                bottom: 0,
                                                left: 0,
                                            }}
                                            categoryTickFormat={() => ""}
                                            valueTickFormat={() => ""}
                                            tooltipTitle={(d) =>
                                                formatDateTimeWithAppSettings(
                                                    new Date(d.time),
                                                    appSettings.dateFormat,
                                                    locale,
                                                )
                                            }
                                            tooltipValueFormat={(v) =>
                                                fmtLargeNum(v)
                                            }
                                            series={
                                                [
                                                    {
                                                        key: "volume",
                                                        label: t(
                                                            "market.volume",
                                                        ),
                                                        accessor: (d) =>
                                                            d.volume,
                                                        color: "hsl(var(--muted-foreground))",
                                                    },
                                                ] as BarSeries<
                                                    (typeof displayChart.points)[number]
                                                >[]
                                            }
                                        />
                                    )}
                                </div>
                            ) : (
                                <div className="flex h-[320px] items-center justify-center type-callout text-label-secondary">
                                    {t("market.noChartData")}
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {/* Trading info (Yahoo symbols only) */}
                    {quote && !isProviderAsset && (
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle variant="sm">
                                    {t("market.tradingInfo")}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="grid gap-3 md:grid-cols-2">
                                    {tradingInfoColumns.map((column, i) => (
                                        <List key={i}>
                                            {column.map(({ label, value }) => (
                                                <ListRow
                                                    key={label}
                                                    className="min-h-10"
                                                    title={
                                                        <span className="text-label-secondary">
                                                            {label}
                                                        </span>
                                                    }
                                                    trailing={
                                                        <span className="text-foreground">
                                                            {value}
                                                        </span>
                                                    }
                                                />
                                            ))}
                                        </List>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* Details — multi-provider scorecard + graded fundamentals, analyst
              consensus, and news (lazy per tab). Hidden for provider-priced
              assets, which Yahoo/FMP don't cover. */}
                    {effectiveSelectedSymbol && !isProviderAsset && (
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle variant="sm">
                                    {t("research.details")}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <Tabs
                                    value={activeTab}
                                    onValueChange={setActiveTab}
                                >
                                    <TabsList>
                                        <TabsTrigger value="fundamentals">
                                            {t("market.fundamentals")}
                                        </TabsTrigger>
                                        <TabsTrigger value="analyst">
                                            {t("market.analystRatings")}
                                        </TabsTrigger>
                                        <TabsTrigger value="news">
                                            {t("market.latestNews")}
                                        </TabsTrigger>
                                    </TabsList>
                                    <TabsContent
                                        value="fundamentals"
                                        className="pt-4"
                                    >
                                        <ResearchFundamentalsTab
                                            symbol={effectiveSelectedSymbol}
                                            enabled={
                                                activeTab === "fundamentals"
                                            }
                                        />
                                    </TabsContent>
                                    <TabsContent
                                        value="analyst"
                                        className="pt-4"
                                    >
                                        <ResearchAnalystTab
                                            symbol={effectiveSelectedSymbol}
                                            enabled={activeTab === "analyst"}
                                        />
                                    </TabsContent>
                                    <TabsContent value="news" className="pt-4">
                                        <ResearchNewsTab
                                            symbol={effectiveSelectedSymbol}
                                            enabled={activeTab === "news"}
                                        />
                                    </TabsContent>
                                </Tabs>
                            </CardContent>
                        </Card>
                    )}

                    {/* Cross-provider symbol mapping (matches the retired symbol page) */}
                    {effectiveSelectedSymbol && !isProviderAsset && (
                        <ResearchMappingDialog
                            open={mappingOpen}
                            onOpenChange={setMappingOpen}
                            instrumentKey={effectiveSelectedSymbol}
                            keyType="internal"
                            query={effectiveSelectedSymbol}
                            displayName={quote?.name ?? effectiveSelectedSymbol}
                            investmentId={mappingInvestmentId}
                        />
                    )}
                </>
            )}
        </PageShell>
    );
}
