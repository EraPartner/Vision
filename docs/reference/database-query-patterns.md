---
title: Database Query Patterns & Optimization
type: reference
status: active
date: 2026-04-21
updated: 2026-06-18
tags: [database, postgresql, queries, optimization, performance, indexes, phase-1, group-by-currency, per-currency-aggregation]
description: PostgreSQL query patterns, index strategies, and optimization techniques used throughout Vision. June 2026 adds multi-currency GROUP BY aggregation pattern.
aliases: [db optimization, query patterns, postgresql performance, indexing strategy]
related_code: ["apps/node-backend/src/repositories/", "apps/node-backend/src/database/", "alembic/versions/"]
---

# Database Query Patterns & Optimization

> [!abstract] Purpose
> This document catalogs the PostgreSQL query patterns, index strategies, and optimization techniques used throughout Vision. Designed for **developers** writing new queries, **DBAs** tuning performance, and **computer scientists** studying database design patterns.

---

## Connection Architecture

**File:** [[apps/node-backend/src/database/connection.js]]

```
┌─────────────────────────────────────────────┐
│              Connection Pool                 │
│  pg.Pool with configurable max connections   │
│  Environment: PGHOST, PGPORT, PGUSER, etc.  │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│         Schema Initialization                │
│  alembic/versions/0001_initial_database...  │
│  - Indexes, triggers, DDL via migrations     │
│  - Idempotent (safe to run multiple times)   │
└─────────────────────────────────────────────┘
```

### Connection Pool Configuration

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `max` | 20 | Maximum pool size |
| `idleTimeoutMillis` | 30000 | Close idle connections after 30s |
| `connectionTimeoutMillis` | 2000 | Fail fast if no connection available |

---

## Query Patterns

### Pattern 1: Parameterized SELECT with Pagination

**Used in:** All `getAll()` repository methods

```sql
SELECT * FROM transactions
WHERE ($1::int IS NULL OR id = $1)
  AND ($2::text IS NULL OR transaction_date >= $2::date)
  AND ($3::text IS NULL OR transaction_date <= $3::date)
  AND ($4::text IS NULL OR bank_account = $4)
  AND ($5::int IS NULL OR category_id = $5)
ORDER BY transaction_date DESC
LIMIT $6 OFFSET $7
```

**Key technique:** `$X::type IS NULL OR column = $X` allows optional filters without dynamic SQL construction.

### Pattern 2: Optimistic Upsert

**Used in:** Recipient resolution during import

```sql
INSERT INTO recipients (name, normalized_name)
VALUES ($1, $2)
ON CONFLICT (normalized_name) DO NOTHING
RETURNING id
```

**Benefit:** Reduces recipient lookups from 2-4 round-trips to 1-2. If conflict occurs, a follow-up SELECT retrieves the existing ID.

### Pattern 3: Batch Insert

**Used in:** Transaction import (250 rows per statement)

```sql
INSERT INTO transactions (date, amount, recipient_id, category_id, memo)
VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10), ...
```

**Benefit:** Reduces round-trips from N to 1 for bulk operations.

### Pattern 4: CTE (Common Table Expression) for Aggregation

**Used in:** Materialized views, statistics

```sql
WITH monthly_data AS (
    SELECT
        date_trunc('month', transaction_date) AS month,
        SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income
    FROM transactions
    GROUP BY date_trunc('month', transaction_date)
)
SELECT * FROM monthly_data ORDER BY month DESC
```

### Pattern 5: Window Functions

**Used in:** Running totals, rankings

```sql
SELECT
    transaction_date,
    amount,
    SUM(amount) OVER (ORDER BY transaction_date) AS running_total,
    ROW_NUMBER() OVER (PARTITION BY recipient_id ORDER BY transaction_date DESC) AS rn
FROM transactions
```

### Pattern 6: JSONB Operations

**Used in:** Settings storage, flexible metadata

```sql
-- Store settings as JSONB
INSERT INTO settings (key, value)
VALUES ($1, $2::jsonb)
ON CONFLICT (key) DO UPDATE SET value = $2::jsonb

-- Query JSONB settings
SELECT value->>'defaultCurrency' FROM settings WHERE key = 'app_settings'
```

---

## Index Strategy

### Core Indexes

| Table | Index | Type | Purpose |
|-------|-------|------|---------|
| `transactions` | `(transaction_date DESC)` | B-tree | Date-range queries, sorting |
| `transactions` | `(recipient_id)` | B-tree | Recipient filtering |
| `transactions` | `(category_id)` | B-tree | Category filtering |
| `transactions` | `(bank_account)` | B-tree | Bank account filtering |
| `recipients` | `(normalized_name)` | B-tree (UNIQUE) | Deduplication, fast lookup |
| `categories` | `(general, detail)` | B-tree (UNIQUE) | Category uniqueness |
| `planned_transactions` | `(next_due_date)` | B-tree | Upcoming payment queries |
| `investments` | `(asset_class)` | B-tree | Asset class filtering |
| `asset_price_history` | `(investment_id, timestamp)` | B-tree | Price history lookups |
| `portfolio_performance_snapshots` | `(snapshot_date)` | B-tree (UNIQUE) | Daily snapshot lookup |

### Composite Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| `transactions` | `(transaction_date, category_id)` | Filtered date range queries |
| `transactions` | `(transaction_date, recipient_id)` | Recipient history queries |
| `asset_price_history` | `(investment_id, timestamp DESC)` | Latest price per investment |

### Materialized View Indexes

| View | Index | Purpose |
|------|-------|---------|
| `mv_monthly_summary` | `(month)` (UNIQUE) | Enables CONCURRENTLY refresh |
| `mv_category_totals` | `(category_id, month)` (UNIQUE) | Enables CONCURRENTLY refresh |
| `mv_daily_cashflow` | `(date)` (UNIQUE) | Enables CONCURRENTLY refresh |
| `mv_bank_balances` | `(bank_account)` (UNIQUE) | Enables CONCURRENTLY refresh |

---

## Table Inheritance

**Migration:** [[alembic/versions/0013_investment_inheritance.py]]

```
investments_base (parent table)
├── investments (view — compatibility layer)
├── stocks_investments
├── crypto_investments
├── real_estate_investments
├── savings_investments
├── bonds_investments
└── metals_investments
```

**Benefits:**
- Each child table has only relevant columns
- Queries against parent see all investments
- Child-specific queries are faster (smaller tables)

**See:** [[docs/adr/004-postgresql-table-inheritance|ADR-004: PostgreSQL Table Inheritance]]

---

## Materialized Views

**Service:** [[apps/node-backend/src/services/materializedViewService.js]]

| View | Query Complexity | Refresh Strategy |
|------|-----------------|-----------------|
| Monthly Summary | Aggregation across all transactions | CONCURRENTLY, debounced 1s |
| Category Totals | GROUP BY category + month | CONCURRENTLY, debounced 1s |
| Daily Cashflow | Day-level income vs expense | CONCURRENTLY, debounced 1s |
| Bank Balances | Per-account balance calculation | CONCURRENTLY, debounced 1s |

**Call Coalescing:**
```
refreshMaterializedViews() called
    ├── refreshInFlight = true
    ├── Refresh all views CONCURRENTLY
    ├── refreshInFlight = false
    └── If refreshQueued = true, schedule deferred refresh
```

**See:** [[docs/adr/005-materialized-views|ADR-005: Materialized Views for Dashboard]]

---

## Database Triggers

**Reference:** [[docs/reference/database-triggers|Database Triggers Reference]]

| Trigger | Table | Event | Purpose |
|---------|-------|-------|---------|
| `update_investments_view` | `investments` (view) | INSTEAD OF INSERT/UPDATE/DELETE | Routes writes to correct child table |
| `refresh_materialized_views` | `transactions` | AFTER INSERT/UPDATE/DELETE | Schedules debounced view refresh |

---

## Query Optimization Techniques

### 1. Avoiding N+1 Queries

**Problem:** Fetching transactions, then looping to fetch recipient names.

**Solution:** Use JOINs or batch IN queries:

```sql
-- Instead of N queries, use one JOIN
SELECT t.*, r.name AS recipient_name, c.general, c.detail
FROM transactions t
LEFT JOIN recipients r ON t.recipient_id = r.id
LEFT JOIN categories c ON t.category_id = c.id
WHERE t.transaction_date BETWEEN $1 AND $2
```

### 2. Efficient Pagination

**Pattern:** Keyset pagination for large datasets

```sql
-- Offset pagination (current — simple but slow for deep pages)
LIMIT $1 OFFSET $2

-- Keyset pagination (recommended for large datasets)
WHERE id < $1 ORDER BY id DESC LIMIT $2
```

### 3. Index-Only Scans

**Technique:** Include all queried columns in the index

```sql
-- Index covers both filter and SELECT columns
CREATE INDEX idx_txn_date_amount ON transactions(transaction_date, amount)

-- Query can use index-only scan (no table lookup)
SELECT amount FROM transactions WHERE transaction_date BETWEEN $1 AND $2
```

### 4. Partial Indexes

**Technique:** Index only active records

```sql
CREATE INDEX idx_active_recipients ON recipients(id, name) WHERE is_active = true
```

### 5. Expression Indexes

**Technique:** Index on computed values

```sql
-- Index on normalized recipient name for case-insensitive matching
CREATE INDEX idx_recipients_normalized ON recipients(LOWER(normalized_name))
```

---

## Migration Patterns

**Reference:** [[docs/guides/migrations|Migration Guide]]

### Safe Migration Checklist

1. **Non-destructive first** — Add columns, never drop in the same migration
2. **Backfill data** — Populate new columns with defaults
3. **Update application code** — Deploy code that reads/writes new columns
4. **Drop old columns** — In a separate migration (next deployment cycle)

### Example: Adding a Column

```python
def upgrade():
    op.add_column('transactions', sa.Column('memo', sa.Text(), nullable=True))

def downgrade():
    op.drop_column('transactions', 'memo')
```

---

## Performance Benchmarks

| Operation | Typical Time | Notes |
|-----------|-------------|-------|
| Single transaction INSERT | < 5ms | Parameterized query |
| Batch INSERT (250 rows) | 10-50ms | Single statement |
| Transaction list (paginated, 50 rows) | 5-20ms | With indexes |
| Materialized view refresh | 100-500ms | Depends on transaction count |
| Recipient resolution (normalized match) | < 2ms | Index on normalized_name |
| Price history lookup | 1-10ms | Index on (investment_id, timestamp) |

---

## Multi-Currency GROUP BY Aggregation Pattern (June 2026)

When summarizing data that spans multiple currencies, push the aggregation fully into SQL rather than fetching all rows and summing in JavaScript. The canonical example is `getTransactionSummary` in `infoRepositoryStatistics.js`:

```sql
SELECT
  currency,
  COUNT(*)                                            AS transaction_count,
  SUM(CASE WHEN amount >= 0 THEN amount ELSE 0 END)  AS total_income,
  SUM(CASE WHEN amount < 0  THEN amount ELSE 0 END)  AS total_spending,
  MIN(date)                                           AS first_date,
  MAX(date)                                           AS last_date
FROM transactions
WHERE <filters>
GROUP BY currency
```

The route/service layer then receives one row per currency and combines them in JS (applying FX conversion). This eliminates N+1 per-currency queries and reduces the result set from O(transactions) to O(currencies).

The same pattern is applied in `infoRepo.monthly.js` for the all-time live path: aggregates `(date, currency)` pairs in SQL with sign-split sums, converts at per-date historical FX rates, then buckets into months in JavaScript.

> [!info] Validation status (June 2026)
> These rewrites are present in the codebase but validation against a live multi-currency database is still pending (tracked in `TODO.md`). Verify on a dataset with non-EUR transactions before treating aggregate numbers as confirmed correct.

## Constraint and Index Conventions (June 2026)

### Currency Integrity (migration 0046)

`transactions.currency` and `planned_transactions.currency` are now:
- `NOT NULL` (backed by backfill — NULL rows set to `'EUR'`)
- `DEFAULT 'EUR'`
- `CHECK (currency ~ '^[A-Z]{3}$') NOT VALID` — enforced for new/updated rows; legacy rows may be validated retroactively with `VALIDATE CONSTRAINT` in a follow-up

Any INSERT path that previously wrote explicit NULL must now write `'EUR'`. See [[docs/adr/086-currency-integrity|ADR-086]].

> [!warning] AUTHORED, NOT YET APPLIED
> Migration `0046_currency_integrity.py` is authored and pending user review/apply.

### One Primary Bank Account Per Recipient (migration 0047)

`recipient_bank_accounts` now has a partial unique index:

```sql
CREATE UNIQUE INDEX uq_recipient_primary_account
    ON recipient_bank_accounts (recipient_id)
 WHERE is_primary
```

This moves the "at most one primary per recipient" invariant from application code into the database. Pre-existing duplicates were demoted (lowest `id` wins) before the index was built.

> [!warning] AUTHORED, NOT YET APPLIED
> Migration `0047_one_primary_bank_account_per_recipient.py` is authored and pending user review/apply.

### Category FK ON DELETE SET NULL (migration 0048)

The three FKs from `transactions.category_id`, `recipients.default_category_id`, and `planned_transactions.category_id` to `categories(id)` are now `ON DELETE SET NULL`. Previously they had the implicit `NO ACTION` (RESTRICT) behavior, so deleting an in-use category surfaced as a raw 500. After this migration, deleting a category un-categorizes the affected rows rather than blocking the delete.

FKs that protect financial history (e.g. `transactions.recipient_id`) are deliberately left as RESTRICT.

> [!warning] AUTHORED, NOT YET APPLIED
> Migration `0048_category_fk_on_delete_set_null.py` is authored and pending user review/apply.

---

## Anti-Patterns to Avoid

| Anti-Pattern | Why Bad | Solution |
|-------------|---------|----------|
| Dynamic SQL without parameters | SQL injection risk | Always use `$1, $2` parameters |
| SELECT * in application code | Breaks on schema change | Explicit column lists |
| Missing WHERE clause on UPDATE/DELETE | Accidental data loss | Always include WHERE |
| Unbounded queries | Memory exhaustion | Always use LIMIT |
| Dropping columns without migration | Data loss | Add → backfill → drop in separate migrations |
| Returning raw pg NUMERIC as-is | Leaks strings where `number` is declared | Use `numericColumn()` / `coerceNumericFields()` at the repo read boundary |
| Nullable currency without DEFAULT | Forces implicit EUR assumptions in read layer | Add `DEFAULT 'EUR' NOT NULL` + ISO CHECK (migration 0046 pattern) |

---

## Related Documentation

- [[docs/adr/002-database-schema|ADR-002: Database Schema]]
- [[docs/adr/004-postgresql-table-inheritance|ADR-004: Table Inheritance]]
- [[docs/adr/005-materialized-views|ADR-005: Materialized Views]]
- [[docs/reference/database-triggers|Database Triggers]]
- [[docs/reference/migration-dependencies|Migration Dependencies]]
- [[docs/performance/caching-strategies|Caching Strategies]]
- [[docs/performance/materialized-views|Materialized Views Performance]]
