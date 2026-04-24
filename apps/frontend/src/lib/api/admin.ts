/**
 * Admin API client.
 *
 * Wraps /api/admin/* routes for database maintenance, feature flags, etc.
 */

import { apiRequest } from '@/lib/api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DbTableStat {
    schemaname: string;
    table_name: string;
    live_rows: string;
    dead_rows: string;
    last_autovacuum: string | null;
    last_autoanalyze: string | null;
    size: string;
    size_bytes: string;
}

export interface DbStats {
    tables: DbTableStat[];
    db_size: string | null;
}

export interface FeatureFlag {
    key: string;
    enabled: boolean;
    description: string | null;
    created_at: string;
    updated_at: string | null;
}

// ── Shadow Divergences ────────────────────────────────────────────────────────

export interface ShadowDivergence {
    id: number;
    endpoint: string;
    request_params: Record<string, unknown>;
    divergences: Record<string, unknown>;
    divergence_count: number;
    created_at: string;
}

export interface ShadowDivergenceEndpointSummary {
    endpoint: string;
    count: number;
    last_seen: string;
    max_divergence_count: number;
}

export interface ShadowDivergencesSummary {
    endpoints: ShadowDivergenceEndpointSummary[];
    total: number;
}

export interface ShadowDivergencesPage {
    rows: ShadowDivergence[];
    total: number;
    limit: number;
    offset: number;
}

export function getShadowDivergencesSummary(): Promise<ShadowDivergencesSummary> {
    return apiRequest<ShadowDivergencesSummary>('/api/admin/shadow-divergences/summary');
}

export function getShadowDivergences(params?: {
    endpoint?: string;
    limit?: number;
    offset?: number;
}): Promise<ShadowDivergencesPage> {
    const qp = new URLSearchParams();
    if (params?.endpoint) qp.set('endpoint', params.endpoint);
    if (params?.limit != null) qp.set('limit', String(params.limit));
    if (params?.offset != null) qp.set('offset', String(params.offset));
    const qs = qp.toString();
    return apiRequest<ShadowDivergencesPage>(`/api/admin/shadow-divergences${qs ? `?${qs}` : ''}`);
}

// ── Database Maintenance ──────────────────────────────────────────────────────

export function getDbStats(): Promise<DbStats> {
    return apiRequest<DbStats>('/api/admin/database/stats');
}

export function vacuumTable(table: string | null): Promise<{ vacuumed: string }> {
    return apiRequest<{ vacuumed: string }>('/api/admin/database/vacuum', {
        method: 'POST',
        body: JSON.stringify({ table }),
    });
}

// ── Feature Flags ─────────────────────────────────────────────────────────────

export function listFeatureFlags(): Promise<FeatureFlag[]> {
    return apiRequest<FeatureFlag[]>('/api/admin/feature-flags');
}

export function setFeatureFlag(key: string, enabled: boolean): Promise<FeatureFlag> {
    return apiRequest<FeatureFlag>(`/api/admin/feature-flags/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
    });
}
