import type { Recipient, RecipientCreate, RecipientsListResponse, RecipientUpdate } from '@/types/api';
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery, createWithStatus } from '@/lib/api/helpers';

export function getRecipients(params?: {
    limit?: number;
    offset?: number;
    name?: string;
    default_category_id?: number;
    active?: boolean;
    search?: string;
    uncategorized?: boolean;
    sort_by?: string;
    sort_dir?: 'asc' | 'desc';
}): Promise<RecipientsListResponse> {
    return requestWithQuery<RecipientsListResponse>('/api/recipients', params);
}

export function getRecipient(id: number): Promise<Recipient> {
    return apiRequest<Recipient>(`/api/recipients/${id}`);
}

export async function createRecipient(
    recipient: RecipientCreate,
): Promise<{ recipient: Recipient; wasCreated: boolean }> {
    const { data, wasCreated } = await createWithStatus<RecipientCreate, Recipient>(
        '/api/recipients',
        recipient,
    );
    return { recipient: data, wasCreated };
}

export function updateRecipient(id: number, recipient: RecipientUpdate): Promise<Recipient> {
    return apiRequest<Recipient>(`/api/recipients/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(recipient),
    });
}

export async function deleteRecipient(id: number): Promise<void> {
    await apiRequest<void>(`/api/recipients/${id}`, { method: 'DELETE' });
}

export function mergeRecipients(
    primaryId: number,
    aliasIds: number[],
): Promise<{ primary: Recipient; merged_ids: number[]; aliases: Array<{ id: number; name: string }> }> {
    return apiRequest(`/api/recipients/${primaryId}/merge`, {
        method: 'POST',
        body: JSON.stringify({ alias_ids: aliasIds }),
    });
}

export function unmergeRecipient(id: number): Promise<Recipient> {
    return apiRequest<Recipient>(`/api/recipients/${id}/unmerge`, { method: 'POST' });
}

export function getRecipientAliases(id: number): Promise<{ items: Recipient[]; total: number }> {
    return apiRequest(`/api/recipients/${id}/aliases`);
}
