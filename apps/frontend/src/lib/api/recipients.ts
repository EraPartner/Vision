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

export interface PatternSuggestion {
    pattern: string;
    kind: 'literal_prefix' | 'glob' | 'regex';
    matchCount: number;
    confidence: 'high' | 'medium' | 'low';
}

export function mergeRecipients(
    primaryId: number,
    aliasIds: number[],
): Promise<{ primary: Recipient; merged_ids: number[]; aliases: Array<{ id: number; name: string }>; patternSuggestion: PatternSuggestion | null }> {
    return apiRequest(`/api/recipients/${primaryId}/merge`, {
        method: 'POST',
        body: JSON.stringify({ alias_ids: aliasIds }),
    });
}

export function unmergeRecipient(id: number): Promise<Recipient> {
    return apiRequest<Recipient>(`/api/recipients/${id}/unmerge`, { method: 'POST' });
}

export interface RecipientPattern {
    id: number;
    pattern: string;
    pattern_kind: 'literal_prefix' | 'glob' | 'regex';
    case_sensitive: boolean;
    priority: number;
    is_active: boolean;
    source: 'user' | 'suggested' | 'system';
    notes: string | null;
    created_at: string;
    updated_at: string;
}

export interface RecipientPatternCreate {
    pattern: string;
    pattern_kind?: 'literal_prefix' | 'glob' | 'regex';
    case_sensitive?: boolean;
    priority?: number;
    notes?: string;
}

export interface RecipientPatternUpdate {
    pattern?: string;
    pattern_kind?: 'literal_prefix' | 'glob' | 'regex';
    case_sensitive?: boolean;
    priority?: number;
    is_active?: boolean;
    notes?: string;
}

export function listRecipientPatterns(recipientId: number): Promise<{ items: RecipientPattern[]; total: number }> {
    return apiRequest(`/api/recipients/${recipientId}/patterns`);
}

export function createRecipientPattern(recipientId: number, data: RecipientPatternCreate): Promise<{ id: number }> {
    return apiRequest(`/api/recipients/${recipientId}/patterns`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export function updateRecipientPattern(recipientId: number, patternId: number, data: RecipientPatternUpdate): Promise<{ patternId: number }> {
    return apiRequest(`/api/recipients/${recipientId}/patterns/${patternId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

/** Delete a pattern. Responds 204 No Content — nothing to unwrap. */
export async function deleteRecipientPattern(recipientId: number, patternId: number): Promise<void> {
    await apiRequest<void>(`/api/recipients/${recipientId}/patterns/${patternId}`, { method: 'DELETE' });
}

export function previewRecipientPattern(recipientId: number, data: Pick<RecipientPatternCreate, 'pattern' | 'pattern_kind' | 'case_sensitive'>): Promise<{ matchCount: number; recipientIds: number[] }> {
    return apiRequest(`/api/recipients/${recipientId}/patterns/preview`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}
