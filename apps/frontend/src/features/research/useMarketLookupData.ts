import { useQuery } from "@tanstack/react-query";

import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { apiClient } from "@/lib/api";
import { getInvestmentPriceHistory } from "@/lib/api/portfolio";
import { marketKeys } from "@/lib/queryKeys";

const DAY_MS = 24 * 60 * 60 * 1000;

export function rangeToFromMs(range: string, now = Date.now()): number {
    switch (range) {
        case "1d":
            return now - DAY_MS;
        case "5d":
            return now - 5 * DAY_MS;
        case "1mo":
            return now - 30 * DAY_MS;
        case "3mo":
            return now - 91 * DAY_MS;
        case "6mo":
            return now - 182 * DAY_MS;
        case "1y":
            return now - 365 * DAY_MS;
        case "5y":
            return now - 5 * 365 * DAY_MS;
        case "max":
            return 0;
        default:
            return now - 30 * DAY_MS;
    }
}

interface ProviderInvestment {
    id: number;
    symbol?: string;
    currency: string;
}

export interface MarketChartPoint {
    time: number;
    close: number;
    high: number;
    low: number;
    volume: number;
}

export function useMarketLookupData<Quote>({
    symbol,
    range,
    interval,
    providerInvestment,
    isProviderAsset,
    useYahoo,
}: {
    symbol: string | null;
    range: string;
    interval: string;
    providerInvestment: ProviderInvestment | undefined;
    isProviderAsset: boolean;
    useYahoo: boolean;
}) {
    const isOnline = useOnlineStatus();
    const quoteQuery = useQuery({
        queryKey: marketKeys.quote(symbol),
        queryFn: async () => {
            const quotes = await apiClient.getMarketQuotes<Quote>(symbol!, {
                detail: "basic",
            });
            return quotes[0] ?? null;
        },
        enabled: useYahoo && isOnline,
        staleTime: 30_000,
        refetchInterval: isOnline ? 60_000 : false,
    });
    const chartQuery = useQuery({
        queryKey: marketKeys.chart(symbol, range, interval),
        queryFn: () => apiClient.getMarketChart(symbol!, range, interval),
        enabled: useYahoo,
        staleTime: 60_000,
    });
    const providerChartQuery = useQuery({
        queryKey: marketKeys.providerChart(providerInvestment?.id, range),
        queryFn: async () => {
            const response = await getInvestmentPriceHistory(
                providerInvestment!.id,
                {
                    from_ms: rangeToFromMs(range),
                    db_only: false,
                },
            );
            const points: MarketChartPoint[] = response.points.map((point) => ({
                time: point.timestampMs,
                close: point.price,
                high: point.price,
                low: point.price,
                volume: 0,
            }));
            return {
                symbol: providerInvestment!.symbol ?? symbol ?? "",
                currency: providerInvestment!.currency,
                points,
            };
        },
        enabled: isProviderAsset && !!providerInvestment,
        staleTime: 60_000,
    });

    return {
        quoteData: quoteQuery.data,
        isQuoteLoading: quoteQuery.isFetching,
        chartData: chartQuery.data,
        isChartLoading: chartQuery.isFetching,
        providerChartData: providerChartQuery.data,
        isProviderChartLoading: providerChartQuery.isFetching,
    };
}
