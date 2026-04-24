/**
 * Bank reconciliation API client.
 *
 * Wraps the /api/reconciliation/* routes defined in
 * apps/node-backend/src/routes/reconciliation.js.
 */

import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReconciliationMatchStatus =
    | 'unmatched'
    | 'auto'
    | 'confirmed'
    | 'manual'
    | 'ignored';

export interface BankStatement {
    id: number;
    bank_account: string;
    currency: string;
    period_start: string;
    period_end: string;
    opening_balance: string | null;
    closing_balance: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string | null;
    total_entries: number;
    unmatched_count: number;
    matched_count: number;
}

export interface ReconciliationEntry {
    id: number;
    bank_statement_id: number;
    entry_date: string;
    description: string | null;
    amount: string;
    currency: string;
    transaction_id: number | null;
    match_status: ReconciliationMatchStatus;
    match_score: string | null;
    created_at: string;
}

export interface MatchCandidate {
    id: number;
    date: string;
    amount: string;
    currency: string;
    memo: string | null;
    bank_account: string | null;
    recipient_name: string | null;
    score: number;
}

export interface BankStatementCreate {
    bank_account: string;
    currency?: string;
    period_start: string;
    period_end: string;
    opening_balance?: number | null;
    closing_balance?: number | null;
    notes?: string | null;
}

export interface BankStatementUpdate {
    bank_account?: string;
    currency?: string;
    period_start?: string;
    period_end?: string;
    opening_balance?: number | null;
    closing_balance?: number | null;
    notes?: string | null;
}

export interface ReconciliationEntryCreate {
    entry_date: string;
    description?: string | null;
    amount: number;
    currency?: string;
}

// ── Statement endpoints ───────────────────────────────────────────────────────

export function listStatements(params?: {
    bank_account?: string;
    limit?: number;
    offset?: number;
}): Promise<BankStatement[]> {
    return requestWithQuery<BankStatement[]>('/api/reconciliation/statements', params);
}

export function getStatement(id: number): Promise<BankStatement> {
    return apiRequest<BankStatement>(`/api/reconciliation/statements/${id}`);
}

export function createStatement(body: BankStatementCreate): Promise<BankStatement> {
    return apiRequest<BankStatement>('/api/reconciliation/statements', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

export function updateStatement(id: number, body: BankStatementUpdate): Promise<BankStatement> {
    return apiRequest<BankStatement>(`/api/reconciliation/statements/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
    });
}

export async function deleteStatement(id: number): Promise<void> {
    await apiRequest<void>(`/api/reconciliation/statements/${id}`, { method: 'DELETE' });
}

// ── Entry endpoints ───────────────────────────────────────────────────────────

export function listEntries(
    statementId: number,
    params?: { match_status?: ReconciliationMatchStatus },
): Promise<ReconciliationEntry[]> {
    return requestWithQuery<ReconciliationEntry[]>(
        `/api/reconciliation/statements/${statementId}/entries`,
        params,
    );
}

export function createEntry(
    statementId: number,
    entry: ReconciliationEntryCreate,
): Promise<ReconciliationEntry> {
    return apiRequest<ReconciliationEntry>(
        `/api/reconciliation/statements/${statementId}/entries`,
        { method: 'POST', body: JSON.stringify(entry) },
    );
}

export function bulkCreateEntries(
    statementId: number,
    entries: ReconciliationEntryCreate[],
): Promise<ReconciliationEntry[]> {
    return apiRequest<ReconciliationEntry[]>(
        `/api/reconciliation/statements/${statementId}/entries`,
        { method: 'POST', body: JSON.stringify(entries) },
    );
}

export async function deleteEntry(statementId: number, entryId: number): Promise<void> {
    await apiRequest<void>(
        `/api/reconciliation/statements/${statementId}/entries/${entryId}`,
        { method: 'DELETE' },
    );
}

// ── Matching endpoints ────────────────────────────────────────────────────────

export function getMatchCandidates(
    statementId: number,
    entryId: number,
): Promise<MatchCandidate[]> {
    return apiRequest<MatchCandidate[]>(
        `/api/reconciliation/statements/${statementId}/entries/${entryId}/candidates`,
    );
}

export function setMatch(
    statementId: number,
    entryId: number,
    body: {
        transaction_id: number | null;
        match_status: ReconciliationMatchStatus;
        match_score?: number | null;
    },
): Promise<ReconciliationEntry> {
    return apiRequest<ReconciliationEntry>(
        `/api/reconciliation/statements/${statementId}/entries/${entryId}/match`,
        { method: 'POST', body: JSON.stringify(body) },
    );
}

export function clearMatch(
    statementId: number,
    entryId: number,
): Promise<ReconciliationEntry> {
    return apiRequest<ReconciliationEntry>(
        `/api/reconciliation/statements/${statementId}/entries/${entryId}/match`,
        { method: 'DELETE' },
    );
}
