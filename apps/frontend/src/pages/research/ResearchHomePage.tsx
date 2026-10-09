import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { useMemo } from "react";
import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { List, ListRow } from "@/components/ui/list";
import { ArrowRight, Plus } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { numberFormatToLocale } from "@/utils/currency";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { useSymbolSearch } from "@/hooks/useSymbolSearch";
import { useMarketQuotesQuery } from "@/hooks/useMarketQuotesQuery";
import { apiClient } from "@/lib/api";
import { watchlistKeys } from "@/lib/queryKeys";
import { useWatchlist } from "@/features/research/useWatchlistData";
import { PageHeader } from "@/components/shared/PageHeader";
import { PortfolioNewsFeed } from "@/features/portfolio/PortfolioNewsFeed";
import { ResearchUnavailableNote } from "@/features/research/ResearchUnavailableNote";
import { SymbolSearchResultItem } from "@/components/shared/SymbolSearchResultItem";
import { SymbolSearchBox } from "@/components/shared/SymbolSearchBox";
import { EmptyState } from "@/components/shared/EmptyState";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { PageShell } from "@/components/shared/PageShell";

// Global-mix market snapshot (ADR-079 Research home). Yahoo index/crypto
// symbols; labels are proper nouns kept out of i18n. Index prices are points,
// not a currency, so the strip renders a plain locale-formatted number.
const BENCHMARKS: ReadonlyArray<{ symbol: string; label: string }> = [
    { symbol: "^GSPC", label: "S&P 500" },
    { symbol: "^STOXX50E", label: "Euro Stoxx 50" },
    { symbol: "^FTSE", label: "FTSE 100" },
    { symbol: "^BFX", label: "BEL 20" },
    { symbol: "BTC-USD", label: "Bitcoin" },
];
const BENCHMARK_SYMBOLS = BENCHMARKS.map((b) => b.symbol).join(",");

const marketHref = (symbol: string) =>
    `/research/market?symbol=${encodeURIComponent(symbol)}`;

export default function ResearchHomePage() {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const { searchText, setSearchText, searchResult, isFetching, isOpen } =
        useSymbolSearch(apiClient.searchResearch, {
            queryKey: "research-search",
        });

    const numberFmt = useMemo(
        () =>
            new Intl.NumberFormat(locale, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            }),
        [locale],
    );

    const items = searchResult?.data.items ?? [];
    const searchUnavailable = searchResult?.meta.source === "unavailable";

    // Live benchmark strip. 60s polling mirrors the watchlist quote cadence.
    const { data: benchmarkData } = useMarketQuotesQuery(
        ["research-benchmarks", BENCHMARK_SYMBOLS],
        BENCHMARK_SYMBOLS,
        { staleTime: QUERY_STALE_TIME_MS.STANDARD },
    );
    const benchmarkMap = useMemo(
        () => new Map((benchmarkData ?? []).map((q) => [q.symbol, q])),
        [benchmarkData],
    );

    const { data: watchlist } = useWatchlist(60_000);
    const watchlistItems = useMemo(() => watchlist?.items ?? [], [watchlist]);
    const watchlistPreview = useMemo(
        () => watchlistItems.slice(0, 9),
        [watchlistItems],
    );

    // Same key construction as WatchlistPage so the two pages share the cache.
    const watchlistSymbols = useMemo(
        () =>
            watchlistItems
                .map((i) => i.symbol)
                .filter(Boolean)
                .join(","),
        [watchlistItems],
    );
    const { data: watchlistQuotes } = useMarketQuotesQuery(
        watchlistKeys.quotes(watchlistSymbols),
        watchlistSymbols,
        { staleTime: QUERY_STALE_TIME_MS.STANDARD },
    );
    const watchlistPriceMap = useMemo(
        () => new Map((watchlistQuotes ?? []).map((q) => [q.symbol, q])),
        [watchlistQuotes],
    );

    // News seeds from watchlist symbols; an empty list yields general headlines.
    const newsSymbols = useMemo(
        () =>
            watchlistItems
                .map((i) => i.symbol)
                .filter((s): s is string => !!s)
                .slice(0, 10),
        [watchlistItems],
    );

    // Shared cached currency formatter (app locale + showDecimalPlaces defaults).
    const formatPrice = useCurrencyFormatter();

    return (
        <PageShell className="">
            <PageHeader
                title={t("research.title")}
                subtitle={t("research.subtitle")}
                icon={PAGE_ICONS["/research"]}
            />

            {/* Prominent search */}
            <SymbolSearchBox
                autoFocus
                className="max-w-2xl"
                placeholder={t("research.searchPlaceholder")}
                value={searchText}
                onChange={setSearchText}
                open={isOpen}
                onDismiss={() => setSearchText("")}
            >
                {searchUnavailable ? (
                    <div className="p-2">
                        <ResearchUnavailableNote
                            provider={searchResult?.meta.provider ?? null}
                        />
                    </div>
                ) : items.length > 0 ? (
                    items.map((item) => (
                        <SymbolSearchResultItem
                            key={`${item.symbol}-${item.exchange}`}
                            item={item}
                            to={marketHref(item.symbol)}
                        />
                    ))
                ) : !isFetching ? (
                    <p className="px-3 py-3 type-callout text-label-secondary">
                        {t("research.noResults")}
                    </p>
                ) : null}
            </SymbolSearchBox>

            {/* Market snapshot strip */}
            <section className="space-y-3">
                <h2 className="type-headline text-label-secondary">
                    {t("research.marketSnapshot")}
                </h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                    {BENCHMARKS.map((b) => {
                        const quote = benchmarkMap.get(b.symbol);
                        const pct = quote?.changePercent;
                        return (
                            <Card key={b.symbol} variant="interactive" asChild>
                                <Link to={marketHref(b.symbol)}>
                                    <CardContent variant="compact">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="truncate type-caption text-label-secondary">
                                                {b.label}
                                            </span>
                                            {pct != null && (
                                                <DeltaPill
                                                    value={pct}
                                                    label={formatPercent(pct, {
                                                        digits: 2,
                                                        signed: true,
                                                    })}
                                                />
                                            )}
                                        </div>
                                        {quote ? (
                                            <>
                                                <p className="mt-2 type-title-3 tabular-nums text-foreground">
                                                    {numberFmt.format(
                                                        quote.price,
                                                    )}
                                                </p>
                                                <p className="type-footnote tabular-nums text-label-secondary">
                                                    {quote.change > 0
                                                        ? "+"
                                                        : ""}
                                                    {numberFmt.format(
                                                        quote.change,
                                                    )}
                                                </p>
                                            </>
                                        ) : (
                                            <p className="mt-2 type-title-3 tabular-nums text-label-tertiary">
                                                —
                                            </p>
                                        )}
                                    </CardContent>
                                </Link>
                            </Card>
                        );
                    })}
                </div>
            </section>

            {/* Watchlist + News */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
                <div className="h-full min-h-0 lg:col-span-2">
                    <Card className="flex flex-col">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                            <CardTitle variant="sm">
                                {t("research.watchlistPreview")}
                            </CardTitle>
                            {watchlistPreview.length > 0 && (
                                <Button asChild variant="ghost" size="sm">
                                    <Link to="/research/watchlist">
                                        {t("research.viewAll")}
                                        <ArrowRight
                                            className="h-4 w-4"
                                            aria-hidden="true"
                                        />
                                    </Link>
                                </Button>
                            )}
                        </CardHeader>
                        <CardContent className="min-h-0 flex-1">
                            {watchlistPreview.length > 0 ? (
                                <List>
                                    {watchlistPreview.map((item) => {
                                        const quote = item.symbol
                                            ? watchlistPriceMap.get(item.symbol)
                                            : undefined;
                                        const pct = quote?.changePercent;
                                        const trailing = (
                                            <>
                                                <span className="text-foreground">
                                                    {quote
                                                        ? formatPrice(
                                                              quote.price,
                                                              {
                                                                  currency:
                                                                      item.currency,
                                                              },
                                                          )
                                                        : "—"}
                                                </span>
                                                {pct != null && (
                                                    <DeltaPill
                                                        value={pct}
                                                        label={formatPercent(
                                                            pct,
                                                            {
                                                                digits: 2,
                                                                signed: true,
                                                            },
                                                        )}
                                                    />
                                                )}
                                            </>
                                        );
                                        return item.symbol ? (
                                            <ListRow
                                                key={item.id}
                                                asChild
                                                chevron
                                                title={
                                                    <span className="font-mono font-medium">
                                                        {item.symbol}
                                                    </span>
                                                }
                                                subtitle={item.name}
                                                trailing={trailing}
                                            >
                                                <Link
                                                    to={marketHref(item.symbol)}
                                                />
                                            </ListRow>
                                        ) : (
                                            <ListRow
                                                key={item.id}
                                                className="opacity-60"
                                                title={item.name}
                                                trailing={trailing}
                                            />
                                        );
                                    })}
                                </List>
                            ) : (
                                <EmptyState
                                    headingLevel={3}
                                    size="compact"
                                    icon={PAGE_ICONS["/research/watchlist"]}
                                    title={t("research.watchlistEmpty")}
                                    action={
                                        <Button
                                            asChild
                                            size="sm"
                                            variant="outline"
                                        >
                                            <Link to="/research/watchlist">
                                                <Plus
                                                    className="h-4 w-4"
                                                    aria-hidden="true"
                                                />
                                                {t(
                                                    "research.watchlistEmptyCta",
                                                )}
                                            </Link>
                                        </Button>
                                    }
                                />
                            )}
                        </CardContent>
                    </Card>
                </div>
                <div className="h-full min-h-0 lg:col-span-1">
                    <PortfolioNewsFeed symbols={newsSymbols} />
                </div>
            </div>
        </PageShell>
    );
}
