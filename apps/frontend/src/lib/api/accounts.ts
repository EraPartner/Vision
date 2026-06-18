import type { Account, AccountCreate, AccountUpdate, AccountsListResponse } from '@/types/api';
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';

export function getAccounts(params?: {
    active?: 'true' | 'false' | 'all';
}): Promise<AccountsListResponse> {
    return requestWithQuery<AccountsListResponse>('/api/accounts', params);
}

export function getAccount(id: number): Promise<Account> {
    return apiRequest<Account>(`/api/accounts/${id}`);
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
