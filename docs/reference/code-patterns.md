---
title: Code Patterns Reference
type: reference
status: active
date: 2026-04-17
tags: [reference, patterns, conventions, code-style, backend, frontend, phase-0, phase-1, phase-2, phase-3, phase-5, phase-6, phase-9, motion, liquid-glass, design-system]
description: Standard code patterns used throughout the Vision project — repositories, routes, hooks, API client, Express setup, error handling, filter builders, aggregation envelopes, aggregation refresh, trigger-maintained tables, golden fixtures, database fixtures, pure calculation services, atomic multi-step transactions, streaming CSV exports, motion consumers, surface shells, and gradient icon tiles
aliases: [code patterns, coding patterns, conventions, patterns, how to write code, repository pattern, route pattern, hook pattern, error handling, filter builder, golden fixture, aggregation envelope, calculation services, motion pattern, surface shell pattern, gradient icon pattern]
---

# Code Patterns Reference

> [!abstract] Purpose
> This document captures the standard code patterns used throughout the Vision project. AI agents should follow these patterns when writing new code. Developers can use this as a quick reference.

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

## Backend Route Pattern

**Source:** [[apps/node-backend/src/routes/transactions.js|transactions.js]], [[apps/node-backend/src/routes/categories.js|categories.js]]

```js
import { Router } from 'express';
import entityRepository from '../repositories/entityRepository.js';
import { logger } from '../config/logger.js';
import { validateIdParam } from '../middleware/validation.js';

const router = Router();

// GET /api/entities — paginated list
router.get('/', async (req, res) => {
  try {
    const { limit = 50, offset = 0, ...filters } = req.query;
    const opts = {
      limit: Math.min(parseInt(limit, 10) || 50, 1000),
      offset: parseInt(offset, 10) || 0,
    };

    const [items, total] = await Promise.all([
      entityRepository.getAll(opts),
      entityRepository.getCount(opts),
    ]);

    res.json({ items, total, limit: opts.limit, offset: opts.offset, links: [] });
  } catch (err) {
    logger.error('Error retrieving entities', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve entities' });
  }
});

// GET /api/entities/:id
router.get('/:id', validateIdParam, async (req, res) => {
  try {
    const entity = await entityRepository.getById(parseInt(req.params.id, 10));
    if (!entity) return res.status(404).json({ detail: 'Entity not found' });
    res.json(entity);
  } catch (err) {
    logger.error('Error retrieving entity', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve entity' });
  }
});

// POST /api/entities
router.post('/', async (req, res) => {
  try {
    const { requiredField, ...data } = req.body;
    if (!requiredField) return res.status(400).json({ detail: 'Missing required fields' });
    const entity = await entityRepository.create(data);
    res.status(201).json(entity);
  } catch (err) {
    logger.error('Error creating entity', { error: err.message });
    res.status(500).json({ detail: 'Failed to create entity' });
  }
});

// PATCH /api/entities/:id
router.patch('/:id', validateIdParam, async (req, res) => {
  try {
    const updated = await entityRepository.update(parseInt(req.params.id, 10), req.body);
    if (!updated) return res.status(404).json({ detail: 'Entity not found' });
    res.json(updated);
  } catch (err) {
    logger.error('Error updating entity', { error: err.message });
    res.status(500).json({ detail: 'Failed to update entity' });
  }
});

// DELETE /api/entities/:id
router.delete('/:id', validateIdParam, async (req, res) => {
  try {
    const deleted = await entityRepository.hardDelete(parseInt(req.params.id, 10));
    if (!deleted) return res.status(404).json({ detail: 'Entity not found' });
    res.json({ message: 'Entity deleted', links: [] });
  } catch (err) {
    logger.error('Error deleting entity', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete entity' });
  }
});

export default router;
```

### Key Conventions

| Pattern | Rule |
|---------|------|
| Parallel fetch | `Promise.all([getAll, getCount])` for list endpoints |
| ID validation | `validateIdParam` middleware on all `/:id` routes |
| Error format | Always `{ detail: 'message' }` |
| Pagination response | `{ items, total, limit, offset, links: [] }` |
| Route ordering | Static routes (e.g., `/providers`) BEFORE `/:id` routes |
| Rate limiting | Per-route limiters for heavy endpoints |
| Export | `export default router` |

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

## Express App Setup

**Source:** [[apps/node-backend/src/main.js|main.js]]

### Middleware Stack (in order)

1. **CORS** — `settings.api.corsOrigins`, credentials enabled
2. **JSON parsing** — `express.json({ limit: '1mb' })`
3. **Security headers** — CSP, HSTS (prod), X-Frame-Options, etc.
4. **Compression** — dynamic import of `compression`
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

**Source:** [[apps/node-backend/src/middleware/errorHandler.js|errorHandler.js]]

Centralized error-handling middleware with typed error classes. Routes throw typed errors; middleware maps to HTTP responses.

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

### Frontend Error Handling

```ts
try {
  const result = await apiClient.createEntity(data);
  toast.success('Created successfully');
} catch (error) {
  toast.error('Failed to create', { description: error.message });
}
```

### Base AppError Constructor

```js
class AppError extends Error {
  constructor(message, {
    status = 500,
    code = 'APP_ERROR',
    cause,        // native Error for logging
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

**Source:** [[apps/node-backend/src/services/calculations/|services/calculations/]]

As of Phase 3, business logic for non-trivial calculations has been extracted into **pure, stateless functions** with no I/O side effects. These are hosted in `services/calculations/` and are suitable for golden-fixture testing and migration to shared utility libraries.

**Modules:**

| Module | Purpose |
|--------|---------|
| `services/calculations/loanSchedule.js` | Loan amortization schedule generation (amortizing, fixed_principal, interest_only) |
| `services/calculations/recurrence.js` | Recurring payment date calculation (daily, weekly, monthly, yearly, custom) |

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

## Aggregation Envelope Pattern (Phase 2)

**Source:** [[apps/node-backend/src/services/calculations/aggregation/_envelope.js|_envelope.js]], [[apps/node-backend/src/routes/aggregations.js|aggregations.js]]

All `/api/aggregations/*` endpoints return a standard envelope with metadata about data freshness and source.

### Envelope Structure

```js
import { buildEnvelope } from '../services/calculations/aggregation/_envelope.js';

const data = { /* calculation result */ };
const envelope = buildEnvelope(data, {
  source: 'mv',           // 'mv' | 'live'
  computedAt: new Date().toISOString()  // optional; defaults to now
});

// Returns:
// {
//   data: { /* calculation result */ },
//   meta: {
//     source: "mv" | "live",
//     computedAt: "2026-04-16T12:34:56.789Z"
//   }
// }
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

### Implementation in Routes

```js
// Route: GET /api/aggregations/monthly-summary
router.get('/monthly-summary', async (req, res) => {
  try {
    const envelope = await computeMonthlySummary({
      targetCurrency: getTargetCurrency(req),
      excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
      excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
    });
    res.json(envelope);  // Already wrapped by computeMonthlySummary
  } catch (err) {
    respondError(res, 'monthly-summary', err);
  }
});
```

### Implementation in Calculation Services

```js
// Service: computeMonthlySummary
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
    excludedRecipientIds  // 3rd positional param (Phase 2 addition)
  );

  return buildEnvelope(data, { source });
}
```

### Frontend Consumption

The UI can inspect `meta.source` to surface data freshness:

```tsx
function DashboardStatCards() {
  const { data: envelope, isLoading } = useQuery({
    queryFn: () => apiClient.getAggregationMonthlySummary({ currency: 'EUR' }),
  });

  if (!envelope) return null;

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

## Streaming CSV Export Pattern (Phase 5)

**Source:** [[apps/node-backend/src/routes/transactions.js|transactions.js]] `GET /api/transactions/export/csv`

For large exports, stream CSV in fixed-size chunks to keep memory bounded. Use a stable `ORDER BY` and accumulator-based running balance to ensure consistency across chunks.

### Implementation

```js
const CSV_EXPORT_CHUNK_SIZE = 1000;

function escapeCsvValue(value) {
  if (value == null) return '';
  // Neutralize formula prefixes
  const string = value.toString();
  if (/^[=+\-@]/.test(string.trimStart())) {
    return `"'${string.replace(/"/g, '""')}"`;
  }
  return string.includes(',') || string.includes('"') || string.includes('\n')
    ? `"${string.replace(/"/g, '""')}"`
    : string;
}

function buildTransactionCsvRow(row, { includeBalance = false } = {}) {
  const cols = [row.date, row.bank_account, row.recipient_name, row.memo,
                row.amount, row.currency, row.balance, row.category_name, row.comment];
  if (includeBalance) cols.push(row.running_balance);
  return cols.map(escapeCsvValue).join(',');
}

router.get('/export/csv', rateLimiter(...), async (req, res) => {
  try {
    const { include_balance } = req.query;
    const includeBalance = include_balance === 'true';

    // Build filter clauses (dynamic WHERE)
    const filterClauses = ['t.is_active = true'];
    const params = [];
    let paramIdx = 1;
    // ... add date, category, bank_account filters ...

    // Probe for existence before streaming
    const probe = await dbQuery(
      `SELECT 1 FROM transactions t WHERE ${filterClauses.join(' AND ')} LIMIT 1`,
      params
    );
    if (probe.rows.length === 0) {
      return res.status(404).json({ detail: 'No transactions found' });
    }

    // Set response headers
    const filename = `transactions_export_${new Date().toISOString().slice(0, 19)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

    // Write CSV header
    const header = includeBalance
      ? 'Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Running Balance'
      : 'Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment';
    res.write(header + '\n');

    // Chunked streaming with running balance
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

    let offset = 0;
    let runningBalance = 0;
    while (true) {
      const chunk = await dbQuery(chunkSql, [...params, CSV_EXPORT_CHUNK_SIZE, offset]);
      if (chunk.rows.length === 0) break;

      const lines = chunk.rows.map((row) => {
        if (includeBalance) {
          runningBalance += parseFloat(row.amount) || 0;
          return buildTransactionCsvRow({ ...row, running_balance: runningBalance }, { includeBalance });
        }
        return buildTransactionCsvRow(row);
      });

      res.write(lines.join('\n') + '\n');
      if (chunk.rows.length < CSV_EXPORT_CHUNK_SIZE) break;
      offset += CSV_EXPORT_CHUNK_SIZE;
    }

    res.end();
  } catch (err) {
    logger.error('Error exporting', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ detail: 'Error exporting' });
    } else {
      res.end();
    }
  }
});
```

### Key Points

| Pattern | Rule |
|---------|------|
| Chunk size | 1000–5000 rows per chunk depending on row width |
| Stable sort | `ORDER BY date ASC, id ASC` ensures no gaps/dupes |
| Running balance | Accumulated in JavaScript with JS number precision |
| Formula safety | Prefix cells with `'` if they start with `=`, `+`, `-`, `@` |
| Probe first | Check for empty results before streaming to return 404 with JSON |
| Error recovery | If headers sent, close gracefully; otherwise return JSON error |
| Rate limiting | Apply per-route limiter to protect DB from concurrent bulk exports |

---

## Atomic Transaction Pattern (Multi-Step Operations)

**Source:** [[apps/node-backend/src/services/recipientMergeService.js|recipientMergeService.js]]

For complex operations spanning multiple tables (e.g., merging recipients across transactions, splits, planned transactions, and bank accounts), use explicit transaction control with row-level locking to ensure atomicity and serialize concurrent access.

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
