---
title: How to Add a New API Endpoint
type: guide
status: active
date: 2026-03-31
tags: [guide, api, how-to, backend, tutorial]
description: Step-by-step guide for adding a new REST API endpoint to the Vision backend
aliases: [add api, new endpoint, create endpoint, api tutorial]
related_code: ["apps/node-backend/src/routes/", "apps/node-backend/src/repositories/", "apps/node-backend/src/main.js"]
---

# How to Add a New API Endpoint

> [!abstract] Overview
> This guide walks through adding a new REST API endpoint to the Vision backend. Covers route creation, repository layer, validation, testing, and documentation.

## When to Add an Endpoint

- New feature requires data access not covered by existing endpoints
- Existing endpoint needs a new operation (not just a query parameter change)
- New resource type needs CRUD operations

## Step-by-Step

### 1. Plan the Endpoint

Decide on:
- **Resource name** (e.g., `tags`, `notifications`)
- **HTTP methods** (GET, POST, PATCH, DELETE)
- **URL path** (e.g., `/api/tags`)
- **Request/response shapes**

> [!tip] Naming Convention
> Use plural, lowercase resource names: `/api/tags`, not `/api/tag` or `/api/Tags`

### 2. Create the Route File

Create `apps/node-backend/src/routes/<resource>.js`. Routes are thin: they parse/validate the request, delegate to the **service** (never the repository — the `vision-local/no-repo-direct-from-route` ESLint gate enforces this, [[docs/adr/067-enforce-route-service-boundary|ADR-067]]), and reply with the `res.ok()` envelope ([[docs/adr/026-unified-api-response-envelope|ADR-026]]). Use `validateIdParam` for `/:id` routes and throw the typed errors from `middleware/errorHandler.js` instead of hand-rolling `res.status(...).json(...)` — the central error handler turns them into the `{ ok:false, error:{ code, message } }` envelope. See `routes/tags.js` for a live reference.

```javascript
import { Router } from 'express';
import <resource>Service from '../services/<resource>Service.js';
import { validateIdParam } from '../middleware/validation.js';
import { parsePagination } from '../lib/pagination.js';

const router = Router();

// GET /api/<resource>
router.get('/', async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { maxLimit: 1000 });
  const { items, total } = await <resource>Service.list({ limit, offset });
  res.ok({ items, total, limit, offset, links: [] });
});

// POST /api/<resource>
router.post('/', async (req, res) => {
  const item = await <resource>Service.create(req.body); // throws ValidationError on bad input
  res.status(201);
  res.ok({ ...item, links: [] });
});

// GET /api/<resource>/:id
router.get('/:id', validateIdParam, async (req, res) => {
  const item = await <resource>Service.get(Number(req.params.id)); // throws NotFoundError if absent
  res.ok({ ...item, links: [] });
});

// PATCH /api/<resource>/:id
router.patch('/:id', validateIdParam, async (req, res) => {
  const item = await <resource>Service.update(Number(req.params.id), req.body);
  res.ok({ ...item, links: [] });
});

// DELETE /api/<resource>/:id
router.delete('/:id', validateIdParam, async (req, res) => {
  await <resource>Service.remove(Number(req.params.id)); // throws NotFoundError if absent
  res.status(204).end();
});

export default router;
```

> [!tip] Rate limiting
> Don't add a per-router `rateLimit(...)` unless the resource needs a tighter budget than the global `/api` limiter already applied in `main.js`. When it does, pass the limiter as middleware to `mountRouter` (see the `aggregations`/`admin` mounts) rather than `router.use(...)`.

### 3. Register the Route

Add to `apps/node-backend/src/main.js`, using `mountRouter` (which also registers the route in the manifest) — not a bare `app.use`:

```javascript
import <resource>Router from './routes/<resource>.js';

// ...alongside the other mounts near main.js:310+
mountRouter(app, '/api/<resource>', <resource>Router);
```

### 4. Create the Service and Repository

**Service** — the ADR-067 seam where validation and orchestration live. Create `apps/node-backend/src/services/<resource>Service.js`:

```javascript
import <resource>Repository from '../repositories/<resource>Repository.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

const <resource>Service = {
  list: ({ limit, offset }) => <resource>Repository.getAllWithCount({ limit, offset }),

  create(data) {
    if (typeof data?.name !== 'string' || !data.name.trim()) {
      throw new ValidationError('Missing required field: name');
    }
    return <resource>Repository.create(data);
  },

  async get(id) {
    const item = await <resource>Repository.getById(id);
    if (!item) throw new NotFoundError(`<resource> ${id} not found`);
    return item;
  },

  async update(id, data) {
    const item = await <resource>Repository.update(id, data);
    if (!item) throw new NotFoundError(`<resource> ${id} not found`);
    return item;
  },

  async remove(id) {
    const deleted = await <resource>Repository.hardDelete(id);
    if (!deleted) throw new NotFoundError(`<resource> ${id} not found`);
  },
};

export default <resource>Service;
```

**Repository** — parameterized SQL only, via the shared `query` helper (there is no `database/pool.js`; the connection module is `database/connection.js`). Create `apps/node-backend/src/repositories/<resource>Repository.js`:

```javascript
import { query } from '../database/connection.js';

const <resource>Repository = {
  async getAllWithCount({ limit = 50, offset = 0 }) {
    const { rows } = await query(
      'SELECT *, COUNT(*) OVER() AS total_count FROM <resource> ORDER BY id ASC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    const total = rows.length ? Number(rows[0].total_count) : 0;
    return { items: rows.map(({ total_count, ...r }) => r), total };
  },

  async getById(id) {
    const { rows } = await query('SELECT * FROM <resource> WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async create(data) {
    const { rows } = await query(
      'INSERT INTO <resource> (name, created_at) VALUES ($1, NOW()) RETURNING *',
      [data.name]
    );
    return rows[0];
  },

  async update(id, data) {
    const { rows } = await query(
      'UPDATE <resource> SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [data.name, id]
    );
    return rows[0] || null;
  },

  async hardDelete(id) {
    const { rowCount } = await query('DELETE FROM <resource> WHERE id = $1', [id]);
    return rowCount > 0;
  },
};

export default <resource>Repository;
```

### 5. Create the Database Migration

```bash
bun run db:revision -- "add_<resource>_table"
```

Edit the migration file in `alembic/versions/`:

```python
def upgrade():
    op.create_table(
        '<resource>',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('name', sa.Text, nullable=False),
        sa.Column('created_at', sa.DateTime, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime, server_default=sa.func.now()),
    )

def downgrade():
    op.drop_table('<resource>')
```

### 6. Add Tests

Create `apps/node-backend/tests/<resource>.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/main.js';

describe('<resource> API', () => {
  it('GET /api/<resource> returns empty list', async () => {
    const res = await request(app).get('/api/<resource>');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('POST /api/<resource> creates item', async () => {
    const res = await request(app)
      .post('/api/<resource>')
      .send({ name: 'Test' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Test');
  });
});
```

### 7. Update the Contract and Documentation

The endpoint is not "done" until the API contract and the generated frontend types agree with it:

1. Add the operation(s) to `openapi.yaml` — it is the authoritative spec, and `scripts/check-endpoint-matrix.js` gates the count in CI.
2. Run `bun run generate:types` to regenerate `apps/frontend/src/types/generated.ts` from `openapi.yaml` ([[docs/adr/031-openapi-type-generation-frontend|ADR-031]]).
3. Add the row(s) to [[docs/reference/api-endpoint-matrix|api-endpoint-matrix.md]] (and bump its `api_operation_count`).
4. Create `docs/api/<resource>.md` following the pattern in [[docs/api/transactions\|Transactions API]], and add it to [[docs/api/index\|API Index]].
5. Update the data-model reference if you added a table, and the [[docs/architecture/backend-architecture\|Backend Architecture]] diagram if significant.

## Checklist

- [ ] Route file created (thin — delegates to the service, uses `res.ok()` + `validateIdParam`, throws typed errors)
- [ ] Service module created (ADR-067 seam; validation + orchestration)
- [ ] Repository created (parameterized SQL via `query` from `database/connection.js`)
- [ ] Route registered in `main.js` via `mountRouter`
- [ ] Database migration created and tested
- [ ] Tests written for all endpoints
- [ ] `openapi.yaml` updated **and** `bun run generate:types` run
- [ ] `docs/reference/api-endpoint-matrix.md` row + count updated
- [ ] `docs/api/<resource>.md` created and API index updated
- [ ] Frontmatter includes `type`, `tags`, `description`, `related_code`

## Related

- [[docs/api/transactions\|Transactions API]] - Reference implementation
- [[docs/api/index\|API Index]] - All endpoints
- [[docs/guides/migrations\|Migration Guide]] - Database migrations
- [[docs/testing/testing\|Testing Guide]] - Testing patterns
- [[docs/architecture/backend-architecture\|Backend Architecture]] - Architecture overview
