import {
    BulkSplitResultSchema,
    OwedDetailListSchema,
    OwedSummaryListSchema,
    SettleAllResultSchema,
    SplitBatchResultSchema,
    SplitListSchema,
    SplitPaymentSchema,
    SplitSchema,
} from '@vision/types/contracts';
import { apiRequest } from '@/lib/api/client';
import { requestBlob, requestWithQuery } from '@/lib/api/helpers';
import type {
    CurrencyCode,
    RecipientId,
    SplitId,
    TransactionId,
} from "@vision/types/brands";

/**
 * Canonical home for the splits API types. `@/types/splits.ts` used to hold a
 * second, drifted copy of these shapes; it has been folded in here so there is
 * one definition per wire shape.
 *
 * Every field below mirrors what `splitRepository.formatSplit` actually emits
 * (apps/node-backend/src/repositories/splitRepository.js) — including
 * `amount_paid`, which this module previously mistyped as `paid_amount`.
 */
export interface SplitItem {
    id: SplitId;
    transaction_id: TransactionId;
    recipient_id: RecipientId;
    amount: number;
    note: string | null;
    amount_paid: number;
    is_settled: boolean;
    created_at: string;
    updated_at: string;
    recipient_name: string | null;
}

/** Body row for POST /api/splits and POST /api/splits/batch. */
export interface SplitCreateInput {
    recipient_id: RecipientId;
    amount: number;
    note?: string | undefined;
}

/** Preset share for POST /api/splits/bulk: `equal` = 50/50, `full` = 0/100 (the payee owes everything). */
export type BulkSplitMode = 'equal' | 'full';

/** Body of POST /api/splits/bulk — one payee, one preset, many transactions. */
export interface BulkSplitRequest {
    transaction_ids: TransactionId[];
    recipient_id: RecipientId;
    mode: BulkSplitMode;
    note?: string;
}

/** Result of POST /api/splits/bulk (splitService.createBulkSplitsAtomic). */
export interface BulkSplitResult {
    requested: number;
    split: number;
    skipped_already_split: number;
    skipped_zero_amount: number;
    skipped_missing: number;
    items: SplitItem[];
}

/** Open splits left out of a converted owed figure because their currency has no stored rate. */
interface OwedUnconverted {
    unconverted_count: number;
    unconverted_currencies: CurrencyCode[];
}

/**
 * Aggregated "who owes what" row from GET /api/splits/owed, its amounts
 * converted on the server to the requested currency.
 */
export interface OwedSummaryItem extends OwedUnconverted {
    recipient_id: RecipientId;
    recipient_name: string;
    total_owed: number;
    total_paid: number;
    remaining: number;
    split_count: number;
}

/** Server-computed total outstanding (`summary` on both owed reads). */
export interface OwedTotals extends OwedUnconverted {
    currency: CurrencyCode;
    remaining: number;
}

/** Per-split detail row from GET /api/splits/owed/:recipientId, enriched with parent-transaction fields. */
export interface OwedDetailItem extends SplitItem {
    transaction_date: string;
    transaction_memo?: string | null;
    transaction_amount: number;
    transaction_currency: CurrencyCode;
    bank_account?: string | null;
    transaction_recipient_name?: string | null;
    remaining: number;
}

/** A split_payments row as emitted by `splitRepository.formatPayment`. */
export interface SplitPayment {
    id: number;
    split_id: SplitId;
    amount: number;
    note: string | null;
    paid_at: string;
    created_at: string;
}

export function getOwedSummary(
    currency: CurrencyCode,
): Promise<{ items: OwedSummaryItem[]; summary: OwedTotals }> {
    return requestWithQuery('/api/splits/owed', { currency }, { schema: OwedSummaryListSchema });
}

export function getOwedByRecipient(
    recipientId: RecipientId,
    currency: CurrencyCode,
): Promise<{ items: OwedDetailItem[]; summary: OwedTotals }> {
    return requestWithQuery(
        `/api/splits/owed/${recipientId}`,
        { currency },
        { schema: OwedDetailListSchema },
    );
}

export async function exportOwedByRecipientCsv(recipientId: RecipientId): Promise<Blob> {
    return requestBlob(`/api/splits/owed/${recipientId}/export/csv`);
}

export function getSplitsByTransaction(transactionId: TransactionId): Promise<{ items: SplitItem[] }> {
    return apiRequest(`/api/splits/transaction/${transactionId}`, { schema: SplitListSchema });
}

export function createSplitsBatch(
    transactionId: TransactionId,
    splits: Array<{
        recipient_id: RecipientId;
        amount: number;
        note?: string | undefined;
    }>,
): Promise<{ items: SplitItem[] }> {
    return apiRequest('/api/splits/batch', {
        method: 'POST',
        body: JSON.stringify({ transaction_id: transactionId, splits }),
        schema: SplitBatchResultSchema,
    });
}

export function createBulkSplits(request: BulkSplitRequest): Promise<BulkSplitResult> {
    return apiRequest('/api/splits/bulk', {
        method: 'POST',
        body: JSON.stringify(request),
        schema: BulkSplitResultSchema,
    });
}

export function recordSplitPayment(
    splitId: SplitId,
    amount: number,
    note?: string,
    paid_at?: string,
): Promise<SplitPayment> {
    return apiRequest(`/api/splits/${splitId}/pay`, {
        method: 'POST',
        body: JSON.stringify({ amount, note, paid_at }),
        schema: SplitPaymentSchema,
    });
}

export function settleSplit(splitId: SplitId): Promise<SplitItem> {
    return apiRequest(`/api/splits/${splitId}/settle`, { method: 'POST', schema: SplitSchema });
}

export function settleAllSplitsByRecipient(recipientId: RecipientId): Promise<{ settled_count: number }> {
    return apiRequest(`/api/splits/owed/${recipientId}/settle-all`, {
        method: 'POST',
        schema: SettleAllResultSchema,
    });
}

export async function deleteSplit(splitId: SplitId): Promise<void> {
    await apiRequest(`/api/splits/${splitId}`, { method: 'DELETE' });
}
