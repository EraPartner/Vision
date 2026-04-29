---
title: Frontend API Client Architecture
type: reference
status: active
date: 2026-04-22
updated: 2026-04-29
tags: [reference, frontend, api-client, typescript, http, phase-1, phase-2, phase-q, client-side, environment, domain-split, openapi, recipient-groups, market-search]
description: Architecture of the frontend HTTP client split into modular layers (transport, types, domain methods) with OpenAPI type generation. Phase Q: getTransactions supports recipient_group_id parameter. 2026-04-29: searchMarket wrapper added to market.ts module; AddToWatchlistDialog migrated to apiClient methods.
aliases: [api-client, frontend-http, fetch-client, apiClient, lib/api]
related_code:
  - apps/frontend/src/lib/api/types.ts
  - apps/frontend/src/lib/api/client.ts
  - apps/frontend/src/lib/api.ts
  - apps/frontend/src/lib/api/transactions.ts
  - apps/frontend/src/lib/api/categories.ts
  - apps/frontend/src/lib/api/investments.ts
  - apps/frontend/src/lib/env.ts
  - apps/frontend/src/types/generated.ts
  - openapi.yaml
---

# Frontend API Client Architecture

## Overview

The frontend HTTP client in `apps/frontend/src/lib/api/` implements a three-layer architecture:

### Phase 1 (2026-04-21) — Foundation
- `client.ts` — Transport layer (fetch, envelope unwrapping, retry/timeout)
- `types.ts` — Shared response types and error codes
- `api.ts` — ApiClient facade

### Phase 2 (2026-04-22) — Domain Split + OpenAPI
- Split monolithic `api.ts` (1553 lines) into 13 domain modules
- Added `openapi.yaml` as authoritative API spec
- Added `openapi-typescript` codegen for type generation
- All domain modules export their methods; `api.ts` re-exports as `apiClient` for backward compat

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

## Current Structure (Phase 2)

```
apps/frontend/src/lib/
├── env.ts            ← Zod validation of VITE_* variables
├── decimal.ts        ← Safe decimal/monetary utilities (Phase 2.1)
├── timezone.ts       ← Timezone-safe date utilities (Phase 2.3)
└── api/
    ├── types.ts      ← Shared response envelopes, error types
    ├── client.ts     ← Fetch transport, envelope unwrapping
    ├── transactions.ts  ← Transaction domain methods (Phase 2.2)
    ├── categories.ts    ← Category domain methods (Phase 2.2)
    ├── recipients.ts    ← Recipient domain methods (Phase 2.2)
    ├── planned.ts       ← Planned transaction methods (Phase 2.2)
    ├── investments.ts   ← Portfolio/investment methods (Phase 2.2)
    ├── imports.ts       ← Import pipeline methods (Phase 2.2)
    ├── settings.ts      ← Settings methods (Phase 2.2)
    ├── ai.ts            ← AI chat methods (Phase 2.2)
    ├── charts.ts        ← Saved charts methods (Phase 2.2)
    ├── market.ts        ← Market lookup methods (Phase 2.2)
    ├── aggregations.ts  ← Aggregation query methods (Phase 2.2)
    ├── portfolio.ts     ← Portfolio overview methods (Phase 2.2)
    ├── info.ts          ← Statistics/info methods (Phase 2.2)
    ├── splits.ts        ← Split methods (Phase 2.2)
    ├── helpers.ts       ← Shared URL builders, query params (Phase 2.2)
    ├── electron.ts      ← Electron-specific methods (Phase 2.2)
    └── api.ts           ← ApiClient barrel re-export (Phase 2.2)

apps/frontend/src/types/
└── generated.ts     ← Auto-generated from openapi.yaml (Phase 2.4)
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

export async function backoffDelay(attempt: number, baseMs: number = 500): Promise<void> {
  // Exponential backoff with jitter, capped at MAX_BACKOFF_MS (30s)
  const ms = Math.min(baseMs * Math.pow(2, attempt) + Math.random() * 200, MAX_BACKOFF_MS);
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
- Exponential backoff (base 500ms, doubled per attempt, jitter ±200ms) capped at 30s maximum
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

### Domain Modules (Phase 2.2)

**Responsibility:** Typed methods organized by feature domain.

Previous monolithic `api.ts` (1553 lines) split into 13 domain modules:

| Module | Exports | Lines |
|--------|---------|-------|
| `transactions.ts` | getTransactions (with `recipient_group_id` support, Phase Q), getTransaction, createTransaction, updateTransaction, deleteTransaction | ~60 |
| `categories.ts` | getCategories, getCategory, createCategory, updateCategory, deleteCategory | ~40 |
| `recipients.ts` | getRecipients, getRecipient, createRecipient, updateRecipient, deleteRecipient, mergeRecipients, unmergeRecipient, getRecipientAliases | ~60 |
| `planned.ts` | getPlannedTransactions, getPlannedTransaction, createPlannedTransaction, updatePlannedTransaction, deletePlannedTransaction, executePlannedTransaction | ~50 |
| `investments.ts` | getInvestments, getInvestment, createInvestment, updateInvestment, deleteInvestment, refreshInvestmentPrices, getPriceProviders, getInvestmentPriceHistory | ~80 |
| `imports.ts` | importCSV, importCSVWithProgress, importCSVCustom, importRecipients, importCategories | ~70 |
| `settings.ts` | getSettings, getSetting, saveSetting, saveSettingsBulk | ~35 |
| `aggregations.ts` | getCategoryAggregations, getRecipientAggregations, getMonthlyAggregations, getRecurringPatterns | ~60 |
| `charts.ts` | getSavedCharts, getSavedChart, createSavedChart, updateSavedChart, deleteSavedChart | ~35 |
| `market.ts` | searchMarket (2026-04-29), getMarketQuotes, getMarketNews, createWatchlistItem | ~40 |
| `ai.ts` | chatMessage, createConversation, getConversations, updateConversation | ~90 |
| `portfolio.ts` | getPortfolioTransactions, getPortfolioTransactionsBulk, createPortfolioTransaction, updatePortfolioTransaction, deletePortfolioTransaction | ~70 |
| `info.ts` | getStatistics, getSupportedParsers, getBanks, getTransactionSummary, getNetWorth, refreshNetWorth | ~80 |

**Example domain module (`transactions.ts`):**

```typescript
import { request } from './client';
import type { Transaction, TransactionQueryParams } from './types';

export async function getTransactions(params?: TransactionQueryParams) {
  const query = new URLSearchParams(params).toString();
  return request<Transaction[]>(
    `/api/transactions${query ? '?' + query : ''}`,
  );
}

export async function createTransaction(data: CreateTransactionRequest) {
  return request<Transaction>('/api/transactions', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
```

### ApiClient Barrel (`api.ts`)

**Responsibility:** Re-export all domain modules as `apiClient` object for backward compatibility.

```typescript
// Import all domain modules
import * as txn from '@/lib/api/transactions';
import * as cat from '@/lib/api/categories';
// ... 11 more domains

// Re-export as single object
export const apiClient = {
  cancelAll: cancelAllRequests,
  // Transactions
  getTransactions: txn.getTransactions,
  createTransaction: txn.createTransaction,
  // ... all other methods from 13 domain modules
};
```

**Benefits of domain split:**
- High cohesion: Each module handles one feature domain
- Low coupling: Modules are independent
- Lazy loading: Only load needed domain modules
- Future OpenAPI integration: Each domain can generate types independently
- Easier testing: Mock/test single domain at a time
- Reduced merge conflicts: Changes to one domain don't affect others

**Current state:**
- All methods call `request<T>()` from `client.ts` (unwrapping handled)
- No mutation patterns — immutable updates return new objects
- Pagination logic moved from frontend conditionals to `meta.pagination` in response
- Backward compatibility maintained: existing call sites using `import { apiClient }` work unchanged

## OpenAPI Type Generation (Phase 2.4)

**Source:** `openapi.yaml` (hand-written OpenAPI 3.0.3 spec at project root)

The frontend uses `openapi-typescript` to auto-generate TypeScript types from the OpenAPI spec:

```bash
# Generate types from spec
bun run generate:types
# Output: apps/frontend/src/types/generated.ts (1127 lines, do not edit manually)
```

**Workflow:**

1. **Backend updates API** → Update `openapi.yaml` (one source of truth)
2. **Run code generator** → `openapi-typescript openapi.yaml -o apps/frontend/src/types/generated.ts`
3. **Frontend imports types** → `import type { Transaction, Category } from '@/types/generated'`

**Benefits:**
- Single source of truth: `openapi.yaml` is authoritative
- Type safety: All request/response types auto-generated
- No manual sync: Types always match spec
- IDE autocomplete: IntelliSense shows all possible properties
- Breaking change detection: TypeScript errors if API contract changes

**Key endpoints covered in `openapi.yaml`:**

| Resource | Methods |
|----------|---------|
| Transactions | GET, POST, PATCH, DELETE |
| Categories | GET, POST, PATCH, DELETE |
| Recipients | GET, POST, PATCH, DELETE |
| Planned Transactions | GET, POST, PATCH, DELETE |
| Investments | GET, POST, PATCH, DELETE |
| Imports | GET, POST |
| Saved Charts | GET, POST, PATCH, DELETE |
| Settings | GET, PUT, DELETE |
| Info & Net Worth | GET |
| Aggregations | GET |
| Market Lookup | GET |

All responses use [[docs/adr/026-unified-api-response-envelope|ADR-026 Envelope]] schema: `{ ok: true, data: T, meta? }` or `{ ok: false, error: {...} }`

**Migration path:**
- Phase 2.4: Hand-written `openapi.yaml` + `generated.ts` (current)
- Phase 3 (future): Generate OpenAPI spec from backend JSDoc/decorators, feed to codegen
- Phase 4+ (future): Full OpenAPI SDK generation if needed

## Roadmap: Current & Future Phases

**Phase 1 (✓ Complete):** Foundation split (types, client, api.ts)

**Phase 2 (✓ Complete):** 
- Domain module split (13 modules)
- OpenAPI spec + codegen (openapi.yaml + generated.ts)
- Decimal utilities (parseDecimal)
- Timezone utilities (parseYmd, todayYmd, daysBetween)

**Phase 3 (Planned):** OpenAPI spec auto-generation from backend (remove hand-written YAML)

**Phase 4+ (Planned):** Full OpenAPI SDK generation, additional type-safe patterns

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

**Architecture & Design:**
- [[docs/adr/030-frontend-environment-schema|ADR-030: Frontend Environment Schema Validation]] — Zod env validation on boot
- [[docs/adr/026-unified-api-response-envelope|ADR-026: Unified API Response Envelope]] — backend envelope contract
- [[docs/adr/027-alembic-single-source-of-schema|ADR-027: Alembic as Single Source of Schema Truth]] — schema management

**Type-safe utilities:**
- [[docs/reference/code-patterns#decimal-pattern-frontend-phase-22|Decimal Pattern]] — `parseDecimal()` for monetary values
- [[docs/reference/code-patterns#timezone-safe-date-utilities-phase-23|Timezone Pattern]] — `parseYmd()`, `todayYmd()`, `daysBetween()`

**Configuration & Environment:**
- [[docs/reference/environment-variables|Environment Variables Reference]] — VITE_API_URL, VITE_LOG_LEVEL, VITE_ENABLE_LOGGING

**Patterns & conventions:**
- [[docs/reference/code-patterns|Code Patterns]] — error handling and state management patterns

**API specifications:**
- [[docs/api/index|API Documentation]] — all HTTP endpoint references
- `openapi.yaml` — Hand-written OpenAPI 3.0.3 spec (source of truth for types)
