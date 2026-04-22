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
