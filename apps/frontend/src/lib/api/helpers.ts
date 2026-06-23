import {
    API_BASE_URL,
    type QueryParams,
    rawFetch,
    apiRequest,
    parseEnvelopeError,
    unwrapEnvelope,
} from '@/lib/api/client';

export type { QueryParams };

export function buildQuery(params?: QueryParams): string {
    if (!params) return '';
    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            queryParams.append(key, String(value));
        }
    });
    return queryParams.toString();
}

export function requestWithQuery<T>(endpoint: string, params?: QueryParams): Promise<T> {
    const query = buildQuery(params);
    return apiRequest<T>(`${endpoint}${query ? `?${query}` : ''}`);
}

export function buildExclusionQuery(params?: {
    excluded_category_ids?: number[];
    excluded_recipient_ids?: number[];
    currency?: string;
}): string {
    const queryParams = new URLSearchParams();

    if (params?.excluded_category_ids?.length) {
        params.excluded_category_ids.forEach((id) => queryParams.append('excluded_category_ids', String(id)));
    }
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) => queryParams.append('excluded_recipient_ids', String(id)));
    }
    if (params?.currency) {
        queryParams.set('currency', params.currency);
    }

    return queryParams.toString();
}

export async function createWithStatus<TPayload, TData>(
    endpoint: string,
    payload: TPayload,
): Promise<{ data: TData; wasCreated: boolean }> {
    const url = `${API_BASE_URL}${endpoint}`;
    const response = await rawFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw await parseEnvelopeError(response, 'Request failed');
    }

    const body = await response.json();
    return { data: unwrapEnvelope<TData>(body), wasCreated: response.status === 201 };
}

export async function postMultipartImport<T>(
    endpoint: string,
    file: File,
    queryParams: URLSearchParams,
): Promise<T> {
    const formData = new FormData();
    formData.append('file', file);

    const query = queryParams.toString();
    const url = `${API_BASE_URL}${endpoint}${query ? `?${query}` : ''}`;
    const response = await rawFetch(url, { method: 'POST', body: formData });

    if (!response.ok) {
        throw await parseEnvelopeError(response, 'Request failed');
    }

    const body = await response.json();
    return unwrapEnvelope<T>(body);
}

/**
 * Fetch a binary/text export as a `Blob`. Shares the tracked transport
 * (timeout, abort registration, correlation id) and the unified envelope error
 * parsing with the rest of the API layer, but returns the raw `Blob` instead of
 * unwrapping a JSON envelope — used by CSV/NDJSON/PDF export endpoints. Pair with
 * `downloadBlob` to trigger the browser download.
 */
export async function requestBlob(endpoint: string, options: RequestInit = {}): Promise<Blob> {
    const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
    const response = await rawFetch(url, options);

    if (!response.ok) {
        throw await parseEnvelopeError(response, 'Export failed');
    }

    return response.blob();
}
