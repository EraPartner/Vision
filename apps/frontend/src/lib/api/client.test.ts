import { describe, it, expect, vi, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { ApiErrorCode } from "@vision/types";
import {
    backoffDelay,
    generateRequestId,
    ApiClientError,
    parseEnvelopeError,
    unwrapEnvelope,
    apiRequest,
    RETRYABLE_STATUS_CODES,
} from "@/lib/api/client";
import { buildQuery, buildExclusionQuery } from "@/lib/api/helpers";

const TEST_URL = "http://localhost:3002/api/client-test";

// ---------------------------------------------------------------------------
// backoffDelay
// ---------------------------------------------------------------------------

describe("backoffDelay", () => {
    afterEach(() => vi.useRealTimers());

    it("resolves when the timer elapses", async () => {
        vi.useFakeTimers();
        const p = backoffDelay(0);
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();
    });

    it("does not resolve before 500ms on attempt 0", async () => {
        vi.useFakeTimers();
        let resolved = false;
        backoffDelay(0).then(() => {
            resolved = true;
        });
        vi.advanceTimersByTime(499);
        await Promise.resolve();
        expect(resolved).toBe(false);
        await vi.runAllTimersAsync();
        expect(resolved).toBe(true);
    });

    it("caps delay at 30 000ms for large attempt numbers", async () => {
        vi.useFakeTimers();
        const p = backoffDelay(100); // 2^100 >> 30 000 ms cap
        vi.advanceTimersByTime(30_000);
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// generateRequestId
// ---------------------------------------------------------------------------

describe("generateRequestId", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("returns a UUID string when crypto.randomUUID is available", () => {
        const id = generateRequestId();
        expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
    });

    it("falls back to req-<base36>-<random> when crypto.randomUUID is absent", () => {
        vi.stubGlobal("crypto", { randomUUID: undefined });
        const id = generateRequestId();
        expect(id).toMatch(/^req-/);
    });
});

// ---------------------------------------------------------------------------
// ApiClientError
// ---------------------------------------------------------------------------

describe("ApiClientError", () => {
    it("is an instance of Error and ApiClientError", () => {
        const err = new ApiClientError({ status: 404, code: ApiErrorCode.NOT_FOUND, message: "not found" });
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(ApiClientError);
    });

    it("has name 'ApiClientError'", () => {
        const err = new ApiClientError({ status: 500, code: ApiErrorCode.INTERNAL_SERVER_ERROR, message: "boom" });
        expect(err.name).toBe("ApiClientError");
    });

    it("stores status, code, message, details, and requestId", () => {
        const err = new ApiClientError({
            status: 422,
            code: ApiErrorCode.VALIDATION_ERROR,
            message: "bad input",
            details: { field: "name" },
            requestId: "req-abc",
        });
        expect(err.status).toBe(422);
        expect(err.code).toBe(ApiErrorCode.VALIDATION_ERROR);
        expect(err.message).toBe("bad input");
        expect(err.details).toEqual({ field: "name" });
        expect(err.requestId).toBe("req-abc");
    });
});

// ---------------------------------------------------------------------------
// parseEnvelopeError
// ---------------------------------------------------------------------------

function mockResponse(status: number, body?: unknown): Response {
    return new Response(body !== undefined ? JSON.stringify(body) : null, {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

describe("parseEnvelopeError", () => {
    it("parses a unified API envelope error", async () => {
        const response = mockResponse(400, {
            ok: false,
            error: { message: "bad request", code: "VALIDATION_ERROR" },
            meta: { requestId: "req-123" },
        });
        const err = await parseEnvelopeError(response, "fallback");
        expect(err.status).toBe(400);
        expect(err.message).toBe("bad request");
        expect(err.code).toBe(ApiErrorCode.VALIDATION_ERROR);
        expect(err.requestId).toBe("req-123");
    });

    it("uses status fallback code when envelope omits code", async () => {
        const response = mockResponse(404, { ok: false, error: { message: "not found" } });
        const err = await parseEnvelopeError(response, "fallback");
        expect(err.code).toBe(ApiErrorCode.NOT_FOUND);
    });

    it("formats Pydantic 422 validation array into a readable message", async () => {
        const response = mockResponse(422, { detail: [{ loc: ["body", "name"], msg: "required" }] });
        const err = await parseEnvelopeError(response, "fallback");
        expect(err.status).toBe(422);
        expect(err.code).toBe(ApiErrorCode.VALIDATION_ERROR);
        expect(err.message).toContain("body.name");
        expect(err.message).toContain("required");
    });

    it("includes retry_after in 429 message", async () => {
        const response = mockResponse(429, { retry_after: 60 });
        const err = await parseEnvelopeError(response, "fallback");
        expect(err.status).toBe(429);
        expect(err.code).toBe(ApiErrorCode.RATE_LIMITED);
        expect(err.message).toContain("60");
    });

    it("uses legacy string detail field", async () => {
        const response = mockResponse(400, { detail: "bad stuff happened" });
        const err = await parseEnvelopeError(response, "fallback");
        expect(err.message).toBe("bad stuff happened");
    });

    it("uses legacy string message field", async () => {
        const response = mockResponse(500, { message: "server exploded" });
        const err = await parseEnvelopeError(response, "fallback");
        expect(err.message).toBe("server exploded");
    });

    it("falls back to the fallback message when body is null", async () => {
        const response = new Response(null, { status: 503 });
        const err = await parseEnvelopeError(response, "Service unavailable");
        expect(err.message).toContain("Service unavailable");
        expect(err.message).toContain("503");
    });

    it.each([
        [400, ApiErrorCode.VALIDATION_ERROR],
        [401, ApiErrorCode.UNAUTHORIZED],
        [403, ApiErrorCode.FORBIDDEN],
        [404, ApiErrorCode.NOT_FOUND],
        [409, ApiErrorCode.CONFLICT],
        [502, ApiErrorCode.BAD_GATEWAY],
        [503, ApiErrorCode.SERVICE_UNAVAILABLE],
    ] as const)("status %d maps to fallback code %s", async (status, expectedCode) => {
        const response = mockResponse(status, {});
        const err = await parseEnvelopeError(response, "x");
        expect(err.code).toBe(expectedCode);
    });

    it("maps unknown 5xx to INTERNAL_SERVER_ERROR", async () => {
        const response = mockResponse(599, {});
        const err = await parseEnvelopeError(response, "x");
        expect(err.code).toBe(ApiErrorCode.INTERNAL_SERVER_ERROR);
    });
});

// ---------------------------------------------------------------------------
// unwrapEnvelope
// ---------------------------------------------------------------------------

describe("unwrapEnvelope", () => {
    it("extracts data from an ok=true envelope", () => {
        expect(unwrapEnvelope({ ok: true, data: { id: 1 } })).toEqual({ id: 1 });
    });

    it("returns a non-envelope object unchanged", () => {
        const obj = { some: "data" };
        expect(unwrapEnvelope(obj)).toBe(obj);
    });

    it("returns an ok=false envelope unchanged (does not throw)", () => {
        const obj = { ok: false, error: { message: "err" } };
        expect(unwrapEnvelope(obj)).toBe(obj);
    });

    it("returns null unchanged", () => {
        expect(unwrapEnvelope(null)).toBeNull();
    });

    it("returns an array unchanged", () => {
        const arr = [1, 2, 3];
        expect(unwrapEnvelope(arr)).toBe(arr);
    });
});

// ---------------------------------------------------------------------------
// RETRYABLE_STATUS_CODES
// ---------------------------------------------------------------------------

describe("RETRYABLE_STATUS_CODES", () => {
    it("includes 408, 429, 502, 503, 504", () => {
        for (const code of [408, 429, 502, 503, 504]) {
            expect(RETRYABLE_STATUS_CODES.has(code)).toBe(true);
        }
    });

    it("excludes non-retryable codes", () => {
        for (const code of [400, 401, 403, 404, 409, 422, 500]) {
            expect(RETRYABLE_STATUS_CODES.has(code)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// buildQuery (from helpers.ts)
// ---------------------------------------------------------------------------

describe("buildQuery", () => {
    it("returns empty string when called without params", () => {
        expect(buildQuery()).toBe("");
        expect(buildQuery(undefined)).toBe("");
    });

    it("encodes params as a query string", () => {
        const q = buildQuery({ page: 1, limit: 20 });
        expect(q).toContain("page=1");
        expect(q).toContain("limit=20");
    });

    it("omits null and undefined values", () => {
        const q = buildQuery({ active: true, deleted: null, missing: undefined });
        expect(q).toContain("active=true");
        expect(q).not.toContain("deleted");
        expect(q).not.toContain("missing");
    });

    it("keeps false and zero values", () => {
        const q = buildQuery({ active: false, count: 0 });
        expect(q).toContain("active=false");
        expect(q).toContain("count=0");
    });
});

// ---------------------------------------------------------------------------
// buildExclusionQuery (from helpers.ts)
// ---------------------------------------------------------------------------

describe("buildExclusionQuery", () => {
    it("returns empty string for no params", () => {
        expect(buildExclusionQuery()).toBe("");
        expect(buildExclusionQuery({})).toBe("");
    });

    it("repeats excluded_category_ids for each value", () => {
        const q = buildExclusionQuery({ excluded_category_ids: [1, 2, 3] });
        expect(q).toContain("excluded_category_ids=1");
        expect(q).toContain("excluded_category_ids=2");
        expect(q).toContain("excluded_category_ids=3");
    });

    it("repeats excluded_recipient_ids for each value", () => {
        const q = buildExclusionQuery({ excluded_recipient_ids: [5, 6] });
        expect(q).toContain("excluded_recipient_ids=5");
        expect(q).toContain("excluded_recipient_ids=6");
    });

    it("sets currency param", () => {
        expect(buildExclusionQuery({ currency: "USD" })).toContain("currency=USD");
    });

    it("omits empty arrays", () => {
        const q = buildExclusionQuery({ excluded_category_ids: [], currency: "EUR" });
        expect(q).not.toContain("excluded_category_ids");
        expect(q).toContain("currency=EUR");
    });
});

// ---------------------------------------------------------------------------
// apiRequest
// ---------------------------------------------------------------------------

describe("apiRequest", () => {
    afterEach(() => vi.useRealTimers());

    it("GET success returns unwrapped data", async () => {
        server.use(
            http.get(TEST_URL, () => HttpResponse.json({ ok: true, data: { id: 1 } })),
        );
        const result = await apiRequest<{ id: number }>("/api/client-test");
        expect(result).toEqual({ id: 1 });
    });

    it("204 returns undefined", async () => {
        server.use(http.get(TEST_URL, () => new HttpResponse(null, { status: 204 })));
        const result = await apiRequest("/api/client-test");
        expect(result).toBeUndefined();
    });

    it("throws ApiClientError on a non-OK response", async () => {
        server.use(
            http.get(TEST_URL, () =>
                HttpResponse.json(
                    { ok: false, error: { message: "not found", code: "NOT_FOUND" } },
                    { status: 404 },
                ),
            ),
        );
        await expect(apiRequest("/api/client-test", {}, 0)).rejects.toThrow(ApiClientError);
        await expect(apiRequest("/api/client-test", {}, 0)).rejects.toMatchObject({
            status: 404,
            code: ApiErrorCode.NOT_FOUND,
        });
    });

    it("POST does not retry — fires exactly once even on 502", async () => {
        let calls = 0;
        server.use(
            http.post(TEST_URL, () => {
                calls++;
                return new HttpResponse(null, { status: 502 });
            }),
        );
        await expect(apiRequest("/api/client-test", { method: "POST" }, 2)).rejects.toThrow();
        expect(calls).toBe(1);
    });

    it("GET retries on a retryable status and succeeds on the second attempt", async () => {
        let calls = 0;
        server.use(
            http.get(TEST_URL, () => {
                calls++;
                return calls < 2
                    ? new HttpResponse(null, { status: 502 })
                    : HttpResponse.json({ ok: true, data: "ok" });
            }),
        );
        vi.useFakeTimers();
        const promise = apiRequest<string>("/api/client-test", {}, 1);
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result).toBe("ok");
        expect(calls).toBe(2);
    });

    it("GET exhausts retries and throws ApiClientError", async () => {
        server.use(
            http.get(TEST_URL, () =>
                HttpResponse.json(
                    { ok: false, error: { message: "gateway down", code: "BAD_GATEWAY" } },
                    { status: 502 },
                ),
            ),
        );
        vi.useFakeTimers();
        const promise = apiRequest("/api/client-test", {}, 1);
        await Promise.allSettled([promise, vi.runAllTimersAsync()]);
        await expect(promise).rejects.toThrow(ApiClientError);
    });

    it("GET with VALIDATION_ERROR does not retry despite retries=2", async () => {
        let calls = 0;
        server.use(
            http.get(TEST_URL, () => {
                calls++;
                return HttpResponse.json(
                    { ok: false, error: { message: "bad", code: "VALIDATION_ERROR" } },
                    { status: 400 },
                );
            }),
        );
        await expect(apiRequest("/api/client-test", {}, 2)).rejects.toThrow(ApiClientError);
        expect(calls).toBe(1);
    });
});
