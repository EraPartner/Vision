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
