import type { WatchlistItem, WatchlistCreate, WatchlistUpdate, WatchlistListResponse } from '@/types/watchlist';
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';
import type { MarketNewsArticle } from '@/lib/api/types';

export type { MarketNewsArticle };

export function getMarketNews(
    symbols?: string[],
    count?: number,
): Promise<{ articles: MarketNewsArticle[] }> {
    const params: Record<string, string | number> = {};
    if (symbols?.length) params.symbols = symbols.join(',');
    if (count) params.count = count;
    return requestWithQuery('/api/market/news', params);
}

export interface MarketQuote {
    symbol: string;
    price: number;
    change: number;
    changePercent: number;
}

/**
 * Fetch quotes for one or more comma-separated symbols. The default `Q` covers
 * the fields every caller relies on; pass a richer type parameter (e.g. the
 * market-lookup page's full `Quote`) when the endpoint's extra fields are needed.
 *
 * `detail: 'basic'` skips the per-symbol fundamentals/analyst `quoteSummary`
 * fetch (~half the outbound Yahoo calls) — use it for price-only views like the
 * benchmark strip and watchlist; omit it (default 'full') when the rich
 * fundamentals/analyst fields are rendered.
 */
export function getMarketQuotes<Q = MarketQuote>(
    symbols: string,
    opts?: { detail?: 'basic' | 'full' },
): Promise<{ quotes: Q[] }> {
    const detail = opts?.detail === 'basic' ? '&detail=basic' : '';
    return apiRequest(`/api/market/quote?symbols=${encodeURIComponent(symbols)}${detail}`);
}

export interface MarketChartPoint {
    time: number;
    close: number;
    high: number;
    low: number;
    volume: number;
}

export interface MarketChartResponse<P = MarketChartPoint> {
    symbol?: string;
    currency?: string;
    points: P[];
}

export function getMarketChart<P = MarketChartPoint>(
    symbol: string,
    range: string,
    interval: string,
): Promise<MarketChartResponse<P>> {
    return requestWithQuery('/api/market/chart', { symbol, range, interval });
}

export interface MarketSearchResult {
    symbol: string;
    name: string;
    type: string;
    exchange: string;
}

export function searchMarket(
    query: string,
): Promise<{ items: MarketSearchResult[] }> {
    return apiRequest(`/api/market/search?q=${encodeURIComponent(query)}`);
}

export function getWatchlist(params?: {
    limit?: number;
    offset?: number;
}): Promise<WatchlistListResponse> {
    const query = params
        ? `?${new URLSearchParams(
              Object.entries(params)
                  .filter(([, v]) => v !== undefined)
                  .map(([k, v]) => [k, String(v)]),
          ).toString()}`
        : '';
    return apiRequest(`/api/watchlist${query}`);
}

export function createWatchlistItem(data: WatchlistCreate): Promise<WatchlistItem> {
    return apiRequest('/api/watchlist', { method: 'POST', body: JSON.stringify(data) });
}

export function updateWatchlistItem(id: number, data: WatchlistUpdate): Promise<WatchlistItem> {
    return apiRequest(`/api/watchlist/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export async function deleteWatchlistItem(id: number): Promise<void> {
    await apiRequest(`/api/watchlist/${id}`, { method: 'DELETE' });
}
