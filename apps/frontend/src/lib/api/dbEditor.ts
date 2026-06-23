/**
 * DB data-editor API client.
 *
 * Wraps /api/admin/database/tables/* — the JetBrains-style table browser/editor.
 * All routes are admin-gated; the Bearer token is attached by apiRequest.
 */

import { apiRequest } from '@/lib/api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DbColumn {
    name: string;
    dataType: string;
    udtName: string;
    nullable: boolean;
    hasDefault: boolean;
    generated: boolean;
    /** GENERATED ALWAYS / identity-always columns can't be written. */
    writable: boolean;
}

/** A row plus the hidden xmin optimistic-concurrency token. */
export type DbRow = Record<string, unknown> & { __xmin?: string };

export interface TableSchema {
    table: string;
    columns: DbColumn[];
    primaryKey: string[];
}

export interface TableRows extends TableSchema {
    rows: DbRow[];
    total: number;
    limit: number;
    offset: number;
}

export type FilterOp =
    | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
    | 'contains' | 'startsWith' | 'isnull' | 'notnull';

export interface DbFilter {
    column: string;
    op?: FilterOp;
    value?: unknown;
}

export interface ReadParams {
    limit?: number;
    offset?: number;
    orderBy?: string;
    dir?: 'asc' | 'desc';
    where?: string;
    filters?: DbFilter[];
}

export type DbChange =
    | { op: 'insert'; values: Record<string, unknown> }
    | { op: 'update'; pk: Record<string, unknown>; xmin?: string; set: Record<string, unknown> }
    | { op: 'delete'; pk: Record<string, unknown>; xmin?: string };

export interface PreviewStatement {
    op: string;
    preview: string;
}

export interface PreviewResult {
    dryRun: true;
    count: number;
    statements: PreviewStatement[];
}

export interface CommitResult {
    dryRun: false;
    applied: number;
    results: { op: string; after?: DbRow }[];
    refreshScheduled: boolean;
}

// ── Calls ─────────────────────────────────────────────────────────────────────

const base = (table: string) => `/api/admin/database/tables/${encodeURIComponent(table)}`;

export function getTableSchema(table: string): Promise<TableSchema> {
    return apiRequest<TableSchema>(`${base(table)}/schema`);
}

export function getTableRows(table: string, params: ReadParams = {}): Promise<TableRows> {
    const q = new URLSearchParams();
    if (params.limit !== undefined) q.set('limit', String(params.limit));
    if (params.offset !== undefined) q.set('offset', String(params.offset));
    if (params.orderBy) q.set('orderBy', params.orderBy);
    if (params.dir) q.set('dir', params.dir);
    if (params.where) q.set('where', params.where);
    if (params.filters && params.filters.length) q.set('filters', JSON.stringify(params.filters));
    const qs = q.toString();
    return apiRequest<TableRows>(`${base(table)}/rows${qs ? `?${qs}` : ''}`);
}

export function previewTableMutation(table: string, changes: DbChange[]): Promise<PreviewResult> {
    return apiRequest<PreviewResult>(`${base(table)}/mutate`, {
        method: 'POST',
        body: JSON.stringify({ changes, dryRun: true }),
    });
}

export function commitTableMutation(table: string, changes: DbChange[]): Promise<CommitResult> {
    return apiRequest<CommitResult>(`${base(table)}/mutate`, {
        method: 'POST',
        body: JSON.stringify({ changes }),
    });
}
