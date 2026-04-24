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

export type ProviderKind = 'price' | 'fx' | 'inflation';

export interface ProviderHealth {
    provider: string;
    kind: ProviderKind;
    label: string;
    last_success_at: string | null;
    last_error_at: string | null;
    last_error: string | null;
    consecutive_failures: number;
    updated_at: string | null;
}

export interface ProbeResult {
    ok: boolean;
    provider: string;
    error?: string;
}

export interface RouteMetric {
    route: string;
    method: string;
    path: string;
    count: number;
    errors: number;
    error_rate: number;
    p50_ms: number;
    p95_ms: number;
    window_minutes: number;
}

export interface EndpointEntry {
    method: string;
    path: string;
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

// ── Provider Health ───────────────────────────────────────────────────────────

export function getProviderHealth(): Promise<ProviderHealth[]> {
    return apiRequest<ProviderHealth[]>('/api/admin/providers/health');
}

export function probeProvider(provider: string): Promise<ProbeResult> {
    return apiRequest<ProbeResult>(`/api/admin/providers/${encodeURIComponent(provider)}/probe`, {
        method: 'POST',
    });
}

// ── Request Metrics ───────────────────────────────────────────────────────────

export function getRequestMetrics(): Promise<RouteMetric[]> {
    return apiRequest<RouteMetric[]>('/api/admin/metrics/requests');
}

// ── Endpoint Manifest ─────────────────────────────────────────────────────────

export function getEndpointManifest(): Promise<EndpointEntry[]> {
    return apiRequest<EndpointEntry[]>('/api/admin/endpoints');
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
