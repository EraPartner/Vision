import type { Account, AccountCreate, AccountUpdate, AccountsListResponse } from '@/types/api';
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';

// PostgreSQL NUMERIC columns arrive over the wire as strings (computed_balance,
// statement_balance, and the derived drift). The Account type declares them as
// numbers, so coerce here — at the single fetch boundary — to keep the runtime
// shape honest for every consumer (e.g. AccountsPage's drift.toFixed()).
function normalizeAccount(a: Account): Account {
    return {
        ...a,
        statement_balance: a.statement_balance == null ? undefined : Number(a.statement_balance),
        computed_balance: a.computed_balance == null ? undefined : Number(a.computed_balance),
        drift: a.drift == null ? undefined : Number(a.drift),
    };
}

export async function getAccounts(params?: {
    active?: 'true' | 'false' | 'all';
}): Promise<AccountsListResponse> {
    const res = await requestWithQuery<AccountsListResponse>('/api/accounts', params);
    return { ...res, items: res.items.map(normalizeAccount) };
}

export function createAccount(account: AccountCreate): Promise<Account> {
    return apiRequest<Account>('/api/accounts', {
        method: 'POST',
        body: JSON.stringify(account),
    });
}

export function updateAccount(id: number, account: AccountUpdate): Promise<Account> {
    return apiRequest<Account>(`/api/accounts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(account),
    });
}

export async function deleteAccount(id: number): Promise<void> {
    await apiRequest<void>(`/api/accounts/${id}`, { method: 'DELETE' });
}

export interface AccountMergeResult {
    into: number;
    merged: number[];
    reassigned: { transactions: number; planned: number; portfolio: number; funding: number };
}

/** Merge source accounts into the survivor (targetId); repoints all references + deletes sources. */
export function mergeAccounts(targetId: number, sourceIds: number[]): Promise<AccountMergeResult> {
    return apiRequest<AccountMergeResult>(`/api/accounts/${targetId}/merge`, {
        method: 'POST',
        body: JSON.stringify({ source_ids: sourceIds }),
    });
}

export interface OpeningBalanceInput {
    balance: number;
    date: string;
    currency?: string;
}

export interface OpeningBalanceResult {
    transaction: { id: number; balance: number; transfer_source: string } | null;
    /** Set when the anchor date does not precede existing activity (anchor+delta makes it inert). */
    warning: string | null;
}

/**
 * Set (create or update) the opening-balance anchor for a manual/cash-only account
 * (ADR-094 second addendum, D4). Stamps one system row per account+currency; the
 * single sanctioned exception to the `transactions.balance` write-protection.
 */
export function setOpeningBalance(id: number, input: OpeningBalanceInput): Promise<OpeningBalanceResult> {
    return apiRequest<OpeningBalanceResult>(`/api/accounts/${id}/opening-balance`, {
        method: 'POST',
        body: JSON.stringify(input),
    });
}

export type ReconcileMode = 'accept' | 'adjustment';

export interface ReconcileResult {
    mode: ReconcileMode;
    /** Drift after the operation — always 0 on success. */
    drift: number;
    statement_balance: number;
    computed_balance: number;
    /** The server-created adjustment row (mode 'adjustment'), else null. */
    transaction: { id: number; amount: number; transfer_source: string } | null;
}

/**
 * Reconcile an account's drift (ADR-094, Phase C). `mode: 'accept'` rewrites the
 * stored statement figures to the computed balance; `mode: 'adjustment'` stamps a
 * server-side 'adjustment' ledger row so the computed balance rises to meet the
 * statement (balance-free — ADR-094 descriptive-only default preserved).
 */
export function reconcileAccount(id: number, mode: ReconcileMode): Promise<ReconcileResult> {
    return apiRequest<ReconcileResult>(`/api/accounts/${id}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
    });
}
