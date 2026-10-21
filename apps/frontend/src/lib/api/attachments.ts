/**
 * Attachment API client — receipt and document uploads for transactions.
 */

import { AttachmentListSchema } from '@vision/types/contracts';
import { API_BASE_URL, apiRequest, rawFetch, parseEnvelopeError } from '@/lib/api/client';
import { requestBlob } from '@/lib/api/helpers';
import type { TransactionId } from "@vision/types/brands";

export interface Attachment {
    /** BIGSERIAL, sent as decimal text. */
    id: string;
    transaction_id: TransactionId;
    filename: string;
    stored_path: string;
    mime_type: string;
    size_bytes: number;
    created_at: string;
}

/** List all attachments for a transaction. */
export function listAttachments(transactionId: TransactionId): Promise<{ items: Attachment[] }> {
    return apiRequest(`/api/attachments/transaction/${transactionId}`, {
        schema: AttachmentListSchema,
    });
}

/** Upload a file attachment for a transaction. */
export async function uploadAttachment(transactionId: TransactionId, file: File): Promise<{ item: Attachment }> {
    const form = new FormData();
    form.append('file', file);

    const response = await rawFetch(`${API_BASE_URL}/api/attachments/transaction/${transactionId}`, {
        method: 'POST',
        body: form,
    });

    if (!response.ok) {
        throw await parseEnvelopeError(response, 'Failed to upload attachment');
    }

    const envelope = await response.json() as { ok: boolean; data: Attachment };
    return { item: envelope.data };
}

/** Delete an attachment by ID. Responds 204 No Content — nothing to unwrap. */
export async function deleteAttachment(attachmentId: string): Promise<void> {
    await apiRequest<void>(`/api/attachments/${attachmentId}`, { method: 'DELETE' });
}

/** Build the URL that serves an attachment (used for inline thumbnails). */
export function getAttachmentDownloadUrl(attachmentId: string): string {
    return `${API_BASE_URL}/api/attachments/${attachmentId}/download`;
}

/**
 * Fetch an attachment's bytes. The desktop app denies every new window, so a
 * `target="_blank"` link cannot open attachments there; callers save the Blob
 * with `downloadBlob` instead, which works in browsers and Electron alike.
 */
export function fetchAttachmentBlob(attachmentId: string): Promise<Blob> {
    return requestBlob(`/api/attachments/${attachmentId}/download`);
}
