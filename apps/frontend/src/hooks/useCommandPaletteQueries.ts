import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";

interface PaletteQuote {
    symbol: string;
    name: string;
    price: number;
    change: number;
    changePercent: number;
    currency: string;
}

export function usePaletteRecipientSearch(query: string, open: boolean) {
    return useQuery({
        queryKey: ["palette-recipients", query],
        queryFn: () =>
            apiClient.getRecipients({ search: query, active: true, limit: 5 }),
        enabled: open && query.length >= 2,
        staleTime: QUERY_STALE_TIME_MS.FREQUENT,
    });
}

export function usePaletteTickerQuote(symbol: string, open: boolean) {
    return useQuery({
        queryKey: ["palette-quote", symbol],
        queryFn: async () => {
            const quotes = await apiClient.getMarketQuotes<PaletteQuote>(
                symbol,
                {
                    detail: "basic",
                },
            );
            return quotes[0] ?? null;
        },
        enabled: open && symbol.length >= 1,
        staleTime: QUERY_STALE_TIME_MS.FREQUENT,
    });
}
