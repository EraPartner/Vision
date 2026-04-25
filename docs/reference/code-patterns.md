---
title: Code Patterns Reference
type: reference
status: active
date: 2026-04-26
updated: 2026-04-25
tags: [reference, patterns, conventions, code-style, backend, frontend, phase-0, phase-1, phase-2, phase-3, phase-4, phase-5, phase-6, phase-9, phase-c, motion, liquid-glass, design-system, decimal, money, timezone, openapi, domain-split, import, import-pipeline, concurrency, batching, decimal-enforcement, zustand, slice-selection, typescript, error-handling, type-safety, csv, formula-injection, cwe-1236]
description: Standard code patterns used throughout the Vision project — repositories, routes, hooks, API client, Express setup, error handling, type safety, filter builders, aggregation envelopes, aggregation refresh, trigger-maintained tables, golden fixtures, database fixtures, pure calculation services, atomic multi-step transactions, streaming CSV exports with formula injection prevention, import batch concurrency, motion consumers, surface shells, gradient icon tiles, money utilities, decimal utilities, timezone boundary handling, TypeScript type annotations, type-safe error handling, domain-split API client, Zustand store with useShallow slice selection, and feature flags with admin API
aliases: [code patterns, coding patterns, conventions, patterns, how to write code, repository pattern, route pattern, hook pattern, error handling, type-safe error handling, type annotations, filter builder, golden fixture, aggregation envelope, calculation services, import concurrency, motion pattern, surface shell pattern, gradient icon pattern, money pattern, decimal pattern, timezone pattern, domain split, openapi, typescript types, csv export, safe csv, formula injection, cwe-1236]
---

# Code Patterns Reference

> [!abstract] Purpose
> This document captures the standard code patterns used throughout the Vision project. AI agents should follow these patterns when writing new code. Developers can use this as a quick reference.

## Money Utility Pattern (Phase 9)

**Source:** [[apps/node-backend/src/lib/money.js|money.js]]

All monetary calculations must use Decimal.js to eliminate IEEE 754 floating-point drift. JavaScript's native `number` type cannot exactly represent 0.1 + 0.2 (results in 0.30000000000000004). Vision uses banker's rounding (HALF_EVEN) to match PostgreSQL NUMERIC semantics.

> [!note] Hot-Path Enforcement (Phase 12 Bugfix Sweep)
> ESLint custom rule `no-raw-money-arithmetic` now warns on raw `+`, `-`, `*`, `÷` operators on identifiers matching money-like names (e.g., `amount`, `balance`, `cost`). This helps prevent drift in hot paths like split allocation and portfolio math. Not all warnings are errors — context matters — but all should be reviewed before merge.



### Pattern

```js
import { toDecimal, addAll, subtract, roundToCents, toNumber } from '../lib/money.js';

// Convert any input (number, string, Decimal, null) to Decimal
const amount = toDecimal(100.5);

// Sum an array without drift
const total = toNumber(addAll([0.1, 0.2, 0.3])); // 0.6 exactly

// Safe subtraction (e.g., outstanding balance)
const outstanding = toNumber(subtract('100.00', '66.67')); // 33.33 exactly

// Round to cents with banker's rounding (HALF_EVEN)
const rounded = toNumber(roundToCents('10.125')); // 10.12 (rounds to even)

// Database NUMERIC strings
const dbAmount = toNumber(toDecimal('100.00')); // Safe from string precision loss
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| All monetary input | Wrap in `toDecimal()` immediately |
| All accumulations | Use `addAll([...])` instead of `.reduce((a, b) => a + b)` |
| Rounding strategy | Always explicit `roundToCents()` before persistence |
| Final output | Use `toNumber()` or `.toString()` for JSON/display |
| Null/undefined | Treated as 0 by `toDecimal()` |
| Database NUMERIC | Convert string to `toDecimal(string)` for safe math |
| Banker's rounding | HALF_EVEN default; 0.005 rounds to 0, 0.015 to 0.02 |

### Mandatory Scopes (Phase 9 Complete)

As of 2026-04-23, decimal enforcement is **mandatory** for all monetary API output paths:

| Scope | Files | Enforcement |
|-------|-------|-----------|
| **Repository reads** | splitRepository, infoRepositoryBanks/Helpers/Monthly, portfolioTransactionRepository, rawTransactionRepository | `toNumber(toDecimal(value))` on all NUMERIC/DECIMAL DB columns |
| **Route responses** | transactions, plannedTransactions, info, aggregations | `toDecimal()` → math → `toNumber()` before JSON serialization |
| **Service calculations** | recurringDetectionService, currencyConversionService, portfolioMath, snapshotBuilder | Decimal.js throughout; `toNumber()` for output |
| **CSV/XML parsing** | Bank import adapters | parseFloat only; DB writes go through repositories (which enforce decimal) |

### When to Use

- **Database reads** — All monetaryvalues from DB (MANDATORY in Phase 9)
- **Split calculations** — outstanding balance, payment allocation
- **Aggregations** — running totals, monthly sums, portfolio valuations
- **Currency conversion** — avoid rounding errors across exchanges
- **Any accumulation loop** — use `addAll()` instead of `for` loop with native arithmetic
- **API output** — All final JSON serialization uses `toNumber()`

### When NOT Necessary

- **Frontend UI** — server sends precise JSON (already 2 DP); frontend displays only
- **Non-monetary calculations** — use native number for counts, ratios, percentages
- **Text parsing for import** — CSV/XML text use parseFloat; decimal enforcement happens at DB write

---

## Decimal Pattern (Frontend, Phase 2.2)

**Source:** [[apps/frontend/src/lib/decimal.ts|decimal.ts]]

Frontend monetary display and form parsing use `parseDecimal()` for safe handling of comma-formatted input and edge cases:

```typescript
import { parseDecimal } from '@/lib/decimal';

// Parse user input (form field)
const amount = parseDecimal('1.234,56'); // → 1234.56
const amount2 = parseDecimal('100');     // → 100
const amount3 = parseDecimal(null);      // → 0 (fallback)

// Safe fallback
const value = parseDecimal(userInput, 0);  // Use 0 if parsing fails
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| User form input | Always wrap in `parseDecimal()` |
| Comma handling | Automatically strips commas (locale-aware parsing) |
| Null/undefined/empty | Returns `fallback` (default 0) |
| Non-finite results | Returns `fallback` (NaN, Infinity handled) |
| API responses | Already precise (server sends 2 DP numbers), display as-is |
| Frontend calculations | Avoid frontend monetary math; compute server-side |

### When to Use

- **Form field parsing** — user enters "1.234,56", parse to 1234.56
- **CSV import preview** — preview user-provided amounts
- **Legacy number input** — handle both comma and decimal separators
- **Fallback safety** — never show NaN in UI

### When NOT to Use

- **API response values** — already precise from backend
- **Arithmetic operations** — keep math on server side
- **Non-monetary numbers** — use `parseFloat()` or `Number()` for counts, ratios

---

## TypeScript Type Annotation Best Practices (Phase 5+)

**Applies to:** Both frontend and backend TypeScript files

### Explicit Type Annotations for Uninitialized Variables

Always explicitly type variables on declaration when not initialized:

```typescript
// WRONG: Type inference on uninitialized variable
let count = 0;  // inferred as number, but looks unintentional
let values = [];  // inferred as unknown[], unclear intent
let currentValue = 0;  // ambiguous for linting

// CORRECT: Explicit type annotation
let count: number;
let values: string[];
let currentValue: number = 0;

// Or use const in loop/scope when possible
let maxValue: number;
for (const item of items) {
  maxValue = Math.max(item.value);  // Now clearly typed
}
```

### Type Narrowing in Conditionals

```typescript
// Avoid casting with `as any`
const value = data.field as any;  // ❌ Disables type safety

// Instead, use type guards with `instanceof` or `typeof`
if (value instanceof Error) {
  console.log(value.message);  // ✅ value is Error here
} else if (typeof value === 'string') {
  console.log(value.toUpperCase());  // ✅ value is string here
}
```

### Interface vs Type (Phase 5+)

**Rule:** Use `type` for simple aliases; use `interface` for object contracts

```typescript
// Type alias (simple/discriminated union)
type ThemeVariant = 'default' | 'dracula' | 'solarized';
type Result<T> = { ok: true; data: T } | { ok: false; error: string };

// Empty interface extends becomes type alias (cleaner)
// BEFORE: interface X extends Y { }
// AFTER:  type X = Y;

// Use interface for object contracts with inheritance
interface Entity {
  id: number;
  createdAt: string;
}

interface Transaction extends Entity {
  amount: number;
  category: string;
}
```

### Function Parameter Types (Phase 5+)

```typescript
// WRONG: Accept 'any' parameter
function process(item: any) { ... }  // ❌ Loses type info

// CORRECT: Use specific type
function process(item: Transaction) { ... }  // ✅ Type-safe

// Generic when flexible:
function process<T extends Entity>(item: T) { ... }
```

### No "Useless Assignment" Anti-Pattern

```typescript
// WRONG: Variable assigned but never used before reassignment
let total = 0;
total = calculateSum(items);  // First assignment is useless

// CORRECT: Declare without initial assignment, or initialize correctly
let total: number;
total = calculateSum(items);

// Or use const when possible
const total = calculateSum(items);
```

---

## Timezone-Safe Date Utilities (Frontend, Phase 2.3)

**Source:** [[apps/frontend/src/lib/timezone.ts|timezone.ts]]

Frontend date operations avoid the pitfall of `new Date("YYYY-MM-DD")`, which parses as UTC midnight and shifts the calendar date in timezones east of UTC. Use helper functions instead:

```typescript
import { parseYmd, toYmd, todayYmd, daysBetween } from '@/lib/timezone';

// Parse a YYYY-MM-DD string as local midnight (not UTC)
const date = parseYmd('2026-04-22');  // → Date at 00:00:00 local time

// Convert Date to YYYY-MM-DD string
const ymdString = toYmd(new Date());  // → "2026-04-22"

// Today's date as string
const today = todayYmd();              // → "2026-04-22"

// Days between two dates (fractional)
const elapsed = daysBetween(startDate, endDate);  // → 5.5 (days)
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Date-only values | Always use `parseYmd()`, never `new Date("YYYY-MM-DD")` |
| String output | Use `toYmd()` for YYYY-MM-DD format |
| Today | Use `todayYmd()` for current date string |
| Date arithmetic | Use `daysBetween()` for elapsed time calculations |
| No timezone conversion | These functions work in browser local time (no APP_TIMEZONE crossing) |
| Server dates | Backend sends ISO 8601; parse with `parseYmd(txn.date)` |

### When to Use

- **Form defaults** — "Today's date" field gets `todayYmd()`
- **Date comparisons** — is planned date in future? Compare with `todayLocal()`
- **Calendar UI** — render days using local midnight
- **Filters** — date range "from Jan 1 to Dec 31 local"

### When NOT to Use

- **Backend aggregations** — server uses `APP_TIMEZONE` for bucketing
- **UTC operations** — use native Date for UTC math
- **Timestamp storage** — use ISO 8601 strings from API

---

## Backend Repository Pattern

**Source:** [[apps/node-backend/src/repositories/transactionRepository.js|transactionRepository.js]], [[apps/node-backend/src/repositories/categoryRepository.js|categoryRepository.js]]

```js
import { query } from '../database/connection.js';

export const entityRepository = {
  async getAll({ limit = 50, offset = 0, active = true, ...filters } = {}) {
    let sql = `SELECT * FROM table_name WHERE 1=1`;
    const params = [];
    let paramIdx = 1;

    if (active) sql += ` AND is_active = true`;
    sql += ` ORDER BY id DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows;
  },

  async getCount({ active = true, ...filters } = {}) {
    let sql = `SELECT count(*) FROM table_name WHERE 1=1`;
    const params = [];
    // Same filter logic as getAll
    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  async getById(id) {
    const result = await query('SELECT * FROM table_name WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async create(data) {
    const sql = `INSERT INTO table_name (col1, col2) VALUES ($1, $2) RETURNING *`;
    const result = await query(sql, [data.field1, data.field2]);
    return result.rows[0] || null;
  },

  async update(id, fields) {
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        setClauses.push(`${key} = $${paramIdx++}`);
        params.push(value);
      }
    }
    if (setClauses.length === 0) return this.getById(id);
    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const sql = `UPDATE table_name SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] || null;
  },

  async hardDelete(id) {
    const result = await query('DELETE FROM table_name WHERE id = $1', [id]);
    return result.rowCount > 0;
  },
};

export default entityRepository;
```

### Key Conventions

| Pattern | Rule |
|---------|------|
| DB access | Import `query` from `../database/connection.js` |
| Filter building | `WHERE 1=1` + dynamic `AND` clauses |
| Parameters | Positional (`$1`, `$2`) with manual index tracking |
| Single row | `result.rows[0] || null` |
| Delete success | `result.rowCount > 0` |
| Dynamic updates | Build `SET` clauses from `Object.entries()`, skip `undefined` |
| SQL injection | Use parameterized queries only, never string concatenation |

---

## Timezone Boundary Handling (Phase 9)

**Source:** [[apps/node-backend/src/lib/timezone.js|timezone.js]], [[apps/node-backend/tests/timezone.test.js|timezone.test.js]]

Certain JavaScript environments (some older Intl implementations, edge cases in Safari) report `hour=24` at midnight when converting from UTC to zoned wall-clock time. This is technically valid per ECMAScript (hour is in range [0,24]) but breaks logic expecting [0,23]. The fix normalizes hour=24 to day+1, hour=0 and re-normalizes via `Date.UTC()` to handle month/year overflow.

### Pattern

```js
import { toAppTz } from '../lib/timezone.js';

// Before (buggy):
const zoned = new Intl.DateTimeFormat('en-GB', {
  timeZone: zone,
  // ... parts ...
}).formatToParts(utcDate);
const hour = get('hour');  // Might be 24!
if (hour > 23) /* error or silent bug */

// After (normalized):
const zoned = toAppTz(utcDate, zone);
// zoned.hour is always [0,23]
// zoned.day, month, year are correctly rolled if hour was 24
```

### Implementation

When `hour === 24`:
1. Set `hour = 0`
2. Increment `day` (via `Date.UTC(year, month-1, day+1)`)
3. Extract year, month, day from rolled Date to handle month/year overflow automatically

### Key Cases

| Scenario | Input | Output |
|----------|-------|--------|
| Jan 31 23:00 UTC (Feb 1 00:00 Brussels) | `hour=24, day=31, month=1` | `hour=0, day=1, month=2, year=2026` |
| Dec 31 23:00 UTC (Jan 1 00:00 Brussels) | `hour=24, day=31, month=12` | `hour=0, day=1, month=1, year=2027` |

### Tests

Two new test cases in `timezone.test.js`:
- `toAppTz handles year boundary at Dec 31 -> Jan 1 rollover`
- (Existing case already covered Jan 31 → Feb 1)

---

## Backend Route Pattern

**Source:** [[apps/node-backend/src/routes/transactions.js|transactions.js]], [[apps/node-backend/src/routes/splits.js|splits.js]], [[apps/node-backend/src/routes/categories.js|categories.js]]

Per [[docs/adr/026-unified-api-response-envelope|ADR-026]], all routes return `{ ok: true, data, meta? }` via `res.ok()` middleware:

```js
import { Router } from 'express';
import entityRepository from '../repositories/entityRepository.js';
import { logger } from '../config/logger.js';
import { validateIdParam } from '../middleware/validation.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

const router = Router();

// GET /api/entities — paginated list
router.get('/', async (req, res) => {
  const { limit = 50, offset = 0, ...filters } = req.query;
  const opts = {
    limit: Math.min(parseInt(limit, 10) || 50, 1000),
    offset: parseInt(offset, 10) || 0,
  };

  const [items, total] = await Promise.all([
    entityRepository.getAll(opts),
    entityRepository.getCount(opts),
  ]);

  // List response: wrap payload as {items, total, ...} inside data
  res.ok({ items, total, limit: opts.limit, offset: opts.offset });
});

// GET /api/entities/:id
router.get('/:id', validateIdParam, async (req, res) => {
  const entity = await entityRepository.getById(parseInt(req.params.id, 10));
  if (!entity) throw new NotFoundError('Entity not found');
  res.ok(entity);
});

// POST /api/entities
router.post('/', async (req, res) => {
  const { requiredField, ...data } = req.body;
  if (!requiredField) {
    throw new ValidationError('Missing required fields: requiredField');
  }
  const entity = await entityRepository.create(data);
  res.status(201);
  res.ok(entity);
});

// PATCH /api/entities/:id
router.patch('/:id', validateIdParam, async (req, res) => {
  const updated = await entityRepository.update(parseInt(req.params.id, 10), req.body);
  if (!updated) throw new NotFoundError('Entity not found');
  res.ok(updated);
});

// DELETE /api/entities/:id
router.delete('/:id', validateIdParam, async (req, res) => {
  const deleted = await entityRepository.hardDelete(parseInt(req.params.id, 10));
  if (!deleted) throw new NotFoundError('Entity not found');
  res.ok({ id: parseInt(req.params.id, 10) });
});

export default router;
```

### Key Conventions

| Pattern | Rule |
|---------|------|
| **List envelope** | `res.ok({ items, total, limit?, offset? })` wraps items in a `data` object per [[docs/adr/026-unified-api-response-envelope|ADR-026]] |
| **Parallel fetch** | `Promise.all([getAll, getCount])` for list endpoints to avoid N+1 |
| **ID validation** | `validateIdParam` middleware on all `/:id` routes |
| **Error handling** | Throw `NotFoundError`, `ValidationError`, etc.; `errorHandler` middleware converts to `{ ok: false, error: {...} }` |
| **Success response** | All success paths use `res.ok(data)` or `res.ok({items, total})` |
| **Route ordering** | Static routes (e.g., `/providers`) BEFORE `/:id` routes |
| **Rate limiting** | Per-route limiters for heavy endpoints (e.g., export, search) |
| **Export** | `export default router` |

---

## List Response Envelope Pattern (ADR-026 Compliance)

**Source:** [[apps/node-backend/src/routes/splits.js|splits.js]], [[apps/node-backend/src/routes/attachments.js|attachments.js]], test suite

All list/paginated endpoints return a consistent envelope shape per [[docs/adr/026-unified-api-response-envelope|ADR-026]]:

```js
// Backend: Route returns wrapped payload
router.get('/', async (req, res) => {
  const [items, total] = await Promise.all([
    repository.getAll({ limit, offset }),
    repository.getCount(),
  ]);
  // Payload wraps inside res.ok(data) — data object becomes {items, total, ...}
  res.ok({ items, total, limit, offset });
});

// HTTP Response:
{
  "ok": true,
  "data": {
    "items": [...],
    "total": 42,
    "limit": 50,
    "offset": 0
  },
  "meta": {
    "requestId": "...",
    "computedAt": "2026-04-24T..."
  }
}
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| **Items always present** | `data.items` is the array; never bare `data` as array |
| **Total count required** | Pagination requires `data.total` (total records matching filter) |
| **Limit/offset optional** | Include if pagination is used; omit for fixed-size responses |
| **Payload wrapping** | `res.ok({items, total, ...})` wraps the list payload inside `data`; never `res.ok(items)` |
| **Parallel fetch** | Use `Promise.all([getAll, getCount])` to avoid N+1 queries |
| **Frontend unwrapping** | API client returns `body.data` automatically; consumer receives `{items, total, ...}` |

### Common Patterns

```js
// List endpoint with filtering
res.ok({ items, total, limit: opts.limit, offset: opts.offset });

// Small fixed list (no pagination)
res.ok({ items: summary, total: summary.length });

// With metadata
res.ok({ items, total }, { source: 'mv', computedAt: '...' });
```

### Frontend Consumption

```typescript
// API client unwraps envelope; frontend gets {items, total, ...}
const { items, total } = await apiClient.getEntities({ limit: 50 });

items.forEach(item => console.log(item));  // items is already the array
```

---

## Frontend Hook Pattern

**Source:** [[apps/frontend/src/hooks/useTransactions.ts|useTransactions.ts]], [[apps/frontend/src/hooks/useCategories.ts|useCategories.ts]]

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';

// LIST query
export function useEntities(params?: { limit?: number; offset?: number }) {
  return useQuery({
    queryKey: ['entities', params],
    queryFn: () => apiClient.getEntities(params),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

// SINGLE query
export function useEntity(id: number) {
  return useQuery({
    queryKey: ['entities', id],
    queryFn: () => apiClient.getEntity(id),
    enabled: !!id,
    staleTime: 60_000,
  });
}

// CREATE mutation
export function useCreateEntity() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();

  return useMutation({
    mutationFn: (data: EntityCreate) => apiClient.createEntity(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entities'] });
      toast.success(t('entities.created'));
    },
    onError: (error: Error) => {
      toast.error(t('entities.createFailedTitle'), { description: error.message });
    },
  });
}

// UPDATE mutation
export function useUpdateEntity() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();

  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: EntityUpdate }) =>
      apiClient.updateEntity(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entities'] });
      toast.success(t('entities.updated'));
    },
    onError: (error: Error) => {
      toast.error(t('entities.updateFailedTitle'), { description: error.message });
    },
  });
}

// DELETE mutation
export function useDeleteEntity() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();

  return useMutation({
    mutationFn: (id: number) => apiClient.deleteEntity(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entities'] });
      toast.success(t('entities.deleted'));
    },
    onError: (error: Error) => {
      toast.error(t('entities.deleteFailedTitle'), { description: error.message });
    },
  });
}
```

### Key Conventions

| Pattern | Rule |
|---------|------|
| Query key | `['entities', params]` — params for cache differentiation |
| Stale time | 30s for transactional data, 2min for reference data |
| Pagination | `placeholderData: (prev) => prev` for smooth transitions |
| Conditional queries | `enabled: !!id` for single-item queries |
| Invalidation | Mutations invalidate base key `['entities']` |
| Toasts | `useLanguage()` for i18n, `description` for error details |

---

## API Client Pattern

**Source:** [[apps/frontend/src/lib/api.ts|api.ts]]

```ts
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

class ApiClient {
  cancelAll(): void { /* abort all in-flight requests */ }

  async getEntities(params?: Record<string, any>): Promise<EntitiesListResponse> {
    const query = this.buildQuery(params);
    return this.request(`/api/entities${query ? '?' + query : ''}`);
  }

  async createEntity(data: EntityCreate): Promise<Entity> {
    return this.request('/api/entities', { method: 'POST', body: JSON.stringify(data) });
  }

  private buildQuery(params?: Record<string, any>): string {
    if (!params) return '';
    const qp = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) qp.append(key, String(value));
    });
    return qp.toString();
  }

  private async request<T>(endpoint: string, options: RequestInit = {}, retries = MAX_RETRIES): Promise<T> {
    const url = API_BASE_URL + endpoint;
    const method = options.method || 'GET';
    const isIdempotent = ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(method);

    for (let attempt = 0; attempt <= (isIdempotent ? retries : 0); attempt++) {
      if (attempt > 0) await backoffDelay(attempt - 1);
      try {
        const response = await this.rawFetch(url, {
          ...options,
          headers: { 'Content-Type': 'application/json', ...options.headers },
        });

        if (RETRYABLE_STATUS_CODES.has(response.status) && isIdempotent && attempt < retries) continue;

        if (!response.ok) {
          const error = await response.json().catch(() => ({ detail: 'Request failed' }));
          throw new Error(error.detail || 'Request failed with status ' + response.status);
        }

        if (response.status === 204) return undefined as unknown as T;
        return response.json();
      } catch (err) {
        if (!isIdempotent || attempt >= retries) throw err;
      }
    }
    throw new Error('Request failed');
  }
}

export const apiClient = new ApiClient();
```

### Key Conventions

| Pattern | Rule |
|---------|------|
| Base URL | `VITE_API_URL` env var, fallback to `localhost:3002` |
| Singleton | Export single `apiClient` instance |
| Query params | `buildQuery()` skips `undefined`/`null` values |
| Retry | Exponential backoff for idempotent methods only |
| Timeout | AbortController with 30s default timeout |
| 204 handling | Returns `undefined` |
| Cancel | `cancelAll()` aborts all in-flight requests |

---

## HTTP Request Parameter Parsing Pattern (Phase 10)

**Source:** [[apps/node-backend/src/routes/aggregations.js|aggregations.js]], [[apps/node-backend/src/routes/info.js|info.js]]

Query parameters from `req.query.*` are always strings (or string arrays if multi-valued). Safe parsing requires explicit validation, bounds checking, and fallback defaults to prevent type coercion bugs.

### Pattern: `parseIntClamped()`

Extracts and validates integer query parameters with configurable bounds:

```js
import { parseInt } from 'builtins';  // Standard parseInt, not a library

function parseIntClamped(raw, { min = 1, max, fallback }) {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return max != null ? Math.min(parsed, max) : parsed;
}

// Usage in route handlers
router.get('/forecast', async (req, res) => {
  // months: defaults to 3, accepts 1–24
  const months = parseIntClamped(req.query.months, { max: 24, fallback: 3 });
  // mcPaths: defaults to 1000, accepts 1–5000
  const mcPaths = parseIntClamped(req.query.mc_paths, { max: 5000, fallback: 1000 });
  // historyMonths: defaults to 36, accepts 1–120
  const historyMonths = parseIntClamped(req.query.history_months, { max: 120, fallback: 36 });
  
  const { data, meta } = await computeCashflowForecast({ months, mcPaths, historyMonths });
  res.ok({ data, meta });
});
```

### Pattern: `parseNumericArrayQueryParam()`

Extracts and validates arrays of numeric query parameters (e.g., multi-select filters):

```js
function parseNumericArrayQueryParam(raw) {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
}

// Usage in route handlers
router.get('/monthly-summary', async (req, res) => {
  const { data, meta } = await computeMonthlySummary({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
  });
  res.ok({ data, meta });
});
```

### Key Rules

| Pattern | Rule |
|---------|------|
| `parseInt(raw, 10)` | Always radix 10 (avoid accidental octal from leading 0) |
| Non-finite check | Reject NaN, Infinity, undefined parse results |
| Bounds enforcement | Apply min (default 1) and max bounds; use `fallback` if out of range |
| String arrays | Handle both single `?param=val` and multi `?param=val1&param=val2` |
| Array filtering | Remove non-finite values, keep empty array if no matches |
| Type narrowing | Results are always `number | number[]` or fallback type, never string |

### When to Use

- **Single integer param** — `parseIntClamped()` with max bounds
- **Array of integers** — `parseNumericArrayQueryParam()` for filter arrays
- **Currency strings** — Direct upper-casing and regex validation (3-letter ISO code)
- **Boolean flags** — `=== 'true' || === '1'` string comparison (no parsing needed)
- **Dates** — Treat as ISO strings, validate with Date constructor or date lib

### When NOT to Use

- **Path parameters** (e.g., `/resource/:id`) — Use Express route constraints or numeric middleware
- **Request body** — Use schema validation (Zod) at middleware layer
- **Header values** — Parse at middleware layer, attach to `req.locals`

---

## Express App Setup

**Source:** [[apps/node-backend/src/main.js|main.js]]

### Middleware Stack (in order)

1. **CORS** — custom inline middleware; checks `Origin` header against `settings.api.corsOrigins` allowlist, sets `Access-Control-*` headers, handles OPTIONS preflight with 204 response (Phase 5 slim-down)
2. **JSON parsing** — `express.json({ limit: '1mb' })`
3. **Security headers** — CSP, HSTS (prod), X-Frame-Options, etc.
4. **Compression** — custom inline middleware using `node:zlib` createGzip(); compresses for `Accept-Encoding: gzip` + compressible types + ≥1 KB responses (Phase 5 slim-down)
5. **Request logging** — `logger.debug('[REQ] METHOD PATH')`
6. **Global rate limiter** — applied before routes
7. **Routes** — registered with per-route limiters where needed
8. **404 handler** — `{ detail: 'Not Found: METHOD PATH' }`
9. **Global error handler** — suppresses details in production

### Startup Sequence

1. Wait for DB with exponential backoff (40 attempts, 50ms to 1s)
2. `initializeSchema()` — idempotent table creation
3. `app.listen()` on configured port
4. Warm caches (exchange rates, inflation) — fire-and-forget
5. Set up 12h refresh interval for external data

### Graceful Shutdown

```js
process.on('SIGINT', async () => { await closePool(); process.exit(0); });
process.on('SIGTERM', async () => { await closePool(); process.exit(0); });
```

---

## Error Handling Pattern

**Source:** [[apps/node-backend/src/middleware/errorHandler.js|errorHandler.js]], [[apps/node-backend/src/services/deduplication.js|deduplication.js]]

Centralized error-handling middleware with typed error classes. Routes throw typed errors; middleware maps to HTTP responses.

### Handling Missing Tables (Schema Evolution, 2026-04-26)

When a table or column may not exist in older schema versions, use PostgreSQL error code `42P01` (undefined_table) to gracefully handle the missing table:

```js
try {
  const result = await query(
    `SELECT transaction_id FROM manual_raw_transactions WHERE deduplication_hash = $1 LIMIT 1`,
    [hash]
  );
  if (result.rows.length > 0) {
    return { isDuplicate: true, existingTransactionId: result.rows[0].transaction_id };
  }
} catch (err) {
  // Only suppress table-not-exist errors (42P01); log other unexpected errors
  if (err.code !== '42P01') {
    logger.warn('Unexpected error in manual dedup hash check', { error: err.message, code: err.code });
  }
  // Fall through to field-based check — table may not exist yet
}
```

**Rationale:**
- Services must work across multiple schema versions during gradual migrations
- PostgreSQL error code 42P01 = "undefined table"
- Only this error is expected and silenced; other errors are logged for visibility
- Fallback logic is executed when table is missing

### Typed Error Classes

```js
import {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from '../lib/errors.js';

// Usage in routes:
if (!requiredField) {
  throw new ValidationError('Missing required field');
}

const entity = await repository.getById(id);
if (!entity) {
  throw new NotFoundError(`Entity ${id} not found`);
}

if (isDuplicate) {
  throw new ConflictError('Duplicate entry');
}
```

### Response Format (Back-Compat)

All errors return this envelope:

```json
{ "detail": "Human-readable error message", "error_code": "ERROR_TYPE" }
```

| Status Code | Class | Error Code | When to Use |
|-------------|-------|-----------|-------------|
| 400 | ValidationError | VALIDATION_ERROR | Validation error, missing fields |
| 401 | UnauthorizedError | UNAUTHORIZED | Authentication required |
| 403 | ForbiddenError | FORBIDDEN | Access denied |
| 404 | NotFoundError | NOT_FOUND | Resource not found |
| 409 | ConflictError | CONFLICT | Duplicate entry |
| 500 | AppError | APP_ERROR | Internal server error |

### Frontend Error Handling (Phase 5+)

```ts
// Type-safe error handling with unknown type
try {
  const result = await apiClient.createEntity(data);
  toast.success('Created successfully');
} catch (err: unknown) {
  // Always type err as unknown, then narrow
  const message = err instanceof Error ? err.message : String(err);
  toast.error('Failed to create', { description: message });
}

// When re-throwing, preserve error context
try {
  await riskyOperation();
} catch (err: unknown) {
  // Chain error context for logging
  throw new Error('Operation failed', { cause: err });
}

// Empty catch blocks must include comment
try {
  await nonCriticalTask();
} catch {
  // Failure is expected/handled elsewhere
}
```

### Type-Safe Catch Pattern (Phase 5+)

Always use `catch (err: unknown)` instead of `catch (err: any)`:

| Pattern | Status | Reason |
|---------|--------|--------|
| `catch (err: any)` | ❌ **Deprecated** | Disables type checking; allows silent bugs |
| `catch (err: unknown)` | ✅ **Required** | Enforces type narrowing before access |
| `catch { ... }` | ✅ **Acceptable** | When error is unused; must have comment |

Type narrowing in catch blocks:

```ts
try {
  // operation
} catch (err: unknown) {
  // Narrowing examples:
  if (err instanceof Error) {
    logger.error('Error message:', err.message);
  } else if (typeof err === 'string') {
    logger.error('String error:', err);
  } else {
    logger.error('Unknown error type:', String(err));
  }
}
```

### Base AppError Constructor

```js
class AppError extends Error {
  constructor(message, {
    status = 500,
    code = 'APP_ERROR',
    cause,        // native Error for logging (Phase 5+)
    details = {}  // non-sensitive debug context
  } = {})
}
```

---

## Filter Builder Pattern

**Source:** [[apps/node-backend/src/services/filterBuilder.js|filterBuilder.js]]

Centralized SQL WHERE clause builder for transaction-like queries. Consolidates previously duplicated filter logic across repositories.

### Usage

```js
import { buildTransactionWhere, validateInt4Ids } from '../services/filterBuilder.js';

const opts = {
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  categoryId: 5,
  excludedCategoryIds: [10, 11, 12],
  excludedRecipientIds: [20, 21],
  bankAccount: 'CH93%',  // ILIKE substring
  active: true,
  startParamIdx: 1,
};

const { sql, params, nextParamIdx } = buildTransactionWhere(opts);

const query = `
  SELECT t.*, r.name, c.general, c.detail
  FROM transactions t
  LEFT JOIN recipients r ON t.recipient_id = r.id
  LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
  LEFT JOIN categories c ON t.category_id = c.id
  LEFT JOIN categories rc ON r.default_category_id = rc.id
  LEFT JOIN categories pc ON pr.default_category_id = pc.id
  WHERE ${sql}
  ORDER BY t.date DESC
  LIMIT 50;
`;

const result = await db.query(query, params);
```

### Contract

Every builder returns `{ sql, params, nextParamIdx }`:
- `sql` — Composable fragment with no leading/trailing whitespace guarantees
- `params` — Flattened array of bind parameters (in order with `sql`)
- `nextParamIdx` — First unused `$`-index for further predicates

### Key Functions

| Function | Purpose |
|----------|---------|
| `validateInt4Ids(ids)` | Validate array of PostgreSQL INT4 IDs; returns filtered array |
| `buildTransactionWhere(opts)` | Build full transaction WHERE clause with all filters |

---

## Pure Calculation Services (Phase 3)

**Source:** [[apps/node-backend/src/services/calculations/|services/calculations/]], [[apps/node-backend/src/utils/portfolioMath.js|portfolioMath.js]]

As of Phase 3, business logic for non-trivial calculations has been extracted into **pure, stateless functions** with no I/O side effects. These are hosted in `services/calculations/` and `utils/` and are suitable for golden-fixture testing and migration to shared utility libraries.

**Modules:**

| Module | Purpose |
|--------|---------|
| `services/calculations/loanSchedule.js` | Loan amortization schedule generation (amortizing, fixed_principal, interest_only) |
| `services/calculations/recurrence.js` | Recurring payment date calculation (daily, weekly, monthly, yearly, custom) |
| `utils/portfolioMath.js` | Cost basis calculations (weighted average, FIFO, LIFO) with immutable lot handling |

**Immutability in portfolioMath (2026-04-25):**
- `calculateCostBasisFIFO()` and `calculateCostBasisLIFO()` now use immutable patterns throughout: spread operators for array construction, immutable object creation for lot updates, and immutable transformations via `.map()` in helper functions.
- `applyEventToLots()` returns an object with mapped lot arrays (never mutations), supporting corporate actions (splits, return_of_capital) with immutable lot transformations.
- All portfolio math calculations avoid in-place mutations, enabling safe concurrent processing and eliminating hidden side effects.

**Migration Status (Phase 9):** Old paths (`services/loanRepaymentService.js`, `services/recurrenceService.js`) are still the live implementation and are directly imported by `routes/plannedTransactions.js`. Migration to the canonical `services/calculations/` paths is blocked on Phase 3 completion. Once routes migrate, the old shims can be removed in Phase 9.

---

## Golden-Fixture Pattern

**Source:** [[apps/node-backend/tests/golden/runGolden.js|runGolden.js]]

Regression testing for non-trivial calculations (loan amortization, recurrence expansion, etc.). Input + expected output stored as JSON fixtures. Paired with pure calculation services in `services/calculations/`.

### Fixture Layout

```
tests/golden/__fixtures__/
├── loanSchedule/
│   ├── amortizing-standard.input.json
│   ├── amortizing-standard.expected.json
│   ├── fixed-principal-basic.input.json
│   ├── fixed-principal-basic.expected.json
│   └── ...
├── recurrence/
│   ├── monthly-basic.input.json
│   ├── monthly-basic.expected.json
│   ├── jan-31-leap-year.input.json
│   └── ...
```

### Coverage (Phase 3)

**loanSchedule.golden.test.js:**
- Amortizing: standard, zero-APR, month-end clamp, single-month, 360-month
- Fixed principal: standard, edge cases
- Interest-only: standard, edge cases

**recurrence.golden.test.js:**
- Built-in patterns: daily, weekly, biweekly, monthly, quarterly, yearly
- Edge cases: Jan 31 clamping (non-leap + leap), Feb 29 yearly rollover, custom "every N days" regex
- Invalid patterns return null

### Usage in Vitest

```js
import { describe, it } from 'vitest';
import { runGolden } from '../golden/runGolden.js';
import { generateLoanSchedule } from '../../src/services/calculations/loanSchedule.js';

describe('loanSchedule golden', () => {
  it('amortizing-standard', async () => {
    await runGolden('loanSchedule/amortizing-standard', (input) =>
      generateLoanSchedule(input),
    );
  });
});
```

### Updating Fixtures

Run tests with `UPDATE_GOLDENS=1` to rewrite expected outputs:

```bash
UPDATE_GOLDENS=1 bun vitest run loanSchedule.golden.test.js
```

This workflow is ideal for business-logic regressions where the visual shape of a result matters more than exact implementation.

### Workflow: Adding a New Test Case

1. Create a new fixture pair: `tests/golden/__fixtures__/module/case-name.input.json` + `...expected.json`
2. In `.expected.json`, set `output` to a placeholder (e.g., `null`) or the value you expect
3. Run with `UPDATE_GOLDENS=1` — test framework will compute the actual output and rewrite `.expected.json`
4. Review the generated `.expected.json` to ensure it's correct
5. Commit both fixtures to git

### Calculation Inventory Lock (Phase 8)

The authoritative coverage matrix for every non-trivial calc lives in [[apps/node-backend/tests/golden/INVENTORY.md|tests/golden/INVENTORY.md]]. It enumerates each function in `services/calculations/` with three coverage markers:

- **G** — golden-fixture count (input/expected pairs under `tests/golden/__fixtures__/<module>/`)
- **P** — covered by a property test under `tests/property/*.property.test.js`
- **S** — covered by the aggregation shadow middleware

**Rule:** any new calc (or new aggregation) **must append a row to INVENTORY.md before merge**. A new calc must land with at least one golden input/expected pair; a new aggregation must land registered with the shadow middleware. Fixture drift is intentional only and must be paired with an ADR in the same PR.

See [[docs/testing/testing#Property Test Pattern (Phase 8)|Property Test Pattern]] for invariant-style coverage and [[docs/adr/016-aggregation-shadow-mode|ADR-016]] for the shadow-middleware rollout gate.

---

## Aggregation Envelope Pattern (Phase 2, Updated Phase 1)

**Source:** [[apps/node-backend/src/services/calculations/aggregation/_envelope.js|_envelope.js]], [[apps/node-backend/src/routes/aggregations.js|aggregations.js]]

All `/api/aggregations/*` endpoints follow the unified transport envelope (ADR-026) with a nested aggregation domain envelope. Calculation modules return `{ data, meta: { source, computedAt } }`, and routes pass this directly to `res.ok()`.

### Double-Nested Envelope Structure (Phase 1 Compliance)

Routes use `res.ok({ data, meta })` to nest the aggregation envelope inside the transport envelope. After the frontend unwraps the outer `{ ok, data }` transport layer, consumers receive the inner `AggregationEnvelope<T>`:

```js
// Route handler (aggregations.js)
router.get('/monthly-summary', async (req, res) => {
  const { data, meta } = await computeMonthlySummary({
    targetCurrency: getTargetCurrency(req),
    excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
    excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
  });
  // Nest domain envelope inside transport envelope
  res.ok({ data, meta });
});

// HTTP Response:
{
  "ok": true,
  "data": {
    "data": { /* calculation result */ },
    "meta": {
      "source": "mv" | "live",
      "computedAt": "2026-04-16T12:34:56.789Z"
    }
  },
  "meta": {
    "requestId": "..."
  }
}

// Frontend receives (after unwrapEnvelope):
{
  data: { /* calculation result */ },
  meta: { source: "mv" | "live", computedAt: "..." }
}
```

### Source Heuristic

The `meta.source` field indicates whether the response was served from a materialized view or computed live.

**Rules:**

1. **Unfiltered request** → `'mv'`
   - No `excluded_category_ids[]`, no `excluded_recipient_ids[]`
   - Fast, from materialized view (stale by ~15 min)
   - Safe for dashboard-level aggregations

2. **Filtered request** → `'live'`
   - At least one `excluded_category_ids[]` OR `excluded_recipient_ids[]` present
   - Slower, dynamically scans transactions
   - Respects user exclusion preferences

3. **Special cases** → Always `'live'`
   - `/average-vs-current` (Phase 2 always computes current-period live)
   - Any endpoint computing "now" relative to historical averages

### Implementation in Calculation Services

```js
// Service: computeMonthlySummary (calculation module)
import { buildEnvelope } from './_envelope.js';
import { getMonthlyFinancialSummary } from '../../repositories/infoRepository.js';

export async function computeMonthlySummary({
  targetCurrency,
  excludedCategoryIds,
  excludedRecipientIds,
}) {
  const hasExclusions = excludedCategoryIds.length > 0 || excludedRecipientIds.length > 0;
  const source = hasExclusions ? 'live' : 'mv';

  const data = await getMonthlyFinancialSummary(
    excludedCategoryIds,
    targetCurrency,
    excludedRecipientIds
  );

  // Return domain envelope; route will nest inside transport envelope
  return buildEnvelope(data, { source });
}
```

### Frontend Consumption

The API client unwraps the outer envelope, so consumers receive the aggregation envelope directly:

```tsx
function DashboardStatCards() {
  const { data: envelope, isLoading } = useQuery({
    queryFn: () => apiClient.getAggregationMonthlySummary({ currency: 'EUR' }),
  });

  if (!envelope) return null;

  // envelope has shape: { data: {...}, meta: { source, computedAt } }
  const isMV = envelope.meta.source === 'mv';
  const freshness = isMV ? '~15 min old' : 'current';

  return (
    <>
      <StatCard title="Monthly Income" value={envelope.data.summary.total_income} />
      <small>{freshness} ({envelope.meta.source})</small>
    </>
  );
}
```

---

## Aggregation Refresh Orchestrator (Phase 1)

**Source:** [[apps/node-backend/src/services/aggregationRefresh.js|aggregationRefresh.js]]

Single entrypoint for refreshing PostgreSQL aggregations (materialized views + trigger-maintained tables).

### Full Refresh (After Bulk Operations)

After bulk imports or mass updates:

```js
import { refreshAggregations } from '../services/aggregationRefresh.js';

// In import service:
await bulkInsertTransactions(transactions);
await refreshAggregations();  // Refreshes all MVs in parallel
logger.info('Aggregations refreshed');
```

**What it does:**
- Refreshes legacy MVs via `materializedViewService.refreshMaterializedViews()`
- Refreshes Phase-1 MVs (`mv_recipient_monthly`) in parallel
- No-op for trigger-maintained tables (automatic updates)

### Debounced Refresh (Single-Row Mutations)

After editing or deleting a transaction:

```js
import { scheduleAggregationRefresh } from '../services/aggregationRefresh.js';

// In transaction route:
app.patch('/api/transactions/:id', async (req, res) => {
  const updated = await transactionService.update(req.params.id, req.body);
  
  // Fire-and-forget debounced refresh
  scheduleAggregationRefresh().catch(err =>
    logger.error('Scheduled refresh failed', { error: err?.message })
  );
  
  res.json(updated);
});
```

**Behavior:**
- Coalesces rapid changes into one refresh (1s debounce)
- Fire-and-forget (doesn't block response)
- Triggers maintain `agg_recipient_totals` and `agg_split_outstanding` automatically

### Exported Surface

```js
import aggregationService, {
  TRIGGER_MAINTAINED_TABLES,  // ['agg_recipient_totals', 'agg_split_outstanding']
} from './aggregationRefresh.js';

await aggregationService.refreshAggregations();
await aggregationService.scheduleAggregationRefresh();
```

---

## Trigger-Maintained Aggregation Tables

**Source:** [[alembic/versions/0026_finance_aggregations.py|Migration 0026]]

Two tables kept in sync via row-level PostgreSQL triggers. Never require refresh from application code.

### agg_recipient_totals

Running all-time totals per recipient per currency.

**PK:** `(recipient_id, currency)`

**Automatic Updates:** Via `fn_agg_recipient_totals_sync()` trigger on `transactions` (AFTER INSERT/UPDATE/DELETE)

**Important:** Do NOT query inside transaction handlers before triggers fire. If you need fresh totals within the same request, refetch after the transaction commits or read from the MV instead.

```js
// ❌ WRONG: Trigger hasn't fired yet
const txn = await query('INSERT INTO transactions (...) RETURNING *');
const totals = await query('SELECT * FROM agg_recipient_totals WHERE recipient_id = $1', [txn.recipient_id]);
// totals is stale

// ✓ CORRECT: Read after transaction commits or fetch in separate query
const txn = await query('INSERT INTO transactions (...) RETURNING *');
// Now (after transaction commit) the trigger has fired
const totals = await query('SELECT * FROM agg_recipient_totals WHERE recipient_id = $1', [txn.recipient_id]);
```

### agg_split_outstanding

Outstanding balance per split (original minus paid).

**PK:** `split_id`

**Automatic Updates:** Via two triggers:
- `fn_trg_split_sync()` on `transaction_splits`
- `fn_trg_split_payment_sync()` on `split_payments`

**Same caveat:** Triggers fire at transaction commit. If you need immediately-fresh outstanding balances within the request, compute manually instead of reading the aggregate.

```js
// After split_payments insert:
const payment = await query('INSERT INTO split_payments (split_id, amount) VALUES (...) RETURNING *');

// The trigger has now fired. Safe to read:
const outstanding = await query(
  'SELECT outstanding_amount FROM agg_split_outstanding WHERE split_id = $1',
  [payment.split_id]
);
```

### Best Practices

1. **Document trigger-maintained aggregates** — Add a comment in code that reads them:
   ```js
   // Reads agg_recipient_totals; maintained by fn_agg_recipient_totals_sync trigger
   const result = await query('SELECT * FROM agg_recipient_totals WHERE ...');
   ```

2. **Never manually INSERT/UPDATE trigger tables** — Writes bypass triggers and create inconsistency. The triggers are the source of truth.

3. **Verify triggers are enabled** — If aggregates look stale:
   ```sql
   SELECT tgname, tgenabled FROM pg_trigger
   WHERE tgrelid = 'transactions'::regclass
   AND NOT tgisinternal;
   ```

4. **Test trigger firing in DB-backed tests** — Use the `hasTestDatabase()` gate:
   ```js
   import { hasTestDatabase, getTestPool } from './setup/db.js';
   
   describe.skipIf(!hasTestDatabase())('trigger-maintained tables', () => {
     it('syncs agg_recipient_totals on insert', async () => {
       const pool = getTestPool();
       // Insert transaction, verify agg_recipient_totals updated
     });
   });
   ```

---

## Safe CSV Export Pattern (Phase 5+)

**Source:** [[apps/node-backend/src/lib/csv.js|csv.js]] — Shared utility with formula injection guard
**Used in:** [[apps/node-backend/src/routes/transactions.js|transactions.js]], [[apps/node-backend/src/routes/splits.js|splits.js]]

CSV exports must escape field values to prevent formula injection (CWE-1236). A centralized utility ensures all exports are protected.

### Safety Requirement: Formula Injection Prevention

Excel and Google Sheets auto-execute leading `=`, `+`, `-`, or `@` as formulas. Example attack:

```
Cell value: =cmd|'/c powershell IEX(New-Object Net.WebClient).DownloadString(...)'
Result: Arbitrary code execution when file is opened
```

**Solution:** Prefix dangerous leading characters with a single quote (`'`). The spreadsheet renders as literal text.

### Shared Implementation

```js
// apps/node-backend/src/lib/csv.js
const DANGEROUS_CSV_FORMULA_PREFIXES = new Set(['=', '+', '-', '@']);

export function neutralizeCsvFormula(value) {
  if (!value) return value;
  const trimmedStart = value.trimStart();
  if (!trimmedStart) return value;
  const firstChar = trimmedStart.charAt(0);
  if (!DANGEROUS_CSV_FORMULA_PREFIXES.has(firstChar)) return value;
  return `'${value}`;  // Prefix dangerous char with '
}

export function escapeCsvValue(value) {
  if (value == null) return '';
  const stringValue = neutralizeCsvFormula(String(value));
  return stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}
```

### Usage in Routes

Import the utility and use it to escape all user-controllable fields before CSV serialization:

```js
import { escapeCsvValue } from '../lib/csv.js';

function buildTransactionCsvRow(row, { includeBalance = false } = {}) {
  const cols = [row.date, row.bank_account, row.recipient_name, row.memo,
                row.amount, row.currency, row.balance, row.category_name, row.comment];
  if (includeBalance) cols.push(row.running_balance);
  return cols.map(escapeCsvValue).join(',');  // ← All fields escaped
}
```

### Streaming Large Exports

For large datasets, stream in fixed-size chunks to keep memory bounded:

```js
const CSV_EXPORT_CHUNK_SIZE = 1000;

router.get('/export/csv', rateLimiter(...), async (req, res) => {
  try {
    // Build filter clauses (dynamic WHERE with parameterized queries)
    const filterClauses = ['t.is_active = true'];
    const params = [];
    let paramIdx = 1;
    // ... add date, category, bank_account filters with params.push() ...

    // Probe for empty results before streaming
    const probe = await dbQuery(
      `SELECT 1 FROM transactions t WHERE ${filterClauses.join(' AND ')} LIMIT 1`,
      params
    );
    if (probe.rows.length === 0) {
      return res.status(404).json({ detail: 'No transactions found' });
    }

    // Set response headers
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=transactions_export_${new Date().toISOString().slice(0, 19)}.csv`);

    // Write CSV header
    res.write('Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment\n');

    // Stream in chunks to bound memory
    let offset = 0;
    while (true) {
      const chunkSql = `
        SELECT t.id, t.date, t.bank_account, 
               COALESCE(pr.name, r.name) AS recipient_name,
               t.memo, t.amount, t.currency, t.balance,
               CASE WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail ELSE '' END AS category_name,
               t.comment
        FROM transactions t
        LEFT JOIN recipients r ON t.recipient_id = r.id
        LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE ${filterClauses.join(' AND ')}
        ORDER BY t.date ASC, t.id ASC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `;
      
      const chunk = await dbQuery(chunkSql, [...params, CSV_EXPORT_CHUNK_SIZE, offset]);
      if (chunk.rows.length === 0) break;

      const lines = chunk.rows.map(row => buildTransactionCsvRow(row));
      res.write(lines.join('\n') + '\n');
      
      if (chunk.rows.length < CSV_EXPORT_CHUNK_SIZE) break;
      offset += CSV_EXPORT_CHUNK_SIZE;
    }

    res.end();
  } catch (err) {
    logger.error('Error exporting', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Error exporting' } });
    } else {
      res.end();  // Headers already sent, close gracefully
    }
  }
});
```

### Key Points

| Pattern | Rule |
|---------|------|
| **Escaping** | **All fields must use `escapeCsvValue()`** to prevent CWE-1236 formula injection |
| **Chunk size** | 1000–5000 rows per chunk depending on row width; tuned to balance memory + latency |
| **Stable sort** | `ORDER BY date ASC, id ASC` ensures no gaps or duplicate rows across chunks |
| **Probe first** | Check for empty results before streaming headers (early 404 return) |
| **Error recovery** | If headers sent, close gracefully (`res.end()`); otherwise return JSON error |
| **Rate limiting** | Apply per-route limiter to protect DB from concurrent bulk exports |

---

## Import Batch Concurrency Pattern (Phase 1, Phase 3.1, Phase C)

**Source:** [[apps/node-backend/src/services/importPipeline/index.js|importPipeline/index.js]], [[apps/node-backend/src/services/importPipeline/validate.js|validate.js]], [[apps/node-backend/src/services/importPipeline/commit.js|commit.js]]

> [!info] Phase C Refactor
> Import batch concurrency was consolidated into the unified `importPipeline` orchestrator (Phase C, April 2026). The pattern remains unchanged; the three legacy services are deprecated.

For bulk CSV imports, rows are processed in adaptive concurrent batches to balance throughput against database pool constraints. Concurrency is derived from the pool configuration, not hardcoded, to remain safe across different deployment pool sizes.

### Pattern

```js
// At module scope (import time, not per-request)
// Derive from DB pool config: ensure at least half the pool remains available for other requests
const _poolMax = Math.max(
  parseInt(process.env.DB_POOL_SIZE, 10) || 5,      // Default: 5
  parseInt(process.env.DB_MAX_OVERFLOW, 10) || 10,  // Default: 10
);
const IMPORT_BATCH_SIZE = Math.max(2, Math.floor(_poolMax / 2));
// With stock settings (poolMax=10): IMPORT_BATCH_SIZE=5
// With custom pool (poolMax=50): IMPORT_BATCH_SIZE=25

// In import processing loop
for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
  const batch = rows.slice(i, i + IMPORT_BATCH_SIZE);
  
  // Process batch rows in parallel (up to IMPORT_BATCH_SIZE concurrent queries)
  const settled = await Promise.allSettled(
    batch.map(async (row) => {
      // Dedup check
      const isDup = await isDuplicateByFields(row.date, row.amount, row.recipient, row.memo);
      if (isDup) return { dup: true };
      
      // Recipient upsert (single round-trip via INSERT ... ON CONFLICT)
      const recipientId = await getOrCreateRecipient(row.recipient, row.account, row.address, row.bank);
      
      return { dup: false, row: [row.date, row.amount, recipientId, ...] };
    })
  );
  
  // Aggregate results
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      results.errors++;
    } else if (outcome.value.dup) {
      results.duplicates++;
    } else {
      results.imported++;
      pendingInserts.push(outcome.value.row);
    }
  }
}
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Compute concurrency from pool ceiling | Adapts to deployment config (local dev vs. production) |
| Use `Math.max(2, Math.floor(poolMax / 2))` | Always keep ≥50% of pool for other requests |
| Read env vars at module init | Avoid per-request resolution overhead |
| Default: 5 (for poolMax=10) | Safe for single-user self-hosted deployments |
| Use `Promise.allSettled()` per batch | One bad row doesn't stall the entire batch |
| Preserve insertion order | `pendingInserts` array maintains order across batches |

### When to Use

- **Large CSV imports** (100+ rows) — batching prevents connection pool exhaustion
- **Streaming imports** — backpressure from concurrent batch processing limits memory growth
- **Multi-bank imports** — handles raw data preservation and dedup across multiple tables

### Configuration

```bash
# Stock settings (recommended for local/small deployments)
DB_POOL_SIZE=5           # Min pool size
DB_MAX_OVERFLOW=10       # Max overflow; total poolMax=10
# Result: IMPORT_BATCH_SIZE = Math.max(2, floor(10/2)) = 5

# Production (larger pool)
DB_POOL_SIZE=20
DB_MAX_OVERFLOW=30       # poolMax=30
# Result: IMPORT_BATCH_SIZE = 15 (up to 15 concurrent dedup/recipient checks)
```

---

## SSE Backpressure Pattern (Phase 3.2)

**Source:** [[apps/node-backend/src/lib/sse.js|sse.js]], [[apps/node-backend/src/routes/ai.js|ai.js]], [[apps/node-backend/src/routes/importRoutes.js|importRoutes.js]]

For long-running streaming responses (AI chat, CSV import progress), propagate TCP backpressure from the HTTP client into the server's event-generation loop to prevent unbounded write buffer growth and memory exhaustion.

### Problem

Without backpressure handling:

```js
// ❌ WRONG: Unbounded memory growth if client is slow
while (importing) {
  res.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`);
  // If the client reads slowly, Node.js TCP buffer fills up
  // Memory keeps growing as rows are processed
}
```

Node.js's `res.write()` returns `false` when the internal buffer is full (`res.writableNeedDrain === true`), signaling that the caller should pause. Ignoring this signal causes the write buffer to grow without bound, consuming all available memory.

### Solution

Create a backpressure-aware writer and `await` after each frame:

```js
import { createSseWriter } from '../lib/sse.js';

router.post('/import/csv/stream', async (req, res) => {
  const writer = createSseWriter(req, res);
  
  try {
    // Probe for data...
    
    res.setHeader('Content-Type', 'text/event-stream');
    
    // Import in batches
    for (const batch of batches) {
      for (const row of batch) {
        const { imported, duplicates, errors } = await processRow(row);
        
        // Backpressure-aware write
        await writer.write('progress', {
          imported,
          duplicates,
          errors,
          total: totalRows,
        });
        
        // Early exit if client disconnected
        if (writer.closed) return;
      }
    }
    
    await writer.write('complete', { imported, duplicates, errors });
    writer.end();
  } catch (err) {
    if (!writer.closed) {
      await writer.write('error', { detail: 'Import failed' });
    }
    writer.end();
  }
});
```

### API Reference

#### `drainIfNeeded(res)`

**Returns:** `Promise<void>`

- If `res.writableNeedDrain` is false: resolves immediately (no pause needed)
- If `res.writableNeedDrain` is true: awaits `res.once('drain', ...)` (TCP buffer full)

#### `createSseWriter(req, res)`

**Returns:** `{ closed: boolean, write(event, data): Promise<void>, end(): void }`

| Property | Purpose |
|----------|---------|
| `closed` | Getter that returns `true` if the client disconnected |
| `write(event, data)` | Async. Writes SSE frame if not closed; calls `drainIfNeeded()` after write |
| `end()` | Ends the response if not already ended |

### Implementation Details

```js
export function createSseWriter(req, res) {
  let closed = false;
  req.on('close', () => { closed = true; });

  return {
    get closed() { return closed; },

    async write(event, data) {
      if (closed) return;  // No-op if client disconnected
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      await drainIfNeeded(res);  // Pause if buffer full
    },

    end() {
      if (!res.writableEnded) res.end();
    },
  };
}
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Always use `createSseWriter` for streaming | Single source of truth for backpressure and client tracking |
| `await writer.write()` in loops | Critical: pauses production when client can't keep up |
| Check `writer.closed` between writes | Exit early if client disconnected to avoid wasted work |
| Async progress callbacks | Make import/AI callbacks `async` and `await` the `write()` result |
| Call `writer.end()` in finally | Ensures response is always closed, even on error |

### When to Use

- **Long-running SSE streams** (>1 second, >100 events)
- **CSV import with progress** — especially large files
- **AI chat streaming** — token-by-token generation
- **Any endpoint that writes multiple times before closing** — prevents memory leak

### When NOT Necessary

- **Single-shot responses** — normal `res.json()` handles backpressure automatically
- **Small fixed-size responses** — TCP buffer unlikely to fill
- **Webhook events** — if you own the client, size is known

### Testing

```js
import { test, expect } from 'vitest';
import { createSseWriter, drainIfNeeded } from '../lib/sse.js';

test('drainIfNeeded returns immediately when buffer not full', async () => {
  const res = { writableNeedDrain: false };
  const start = Date.now();
  await drainIfNeeded(res);
  expect(Date.now() - start).toBeLessThan(10);  // No pause
});

test('createSseWriter tracks client close', (done) => {
  const req = new EventEmitter();
  const res = { write: () => true, writableEnded: false };
  
  const writer = createSseWriter(req, res);
  expect(writer.closed).toBe(false);
  
  req.emit('close');
  expect(writer.closed).toBe(true);
  
  done();
});
```

---

## Atomic Transaction Pattern (Multi-Step Operations)

**Source:** [[apps/node-backend/src/services/recipientMergeService.js|recipientMergeService.js]], [[apps/node-backend/src/repositories/splitRepository.js|splitRepository.js]] (Phase 12 Bugfix Sweep)

For complex operations spanning multiple tables (e.g., merging recipients across transactions, splits, planned transactions, and bank accounts), or for race-sensitive single-table operations (e.g., recording payments against a split with overpayment risk), use explicit transaction control with row-level locking to ensure atomicity and serialize concurrent access.

### Pattern

```js
import { getClient } from '../database/connection.js';

export async function complexMultiStepOperation(primaryId, aliasIds) {
  // Validate inputs
  if (!Number.isInteger(primaryId) || !Array.isArray(aliasIds)) {
    throw new Error('Invalid inputs');
  }

  // Get a dedicated client for transaction control
  const client = await getClient();
  try {
    // Begin transaction
    await client.query('BEGIN');

    // Lock the primary row to serialize concurrent operations
    const primaryCheck = await client.query(
      `SELECT id FROM primary_table WHERE id = $1 FOR UPDATE`,
      [primaryId],
    );
    if (!primaryCheck.rows.length) {
      throw new Error('Primary not found');
    }

    // Step 1: Update first dependent table
    const step1 = await client.query(
      `UPDATE table1 SET primary_id = $1 WHERE primary_id = ANY($2)`,
      [primaryId, aliasIds],
    );

    // Step 2: Update second dependent table
    const step2 = await client.query(
      `UPDATE table2 SET primary_id = $1 WHERE primary_id = ANY($2)`,
      [primaryId, aliasIds],
    );

    // Step 3: Deduplicate via INSERT ... ON CONFLICT (race-safe)
    await client.query(
      `INSERT INTO dedup_table (primary_id, unique_field, data)
       SELECT $1, unique_field, data FROM source_table WHERE id = ANY($2)
       ON CONFLICT (primary_id, unique_field) DO NOTHING`,
      [primaryId, aliasIds],
    );

    // Step 4: Mark aliases as merged
    await client.query(
      `UPDATE primary_table SET primary_reference_id = $1 WHERE id = ANY($2)`,
      [primaryId, aliasIds],
    );

    // Commit all steps atomically
    await client.query('COMMIT');

    return { 
      primaryId, 
      mergedAliasIds: aliasIds,
      reassigned: {
        table1: step1.rowCount,
        table2: step2.rowCount,
      }
    };
  } catch (error) {
    // Rollback on any error — all partial changes discarded
    await client.query('ROLLBACK');
    throw error;
  }
}
```

### Key Conventions

| Pattern | Rule |
|---------|------|
| Explicit tx | Use `BEGIN` / `COMMIT` / `ROLLBACK` for control |
| Row locking | Lock primary row with `FOR UPDATE` before updates to serialize concurrent access |
| Dependency order | Update tables in FK dependency order (parents before children or children before parents, as FK constraints dictate) |
| Conflict dedup | Use `INSERT ... ON CONFLICT (uk_fields) DO NOTHING` for race-safe deduplication |
| Error handling | `ROLLBACK` on any error; caller receives clear error message |
| Fallback reads | After `ON CONFLICT DO NOTHING`, use `RETURNING id` or follow-up query to get the inserted-or-existing row ID |
| Validation first | Validate all inputs before `BEGIN` to fail fast |
| No nested txs | PostgreSQL does not support nested transactions (except savepoints); keep transaction boundaries explicit |

### When to Use

- Multi-step operations that must all succeed or all fail
- Operations with race conditions (e.g., deduplication during merge)
- Operations that need to serialize concurrent access (e.g., merging into the same primary)
- Operations that need to roll back partial work on error

### When NOT to Use

- Simple single-statement operations (repositories handle implicit tx)
- Pure calculation services (no DB access)
- Streaming or large-batch operations (explicit chunking may be more efficient)

---

## Motion Consumer Pattern (Phase 9)

**Source:** [[apps/frontend/src/lib/motion.ts|motion.ts]]

All Framer Motion-enabled components must check `useReducedMotion()` and conditionally apply animations to respect OS accessibility settings.

> [!note] PageTransition Removed (2026-04-17)
> The `PageTransition` component was removed as part of Electron M1 performance optimization. See [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020]] for details. Motion consumers remain relevant for modal/dialog entry animations and chart effects.

### Pattern

```tsx
import { motion } from 'framer-motion';
import { DURATION_NORMAL, SPRING_SMOOTH, useReducedMotion } from '@/lib/motion';

export function MyAnimatedComponent() {
  const prefersReduced = useReducedMotion();
  
  return (
    <motion.div
      initial={prefersReduced ? {} : { opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={prefersReduced ? {} : { opacity: 0, scale: 0.90 }}
      transition={prefersReduced ? {} : { duration: DURATION_NORMAL / 1000, ...SPRING_SMOOTH }}
    >
      {/* Content */}
    </motion.div>
  );
}
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Always check `useReducedMotion()` | Mandatory accessibility compliance for non-essential motion |
| Empty initial/exit when reduced | Simplest way to skip animations entirely (no jank from animation state) |
| Instant transition when reduced | Zero delay, zero animation time |
| Use token-based timing | Never hardcode durations; import from `motion.ts` |
| Only animate transforms/opacity | GPU-accelerated, no layout thrashing |
| Centralize motion configs | New patterns go into `motion.ts`, not scattered in components |

### Use Cases

| Pattern | Duration | Timing | When |
|---------|----------|--------|------|
| Dialog enter | 300ms | SPRING_SMOOTH | Modal overlay, form dialog |
| Dialog exit | 200ms | ease-out-cubic | Dismissal or cancel |
| Page transition | 300ms enter, 200ms exit | SPRING_BOUNCE | Route change |
| Hover elevation | 150ms | ease-out-cubic | Card, button hover state |
| Micro-interaction | 150ms | ease-out-expo | Icon action, toggle state |
| Loading pulse | 1.5s | ease-in-out | Skeleton screens (opacity only) |
| Fade in | 200-300ms | ease-out-cubic | Content appearance |

---

## Surface Shell Pattern (Phase 9)

**Source:** [[apps/frontend/src/components/ui/card.tsx|card.tsx]], [[apps/frontend/src/components/dashboard/StatCard.tsx|StatCard.tsx]], [[apps/frontend/src/components/layout/AppLayout.tsx|AppLayout.tsx]]

Standard card and surface shell for consistent material hierarchy and visual cohesion.

### Pattern

```tsx
// Standard elevated card (most common)
<div className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
  {/* Content */}
</div>

// Glass surface (dialogs, overlays)
<div className="relative overflow-hidden glass-thick rounded-lg border border-white/10">
  {/* Content */}
</div>

// Premium stat card (hero emphasis)
<div className="group relative overflow-hidden glass-regular rounded-lg border border-white/10 micro-lift">
  <div className="absolute inset-0 opacity-40 bg-gradient-to-br from-primary/20 to-transparent" />
  {/* Content */}
</div>

// Navigation chrome
<div className="glass-chrome border-r border-white/10">
  {/* Sidebar content */}
</div>
```

### Utilities Breakdown

| Utility | Purpose |
|---------|---------|
| `surface-elevated` | Elevated non-glass card background (default for most cards) |
| `premium-frame` | Elevated depth + subtle shadow (works with or without glass) |
| `micro-lift` | Hover transform: very small `translateY(-2px)` + shadow increase |
| `glass-*` | Glass variants (thin, regular, thick, chrome, elevated) |
| `group` | Parent selector for hover states affecting children |
| `overflow-hidden` | Clip rounded corners (important for glass + grain texture) |
| `backdrop-blur-sm` | Subtle blur fallback for browsers without full glass support |
| `border border-white/10` | Subtle highlight rim at 10% white opacity |

### Gradient Icon Tile Pattern (Phase 9)

**Source:** [[apps/frontend/src/pages/DashboardPage.tsx|DashboardPage.tsx]], [[apps/frontend/src/components/dashboard/StatCard.tsx|StatCard.tsx]]

Summary cards and stat tiles use a semi-transparent gradient background with an icon inside for visual interest:

```tsx
<div className="surface-elevated premium-frame micro-lift rounded-lg p-4">
  <div className="flex items-center gap-3">
    <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-emerald-400/30 via-transparent to-primary/20 flex items-center justify-center">
      <TrendingUpIcon className="h-6 w-6 text-emerald-400" />
    </div>
    <div>
      <p className="text-sm text-muted-foreground">Monthly Income</p>
      <p className="text-2xl font-semibold">€4,250</p>
    </div>
  </div>
</div>
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Always use `overflow-hidden` with rounded corners | Prevents gradient overflow; clips grain texture properly |
| Pair `surface-elevated` with `premium-frame` | Consistent depth signal across all cards |
| Use `micro-lift` on interactive containers | Hover feedback without changing layout |
| Gradient icons 12×12–16×16 max | Avoid visual clutter; icon should be supplementary |
| Mute gradient opacity (20-40%) | Ensure text contrast and readability |
| Apply in card shell, not direct wrapping | Compose surfaces from these utilities, don't mix |

---

## Zustand Store Pattern (Frontend, Phase 4)

**Source:** [[apps/frontend/src/stores/settingsStore.ts|settingsStore.ts]]

Use Zustand for client state that spans multiple pages or contexts. Vision uses Zustand to unify settings state (app settings, dashboard settings, theme) that previously required three separate React contexts.

### Pattern

```typescript
import { create } from 'zustand';

interface AppState {
  // State slices
  count: number;
  settings: Record<string, any>;

  // Actions
  increment: () => void;
  updateSettings: (updates: Partial<Record<string, any>>) => void;
}

export const useAppStore = create<AppState>((set) => ({
  count: 0,
  settings: {},

  increment: () => set((state) => ({ count: state.count + 1 })),
  updateSettings: (updates) =>
    set((state) => ({
      settings: { ...state.settings, ...updates },
    })),
}));
```

### Slice Selection with useShallow (Best Practice)

When using multiple slices in a component, use `useShallow()` to prevent re-renders when unrelated slices change:

```typescript
import { useShallow } from 'zustand/react'; // v4.5+

// AVOID: Re-renders if ANY part of state changes
const settings = useAppStore((s) => s.settings);
const count = useAppStore((s) => s.count);

// PREFER: Only re-renders if this slice changes
const slice = useAppStore(
  useShallow((s) => ({
    settings: s.settings,
    count: s.count,
  }))
);
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Store for cross-page state only | Local component state → useState; UI state → Context |
| Use `useShallow()` for multiple selections | Prevents unrelated updates from triggering re-renders |
| Actions mutate immutably | Always spread objects: `{ ...state, field: value }` |
| Split large stores into slices | Keep each store <200 LOC; use multiple stores if needed |
| Pair with Context wrappers | Zustand for state, Context Providers for side-effects (hydration, persistence) |

### When to Use

- Settings/preferences that affect multiple pages
- Theme state across the app
- User session data
- Multi-page forms with shared draft state

### When NOT to Use

- **Local UI state** — Use `useState` instead
- **Server data** — Use React Query
- **Form state** — Use `useFormState()` hook or React Hook Form

---

## Feature Flag Pattern (Deprecated)

> [!warning] Deprecated
> This pattern was removed via [[docs/adr/035-remove-feature-flags|ADR-035]]. The `feature_flags` table, backend service/repo, and admin UI were deleted in Phase 9. All features are now always enabled unconditionally.

**Removal Date:** 2026-04-24

**Historical Reference:** The pattern documented runtime-toggleable feature flags via a `feature_flags` PostgreSQL table with admin endpoints to toggle flags. In practice, no flags were ever toggled off in production; the system added maintenance surface without delivering value.

**Migration Path:** Alembic migration `0011_drop_feature_flags` drops the table while preserving the creation migration (`0002_feature_flags.py`) in the history for audit/compliance purposes.

**For New Features:** If you need to control feature availability, use environment variables or configuration instead of database-backed toggles. See [[docs/adr/035-remove-feature-flags|ADR-035]] for rationale.

---

## Related

- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Aggregation Strategy]]
- [[docs/adr/014-atomic-merge-transactional-safety|ADR-014: Atomic Merge Transactional Safety]]
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/018-visx-d3-chart-migration|ADR-018: visx/d3 Chart Migration]]
- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]]
- [[docs/performance/materialized-views|Materialized Views & Aggregation]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/guides/how-to-add-api-endpoint|How to Add an API Endpoint]]
- [[docs/guides/how-to-add-react-component|How to Add a React Component]]
- [[docs/guides/how-to-add-new-page|How to Add a New Page]]
- [[docs/reference/react-query-keys|React Query Keys Reference]]
- [[docs/reference/error-codes|Error Codes Reference]]
