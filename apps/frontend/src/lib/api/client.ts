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

/**
 * Sleep for exponential backoff: base * 2^attempt (with jitter).
 */
export function backoffDelay(attempt: number, baseMs: number = 500): Promise<void> {
    const delay = baseMs * Math.pow(2, attempt) + Math.random() * 200;
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
