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

Create `apps/node-backend/src/routes/<resource>.js`:

```javascript
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { <resource>Repository } from '../repositories/<resource>Repository.js';

const router = Router();

// Rate limiting
const limiter = rateLimit({ windowMs: 60_000, max: 100 });
router.use(limiter);

// GET /api/<resource>
router.get('/', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const items = await <resource>Repository.getAll({ limit, offset });
  const total = await <resource>Repository.getCount();
  res.json({ items, total, limit, offset, links: [] });
});

// POST /api/<resource>
router.post('/', async (req, res) => {
  const item = await <resource>Repository.create(req.body);
  res.status(201).json({ ...item, links: [] });
});

// GET /api/<resource>/:id
router.get('/:id', async (req, res) => {
  const item = await <resource>Repository.getById(parseInt(req.params.id, 10));
  if (!item) return res.status(404).json({ detail: 'Not found' });
  res.json({ ...item, links: [] });
});

// PATCH /api/<resource>/:id
router.patch('/:id', async (req, res) => {
  const item = await <resource>Repository.update(parseInt(req.params.id, 10), req.body);
  if (!item) return res.status(404).json({ detail: 'Not found' });
  res.json({ ...item, links: [] });
});

// DELETE /api/<resource>/:id
router.delete('/:id', async (req, res) => {
  const deleted = await <resource>Repository.hardDelete(parseInt(req.params.id, 10));
  if (!deleted) return res.status(404).json({ detail: 'Not found' });
  res.status(204).end();
});

export default router;
```

### 3. Register the Route

Add to `apps/node-backend/src/main.js`:

```javascript
import <resource>Router from './routes/<resource>.js';

// ...
app.use('/api/<resource>', <resource>Router);
```

### 4. Create the Repository

Create `apps/node-backend/src/repositories/<resource>Repository.js`:

```javascript
import { getPool } from '../database/pool.js';

export const <resource>Repository = {
  async getAll({ limit = 50, offset = 0 }) {
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT * FROM <resource> ORDER BY id ASC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    return rows;
  },

  async getCount() {
    const pool = getPool();
    const { rows } = await pool.query('SELECT COUNT(*) as count FROM <resource>');
    return parseInt(rows[0].count, 10);
  },

  async getById(id) {
    const pool = getPool();
    const { rows } = await pool.query('SELECT * FROM <resource> WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async create(data) {
    const pool = getPool();
    const { rows } = await pool.query(
      'INSERT INTO <resource> (name, created_at) VALUES ($1, NOW()) RETURNING *',
      [data.name]
    );
    return rows[0];
  },

  async update(id, data) {
    const pool = getPool();
    const { rows } = await pool.query(
      'UPDATE <resource> SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [data.name, id]
    );
    return rows[0] || null;
  },

  async hardDelete(id) {
    const pool = getPool();
    const { rowCount } = await pool.query('DELETE FROM <resource> WHERE id = $1', [id]);
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

### 7. Update Documentation

1. Create `docs/api/<resource>.md` following the pattern in [[docs/api/transactions\|Transactions API]]
2. Add to [[docs/api/index\|API Index]]
3. Update [[docs/adr/002-database-schema\|Database Schema ADR]] if new table
4. Add to [[docs/architecture/backend-architecture\|Backend Architecture]] diagram if significant

## Checklist

- [ ] Route file created with proper HTTP methods
- [ ] Route registered in `main.js`
- [ ] Repository created with all CRUD operations
- [ ] Database migration created and tested
- [ ] Tests written for all endpoints
- [ ] API documentation created
- [ ] API index updated
- [ ] Frontmatter includes `type: endpoint`, `tags`, `description`, `related_code`

## Related

- [[docs/api/transactions\|Transactions API]] - Reference implementation
- [[docs/api/index\|API Index]] - All endpoints
- [[docs/guides/migrations\|Migration Guide]] - Database migrations
- [[docs/testing/testing\|Testing Guide]] - Testing patterns
- [[docs/architecture/backend-architecture\|Backend Architecture]] - Architecture overview
