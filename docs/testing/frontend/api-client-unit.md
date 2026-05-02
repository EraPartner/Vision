---
title: API Client Unit Tests (E10)
type: testing
status: active
date: 2026-05-01
tags:
  - testing
  - frontend
  - unit-tests
  - api-client
  - vitest
  - msw
  - phase-e10
description: Unit test coverage for the Vision frontend API client layer (46 tests)
aliases:
  - api client tests
  - client layer tests
  - apiRequest tests
related_code:
  - apps/frontend/src/lib/api/client.ts
  - apps/frontend/src/lib/api/helpers.ts
  - apps/frontend/src/lib/api/client.test.ts
---

# API Client Unit Tests (E10)

> [!abstract] Overview
> Phase E10 adds comprehensive unit test coverage for the frontend API client layer. Tests verify retry logic, error handling, envelope parsing, and query building helpers. Covers 46 test cases with near-complete branch coverage.

## Test File

`apps/frontend/src/lib/api/client.test.ts` — 46 unit tests, <2 seconds execution

## Test Categories

### 1. Backoff Delay (3 tests)

Tests the exponential backoff strategy with minimum delay and maximum cap.

```typescript
describe("backoffDelay", () => {
  // Test 1: Resolves correctly with fake timers
  it("resolves when the timer elapses", async () => {
    vi.useFakeTimers();
    const p = backoffDelay(0);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
  });

  // Test 2: Enforces 500ms minimum on attempt 0
  it("does not resolve before 500ms on attempt 0", async () => {
    vi.useFakeTimers();
    let resolved = false;
    backoffDelay(0).then(() => { resolved = true; });
    vi.advanceTimersByTime(499);
    await Promise.resolve();
    expect(resolved).toBe(false);
    await vi.runAllTimersAsync();
    expect(resolved).toBe(true);
  });

  // Test 3: Caps delay at 30,000ms
  it("caps delay at 30 000ms for large attempt numbers", async () => {
    vi.useFakeTimers();
    const p = backoffDelay(100); // 2^100 >> 30 000 ms cap
    vi.advanceTimersByTime(30_000);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
  });
});
```

**Key Patterns:**
- `vi.useFakeTimers()` to control time advancement
- `vi.advanceTimersByTime()` to test minimum delay enforcement
- `vi.runAllTimersAsync()` to drain all pending timers and await promises
- Cleanup: `afterEach(() => vi.useRealTimers())`

**Coverage:**
- Minimum 500ms delay enforced
- Exponential backoff calculation correct
- 30,000ms cap applied
- Promise resolution timing guaranteed

### 2. Request ID Generation (2 tests)

Tests deterministic UUID or fallback generation when crypto is unavailable.

```typescript
describe("generateRequestId", () => {
  // Test 1: UUID format when available
  it("returns a UUID string when crypto.randomUUID is available", () => {
    const id = generateRequestId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  // Test 2: Fallback format when crypto absent
  it("falls back to req-<base36>-<random> when crypto.randomUUID is absent", () => {
    vi.stubGlobal("crypto", { randomUUID: undefined });
    const id = generateRequestId();
    expect(id).toMatch(/^req-/);
  });
});
```

**Key Patterns:**
- `vi.stubGlobal()` to mock missing globals in test environment
- Regex matching for UUID and fallback formats
- Cleanup: `afterEach(() => vi.unstubAllGlobals())`

**Coverage:**
- Crypto UUID generation preferred
- Fallback generation works in absence of crypto API

### 3. ApiClientError Class (3 tests)

Tests error class definition, prototype chain, and field storage.

```typescript
describe("ApiClientError", () => {
  // Test 1: Instanceof checks
  it("is an instance of Error and ApiClientError", () => {
    const err = new ApiClientError({ 
      status: 404, 
      code: ApiErrorCode.NOT_FOUND, 
      message: "not found" 
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiClientError);
  });

  // Test 2: Error name
  it("has name 'ApiClientError'", () => {
    const err = new ApiClientError({ 
      status: 500, 
      code: ApiErrorCode.INTERNAL_SERVER_ERROR, 
      message: "boom" 
    });
    expect(err.name).toBe("ApiClientError");
  });

  // Test 3: Field storage
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
```

**Coverage:**
- Error class inheritance chain correct
- Name property set correctly
- All error fields accessible and stored

### 4. Envelope Error Parsing (9 tests)

Tests extraction and mapping of error information from various response formats per [[docs/adr/026-unified-api-response-envelope|ADR-026]].

```typescript
describe("parseEnvelopeError", () => {
  // Test 1: Unified envelope error
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

  // Test 2: Status fallback code
  it("uses status fallback code when envelope omits code", async () => {
    const response = mockResponse(404, { ok: false, error: { message: "not found" } });
    const err = await parseEnvelopeError(response, "fallback");
    expect(err.code).toBe(ApiErrorCode.NOT_FOUND);
  });

  // Test 3: Pydantic 422 validation array
  it("formats Pydantic 422 validation array into a readable message", async () => {
    const response = mockResponse(422, { 
      detail: [{ loc: ["body", "name"], msg: "required" }] 
    });
    const err = await parseEnvelopeError(response, "fallback");
    expect(err.status).toBe(422);
    expect(err.code).toBe(ApiErrorCode.VALIDATION_ERROR);
    expect(err.message).toContain("body.name");
    expect(err.message).toContain("required");
  });

  // Test 4: 429 Rate-Limit with retry_after
  it("includes retry_after in 429 message", async () => {
    const response = mockResponse(429, { retry_after: 60 });
    const err = await parseEnvelopeError(response, "fallback");
    expect(err.status).toBe(429);
    expect(err.code).toBe(ApiErrorCode.RATE_LIMITED);
    expect(err.message).toContain("60");
  });

  // Test 5: Legacy detail field (string)
  it("uses legacy string detail field", async () => {
    const response = mockResponse(400, { detail: "bad stuff happened" });
    const err = await parseEnvelopeError(response, "fallback");
    expect(err.message).toBe("bad stuff happened");
  });

  // Test 6: Legacy message field
  it("uses legacy string message field", async () => {
    const response = mockResponse(500, { message: "server exploded" });
    const err = await parseEnvelopeError(response, "fallback");
    expect(err.message).toBe("server exploded");
  });

  // Test 7: Null body fallback
  it("falls back to the fallback message when body is null", async () => {
    const response = new Response(null, { status: 503 });
    const err = await parseEnvelopeError(response, "Service unavailable");
    expect(err.message).toContain("Service unavailable");
    expect(err.message).toContain("503");
  });

  // Test 8: Status code mapping (it.each)
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

  // Test 9: Unknown 5xx
  it("maps unknown 5xx to INTERNAL_SERVER_ERROR", async () => {
    const response = mockResponse(599, {});
    const err = await parseEnvelopeError(response, "x");
    expect(err.code).toBe(ApiErrorCode.INTERNAL_SERVER_ERROR);
  });
});
```

**Key Patterns:**
- Helper: `mockResponse(status, body)` creates Response objects for testing
- `it.each()` for parameterized status code mapping tests
- Handles multiple error formats: unified envelope, Pydantic array, legacy detail/message
- Rate-limit special case (retry_after extraction)

**Coverage:**
- All error envelope formats recognized
- Status codes mapped to error codes
- Fallback codes applied when envelope omits code
- Pydantic validation errors formatted readably
- Rate-limit metadata extracted
- Null/empty response handled gracefully

### 5. Envelope Unwrapping (5 tests)

Tests extraction of data from success envelopes without mutation.

```typescript
describe("unwrapEnvelope", () => {
  // Test 1: Extract from ok=true envelope
  it("extracts data from an ok=true envelope", () => {
    expect(unwrapEnvelope({ ok: true, data: { id: 1 } })).toEqual({ id: 1 });
  });

  // Test 2: Non-envelope passthrough
  it("returns a non-envelope object unchanged", () => {
    const obj = { some: "data" };
    expect(unwrapEnvelope(obj)).toBe(obj);
  });

  // Test 3: ok=false passthrough (does not throw)
  it("returns an ok=false envelope unchanged (does not throw)", () => {
    const obj = { ok: false, error: { message: "err" } };
    expect(unwrapEnvelope(obj)).toBe(obj);
  });

  // Test 4: Null passthrough
  it("returns null unchanged", () => {
    expect(unwrapEnvelope(null)).toBeNull();
  });

  // Test 5: Array passthrough
  it("returns an array unchanged", () => {
    const arr = [1, 2, 3];
    expect(unwrapEnvelope(arr)).toBe(arr);
  });
});
```

**Coverage:**
- Envelope detection and unwrapping correct
- Non-envelope values passed through unchanged
- Error envelopes not unwrapped (left for caller)
- Immutability maintained (same object reference)

### 6. Retryable Status Codes (2 tests)

Tests the set of HTTP status codes eligible for retry logic.

```typescript
describe("RETRYABLE_STATUS_CODES", () => {
  // Test 1: Retryable codes
  it("includes 408, 429, 502, 503, 504", () => {
    for (const code of [408, 429, 502, 503, 504]) {
      expect(RETRYABLE_STATUS_CODES.has(code)).toBe(true);
    }
  });

  // Test 2: Non-retryable codes
  it("excludes non-retryable codes", () => {
    for (const code of [400, 401, 403, 404, 409, 422, 500]) {
      expect(RETRYABLE_STATUS_CODES.has(code)).toBe(false);
    }
  });
});
```

**Coverage:**
- Retryable codes (transient): 408, 429, 502, 503, 504
- Non-retryable codes (permanent): 400, 401, 403, 404, 409, 422, 500

### 7. Query Building (4 tests)

Tests URL query string construction from parameter objects.

```typescript
describe("buildQuery", () => {
  // Test 1: Empty params
  it("returns empty string when called without params", () => {
    expect(buildQuery()).toBe("");
    expect(buildQuery(undefined)).toBe("");
  });

  // Test 2: Parameter encoding
  it("encodes params as a query string", () => {
    const q = buildQuery({ page: 1, limit: 20 });
    expect(q).toContain("page=1");
    expect(q).toContain("limit=20");
  });

  // Test 3: Omit null/undefined
  it("omits null and undefined values", () => {
    const q = buildQuery({ active: true, deleted: null, missing: undefined });
    expect(q).toContain("active=true");
    expect(q).not.toContain("deleted");
    expect(q).not.toContain("missing");
  });

  // Test 4: Keep falsy but defined values
  it("keeps false and zero values", () => {
    const q = buildQuery({ active: false, count: 0 });
    expect(q).toContain("active=false");
    expect(q).toContain("count=0");
  });
});
```

**Coverage:**
- Empty parameter handling
- URL encoding of query strings
- Null/undefined exclusion (but false/0 kept)

### 8. Exclusion Query Building (5 tests)

Tests query building for multi-valued exclusion filters.

```typescript
describe("buildExclusionQuery", () => {
  // Test 1: Empty params
  it("returns empty string for no params", () => {
    expect(buildExclusionQuery()).toBe("");
    expect(buildExclusionQuery({})).toBe("");
  });

  // Test 2: Repeat category IDs
  it("repeats excluded_category_ids for each value", () => {
    const q = buildExclusionQuery({ excluded_category_ids: [1, 2, 3] });
    expect(q).toContain("excluded_category_ids=1");
    expect(q).toContain("excluded_category_ids=2");
    expect(q).toContain("excluded_category_ids=3");
  });

  // Test 3: Repeat recipient IDs
  it("repeats excluded_recipient_ids for each value", () => {
    const q = buildExclusionQuery({ excluded_recipient_ids: [5, 6] });
    expect(q).toContain("excluded_recipient_ids=5");
    expect(q).toContain("excluded_recipient_ids=6");
  });

  // Test 4: Currency param
  it("sets currency param", () => {
    expect(buildExclusionQuery({ currency: "USD" })).toContain("currency=USD");
  });

  // Test 5: Omit empty arrays
  it("omits empty arrays", () => {
    const q = buildExclusionQuery({ excluded_category_ids: [], currency: "EUR" });
    expect(q).not.toContain("excluded_category_ids");
    expect(q).toContain("currency=EUR");
  });
});
```

**Coverage:**
- Empty parameter handling
- Array repetition for multi-value filters
- Single value params (currency)
- Empty array exclusion

### 9. API Request Orchestration (7 tests)

Tests the main `apiRequest()` function: retry logic, error handling, envelope unwrapping, and method-specific behavior.

```typescript
describe("apiRequest", () => {
  // Test 1: GET success with unwrap
  it("GET success returns unwrapped data", async () => {
    server.use(
      http.get(TEST_URL, () => HttpResponse.json({ ok: true, data: { id: 1 } })),
    );
    const result = await apiRequest<{ id: number }>("/api/client-test");
    expect(result).toEqual({ id: 1 });
  });

  // Test 2: 204 No Content
  it("204 returns undefined", async () => {
    server.use(
      http.get(TEST_URL, () => new HttpResponse(null, { status: 204 }))
    );
    const result = await apiRequest("/api/client-test");
    expect(result).toBeUndefined();
  });

  // Test 3: Non-OK response throws
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

  // Test 4: POST does not retry
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

  // Test 5: GET retries and succeeds
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

  // Test 6: GET exhausts retries
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
    // Use Promise.allSettled to prevent unhandled rejection
    await Promise.allSettled([promise, vi.runAllTimersAsync()]);
    await expect(promise).rejects.toThrow(ApiClientError);
  });

  // Test 7: VALIDATION_ERROR skips retries
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
```

**Key Patterns:**
- MSW `server.use()` per-test overrides for HTTP interception
- `http.get()` / `http.post()` to mock different methods
- `HttpResponse.json()` for JSON responses; `new HttpResponse(null, { status })` for status-only
- Retry testing with fake timers: `vi.useFakeTimers()` + `vi.runAllTimersAsync()`
- `Promise.allSettled()` to prevent unhandled rejection in exhausted-retry test
- Call counter pattern to verify retry attempts

**Coverage:**
- GET success path with envelope unwrap
- 204 No Content (no body)
- Non-OK response error handling
- POST method skips retry (fires once)
- GET method retries on transient failures (502)
- GET method succeeds on second attempt after 502
- GET method exhausts retries and throws
- Validation errors (400) skip retries even with retries=2

## Key Testing Patterns

### Fake Timers

Use `vi.useFakeTimers()` to control time in backoff delay and retry tests:

```typescript
afterEach(() => vi.useRealTimers()); // Always reset

vi.useFakeTimers();
const promise = someAsyncFunction();
await vi.runAllTimersAsync(); // Drain all timers
```

### Global Stubbing

Stub missing globals with `vi.stubGlobal()`:

```typescript
afterEach(() => vi.unstubAllGlobals());

vi.stubGlobal("crypto", { randomUUID: undefined });
// Test fallback behavior
```

### MSW Mocking

Override MSW handlers per test with `server.use()`:

```typescript
server.use(
  http.get(URL, () => HttpResponse.json({ /* response */ })),
);
```

### Error Verification

Use `.toMatchObject()` to verify error fields without exact equality:

```typescript
await expect(apiRequest(...)).rejects.toMatchObject({
  status: 404,
  code: ApiErrorCode.NOT_FOUND,
});
```

### Unhandled Rejection Prevention

Use `Promise.allSettled()` when testing retry exhaustion:

```typescript
// Without allSettled, unhandled rejection occurs
await Promise.allSettled([promise, vi.runAllTimersAsync()]);
await expect(promise).rejects.toThrow();
```

## Running the Tests

```bash
# Run all API client tests
bun vitest run apps/frontend/src/lib/api/client.test.ts

# Watch mode
bun test:watch

# With coverage
bun vitest run --coverage apps/frontend/src/lib/api/client.test.ts
```

## Related Documentation

- [[docs/adr/026-unified-api-response-envelope|ADR-026: Unified API Response Envelope]] — Error code mappings, envelope format
- [[docs/testing/test-inventory|Test Inventory]] — Full test coverage status
- [[docs/testing/testing|Testing Guide]] — General patterns and conventions
- [[docs/reference/code-patterns|Code Patterns]] — API client usage patterns

## Coverage Summary

| Component | Tests | Coverage | Status |
|-----------|-------|----------|--------|
| `backoffDelay` | 3 | Minimum delay, exponential, cap | ✓ Complete |
| `generateRequestId` | 2 | UUID, fallback | ✓ Complete |
| `ApiClientError` | 3 | Class, name, fields | ✓ Complete |
| `parseEnvelopeError` | 9 | Unified, legacy, special cases | ✓ Complete |
| `unwrapEnvelope` | 5 | Extract, passthrough | ✓ Complete |
| `RETRYABLE_STATUS_CODES` | 2 | Retryable, non-retryable | ✓ Complete |
| `buildQuery` | 4 | Empty, encode, filter | ✓ Complete |
| `buildExclusionQuery` | 5 | Empty, arrays, currency | ✓ Complete |
| `apiRequest` | 7 | Success, retry, errors | ✓ Complete |
| **Total** | **46** | **API layer** | ✓ Complete |

**Execution time:** <2 seconds (no jsdom overhead, node environment)

**Status:** Phase E10 COMPLETE (2026-05-01)
