/**
 * Attachment API client — receipt and document uploads for transactions.
 */

import { API_BASE_URL, apiRequest, generateRequestId, parseEnvelopeError } from '@/lib/api/client';

export interface Attachment {
    id: number;
    transaction_id: number;
    filename: string;
    stored_path: string;
    mime_type: string;
    size_bytes: number;
    created_at: string;
}

/** List all attachments for a transaction. */
export function listAttachments(transactionId: number): Promise<{ items: Attachment[] }> {
    return apiRequest(`/api/attachments/transaction/${transactionId}`);
}

/** Upload a file attachment for a transaction. */
export async function uploadAttachment(transactionId: number, file: File): Promise<{ item: Attachment }> {
    const form = new FormData();
    form.append('file', file);

    const response = await fetch(`${API_BASE_URL}/api/attachments/transaction/${transactionId}`, {
        method: 'POST',
        headers: { 'X-Request-Id': generateRequestId() },
        body: form,
    });

    if (!response.ok) {
        throw await parseEnvelopeError(response, 'Failed to upload attachment');
    }

    const envelope = await response.json() as { ok: boolean; data: Attachment };
    return { item: envelope.data };
}

/** Delete an attachment by ID. */
export function deleteAttachment(attachmentId: number): Promise<{ item: { deleted: boolean } }> {
    return apiRequest(`/api/attachments/${attachmentId}`, { method: 'DELETE' });
}

/** Build the URL to download/view an attachment in the browser. */
export function getAttachmentDownloadUrl(attachmentId: number): string {
    return `${API_BASE_URL}/api/attachments/${attachmentId}/download`;
}
