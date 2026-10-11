import type { Tag, TagCreate, TagListResponse, TagUpdate, BulkTagRequest, BulkTagResult } from '@/types/api';
import { TagListSchema } from '@vision/types/contracts';
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';

/**
 * `is_active` filters on the tag's own flag; GET /api/tags reads it as
 * `active` (`true`/`false`; omitted, the route lists active tags only).
 */
export function getTags(params?: { is_active?: boolean; limit?: number; offset?: number }): Promise<TagListResponse> {
    const { is_active, ...page } = params ?? {};
    return requestWithQuery<TagListResponse>(
        '/api/tags',
        { ...page, active: is_active },
        { schema: TagListSchema },
    );
}

export function createTag(tag: TagCreate): Promise<Tag> {
    return apiRequest<Tag>('/api/tags', {
        method: 'POST',
        body: JSON.stringify(tag),
    });
}

export function updateTag(id: number, data: TagUpdate): Promise<Tag> {
    return apiRequest<Tag>(`/api/tags/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

export async function deleteTag(id: number): Promise<void> {
    await apiRequest<void>(`/api/tags/${id}`, { method: 'DELETE' });
}

export function bulkTagTransactions(request: BulkTagRequest): Promise<BulkTagResult> {
    return apiRequest<BulkTagResult>('/api/transactions/bulk-tag', {
        method: 'POST',
        body: JSON.stringify(request),
    });
}
