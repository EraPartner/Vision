/**
 * Base HTTP client primitives for the API layer.
 *
 * Contains the transport-level helpers (timeout, retry, correlation id,
 * envelope parsing) and the typed `ApiClientError`. Domain clients compose
 * these rather than re-implementing them.
 *
 * See docs/adr/026-unified-api-response-envelope.md for the envelope contract.
 */

import {
    ApiErrorCode,
    type ApiErrorCodeValue,
    type ApiFailure,
    type ApiResponse,
    type ApiSuccess,
} from '@vision/types';

import { env } from '@/lib/env';
import logger from '@/lib/logger';

export const API_BASE_URL = env.VITE_API_URL || 'http://localhost:3002';

/** Default request timeout in milliseconds */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Max retry attempts for transient failures */
export const MAX_RETRIES = 2;

/** HTTP status codes that are safe to retry */
export const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

const MAX_BACKOFF_MS = 30_000;

/**
 * Sleep for exponential backoff: base * 2^attempt (with jitter), capped at MAX_BACKOFF_MS.
 */
export function backoffDelay(attempt: number, baseMs: number = 500): Promise<void> {
    const delay = Math.min(baseMs * Math.pow(2, attempt) + Math.random() * 200, MAX_BACKOFF_MS);
    return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Mint a correlation id for a single outgoing request. Echoed in the
 * `X-Request-Id` header and surfaced on the `ApiClientError.requestId` field
 * so client logs can be stitched to server logs.
 */
export function generateRequestId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Typed error surfaced by the API client. Carries the unified envelope error
 * (see docs/adr/026-unified-api-response-envelope.md) plus HTTP status and
 * the correlation id attached to the failing request.
 */
export class ApiClientError extends Error {
    public readonly status: number;
    public readonly code: ApiErrorCodeValue;
    public readonly details?: unknown;
    public readonly requestId?: string;

    constructor(opts: {
        status: number;
        code: ApiErrorCodeValue;
        message: string;
        details?: unknown;
        requestId?: string;
    }) {
        super(opts.message);
        this.name = 'ApiClientError';
        this.status = opts.status;
        this.code = opts.code;
        this.details = opts.details;
        this.requestId = opts.requestId;
    }
}

const STATUS_FALLBACK_CODE: Record<number, ApiErrorCodeValue> = {
    400: ApiErrorCode.VALIDATION_ERROR,
    401: ApiErrorCode.UNAUTHORIZED,
    403: ApiErrorCode.FORBIDDEN,
    404: ApiErrorCode.NOT_FOUND,
    409: ApiErrorCode.CONFLICT,
    422: ApiErrorCode.VALIDATION_ERROR,
    429: ApiErrorCode.RATE_LIMITED,
    502: ApiErrorCode.BAD_GATEWAY,
    503: ApiErrorCode.SERVICE_UNAVAILABLE,
};

/**
 * Parse a non-OK `Response` as a unified API failure envelope and return an
 * `ApiClientError`. Falls back to legacy `{ detail }` / `{ message }` shapes
 * while older routes are migrated, and finally to a status-only error if the
 * body is empty or unparsable.
 */
export async function parseEnvelopeError(
    response: Response,
    fallbackMessage: string,
): Promise<ApiClientError> {
    let raw: unknown = null;
    try {
        raw = await response.json();
    } catch (err) {
        logger.warn('Failed to parse error response', err);
    }

    const fallbackCode: ApiErrorCodeValue =
        STATUS_FALLBACK_CODE[response.status] ??
        (response.status >= 500 ? ApiErrorCode.INTERNAL_SERVER_ERROR : ApiErrorCode.APP_ERROR);

    const fail = raw as Partial<ApiFailure> | null;
    if (fail && fail.ok === false && fail.error && typeof fail.error === 'object') {
        return new ApiClientError({
            status: response.status,
            code: fail.error.code ?? fallbackCode,
            message: fail.error.message || fallbackMessage,
            details: fail.error.details,
            requestId: fail.meta?.requestId,
        });
    }

    const legacy = raw as { detail?: unknown; message?: unknown; retry_after?: unknown } | null;
    if (legacy && typeof legacy === 'object') {
        if (response.status === 422 && Array.isArray(legacy.detail)) {
            const validationErrors = legacy.detail
                .map((err: unknown) => {
                    const e = err as { loc?: unknown[]; msg?: unknown };
                    const field = Array.isArray(e?.loc) ? e.loc.join('.') : 'unknown';
                    return `${field}: ${e?.msg ?? ''}`;
                })
                .join('; ');
            return new ApiClientError({
                status: response.status,
                code: ApiErrorCode.VALIDATION_ERROR,
                message: `Validation error: ${validationErrors}`,
                details: legacy.detail,
            });
        }
        if (response.status === 429) {
            const retryAfter = legacy.retry_after ?? 'a few';
            return new ApiClientError({
                status: response.status,
                code: ApiErrorCode.RATE_LIMITED,
                message: `Too many requests. Please try again in ${retryAfter} seconds.`,
            });
        }
        if (typeof legacy.detail === 'string' && legacy.detail.trim()) {
            return new ApiClientError({
                status: response.status,
                code: fallbackCode,
                message: legacy.detail,
            });
        }
        if (typeof legacy.message === 'string' && legacy.message.trim()) {
            return new ApiClientError({
                status: response.status,
                code: fallbackCode,
                message: legacy.message,
            });
        }
    }

    return new ApiClientError({
        status: response.status,
        code: fallbackCode,
        message: `${fallbackMessage} (status ${response.status})`,
    });
}

/**
 * Extract `data` from a unified envelope body. Tolerates non-envelope
 * responses during migration — returns the body as-is when `ok` is absent.
 */
export function unwrapEnvelope<T>(body: unknown): T {
    if (body && typeof body === 'object' && 'ok' in body) {
        const envelope = body as ApiResponse<T>;
        if (envelope.ok === true) return (envelope as ApiSuccess<T>).data;
    }
    return body as T;
}

// ---------------------------------------------------------------------------
// Module-level transport — used by domain modules instead of the ApiClient class
// ---------------------------------------------------------------------------

/** Param values accepted by buildQuery / requestWithQuery. */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;

const activeControllers = new Set<AbortController>();

/** Cancel every in-flight request (e.g. on logout). */
export function cancelAllRequests(): void {
    for (const controller of activeControllers) {
        controller.abort();
    }
    activeControllers.clear();
}

/**
 * Raw fetch with timeout and AbortController tracking.
 * Does NOT parse the response — callers handle that.
 */
export async function rawFetch(
    url: string,
    options: RequestInit = {},
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
    const controller = new AbortController();
    activeControllers.add(controller);

    if (options.signal) {
        options.signal.addEventListener('abort', () => controller.abort());
    }

    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const requestId = generateRequestId();
    const mergedHeaders = new Headers(options.headers);
    if (!mergedHeaders.has('X-Request-Id')) {
        mergedHeaders.set('X-Request-Id', requestId);
    }

    try {
        return await fetch(url, {
            ...options,
            headers: mergedHeaders,
            signal: controller.signal,
        });
    } catch (err: unknown) {
        if ((err as Error).name === 'AbortError') {
            throw new Error('Request timed out or was cancelled', { cause: err });
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
        activeControllers.delete(controller);
    }
}

/**
 * Core request with timeout, exponential-backoff retry, and envelope unwrap.
 * Domain modules import this instead of going through ApiClient.
 */
export async function apiRequest<T>(
    endpoint: string,
    options: RequestInit = {},
    retries: number = MAX_RETRIES,
): Promise<T> {
    const headers: HeadersInit = {
        'Content-Type': 'application/json',
        ...options.headers,
    };

    const url = `${API_BASE_URL}${endpoint}`;
    const method = options.method ?? 'GET';
    const isIdempotent = ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(method);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= (isIdempotent ? retries : 0); attempt++) {
        if (attempt > 0) {
            await backoffDelay(attempt - 1);
        }

        try {
            const response = await rawFetch(url, { ...options, headers });

            if (RETRYABLE_STATUS_CODES.has(response.status) && isIdempotent && attempt < retries) {
                lastError = new Error(`Server returned ${response.status}`);
                continue;
            }

            if (!response.ok) {
                throw await parseEnvelopeError(response, 'Request failed');
            }

            if (response.status === 204) {
                return undefined as unknown as T;
            }

            const body = await response.json();
            return unwrapEnvelope<T>(body);
        } catch (err: unknown) {
            lastError = err as Error;
            const nonRetryable =
                err instanceof ApiClientError &&
                (err.code === ApiErrorCode.VALIDATION_ERROR ||
                    err.code === ApiErrorCode.RATE_LIMITED ||
                    err.code === ApiErrorCode.UNAUTHORIZED ||
                    err.code === ApiErrorCode.FORBIDDEN ||
                    err.code === ApiErrorCode.NOT_FOUND ||
                    err.code === ApiErrorCode.CONFLICT);
            if (!isIdempotent || nonRetryable) {
                throw err;
            }
            if (attempt >= retries) throw err;
        }
    }

    throw lastError ?? new Error('Request failed');
}
