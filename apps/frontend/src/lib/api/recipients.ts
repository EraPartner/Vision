import type { Recipient, RecipientCreate, RecipientsListResponse, RecipientUpdate } from '@/types/api';
import {
    RecipientCreatedSchema,
    RecipientListSchema,
    RecipientMergeResultSchema,
    RecipientPatternCreatedSchema,
    RecipientPatternListSchema,
    RecipientPatternPreviewSchema,
    RecipientPatternUpdatedSchema,
    RecipientSchema,
} from '@vision/types/contracts';
import { apiRequest, checkWireData } from '@/lib/api/client';
import { requestWithQuery, createWithStatus } from '@/lib/api/helpers';
import type { CategoryId, RecipientId } from "@vision/types/brands";

export function getRecipients(params?: {
    limit?: number | undefined;
    offset?: number | undefined;
    name?: string | undefined;
    default_category_id?: CategoryId | undefined;
    active?: boolean | undefined;
    search?: string | undefined;
    uncategorized?: boolean | undefined;
    sort_by?: string | undefined;
    sort_dir?: 'asc' | 'desc' | undefined;
}): Promise<RecipientsListResponse> {
    return requestWithQuery<RecipientsListResponse>('/api/recipients', params, {
        schema: RecipientListSchema,
    });
}

export function getRecipient(id: RecipientId): Promise<Recipient> {
    return apiRequest<Recipient>(`/api/recipients/${id}`, { schema: RecipientSchema });
}

export async function createRecipient(
    recipient: RecipientCreate,
): Promise<{ recipient: Recipient; wasCreated: boolean }> {
    const { data, wasCreated } = await createWithStatus('/api/recipients', recipient);
    // createWithStatus takes no schema; check the body the caller reads.
    const created = checkWireData(
        RecipientCreatedSchema,
        data,
        'POST /api/recipients',
    );
    return { recipient: created, wasCreated };
}

export function updateRecipient(id: RecipientId, recipient: RecipientUpdate): Promise<Recipient> {
    return apiRequest<Recipient>(`/api/recipients/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(recipient),
        schema: RecipientSchema,
    });
}

export async function deleteRecipient(id: RecipientId): Promise<void> {
    await apiRequest(`/api/recipients/${id}`, { method: 'DELETE' });
}

export interface PatternSuggestion {
    pattern: string;
    kind: 'literal_prefix' | 'glob' | 'regex';
    matchCount: number;
    confidence: 'high' | 'medium' | 'low';
}

export function mergeRecipients(
    primaryId: RecipientId,
    aliasIds: number[],
): Promise<{ primary: Recipient; merged_ids: RecipientId[]; aliases: Array<{ id: RecipientId; name: string }>; patternSuggestion: PatternSuggestion | null }> {
    return apiRequest(`/api/recipients/${primaryId}/merge`, {
        method: 'POST',
        body: JSON.stringify({ alias_ids: aliasIds }),
        schema: RecipientMergeResultSchema,
    });
}

export function unmergeRecipient(id: RecipientId): Promise<Recipient> {
    return apiRequest<Recipient>(`/api/recipients/${id}/unmerge`, { method: 'POST', schema: RecipientSchema });
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
    notes?: string | null | undefined;
}

export interface RecipientPatternUpdate {
    pattern?: string;
    pattern_kind?: 'literal_prefix' | 'glob' | 'regex';
    case_sensitive?: boolean;
    priority?: number;
    is_active?: boolean;
    notes?: string | null | undefined;
}

export function listRecipientPatterns(recipientId: RecipientId): Promise<{ items: RecipientPattern[]; total: number }> {
    return apiRequest(`/api/recipients/${recipientId}/patterns`, { schema: RecipientPatternListSchema });
}

export function createRecipientPattern(recipientId: RecipientId, data: RecipientPatternCreate): Promise<{ id: number }> {
    return apiRequest(`/api/recipients/${recipientId}/patterns`, {
        method: 'POST',
        body: JSON.stringify(data),
        schema: RecipientPatternCreatedSchema,
    });
}

export function updateRecipientPattern(recipientId: RecipientId, patternId: number, data: RecipientPatternUpdate): Promise<{ patternId: number }> {
    return apiRequest(`/api/recipients/${recipientId}/patterns/${patternId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
        schema: RecipientPatternUpdatedSchema,
    });
}

/** Delete a pattern. Responds 204 No Content — nothing to unwrap. */
export async function deleteRecipientPattern(recipientId: RecipientId, patternId: number): Promise<void> {
    await apiRequest(`/api/recipients/${recipientId}/patterns/${patternId}`, { method: 'DELETE' });
}

export function previewRecipientPattern(recipientId: RecipientId, data: Pick<RecipientPatternCreate, 'pattern' | 'pattern_kind' | 'case_sensitive'>): Promise<{ matchCount: number; recipientIds: RecipientId[] }> {
    return apiRequest(`/api/recipients/${recipientId}/patterns/preview`, {
        method: 'POST',
        body: JSON.stringify(data),
        schema: RecipientPatternPreviewSchema,
    });
}
