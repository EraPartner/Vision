import { useQuery, type QueryKey } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import type { MarketQuote } from '@/lib/api/market';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { QUERY_STALE_TIME_MS } from '@/lib/queryPolicies';

/**
 * Shared 60s online-gated batch-quote poll for the research pages: price-only
 * (detail=basic) quotes, polling and retry suspended while offline. The caller
 * owns the query key — several pages deliberately share the "watchlist-quotes"
 * cache entry — the hook owns the cadence and offline guards.
 */
export function useMarketQuotesQuery<Q = MarketQuote>(
    queryKey: QueryKey,
    symbols: string,
    options?: { staleTime?: number | undefined },
) {
    const isOnline = useOnlineStatus();
    return useQuery({
        queryKey,
        queryFn: () =>
            symbols
                ? apiClient.getMarketQuotes<Q>(symbols, { detail: 'basic' })
                : Promise.resolve<Q[]>([]),
        enabled: !!symbols && isOnline,
        // Fresh for one poll period, so moving between research pages that
        // share a key reuses the last poll instead of refetching (ADR-256).
        staleTime: options?.staleTime ?? QUERY_STALE_TIME_MS.STANDARD,
        refetchInterval: isOnline ? 60_000 : false,
        refetchOnWindowFocus: false,
        retry: isOnline ? 1 : false,
    });
}
