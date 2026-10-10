import type {
    WatchlistItem,
    WatchlistCreate,
    WatchlistUpdate,
    WatchlistListResponse,
} from "@/types/watchlist";
import { apiRequest } from "@/lib/api/client";
import { requestWithQuery } from "@/lib/api/helpers";
import {
    MarketChartSchema,
    MarketNewsListSchema,
    MarketQuoteListSchema,
    MarketSearchSchema,
    WatchlistItemSchema,
    WatchlistListSchema,
} from "@vision/types/contracts";
import type { MarketNewsArticle } from "@/types/apiClient";
import type {
    MarketChartPoint,
    MarketChartResponse,
    MarketQuote,
    ResearchSearchItem,
} from "@/types/research";

export type { MarketNewsArticle };
export type {
    MarketChartPoint,
    MarketChartResponse,
    MarketQuote,
    ResearchSearchItem,
};

/** Canonical `{items, total}` collection body — callers only need the rows. */
export async function getMarketNews(
    symbols?: string[],
    count?: number,
): Promise<MarketNewsArticle[]> {
    const params: Record<string, string | number> = {};
    if (symbols?.length) params.symbols = symbols.join(",");
    if (count) params.count = count;
    const { items } = await requestWithQuery<{
        items: MarketNewsArticle[];
        total: number;
    }>("/api/market/news", params, { schema: MarketNewsListSchema });
    return items;
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
export async function getMarketQuotes<Q = MarketQuote>(
    symbols: string,
    opts?: { detail?: "basic" | "full" },
): Promise<Q[]> {
    const detail = opts?.detail === "basic" ? "&detail=basic" : "";
    // Canonical `{items, total}` collection body — callers only need the rows.
    const { items } = await apiRequest<{ items: Q[]; total: number }>(
        `/api/market/quote?symbols=${encodeURIComponent(symbols)}${detail}`,
        { schema: MarketQuoteListSchema },
    );
    return items;
}

/**
 * The wire body is the canonical `{items, total}` collection (with `symbol` and
 * `currency` alongside); the series is re-surfaced as `points` here so chart
 * consumers keep a domain-named field.
 */
export async function getMarketChart<P = MarketChartPoint>(
    symbol: string,
    range: string,
    interval: string,
): Promise<MarketChartResponse<P>> {
    const { items, ...rest } = await requestWithQuery<{
        symbol?: string;
        currency?: string;
        items: P[];
        total: number;
    }>(
        "/api/market/chart",
        { symbol, range, interval },
        { schema: MarketChartSchema },
    );
    return { symbol: rest.symbol, currency: rest.currency, points: items };
}

export function searchMarket(
    query: string,
): Promise<{ items: ResearchSearchItem[] }> {
    return apiRequest(`/api/market/search?q=${encodeURIComponent(query)}`, {
        schema: MarketSearchSchema,
    });
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
        : "";
    return apiRequest(`/api/watchlist${query}`, {
        schema: WatchlistListSchema,
    });
}

export function createWatchlistItem(
    data: WatchlistCreate,
): Promise<WatchlistItem> {
    return apiRequest("/api/watchlist", {
        method: "POST",
        body: JSON.stringify(data),
        schema: WatchlistItemSchema,
    });
}

export function updateWatchlistItem(
    id: number,
    data: WatchlistUpdate,
): Promise<WatchlistItem> {
    return apiRequest(`/api/watchlist/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
        schema: WatchlistItemSchema,
    });
}

export async function deleteWatchlistItem(id: number): Promise<void> {
    await apiRequest(`/api/watchlist/${id}`, { method: "DELETE" });
}
