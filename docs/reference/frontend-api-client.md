---
title: Frontend API Client Architecture
type: reference
status: active
date: 2026-04-21
tags: [reference, frontend, api-client, typescript, http, phase-1, client-side, environment]
description: Architecture of the frontend HTTP client split into modular layers (transport, types, domain methods)
aliases: [api-client, frontend-http, fetch-client, apiClient, lib/api]
related_code:
  - apps/frontend/src/lib/api/types.ts
  - apps/frontend/src/lib/api/client.ts
  - apps/frontend/src/lib/api.ts
  - apps/frontend/src/lib/env.ts
---

# Frontend API Client Architecture

## Overview

The frontend HTTP client in `apps/frontend/src/lib/api/` is being refactored from a monolithic 1243-line file into modular layers. **Phase 1 (2026-04-21)** establishes the foundation:

- `client.ts` — Transport layer (fetch, envelope unwrapping, retry/timeout)
- `types.ts` — Shared response types and error codes
- `api.ts` — ApiClient class (facade for all 108 endpoint methods)

## Environment Configuration

**`apps/frontend/src/lib/env.ts` (Phase 1):**

Centralized environment variable validation via Zod. Imported at app boot time in `main.tsx`:

```typescript
import env from '@/lib/env';

// env.VITE_API_URL :: string | undefined
// env.VITE_LOG_LEVEL :: 'debug' | 'info' | 'warn' | 'error' | 'silent' | undefined
// env.VITE_ENABLE_LOGGING :: boolean
```

**API URL contract:**

```typescript
// In apps/frontend/src/lib/api/client.ts
export const API_BASE_URL = env.VITE_API_URL || 'http://localhost:3002';
```

If `VITE_API_URL` is malformed, Zod validation fails at boot with a clear error message, preventing silent misconfiguration. See [[docs/adr/030-frontend-environment-schema|ADR-030]] for validation rules.

## Current Structure (Phase 1)

```
apps/frontend/src/lib/
├── env.ts            ← Zod validation of VITE_* variables (Phase 1)
└── api/
    ├── types.ts      ← Response envelopes, error types
    ├── client.ts     ← Fetch transport, envelope unwrapping
    └── api.ts        ← ApiClient singleton with ~120 methods
```

### Transport & Envelope (`client.ts`)

**Responsibility:** Low-level HTTP transport, response unwrapping, error handling.

```typescript
import { env } from '@/lib/env';

// Exported utilities
export const API_BASE_URL = env.VITE_API_URL || 'http://localhost:3002';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RETRIES = 2;
export const RETRYABLE_STATUS_CODES = [408, 429, 502, 503, 504];

export async function backoffDelay(attempt: number): Promise<void> {
  // Exponential backoff with jitter
  const ms = 500 * Math.pow(2, attempt) + Math.random() * 200;
  await new Promise(r => setTimeout(r, ms));
}

export class ApiClientError extends Error {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
  httpStatus: number;
}

export function parseEnvelopeError(body: ApiResponse<unknown>, status: number): ApiClientError {
  // Extract error from { ok: false, error: { code, message, details } }
}

export function unwrapEnvelope<T>(body: ApiResponse<T>, status: number): T {
  // Extract data from { ok: true, data: T, meta? }
  // Throws ApiClientError on { ok: false, ... }
}
```

**Key features:**
- Single `request<T>` function for all endpoint calls
- Automatic retry on 408, 429, 502, 503, 504
- 30s timeout by default (per-call override supported)
- AbortController support for cancellation
- Envelope unwrapping: `{ ok, data/error }` → `data` or throws `ApiClientError`

### Shared Types (`types.ts`)

**Responsibility:** Response envelope and error type definitions (backend-agnostic contract).

```typescript
export type ApiResponse<T> =
  | { ok: true; data: T; meta?: ResponseMeta }
  | { ok: false; error: ApiError };

export interface ResponseMeta {
  requestId?: string;
  computedAt?: string;
  source?: 'mv' | 'live';
  pagination?: { total: number; page: number; limit: number };
}

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'INTERNAL_SERVER_ERROR'
  | 'BAD_GATEWAY'
  | 'APP_ERROR';

export interface AggregationEnvelope<T> {
  ok: true;
  data: T;
  meta: { source: 'mv' | 'live'; computedAt: string; requestId?: string };
}

export interface ImportProgress {
  processed: number;
  total: number;
  currentBank: string;
  startedAt: string;
}

export interface ImportResult {
  imported: number;
  deduplicated: number;
  failed: number;
  summary: Record<string, unknown>;
}
```

### ApiClient Singleton (`api.ts`)

**Responsibility:** Typed methods for all endpoints (facade over `client.ts`).

Currently 1243 lines with ~120 methods organized by domain:
- Transactions (get, create, update, delete, bulk)
- Categories, Recipients, Planned Transactions
- Investments, Portfolio, Watchlist
- Imports, Aggregations, Charts
- Settings, Info, Admin

**Example method signature:**

```typescript
export class ApiClient {
  async getTransactions(params?: TransactionQueryParams): Promise<TransactionsListResponse> {
    return this.request<TransactionsListResponse>(
      `/api/transactions?${new URLSearchParams(params).toString()}`,
    );
  }

  async createTransaction(data: CreateTransactionRequest): Promise<Transaction> {
    return this.request<Transaction>('/api/transactions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
}
```

**Current state:**
- All methods call `this.request<T>()` (unwrapping handled by `client.ts`)
- No mutation patterns — immutable updates return new objects
- Pagination logic moved from frontend conditionals to `meta.pagination` in response

## Roadmap: Future Phases

**Phase 1 (Complete):** Foundation split (types, client, api.ts)

**Phase 2 (Planned):** Domain module split
```
apps/frontend/src/lib/api/
├── types.ts
├── client.ts
├── modules/
│   ├── transactions.ts
│   ├── categories.ts
│   ├── recipients.ts
│   ├── investments.ts
│   ├── aggregations.ts
│   └── [other domains...]
└── api.ts (re-exports all as ApiClient facade)
```

**Phase 3 (Planned):** OpenAPI codegen to replace hand-written types.

## Error Handling Pattern

Frontend error handling is now uniform:

```typescript
// In React components / hooks
try {
  const data = await apiClient.getTransactions();
  // ...
} catch (error) {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case 'VALIDATION_ERROR':
        // Show form errors from error.details
        break;
      case 'NOT_FOUND':
        // Show 404 toast
        break;
      case 'RATE_LIMITED':
        // Inform user to retry later
        break;
      default:
        // Generic error toast
    }
  }
}
```

**Benefits over legacy sniffing:**
- Single error type, no `instanceof` chains
- Error code available for i18n message keys
- Request ID in `error.requestId` for support logs
- Validation details always in `error.details`

## Immutability Pattern

All paginated responses now use immutable updates:

```typescript
// Legacy (before Phase 1):
const getTransactions = async (params) => {
  const res = await fetch(`/api/transactions?...`);
  const data = await res.json();
  data.items = data.items.map(/* mutation */)  // ❌ mutates original
  return data;
};

// Current (Phase 1+):
async getTransactions(params?: TransactionQueryParams): Promise<TransactionsListResponse> {
  const body = await this.request<TransactionsListResponse>(`/api/transactions?...`);
  // body.data is the array; meta.pagination is separate
  return body.data; // pure value, no mutation
}
```

## Related

- [[docs/adr/030-frontend-environment-schema|ADR-030: Frontend Environment Schema Validation]] — Zod env validation on boot
- [[docs/adr/026-unified-api-response-envelope|ADR-026: Unified API Response Envelope]] — backend envelope contract
- [[docs/adr/027-alembic-single-source-of-schema|ADR-027: Alembic as Single Source of Schema Truth]] — schema management
- [[docs/reference/environment-variables|Environment Variables Reference]] — VITE_API_URL, VITE_LOG_LEVEL, VITE_ENABLE_LOGGING
- [[docs/reference/code-patterns|Code Patterns]] — error handling and state management patterns
- [[docs/api/index|API Documentation]] — all HTTP endpoint references
