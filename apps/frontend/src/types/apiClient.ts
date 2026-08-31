/**
 * Shared envelope / response shape types used by the API client.
 *
 * Kept in a dedicated module so domain clients can import them without
 * pulling the full `api.ts` surface (see Phase 1 split in the Vision
 * perf/arch plan).
 */

import type { components } from "@/types/generated";
import type { ResearchNewsArticle } from "@/types/research";

export interface AggregationEnvelope<T> {
    data: T;
    meta: {
        computedAt: string;
        source: "mv" | "live";
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

/**
 * Result of the SSE import stream (`POST /api/import/csv/stream`). Stays
 * hand-written: the spec documents that route's response as an opaque
 * `text/event-stream` (matching the portfolio sibling), so there is no
 * generated schema to pin to — the `complete` event's payload is defined by
 * `buildComplete` in node-backend routes/importRoutes.js.
 */
export interface ImportResult {
    /**
     * Absent on the synthesized review-required result — the backend's
     * `review_required` SSE event carries no counts (lib/importProgress.js
     * emits only `{batch_id, match_source_counts, percent}`).
     */
    total_processed?: number;
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

export type MatchSource = "exact" | "fuzzy" | "pattern" | "new";

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
    /**
     * Pagination facts for `snapshots`, in the body (the one API-wide
     * convention — there is no `meta.pagination`). All three are set only when
     * the request supplied limit/offset; without them `snapshots` is the
     * complete series.
     */
    snapshotsTotal?: number;
    snapshotsLimit?: number;
    snapshotsOffset?: number;
}

export type ChartType = "line" | "bar" | "area";
// 'ranked' = one bar per entity, sized by total spend over the range (bar only).
export type ChartVariant = "default" | "stacked" | "grouped" | "ranked";
export type TimeBucket = "monthly" | "yearly";

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

export type ImportBatch = components["schemas"]["ImportBatch"];

export interface BatchListResponse {
    items: ImportBatch[];
    total: number;
    limit: number;
    offset: number;
}

export type MarketNewsArticle = ResearchNewsArticle;
