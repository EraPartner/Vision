/**
 * Shared envelope / response shape types used by the API client.
 *
 * Kept in a dedicated module so domain clients can import them without
 * pulling the full `api.ts` surface (see Phase 1 split in the Vision
 * perf/arch plan).
 */

export interface AggregationEnvelope<T> {
    data: T;
    meta: {
        computedAt: string;
        source: 'mv' | 'live';
    };
}

export interface ImportProgress {
    phase: string;
    current: number;
    total: number;
    imported: number;
    duplicates: number;
    errors: number;
    percent: number;
}

export interface ImportResult {
    total_processed: number;
    imported: number;
    duplicates: number;
    errors: number;
    status?: string;
    error_message?: string;
}

export interface NetWorthSnapshot {
    date: string;
    liquid: number;
    investments: number;
    netWorth: number;
}

export interface NetWorthResponse {
    current: {
        liquid: number;
        investments: number;
        netWorth: number;
    };
    monthlyChange: number;
    monthlyChangePercent: number;
    snapshots: NetWorthSnapshot[];
    /** Total number of snapshots server-side (only set when pagination params sent). */
    snapshotsTotal?: number;
}

export interface SavedChart {
    id: number;
    name: string;
    chart_type: 'line' | 'bar' | 'area';
    category_ids: number[];
    created_at: string;
    updated_at: string;
}

export interface SavedChartCreate {
    name: string;
    chartType: 'line' | 'bar' | 'area';
    categoryIds: number[];
}

export interface MarketNewsArticle {
    title: string;
    link: string;
    publisher: string;
    publishedAt: number | null;
    thumbnail: string | null;
    relatedSymbols: string[];
}
