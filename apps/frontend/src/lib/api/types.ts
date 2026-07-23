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
    batch_id?: number;
    requires_review?: boolean;
    /** Planned payments auto-cleared by matching imported transactions. */
    auto_linked_count?: number;
}

export type MatchSource = 'exact' | 'fuzzy' | 'pattern' | 'new';

export interface ImportStagingRow {
    id: number;
    row_index: number;
    recipient_raw: string;
    amount: string;
    currency: string | null;
    tx_date: string;
    memo: string | null;
    /** Account label parsed from the CSV (WP-B6 import disclosure); absent on older servers. */
    bank_account?: string | null;
    match_source: MatchSource | null;
    match_similarity: number | null;
    matched_pattern_id: number | null;
    user_override_recipient_id: number | null;
    override_category_id: number | null;
}

export interface ImportPreviewGroup {
    recipient_id: number | null;
    recipient_name: string | null;
    recipient_default_category_id: number | null;
    recipient_default_category_label: string | null;
    override_category_id: number | null;
    current_category_id: number | null;
    current_category_label: string | null;
    matched_pattern_id: number | null;
    matched_pattern_text: string | null;
    matched_pattern_kind: string | null;
    row_count: number;
    rows: ImportStagingRow[];
}

export interface ImportPreviewResponse {
    batch_id: number;
    groups: ImportPreviewGroup[];
    totals: {
        exact: number;
        fuzzy: number;
        pattern: number;
        new: number;
        unresolved: number;
    };
}

export interface NetWorthSnapshot {
    date: string;
    liquid: number;
    /** Σ liability-account balances (negative); split out of `liquid` (ADR-092). */
    liabilities: number;
    investments: number;
    netWorth: number;
}

export interface NetWorthResponse {
    current: {
        liquid: number;
        liabilities: number;
        investments: number;
        netWorth: number;
    };
    monthlyChange: number;
    monthlyChangePercent: number;
    snapshots: NetWorthSnapshot[];
    /** Total number of snapshots server-side (only set when pagination params sent). */
    snapshotsTotal?: number;
}

export type ChartType = 'line' | 'bar' | 'area';
// 'ranked' = one bar per entity, sized by total spend over the range (bar only).
export type ChartVariant = 'default' | 'stacked' | 'grouped' | 'ranked';
export type TimeBucket = 'monthly' | 'yearly';

export interface SavedChart {
    id: number;
    name: string;
    chart_type: ChartType;
    chart_variant: ChartVariant;
    time_bucket: TimeBucket;
    category_ids: number[];
    recipient_ids: number[];
    tag_ids: number[];
    // Dynamic "all of this dimension" sources. When true the matching *_ids list
    // is ignored and every entity (incl. ones added later) is charted.
    all_categories: boolean;
    all_recipients: boolean;
    all_tags: boolean;
    date_range_start: string | null;
    date_range_end: string | null;
    created_at: string;
    updated_at: string;
}

export interface SavedChartCreate {
    name: string;
    chartType: ChartType;
    chartVariant?: ChartVariant;
    timeBucket?: TimeBucket;
    categoryIds: number[];
    recipientIds?: number[];
    tagIds?: number[];
    allCategories?: boolean;
    allRecipients?: boolean;
    allTags?: boolean;
    dateRangeStart?: string | null;
    dateRangeEnd?: string | null;
}

export interface ImportBatch {
    id: number;
    adapter_name: string;
    source_filename: string | null;
    source_size_bytes: number | null;
    status: 'pending' | 'staging' | 'validating' | 'matching' | 'committing' | 'complete' | 'failed' | 'aborted';
    rows_total: number | null;
    rows_imported: number | null;
    rows_duplicate: number | null;
    rows_error: number | null;
    error_summary: string | null;
    started_at: string;
    completed_at: string | null;
    transactions_remaining: number;
}

export interface BatchListResponse {
    batches: ImportBatch[];
    total: number;
    limit: number;
    offset: number;
}

export interface MarketNewsArticle {
    title: string;
    link: string;
    publisher: string;
    publishedAt: number | null;
    thumbnail: string | null;
    relatedSymbols: string[];
}
