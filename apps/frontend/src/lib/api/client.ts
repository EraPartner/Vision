/**
 * Base HTTP client primitives for the API layer.
 *
 * Contains the transport-level helpers (timeout, retry, correlation id,
 * envelope parsing) and the typed `ApiClientError`. Domain clients compose
 * these rather than re-implementing them.
 *
 * See docs/adr/026-unified-api-response-envelope.md for the envelope contract.
 */

import { listGuard } from "@/lib/enumGuard";
import { isRecord } from "@/lib/isRecord";
import { isAbortError } from "@/lib/api/abortError";
import {
    ApiErrorCode,
    type ApiErrorCodeValue,
} from "@vision/types";
import type { z } from "zod";

import { env } from "@/lib/env";
import logger from "@/lib/logger";
import { apiEventBus } from "@/lib/devtools/apiEventBus";

// The API is always same-origin (ADR-233): in the desktop app the backend serves
// the frontend (Electron resolves a random host port per app — see
// packaging/electron/main.ts resolveAppPort), and in development the Vite proxy
// forwards /api to the backend. The backend sends no CORS headers, so a
// cross-origin base URL cannot work. Tests (MSW on :3002) keep the explicit
// fallback.
export const API_BASE_URL =
    env.VITE_API_URL ||
    (import.meta.env.MODE !== "test" && typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost:3002");

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
export function backoffDelay(
    attempt: number,
    baseMs: number = 500,
    signal?: AbortSignal | null,
): Promise<void> {
    signal?.throwIfAborted();
    const delay = Math.min(
        baseMs * Math.pow(2, attempt) + Math.random() * 200,
        MAX_BACKOFF_MS,
    );
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            // Mirror signal.throwIfAborted() above: reject with the signal's own
            // reason (an AbortError DOMException unless the caller supplied one).
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- AbortSignal.reason is caller-defined; rewrapping would change abort semantics
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, delay);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Mint a correlation id for a single outgoing request. Echoed in the
 * `X-Request-Id` header and surfaced on the `ApiClientError.requestId` field
 * so client logs can be stitched to server logs.
 */
export function generateRequestId(): string {
    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
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
    public readonly requestId?: string | undefined;

    constructor(opts: {
        status: number;
        code: ApiErrorCodeValue;
        message: string;
        details?: unknown;
        requestId?: string | undefined;
    }) {
        super(opts.message);
        this.name = "ApiClientError";
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
    504: ApiErrorCode.GATEWAY_TIMEOUT,
};

const isApiErrorCode = listGuard(Object.values(ApiErrorCode));

/**
 * Parse a non-OK `Response` as a unified API failure envelope and return an
 * `ApiClientError`. Malformed, empty, and unparsable bodies fall back to the
 * HTTP status because supported frontend and backend builds ship together.
 */
export async function parseEnvelopeError(
    response: Response,
    fallbackMessage: string,
): Promise<ApiClientError> {
    let raw: unknown = null;
    try {
        raw = await response.json();
    } catch (err) {
        logger.warn("Failed to parse error response", err);
    }

    const fallbackCode: ApiErrorCodeValue =
        STATUS_FALLBACK_CODE[response.status] ??
        (response.status >= 500
            ? ApiErrorCode.INTERNAL_SERVER_ERROR
            : ApiErrorCode.APP_ERROR);

    // The body is untrusted: read each field before relying on it.
    const fail = isRecord(raw) ? raw : null;
    const error = fail && isRecord(fail.error) ? fail.error : null;
    const code = error?.code;
    const message = error?.message;
    if (
        fail?.ok === false &&
        error &&
        typeof code === "string" &&
        code.trim() &&
        typeof message === "string" &&
        message.trim()
    ) {
        const requestId =
            isRecord(fail.meta) && typeof fail.meta.requestId === "string"
                ? fail.meta.requestId
                : undefined;
        return new ApiClientError({
            status: response.status,
            code: isApiErrorCode(code) ? code : fallbackCode,
            message,
            details: error.details,
            requestId,
        });
    }

    return new ApiClientError({
        status: response.status,
        code: fallbackCode,
        message: `${fallbackMessage} (status ${response.status})`,
    });
}

/**
 * A success response whose body does not match the schema its client declared.
 * `issues` holds `path: message` strings only, never the offending values.
 */
export class ApiContractError extends Error {
    public readonly endpoint: string;
    public readonly issues: readonly string[];

    constructor(endpoint: string, issues: readonly string[]) {
        super(
            `Response contract violation for ${endpoint}: ${issues.join("; ")}`,
        );
        this.name = "ApiContractError";
        this.endpoint = endpoint;
        this.issues = issues;
    }
}

function formatIssuePath(path: readonly PropertyKey[]): string {
    let out = "";
    for (const segment of path) {
        if (typeof segment === "number") out += `[${segment}]`;
        else out += out ? `.${String(segment)}` : String(segment);
    }
    return out || "(root)";
}

/**
 * Check `data` against `schema` and return `data` unchanged, or throw
 * `ApiContractError`. The schema only validates: on success the caller keeps
 * the wire value. `label` is "METHOD /path"; its query string is
 * dropped because search terms can carry personal data.
 */
export function checkResponseContract<T>(
    schema: z.ZodType,
    data: T,
    label: string,
): T {
    const result = schema.safeParse(data);
    if (result.success) return data;

    // A mismatch in data the backend produced is a bug, not bad input; the
    // owner chose to block it in every build (ADR-193). Issue paths only: the
    // values are personal financial data.
    const endpoint = label.split("?")[0] ?? label;
    throw new ApiContractError(
        endpoint,
        result.error.issues.map(
            (issue) => `${formatIssuePath(issue.path)}: ${issue.message}`,
        ),
    );
}

/**
 * `checkResponseContract` for data that is still `unknown`: validates it and
 * returns it typed as the schema's output. The cast is the point of the schema
 * check above it (contract-guard pins each schema to its hand-written type).
 */
export function checkWireData<S extends z.ZodType>(
    schema: S,
    data: unknown,
    label: string,
): z.output<S> {
    checkResponseContract(schema, data, label);
    return data as z.output<S>;
}

/**
 * Extract `data` from a unified envelope body. Tolerates non-envelope
 * responses during migration — returns the body as-is when `ok` is absent.
 */
export function unwrapEnvelope(body: unknown): unknown {
    if (isRecord(body) && "ok" in body) {
        if (body.ok) return body.data;
    }
    return body;
}

// ---------------------------------------------------------------------------
// Module-level transport — used by domain modules instead of the ApiClient class
// ---------------------------------------------------------------------------

/** Param values accepted by buildQuery / requestWithQuery. */
export type QueryParams = Record<
    string,
    string | number | boolean | null | undefined
>;

const activeControllers = new Set<AbortController>();

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

    // Object holder: the timer callback writes it, which control-flow narrowing
    // cannot see for a plain `let`.
    const abort = { timedOut: false };
    const abortHandler = () => controller.abort();
    if (options.signal) {
        // Honor a signal that is already aborted before the listener is wired.
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener("abort", abortHandler);
    }

    const timeoutId = setTimeout(() => {
        abort.timedOut = true;
        controller.abort();
    }, timeoutMs);

    const requestId = generateRequestId();
    const mergedHeaders = new Headers(options.headers);
    if (!mergedHeaders.has("X-Request-Id")) {
        mergedHeaders.set("X-Request-Id", requestId);
    }

    try {
        return await fetch(url, {
            ...options,
            headers: mergedHeaders,
            signal: controller.signal,
        });
    } catch (err: unknown) {
        if (isAbortError(err)) {
            if (abort.timedOut) throw new Error("Request timed out", { cause: err });
            throw err;
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
        activeControllers.delete(controller);
        if (options.signal) {
            options.signal.removeEventListener("abort", abortHandler);
        }
    }
}

export interface ApiRequestOptions extends RequestInit {
    /**
     * Response contract for the unwrapped `data`, checked by
     * `checkResponseContract`. Omit it to skip the check.
     */
    schema?: z.ZodType;
}

/**
 * Core request with timeout, exponential-backoff retry, and envelope unwrap.
 * Domain modules import this instead of going through ApiClient.
 */
export async function apiRequest<T>(
    endpoint: string,
    options: ApiRequestOptions = {},
    retries: number = MAX_RETRIES,
): Promise<T> {
    const { schema, ...init } = options;
    const requestId = generateRequestId();
    // Caller headers win over the defaults. `init.headers` may be a Headers
    // instance or tuple array, which an object spread would silently drop.
    const headers = new Headers({
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
    });
    new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
    });

    const url = `${API_BASE_URL}${endpoint}`;
    const method = init.method ?? "GET";
    const isIdempotent = ["GET", "PUT", "DELETE", "HEAD", "OPTIONS"].includes(
        method,
    );

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= (isIdempotent ? retries : 0); attempt++) {
        init.signal?.throwIfAborted();
        if (attempt > 0) {
            await backoffDelay(attempt - 1, 500, init.signal);
        }
        init.signal?.throwIfAborted();

        const startedAt = performance.now();
        apiEventBus.emit({
            id: requestId,
            method,
            endpoint,
            startedAt,
            attempt,
            phase: "start",
        });
        // Every "start" gets exactly one end event, or the devtools inspector
        // keeps the request in flight (and its icon pulsing) forever.
        let attemptEnded = false;

        try {
            const response = await rawFetch(url, { ...init, headers });

            if (
                RETRYABLE_STATUS_CODES.has(response.status) &&
                isIdempotent &&
                attempt < retries
            ) {
                lastError = new Error(`Server returned ${response.status}`);
                // Release the unconsumed body stream before retrying (fire-and-forget).
                void response.body?.cancel().catch(() => {});
                apiEventBus.emit({
                    id: requestId,
                    method,
                    endpoint,
                    startedAt,
                    attempt,
                    phase: "error",
                    durationMs: performance.now() - startedAt,
                    status: response.status,
                    errorMessage: lastError.message,
                });
                attemptEnded = true;
                continue;
            }

            if (!response.ok) {
                const apiErr = await parseEnvelopeError(
                    response,
                    "Request failed",
                );
                const durationMs = performance.now() - startedAt;
                apiEventBus.emit({
                    id: requestId,
                    method,
                    endpoint,
                    startedAt,
                    attempt,
                    phase: "error",
                    durationMs,
                    status: response.status,
                    errorCode: apiErr.code,
                    errorMessage: apiErr.message,
                });
                attemptEnded = true;
                logger.debug(`api:request ${method} ${endpoint}`, {
                    requestId,
                    durationMs,
                    status: response.status,
                    error: apiErr.code,
                });
                throw apiErr;
            }

            if (response.status === 204) {
                const durationMs = performance.now() - startedAt;
                apiEventBus.emit({
                    id: requestId,
                    method,
                    endpoint,
                    startedAt,
                    attempt,
                    phase: "success",
                    durationMs,
                    status: 204,
                });
                attemptEnded = true;
                logger.debug(`api:request ${method} ${endpoint}`, {
                    requestId,
                    durationMs,
                    status: 204,
                });
                // 204: callers that expect no body type `T` as void/unknown.
                // 204: callers that expect no body type `T` as void/unknown.
                return undefined as unknown as T;
            }

            const body: unknown = await response.json();
            // `T` is the caller's claim about the wire shape; `schema` (when given)
            // checks it below (ADR-193).
            // `T` is the caller's claim about the wire shape; `schema` (when given)
            // checks it below (ADR-193).
            const result = unwrapEnvelope(body) as T;
            if (schema) {
                checkResponseContract(schema, result, `${method} ${endpoint}`);
            }
            const durationMs = performance.now() - startedAt;
            apiEventBus.emit({
                id: requestId,
                method,
                endpoint,
                startedAt,
                attempt,
                phase: "success",
                durationMs,
                status: response.status,
            });
            attemptEnded = true;
            logger.debug(`api:request ${method} ${endpoint}`, {
                requestId,
                durationMs,
                status: response.status,
            });
            return result;
        } catch (err: unknown) {
            if (!(err instanceof ApiClientError)) {
                // Network/timeout errors not yet emitted
                const durationMs = performance.now() - startedAt;
                apiEventBus.emit({
                    id: requestId,
                    method,
                    endpoint,
                    startedAt,
                    attempt,
                    phase: "error",
                    durationMs,
                    errorMessage:
                        err instanceof Error ? err.message : "Network error",
                });
                attemptEnded = true;
                logger.debug(`api:request ${method} ${endpoint}`, {
                    requestId,
                    durationMs,
                    error: String(err),
                });
            }
            lastError = err instanceof Error ? err : new Error(String(err));
            const nonRetryable =
                init.signal?.aborted ||
                (err instanceof Error && err.name === "AbortError") ||
                err instanceof ApiContractError ||
                (err instanceof ApiClientError &&
                    (err.code === ApiErrorCode.VALIDATION_ERROR ||
                        err.code === ApiErrorCode.RATE_LIMITED ||
                        err.code === ApiErrorCode.UNAUTHORIZED ||
                        err.code === ApiErrorCode.FORBIDDEN ||
                        err.code === ApiErrorCode.NOT_FOUND ||
                        err.code === ApiErrorCode.CONFLICT));
            if (!isIdempotent || nonRetryable) {
                throw err;
            }
            if (attempt >= retries) throw err;
        } finally {
            if (!attemptEnded) {
                apiEventBus.emit({
                    id: requestId,
                    method,
                    endpoint,
                    startedAt,
                    attempt,
                    phase: "error",
                    durationMs: performance.now() - startedAt,
                    errorMessage: "Request ended without a result",
                });
            }
        }
    }

    throw lastError ?? new Error("Request failed");
}
