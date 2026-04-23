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

export function getMarketQuotes(
    symbols: string,
): Promise<{ quotes: Array<{ symbol: string; price: number; change: number; changePercent: number }> }> {
    return apiRequest(`/api/market/quote?symbols=${encodeURIComponent(symbols)}`);
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
