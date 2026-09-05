import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { ChartPeriod } from "@/components/charts";
import { apiClient } from "@/lib/api";
import { getMarketQuotes, searchMarket } from "@/lib/api/market";
import { netWorthKeys, portfolioKeys } from "@/lib/queryKeys";
import { useBackgroundQueryCue } from "@/components/shared/BackgroundQueryIndicator";

export function useMarketSearchQuery(query: string, enabled: boolean) {
    return useQuery({
        queryKey: ["market-search", query],
        queryFn: async () => {
            if (!query || query.length < 2) return { items: [] };
            try {
                return await searchMarket(query);
            } catch {
                return { items: [] };
            }
        },
        enabled,
        retry: false,
        refetchOnWindowFocus: false,
    });
}

export function useMarketQuoteQuery(symbol: string | undefined) {
    return useQuery({
        queryKey: ["quote", symbol],
        queryFn: async () => {
            if (!symbol) return null;
            try {
                const quotes = await getMarketQuotes(symbol, {
                    detail: "basic",
                });
                return quotes[0] ?? null;
            } catch {
                return null;
            }
        },
        enabled: !!symbol,
        retry: false,
        refetchOnWindowFocus: false,
    });
}

export function useWatchlistMarketQueries(
    symbol: string | null | undefined,
    range: string,
    interval: string,
    enabled: boolean,
) {
    const chart = useQuery({
        queryKey: ["watchlist-chart", symbol, range],
        queryFn: async () => {
            if (!symbol) return null;
            try {
                return await apiClient.getMarketChart(symbol, range, interval);
            } catch {
                return null;
            }
        },
        enabled: !!symbol && enabled,
        retry: false,
        refetchOnWindowFocus: false,
    });
    const quote = useQuery({
        queryKey: ["watchlist-quote", symbol],
        queryFn: async () => {
            if (!symbol) return null;
            try {
                const quotes = await apiClient.getMarketQuotes(symbol, {
                    detail: "basic",
                });
                return quotes[0] ?? null;
            } catch {
                return null;
            }
        },
        enabled: !!symbol && enabled,
        retry: false,
        refetchOnWindowFocus: false,
    });
    return { chart, quote };
}

export function usePortfolioNews(
    symbols: string[],
    limit: number,
    isOnline: boolean,
) {
    return useQuery({
        queryKey: ["market-news", symbols],
        queryFn: () =>
            apiClient.getMarketNews(
                symbols.length > 0 ? symbols : undefined,
                limit,
            ),
        staleTime: 5 * 60 * 1000,
        refetchInterval: isOnline ? 10 * 60 * 1000 : false,
        refetchOnWindowFocus: false,
        retry: isOnline ? 1 : false,
        enabled: isOnline,
    });
}

export function usePortfolioTickerQuotes<T>(
    symbols: string,
    hasSymbols: boolean,
    isOnline: boolean,
    active: boolean,
) {
    return useQuery({
        queryKey: ["portfolio-ticker", symbols],
        queryFn: () =>
            apiClient.getMarketQuotes<T>(symbols, { detail: "basic" }),
        enabled: isOnline && hasSymbols,
        staleTime: 60_000,
        refetchInterval: active && isOnline ? 60_000 : false,
        refetchOnWindowFocus: false,
        retry: isOnline ? 1 : false,
    });
}

export function usePerformanceQueries(currency: string, period: ChartPeriod) {
    const performance = useQuery({
        queryKey: portfolioKeys.performance(currency, period),
        queryFn: () => apiClient.getPortfolioPerformance({ currency, period }),
        staleTime: 300_000,
        gcTime: 10 * 60_000,
        placeholderData: keepPreviousData,
    });
    useBackgroundQueryCue(
        performance.isFetching && performance.isPlaceholderData,
    );
    const sparkline1m = useQuery({
        queryKey: portfolioKeys.performance(currency, "1m"),
        queryFn: () =>
            apiClient.getPortfolioPerformance({ currency, period: "1m" }),
        staleTime: 300_000,
        gcTime: 10 * 60_000,
    });
    return { performance, sparkline1m };
}

export function useRebalanceInputs(currency: string) {
    return useQuery({
        queryKey: ["rebalance-inputs", currency],
        queryFn: () =>
            apiClient.computeRebalance({ model: "sixty_forty", currency }),
        staleTime: 60_000,
    });
}

export const portfolioImportPreviewKey = (batchId: number) =>
    ["portfolio-import-preview", batchId] as const;

export function usePortfolioImportPreview(batchId: number) {
    return useQuery({
        queryKey: portfolioImportPreviewKey(batchId),
        queryFn: () => apiClient.getPortfolioImportPreview(batchId),
        enabled: Number.isFinite(batchId),
    });
}

export function useNetWorthSummary(currency: string) {
    return useQuery({
        queryKey: netWorthKeys.byCurrency(currency),
        queryFn: () => apiClient.getNetWorth({ currency }),
        staleTime: 120_000,
    });
}
