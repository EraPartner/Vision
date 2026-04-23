import { API_BASE_URL, apiRequest, generateRequestId, parseEnvelopeError } from '@/lib/api/client';

export interface SplitItem {
    id: number;
    transaction_id: number;
    recipient_id: number;
    amount: number;
    note?: string | null;
    paid_amount: number;
    is_settled: boolean;
    created_at: string;
    updated_at: string;
}

export interface SplitPayment {
    id: number;
    split_id: number;
    amount: number;
    note?: string | null;
    paid_at: string;
    created_at: string;
}

export function getOwedSummary(): Promise<{ items: SplitItem[] }> {
    return apiRequest('/api/splits/owed');
}

export function getOwedByRecipient(recipientId: number): Promise<{ items: SplitItem[] }> {
    return apiRequest(`/api/splits/owed/${recipientId}`);
}

export async function exportOwedByRecipientCsv(recipientId: number): Promise<Blob> {
    const response = await fetch(`${API_BASE_URL}/api/splits/owed/${recipientId}/export/csv`, {
        method: 'GET',
        headers: { 'X-Request-Id': generateRequestId() },
    });

    if (!response.ok) {
        throw await parseEnvelopeError(response, 'Failed to export owed transactions');
    }

    return response.blob();
}

export function getSplitsByTransaction(transactionId: number): Promise<{ items: SplitItem[] }> {
    return apiRequest(`/api/splits/transaction/${transactionId}`);
}

export function createSplitsBatch(
    transactionId: number,
    splits: Array<{ recipient_id: number; amount: number; note?: string }>,
): Promise<{ items: SplitItem[] }> {
    return apiRequest('/api/splits/batch', {
        method: 'POST',
        body: JSON.stringify({ transaction_id: transactionId, splits }),
    });
}

export function recordSplitPayment(
    splitId: number,
    amount: number,
    note?: string,
    paid_at?: string,
): Promise<SplitPayment> {
    return apiRequest(`/api/splits/${splitId}/pay`, {
        method: 'POST',
        body: JSON.stringify({ amount, note, paid_at }),
    });
}

export function settleSplit(splitId: number): Promise<SplitItem> {
    return apiRequest(`/api/splits/${splitId}/settle`, { method: 'POST' });
}

export function settleAllSplitsByRecipient(recipientId: number): Promise<{ settled_count: number }> {
    return apiRequest(`/api/splits/owed/${recipientId}/settle-all`, { method: 'POST' });
}

export async function deleteSplit(splitId: number): Promise<void> {
    await apiRequest(`/api/splits/${splitId}`, { method: 'DELETE' });
}
