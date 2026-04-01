---
title: Code Patterns Reference
type: reference
status: active
date: 2026-03-31
tags: [reference, patterns, conventions, code-style, backend, frontend]
description: Standard code patterns used throughout the Vision project — repositories, routes, hooks, API client, and Express setup
aliases: [code patterns, coding patterns, conventions, patterns, how to write code, repository pattern, route pattern, hook pattern]
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

1. Start PostgreSQL (unless `EXTERNAL_DATABASE=true`)
2. Wait for DB with exponential backoff (40 attempts, 50ms to 1s)
3. `initializeSchema()` — idempotent table creation
4. `app.listen()` on configured port
5. Warm caches (exchange rates, inflation) — fire-and-forget
6. Set up 12h refresh interval for external data

### Graceful Shutdown

```js
process.on('SIGINT', async () => { await closePool(); process.exit(0); });
process.on('SIGTERM', async () => { await closePool(); process.exit(0); });
```

---

## Error Handling Pattern

### Backend Error Responses

All errors follow this format:

```json
{ "detail": "Human-readable error message" }
```

| Status Code | When to Use | Example |
|-------------|-------------|---------|
| 400 | Validation error, missing fields | `{ detail: 'Missing required fields' }` |
| 404 | Resource not found | `{ detail: 'Entity 42 not found' }` |
| 409 | Conflict (duplicate) | `{ detail: 'Duplicate entry' }` |
| 429 | Rate limited | `{ detail: 'Too many requests' }` |
| 500 | Internal server error | `{ detail: 'Failed to retrieve entities' }` |

### Frontend Error Handling

```ts
try {
  const result = await apiClient.createEntity(data);
  toast.success('Created successfully');
} catch (error) {
  toast.error('Failed to create', { description: error.message });
}
```

---

## Related

- [[docs/guides/how-to-add-api-endpoint|How to Add an API Endpoint]]
- [[docs/guides/how-to-add-react-component|How to Add a React Component]]
- [[docs/guides/how-to-add-new-page|How to Add a New Page]]
- [[docs/reference/react-query-keys|React Query Keys Reference]]
- [[docs/reference/error-codes|Error Codes Reference]]
