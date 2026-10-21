---
title: How to Add a New API Endpoint
type: guide
status: active
date: 2026-10-20
updated: 2026-10-20
tags: [guide, api, how-to, backend, tutorial]
description: Step-by-step guide for adding a new REST API endpoint to the Vision backend
aliases: [add api, new endpoint, create endpoint, api tutorial]
related_code:
  [
    "apps/node-backend/src/routes/",
    "apps/node-backend/src/repositories/",
    "apps/node-backend/src/main.ts",
  ]
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

Create `apps/node-backend/src/routes/<resource>.ts`. Routes are thin: they parse/validate the request, delegate to the **service** (never the repository — the `vision-local/no-repo-direct-from-route` ESLint gate enforces this, [[docs/adr/067-enforce-route-service-boundary|ADR-067]]), and reply with the `res.ok()` envelope ([[docs/adr/026-unified-api-response-envelope|ADR-026]]). Parse `req.params`, `req.query` and `req.body` with zod schemas through `parseInput` ([[docs/adr/193-zod-runtime-contracts|ADR-193]]) and throw the typed errors from `middleware/errorHandler.ts` instead of hand-rolling `res.status(...).json(...)` — the central error handler turns them into the `{ ok:false, error:{ code, message } }` envelope. See `routes/tags.ts` for a live reference.

`parseInput(schema, value)` (`lib/zodInput.ts`) throws `ValidationError` when the schema fails,
so a bad request is a 400 `VALIDATION_ERROR` with the issues joined as `path: message`. Reuse the
shared fields in `routes/_requestSchemas.ts`: `idParams` for `/:id`, `idSchema()` for a named
sub-resource id, `pageFields`, `booleanQuery()`, `clampedIntQuery()`, `singleQueryString` and
`requiredString`. Declare every field that may be absent as `.optional()`. See
[[docs/reference/code-patterns#Request validation with parseInput (ADR-193)|Request validation]].

```typescript
import { Router } from 'express';
import { z } from 'zod';
import <resource>Service from '../services/<resource>Service.ts';
import { parsePagination } from '../lib/pagination.ts';
import { parseInput } from '../lib/zodInput.ts';
import { idParams, pageFields, requiredString } from './_requestSchemas.ts';

const router = Router();

const listQuery = z
  .object({ ...pageFields })
  .transform((page) => parsePagination(page, { maxLimit: 1000 }));
const createBody = z.object({ name: requiredString });
const updateBody = z.object({ name: z.string().optional() });

// GET /api/<resource>
router.get('/', async (req, res) => {
  const { limit, offset } = parseInput(listQuery, req.query);
  const { items, total } = await <resource>Service.list({ limit, offset });
  res.ok({ items, total, limit, offset, links: [] });
});

// POST /api/<resource>
router.post('/', async (req, res) => {
  const item = await <resource>Service.create(parseInput(createBody, req.body));
  res.status(201);
  res.ok({ ...item, links: [] });
});

// GET /api/<resource>/:id
router.get('/:id', async (req, res) => {
  const { id } = parseInput(idParams, req.params);
  const item = await <resource>Service.get(id); // throws NotFoundError if absent
  res.ok({ ...item, links: [] });
});

// PATCH /api/<resource>/:id
router.patch('/:id', async (req, res) => {
  const { id } = parseInput(idParams, req.params);
  const item = await <resource>Service.update(id, parseInput(updateBody, req.body));
  res.ok({ ...item, links: [] });
});

// DELETE /api/<resource>/:id
router.delete('/:id', async (req, res) => {
  const { id } = parseInput(idParams, req.params);
  await <resource>Service.remove(id); // throws NotFoundError if absent
  res.status(204).end();
});

export default router;
```

> [!tip] Rate limiting
> Don't add a per-router `rateLimit(...)` unless the resource needs a tighter budget than the global `/api` limiter already applied in `main.ts`. When it does, pass the limiter as middleware to `mountRouter` (see the `aggregations`/`admin` mounts) rather than `router.use(...)`.

### 3. Register the Route

Add to `apps/node-backend/src/main.ts`, using `mountRouter` (which also registers the route in the manifest) — not a bare `app.use`:

```typescript
import <resource>Router from './routes/<resource>.ts';

// ...alongside the other mounts near main.ts:254+
mountRouter(app, '/api/<resource>', <resource>Router);
```

### 4. Create the Service and Repository

**Service** — the ADR-067 seam where validation and orchestration live. Create `apps/node-backend/src/services/<resource>Service.ts`:

```typescript
import <resource>Repository from '../repositories/<resource>Repository.ts';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.ts';

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

**Repository** — queries are built with Kysely through `db` from `database/db.ts`, not SQL strings
([[docs/adr/226-kysely-query-builder|ADR-226]]). The driver runs every compiled query through
`query()` in `database/connection.ts`, so it joins the ambient `withTransaction()` transaction.
`checkedRows(schema, builder)` and `checkedRow(...)` check the returned rows against a row schema
([[docs/adr/193-zod-runtime-contracts|ADR-193]]). Analytical SQL that the builder would make harder
to read uses Kysely's `sql` tag with bound parameters. Create
`apps/node-backend/src/repositories/<resource>Repository.ts` (see `repositories/tagRepository.ts`
for a live reference):

```typescript
import { sql } from 'kysely';
import { checkedRow, checkedRows, db } from '../database/db.ts';
import { countRowSchema } from '../database/rowSchemas.ts';
import { <resource>RowSchema } from '../database/rows/<area>.ts';
import type { <Resource>Id } from '@vision/types/brands';

const <resource>Repository = {
  async getAllWithCount({ limit = 50, offset = 0 }) {
    const items = await checkedRows(
      <resource>RowSchema,
      db.selectFrom('<resource>').selectAll().orderBy('id').limit(limit).offset(offset),
    );
    const count = await checkedRow(
      countRowSchema,
      db.selectFrom('<resource>').select(sql<string>`COUNT(*)`.as('count')),
    );
    return { items, total: Number(count?.count ?? 0) };
  },

  getById(id: <Resource>Id) {
    return checkedRow(
      <resource>RowSchema,
      db.selectFrom('<resource>').selectAll().where('id', '=', id),
    );
  },

  create(data: { name: string }) {
    return checkedRow(
      <resource>RowSchema,
      db.insertInto('<resource>').values({ name: data.name }).returningAll(),
    );
  },

  update(id: <Resource>Id, data: { name?: string }) {
    return checkedRow(
      <resource>RowSchema,
      db
        .updateTable('<resource>')
        .set({ ...data, updated_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .returningAll(),
    );
  },

  async hardDelete(id: <Resource>Id) {
    const result = await db.deleteFrom('<resource>').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  },
};

export default <resource>Repository;
```

> [!tip] Row contracts and generated types
> The table must exist in `database/schema.generated.ts` (run `bun run db:codegen` after the
> migration in step 5) before the builder accepts it. Add the row schema to the area module
> `database/rows/<area>.ts` (built from the `pg*` primitives in `database/rowSchemas.ts`) and export
> the row type as `z.output<typeof schema>` next to it. Brand the new id
> ([[docs/adr/220-branded-ids-currency-codes-and-money|ADR-220]]) and add its override line to
> `apps/node-backend/.kysely-codegenrc.json`. See
> [[docs/reference/code-patterns#Row contracts for new queries (ADR-193)|Row contracts]].

### 5. Create the Database Migration

```bash
bun run db:new -- add_<resource>_table
```

Write plain SQL in the new `db/migrations/NNNN_add_<resource>_table.sql` (it runs inside the
migrator's transaction, so no `BEGIN`/`COMMIT`):

```sql
CREATE TABLE "<resource>" (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Add `NNNN_add_<resource>_table.down.sql` with `DROP TABLE "<resource>";`, then run
`bun run db:migrate`, `bun run db:codegen` and `bun run db:lint`. The backup is a whole-database
`pg_dump`, so a new table needs no backup registration. See
[[docs/guides/migrations|Database Migration Guide]].

### 6. Add Tests

Create `apps/node-backend/tests/<resource>.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
import { routeAgent } from "./helpers/routeApp.ts";

vi.mock("../src/database/connection.ts", () => mockConnection());

import { query } from "../src/database/connection.ts";
const { default: router } = await import("../src/routes/<resource>.ts");

// Mounts the router behind the same middleware and error handler as main.ts,
// without booting the server (importing main.ts starts it).
const api = routeAgent(router, { mountPath: "/api/<resource>" });

describe("<resource> API", () => {
  it("GET /api/<resource> returns an empty list", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await api.get("/api/<resource>");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
```

### 7. Update the Contract and Documentation

The endpoint is not "done" until the API contract and the generated frontend types agree with it:

1. Add the operation(s) to `openapi.yaml` — it is the authoritative spec, and `scripts/check-endpoint-matrix.ts` gates the count in CI.
2. Run `bun run generate:types` to regenerate `apps/frontend/src/types/generated.ts` from `openapi.yaml` ([[docs/adr/031-openapi-type-generation-frontend|ADR-031]]).
3. Add the row(s) to [[docs/reference/api-endpoint-matrix|api-endpoint-matrix.md]] (and bump its `api_operation_count`).
4. Create `docs/api/<resource>.md` following the pattern in [[docs/api/transactions\|Transactions API]], and add it to [[docs/api/index\|API Index]].
5. Update the data-model reference if you added a table, and the [[docs/architecture/backend-architecture\|Backend Architecture]] diagram if significant.
6. If the frontend calls the endpoint, add a wire schema to the area module in `packages/types/src/contracts/` and pass it as the `schema` option of `apiRequest` or `requestWithQuery`, for reads and for saves whose result the UI uses ([[docs/reference/frontend-api-client#Response contracts\|Response contracts]]).

## Checklist

- [ ] Route file created (thin — parses input with `parseInput`, delegates to the service, uses `res.ok()`, throws typed errors)
- [ ] Service module created (ADR-067 seam; validation + orchestration)
- [ ] Repository created (Kysely builder through `db`; rows read through `checkedRows`/`checkedRow` with a schema in `database/rows/<area>.ts`)
- [ ] Route registered in `main.ts` via `mountRouter`
- [ ] Database migration created and tested
- [ ] Tests written for all endpoints
- [ ] `openapi.yaml` updated **and** `bun run generate:types` run
- [ ] `docs/reference/api-endpoint-matrix.md` row + count updated
- [ ] `docs/api/<resource>.md` created and API index updated
- [ ] Frontend client checks the response with a schema from `@vision/types/contracts`
- [ ] Frontmatter includes `type`, `tags`, `description`, `related_code`

## Related

- [[docs/api/transactions\|Transactions API]] - Reference implementation
- [[docs/api/index\|API Index]] - All endpoints
- [[docs/guides/migrations\|Migration Guide]] - Database migrations
- [[docs/testing/testing\|Testing Guide]] - Testing patterns
- [[docs/architecture/backend-architecture\|Backend Architecture]] - Architecture overview
