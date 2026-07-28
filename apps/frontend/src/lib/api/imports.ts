import { z } from 'zod';
import { API_BASE_URL, generateRequestId, parseEnvelopeError, apiRequest } from '@/lib/api/client';
import { postMultipartImport } from '@/lib/api/helpers';
import { readSseStream } from '@/lib/api/sse';
import type { ImportProgress, ImportResult, BatchListResponse, ImportPreviewResponse } from '@/lib/api/types';

/**
 * Runtime guards for the import SSE streams (ZOD-10). Loose objects so the
 * backend may add fields; TypeScript shapes stay sourced from
 * `@/lib/api/types` — these schemas only gate the untrusted payloads before
 * the existing casts. A failing payload rejects the stream through the same
 * `Invalid SSE payload` path as malformed JSON; the `error` event stays
 * schema-free because `extractErrorDetail` is already shape-tolerant.
 */
export const importProgressSchema = z.looseObject({
    phase: z.string(),
    current: z.number(),
    total: z.number(),
    imported: z.number(),
    duplicates: z.number(),
    errors: z.number(),
    percent: z.number(),
});

const importResultSchema = z.looseObject({
    total_processed: z.number(),
    imported: z.number(),
    duplicates: z.number(),
    errors: z.number(),
    status: z.string().optional(),
    error_message: z.string().optional(),
    batch_id: z.number().optional(),
    requires_review: z.boolean().optional(),
    auto_linked_count: z.number().optional(),
});

// The backend emits { batch_id, match_source_counts, percent } — no `total`
// (see node-backend lib/importProgress.js), so only batch_id is required.
const reviewRequiredSchema = z.looseObject({
    batch_id: z.number(),
    total: z.number().optional(),
});

const IMPORT_STREAM_SCHEMAS: Record<string, z.ZodType> = {
    progress: importProgressSchema,
    complete: importResultSchema,
    review_required: reviewRequiredSchema,
};

export function importCSV(
    file: File,
    bankName: string,
): Promise<{ batch_id: number; imported: number; duplicates: number; total_processed: number; message: string }> {
    const queryParams = new URLSearchParams();
    queryParams.append('bank_name', bankName);
    return postMultipartImport('/api/import/csv', file, queryParams);
}

export function importCSVWithProgress(
    file: File,
    bankName: string,
    onProgress: (progress: ImportProgress) => void,
): { abort: () => void; result: Promise<ImportResult> } {
    const controller = new AbortController();
    const formData = new FormData();
    formData.append('file', file);

    const queryParams = new URLSearchParams();
    queryParams.append('bank_name', bankName);

    const url = `${API_BASE_URL}/api/import/csv/stream?${queryParams.toString()}`;

    const extractErrorDetail = (payload: unknown): string => {
        if (payload && typeof payload === 'object' && 'detail' in payload) {
            const detail = (payload as { detail?: unknown }).detail;
            if (typeof detail === 'string' && detail.trim()) return detail;
        }
        return 'Import failed';
    };

    const result = (async (): Promise<ImportResult> => {
        try {
            const response = await fetch(url, {
                method: 'POST',
                body: formData,
                headers: { 'X-Request-Id': generateRequestId() },
                signal: controller.signal,
            });

            if (!response.ok) {
                throw await parseEnvelopeError(response, 'Import failed');
            }

            let finalResult: ImportResult | null = null;

            for await (const { event, data } of readSseStream<unknown>(response, { schemas: IMPORT_STREAM_SCHEMAS })) {
                if (event === 'progress') {
                    onProgress(data as ImportProgress);
                    continue;
                }
                if (event === 'complete') {
                    finalResult = data as ImportResult;
                    onProgress({
                        ...(data as Partial<ImportProgress>),
                        phase: 'complete',
                        percent: 100,
                    } as ImportProgress);
                    continue;
                }
                if (event === 'review_required') {
                    const d = data as { batch_id: number; total: number };
                    finalResult = {
                        total_processed: d.total,
                        imported: 0,
                        duplicates: 0,
                        errors: 0,
                        status: 'review_required',
                        batch_id: d.batch_id,
                        requires_review: true,
                    };
                    onProgress({ phase: 'review_required', current: d.total, total: d.total, imported: 0, duplicates: 0, errors: 0, percent: 100 } as ImportProgress);
                    continue;
                }
                if (event === 'error') {
                    throw new Error(extractErrorDetail(data));
                }
            }

            return finalResult ?? {
                total_processed: 0,
                imported: 0,
                duplicates: 0,
                errors: 0,
                status: 'completed',
            };
        } catch (err) {
            if ((err as Error).name === 'AbortError') {
                throw new Error('Import cancelled', { cause: err });
            }
            throw err;
        }
    })();

    return { abort: () => controller.abort(), result };
}

export function importCSVCustom(
    file: File,
    bankName: string,
    dateFormat: string,
    dateColumn: string,
    recipientColumn: string,
    amountColumn: string,
    memoColumn?: string,
    separator: string = ',',
    encoding: string = 'utf-8',
    skipRows: number = 0,
): Promise<{ batch_id: number; imported: number; duplicates: number; total_processed: number; message: string }> {
    const queryParams = new URLSearchParams();
    queryParams.append('bank_name', bankName);
    queryParams.append('date_format', dateFormat);
    queryParams.append('date_column', dateColumn);
    queryParams.append('recipient_column', recipientColumn);
    queryParams.append('amount_column', amountColumn);
    if (memoColumn) queryParams.append('memo_column', memoColumn);
    queryParams.append('separator', separator);
    queryParams.append('encoding', encoding);
    queryParams.append('skip_rows', skipRows.toString());
    return postMultipartImport('/api/import/csv/custom', file, queryParams);
}

export interface CustomParserConfigPayload {
    dateColumn: string;
    dateFormat: string;
    recipientColumn: string;
    amountColumn: string;
    memoColumn: string;
    separator: string;
    encoding: string;
    skipRows: number;
}

export interface SavedParserConfig {
    id: number;
    name: string;
    config: CustomParserConfigPayload;
    created_at: string;
    updated_at: string;
}

/**
 * Collection GETs return the canonical `{items, total}` body; callers of this
 * helper only need the rows, so the envelope is unwrapped here.
 */
export async function listCustomParserConfigs(): Promise<SavedParserConfig[]> {
    const { items } = await apiRequest<{ items: SavedParserConfig[]; total: number }>('/api/import/parsers');
    return items;
}

export function createCustomParserConfig(
    name: string,
    config: CustomParserConfigPayload,
): Promise<SavedParserConfig> {
    return apiRequest<SavedParserConfig>('/api/import/parsers', {
        method: 'POST',
        body: JSON.stringify({ name, config }),
    });
}

export function updateCustomParserConfig(
    id: number,
    patch: { name?: string; config?: CustomParserConfigPayload },
): Promise<SavedParserConfig> {
    return apiRequest<SavedParserConfig>(`/api/import/parsers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    });
}

export function deleteCustomParserConfig(id: number): Promise<void> {
    return apiRequest<void>(`/api/import/parsers/${id}`, { method: 'DELETE' });
}

export function importRecipients(
    file: File,
    separator: string = ',',
    encoding: string = 'utf-8',
): Promise<{ total_processed: number; imported: number; skipped: number; errors: number; status: string }> {
    const queryParams = new URLSearchParams({ separator, encoding });
    return postMultipartImport('/api/import/recipients', file, queryParams);
}

export function importCategories(
    file: File,
    separator: string = ',',
    encoding: string = 'utf-8',
): Promise<{ total_processed: number; imported: number; skipped: number; errors: number; status: string }> {
    const queryParams = new URLSearchParams({ separator, encoding });
    return postMultipartImport('/api/import/categories', file, queryParams);
}

export function listImportBatches(
    limit: number = 20,
    offset: number = 0,
): Promise<BatchListResponse> {
    return apiRequest<BatchListResponse>(`/api/import/batches?limit=${limit}&offset=${offset}`);
}

export function rollbackImportBatch(id: number): Promise<{ deleted: number }> {
    return apiRequest<{ deleted: number }>(`/api/import/batches/${id}`, { method: 'DELETE' });
}

export function getImportPreview(batchId: number): Promise<ImportPreviewResponse> {
    return apiRequest<ImportPreviewResponse>(`/api/import/batches/${batchId}/preview`);
}

export function overrideImportRow(batchId: number, rowId: number, recipientId: number | null): Promise<{ row_id: number; user_override_recipient_id: number | null }> {
    return apiRequest(`/api/import/batches/${batchId}/rows/${rowId}/override`, {
        method: 'POST',
        body: JSON.stringify({ recipient_id: recipientId }),
    });
}

export function overrideImportRowCategory(batchId: number, rowId: number, categoryId: number | null): Promise<{ row_id: number; override_category_id: number | null }> {
    return apiRequest(`/api/import/batches/${batchId}/rows/${rowId}/category-override`, {
        method: 'POST',
        body: JSON.stringify({ category_id: categoryId }),
    });
}

export function commitImportBatch(batchId: number): Promise<{ batch_id: number; imported: number; duplicates: number; errors: number; auto_linked_count?: number }> {
    return apiRequest(`/api/import/batches/${batchId}/commit`, { method: 'POST' });
}
