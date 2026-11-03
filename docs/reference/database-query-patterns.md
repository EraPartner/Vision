---
title: Database Query Patterns & Optimization
type: reference
status: active
date: 2026-11-03
updated: 2026-11-03
tags:
  [
    database,
    sqlite,
    queries,
    optimization,
    performance,
    indexes,
    phase-1,
    group-by-currency,
    per-currency-aggregation,
  ]
description: SQLite query patterns, index strategies, and optimization techniques used throughout Vision. June 2026 adds multi-currency GROUP BY aggregation pattern; November 2026 moves every example to SQLite (ADR-263).
aliases:
  [db optimization, query patterns, sqlite performance, indexing strategy]
related_code:
  [
    "apps/node-backend/src/repositories/",
    "apps/node-backend/src/database/",
    "db/migrations/0001_baseline.sql",
  ]
---

# Database Query Patterns & Optimization

> [!abstract] Purpose
> This document catalogs the SQLite query patterns, index strategies, and optimization techniques used throughout Vision. Every example follows [[docs/reference/sqlite-sql-dialect|SQLite SQL dialect]]: money goes through the `dec_*` and `vision_numeric` functions, and there are no `::type` casts ([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]). Designed for **developers** writing new queries, **DBAs** tuning performance, and **computer scientists** studying database design patterns.

---

## Connection Architecture

**File:** [[apps/node-backend/src/database/connection.ts]]

```
┌─────────────────────────────────────────────┐
│        One SQLite file (node:sqlite)         │
│  VISION_DATABASE_PATH                        │
│  writer: every write and transaction         │
│  reader: PRAGMA query_only, plain reads      │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│         Schema Initialization                │
│  db/migrations/0001_baseline.sql + NNNN_*    │
│  - Indexes, triggers, DDL via migrations     │
│  - SQLite migration runner, ledger           │
│    vision_migrations (one SHA-256 per file)  │
└─────────────────────────────────────────────┘
```

### Connection settings

The backend opens two connections to the same file. The writer runs every write and every
transaction, one at a time behind an async lock. `withTransaction()` starts `BEGIN IMMEDIATE`,
and a nested call becomes a savepoint. A write that waits longer than
`VISION_DB_LOCK_TIMEOUT_MS` (default 60000 ms) fails with SQLSTATE `55P03`. The reader runs
plain reads outside transactions.

| Pragma                       | Value | Purpose                                         |
| ---------------------------- | ----- | ----------------------------------------------- |
| `journal_mode`               | WAL   | Readers do not block the writer (set by the writer) |
| `foreign_keys`               | ON    | Enforce foreign keys                            |
| `synchronous`                | FULL  | Durable commits                                 |
| `fullfsync`, `checkpoint_fullfsync` | ON | Flush to disk on macOS                    |
| `busy_timeout`               | 10000 | Wait up to 10 s for a file lock                 |
| `recursive_triggers`         | OFF   | A trigger's own writes do not fire it again     |
| `query_only`                 | ON    | Reader connection only                          |

### Row contracts (ADR-193)

**Files:** [[apps/node-backend/src/database/rowContracts.ts]], [[apps/node-backend/src/database/rowSchemas.ts]], `apps/node-backend/src/database/rows/<area>.ts`

`query<R>()` does not check its generic, and without one its rows are `unknown`.
`queryRows(schema, sql, params, client?)` and
`queryOne(...)` run the query and check each row with a zod schema. `checkRows(schema, rows)`
checks rows a caller already has. The schemas describe what the SQLite driver returns: it
converts a column by its declared type, so `DECIMAL_TEXT` and `BIGINT` columns read as strings,
`DATE_TEXT` and `TIMESTAMPTZ_TEXT` as `Date`, `INTEGER` as numbers and JSON columns already
parsed. An expression column has no declared type and needs a hint in its alias, for example
`count(*) AS "n::bigint"` ([[docs/reference/sqlite-sql-dialect#Expression columns|Expression columns]]).

- Rows are never rewritten. The caller gets the exact objects the driver returned.
- Plain `z.object` ignores unlisted columns, so `SELECT *` keeps working after a migration adds one.
- The row types in `src/types/rows.ts` are `z.output<typeof …Schema>`, so type and check share one
  definition.
- A mismatch is a bug, not bad input. Tests and development throw `RowContractError` (a 500).
  Other environments follow `PRODUCTION_DATA_CONTRACT_MODE` in `lib/dataContract.ts`, which is
  `"throw"` (the owner chose to block, 2026-10-09), so production answers 500 too. The check stops
  at the first failing row.
- Messages name the query, the row index, column paths and type names. They never contain values.
- A catch block that falls back on failure (report data fetchers, FX resolution and cache warm-up,
  quote backfill, forecast accuracy) rethrows `RowContractError` first: a contract violation is a
  data fault, not a transient failure.
- `requireRow(row, label)` returns the single row of an `INSERT … RETURNING` or another
  always-one-row query and throws when it is missing.

Almost every repository and service query whose rows are read goes through these helpers. Not
checked: rows that are never read, DDL and infrastructure queries, and tables only known at run
time (the admin database editor, analysis custom SQL). `rowSchemas.ts` holds the `pg*` primitives
and the transaction, planned-transaction, account and split schemas; every other area keeps its
schemas in `database/rows/<area>.ts` (`admin`, `ai`, `analysis`, `audit`, `catalog`, `imports`,
`info`, `ledger`, `portfolio`, `portfolioImport`). See
[[docs/reference/code-patterns#Row contracts for new queries (ADR-193)|Row contracts for new queries]],
[[docs/adr/193-zod-runtime-contracts|ADR-193]] and
[[docs/adr/194-runtime-contracts-completion|ADR-194]].

### Query builder (ADR-226)

**Files:** [[apps/node-backend/src/database/db.ts]], [[apps/node-backend/src/database/schema.generated.ts]], `apps/node-backend/db-codegen.config.json`

Queries are built with Kysely's `db` against the generated `DB` types (`bun run db:codegen`, from the SQLite schema the migrations build). The driver sends each
compiled query through `query()`, so a built query runs inside the ambient `withTransaction()`
transaction and shows up in the slow-query log. `checkedRows(schema, builder)` and
`checkedRow(...)` add the row-contract check. Analytical SQL uses Kysely's `sql` tag with bound
parameters, and `db.transaction()` is not used. The SQL patterns below describe what the builder
and the `sql` templates produce. See [[docs/adr/226-kysely-query-builder|ADR-226]].

---

## Query Patterns

### Pattern 1: Parameterized SELECT with Pagination

**Used in:** All `getAll()` repository methods

```sql
SELECT * FROM transactions
WHERE ($1 IS NULL OR id = $1)
  AND ($2 IS NULL OR date >= $2)
  AND ($3 IS NULL OR date <= $3)
  AND ($4 IS NULL OR account_id = $4)
  AND ($5 IS NULL OR category_id = $5)
ORDER BY date DESC, id DESC
LIMIT $6 OFFSET $7
```

**Key technique:** `$X IS NULL OR column = $X` allows optional filters without dynamic SQL
construction. SQLite needs no cast on the parameter. Dates bind as `YYYY-MM-DD` text, which
compares correctly with a `DATE_TEXT` column.

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
-- Amounts bind as strings; vision_numeric() stores the column's canonical scale
INSERT INTO transactions (date, amount, recipient_id, category_id, memo)
VALUES ($1, vision_numeric($2, 18, 4), $3, $4, $5),
       ($6, vision_numeric($7, 18, 4), $8, $9, $10), ...
```

**Benefit:** Reduces round-trips from N to 1 for bulk operations.

### Pattern 4: CTE (Common Table Expression) for Aggregation

**Used in:** Summary tables, statistics

```sql
WITH monthly_data AS (
    SELECT
        date_trunc('month', date) AS month,
        dec_sum(CASE WHEN dec_sign(amount) < 0 THEN amount ELSE 0 END) AS expenses,
        dec_sum(CASE WHEN dec_sign(amount) > 0 THEN amount ELSE 0 END) AS income
    FROM transactions
    WHERE is_active = 1
    GROUP BY date_trunc('month', date)
)
SELECT * FROM monthly_data ORDER BY month DESC
```

`dec_sum` adds the decimal text exactly. A plain `SUM` would turn it into floats.

### Pattern 5: Window Functions

**Used in:** Running totals, rankings

```sql
SELECT
    date,
    amount,
    dec_sum(amount) OVER (ORDER BY date, id) AS running_total,
    row_number() OVER (PARTITION BY recipient_id ORDER BY date DESC, id DESC) AS rn
FROM transactions
```

A `row_number()` window also replaces PostgreSQL's `DISTINCT ON`: keep the rows where `rn = 1`.

### Pattern 6: JSON Operations

**Used in:** Settings storage, flexible metadata

```sql
-- Store a setting as canonical jsonb text (JSONB_TEXT column)
INSERT INTO user_settings (key, value)
VALUES ($1, vision_jsonb($2))
ON CONFLICT (key) DO UPDATE SET value = excluded.value

-- Read one field
SELECT value ->> 'defaultCurrency' FROM user_settings WHERE key = 'app_settings'
```

`vision_jsonb()` writes the one canonical form, so equal values compare equal as text. Use
`json_contains(j, ...)` where PostgreSQL used `@>`.

---

## Index Strategy

### Core Indexes

| Table                             | Index                        | Type            | Purpose                     |
| --------------------------------- | ---------------------------- | --------------- | --------------------------- |
| `transactions`                    | `(transaction_date DESC)`    | B-tree          | Date-range queries, sorting |
| `transactions`                    | `(recipient_id)`             | B-tree          | Recipient filtering         |
| `transactions`                    | `(category_id)`              | B-tree          | Category filtering          |
| `transactions`                    | `(bank_account)`             | B-tree          | Bank account filtering      |
| `recipients`                      | `(normalized_name)`          | B-tree (UNIQUE) | Deduplication, fast lookup  |
| `categories`                      | `(general, detail)`          | B-tree (UNIQUE) | Category uniqueness         |
| `planned_transactions`            | `(next_due_date)`            | B-tree          | Upcoming payment queries    |
| `investments`                     | `(asset_class)`              | B-tree          | Asset class filtering       |
| `asset_price_history`             | `(investment_id, timestamp)` | B-tree          | Price history lookups       |
| `portfolio_performance_snapshots` | `(snapshot_date)`            | B-tree (UNIQUE) | Daily snapshot lookup       |

### Composite Indexes

| Table                 | Index                              | Purpose                     |
| --------------------- | ---------------------------------- | --------------------------- |
| `transactions`        | `(transaction_date, category_id)`  | Filtered date range queries |
| `transactions`        | `(transaction_date, recipient_id)` | Recipient history queries   |
| `asset_price_history` | `(investment_id, timestamp DESC)`  | Latest price per investment |

### Summary Table Indexes

| Table                | Index                                                         | Purpose                                 |
| -------------------- | ------------------------------------------------------------- | --------------------------------------- |
| `mv_monthly_summary` | `idx_mv_monthly_summary (month_start, currency, category_id_key)` (UNIQUE) | Refuses duplicate rows in a refill |
| `mv_category_totals` | `idx_mv_category_totals (category_id, currency)` (UNIQUE)     | Refuses duplicate rows in a refill      |

---

## Flat investment tables

The supported head schema uses one `investments` table and one `portfolio_transactions` table.
Repositories query those relations directly; they do not probe for alternate schema shapes.
Asset-specific fields are nullable when they do not apply. Migration 0087 converted the retired
ADR-004 inheritance layout, as specified by
[[docs/adr/109-flat-investments-schema-canonical|ADR-109]].

---

## Materialized Views

**Service:** [[apps/node-backend/src/services/materializedViewService.ts]]

SQLite has no materialized views. The two that Vision kept are ordinary tables created by the
baseline migration, and the service refills them.

| Table                | Query Complexity                               | Refresh Strategy                                      |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `mv_monthly_summary` | Last 12 months per month, currency, category   | `DELETE` + `INSERT ... SELECT`, debounced 5 s (10 s max wait) |
| `mv_category_totals` | All time per category and currency             | Same refill, in the same write transaction            |

Both tables refill in one write transaction. Reads on the reader connection see the old contents
until `COMMIT` and never an empty table.

**Call Coalescing:**

```
refreshMaterializedViews() called
    ├── refreshInFlight set to the running refresh
    ├── Refill both tables in one withTransaction()
    ├── refreshInFlight cleared
    └── If refreshQueued = true, schedule a deferred refresh (500 ms)
```

**See:** [[docs/adr/005-materialized-views|ADR-005: Materialized Views for Dashboard]]

---

## Database Triggers

**Reference:** [[docs/reference/database-triggers|Database Triggers Reference]]

| Trigger                                   | Table                | Event                        | Purpose                                         |
| ----------------------------------------- | -------------------- | ---------------------------- | ----------------------------------------------- |
| `update_<table>_updated_at`               | most mutable tables  | AFTER UPDATE                 | Sets `updated_at = now()`                       |
| `trg_split_outstanding_sync__*`           | `transaction_splits` | AFTER INSERT/UPDATE/DELETE   | Maintains `agg_split_outstanding`               |
| `trg_split_payment_outstanding_sync__*`   | `split_payments`     | AFTER INSERT/UPDATE/DELETE   | Maintains `agg_split_outstanding`               |
| `trg_enforce_split_within_amount`         | `transactions`       | BEFORE UPDATE                | Refuses an amount below the split total (23514) |

SQLite triggers are row-level. A PostgreSQL `BEFORE` trigger that assigned `NEW.<column>` is an
`AFTER` trigger that updates the row, so `RETURNING` does not see its change. No trigger refreshes
the summary tables; the backend schedules that refresh after mutations.

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
WHERE t.date BETWEEN $1 AND $2
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
CREATE INDEX idx_txn_date_amount ON transactions (date, amount)

-- SQLite can answer from the covering index (no table lookup)
SELECT amount FROM transactions WHERE date BETWEEN $1 AND $2
```

### 4. Partial Indexes

**Technique:** Index only active records

```sql
-- From the baseline: booleans are stored as 0 and 1
CREATE INDEX idx_transactions_active ON transactions (date DESC, id DESC) WHERE is_active = 1
```

### 5. Expression Indexes

**Technique:** Index on computed values

```sql
-- From the baseline: an index on a registered decimal function
CREATE INDEX idx_transactions_abs_amount_date ON transactions (dec_abs(amount), date)
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

```sql
-- db/migrations/NNNN_add_transactions_note.sql
ALTER TABLE transactions ADD COLUMN note TEXT;

-- db/migrations/NNNN_add_transactions_note.down.sql
ALTER TABLE transactions DROP COLUMN note;
```

---

## Performance Benchmarks

| Operation                               | Typical Time | Notes                               |
| --------------------------------------- | ------------ | ----------------------------------- |
| Single transaction INSERT               | < 5ms        | Parameterized query                 |
| Batch INSERT (250 rows)                 | 10-50ms      | Single statement                    |
| Transaction list (paginated, 50 rows)   | 5-20ms       | With indexes                        |
| Summary-table refresh                   | 100-500ms    | Depends on transaction count        |
| Recipient resolution (normalized match) | < 2ms        | Index on normalized_name            |
| Price history lookup                    | 1-10ms       | Index on (investment_id, timestamp) |

---

## Multi-Currency GROUP BY Aggregation Pattern (June 2026)

When summarizing data that spans multiple currencies, push the aggregation fully into SQL rather than fetching all rows and summing in JavaScript. The canonical example is `getTransactionSummary` in `infoRepositoryStatistics.ts`:

```sql
SELECT
  currency,
  count(*)                                                       AS "transaction_count::bigint",
  dec_sum(CASE WHEN dec_sign(amount) >= 0 THEN amount ELSE 0 END) AS total_income,
  dec_sum(CASE WHEN dec_sign(amount) < 0 THEN amount ELSE 0 END)  AS total_spending,
  min(date)                                                      AS "first_date::date",
  max(date)                                                      AS "last_date::date"
FROM transactions
WHERE <filters>
GROUP BY currency
```

The route/service layer then receives one row per currency and combines them in JS (applying FX conversion). This eliminates N+1 per-currency queries and reduces the result set from O(transactions) to O(currencies).

The same pattern is applied in `infoRepositoryMonthly.ts` for the all-time live path: aggregates `(date, currency)` pairs in SQL with sign-split sums, converts at per-date historical FX rates, then buckets into months in JavaScript.

> [!info] Validation status (June 2026)
> These rewrites are present in the codebase but validation against a live multi-currency database is still pending (tracked in `TODO.md`). Verify on a dataset with non-EUR transactions before treating aggregate numbers as confirmed correct.

## Constraint and Index Conventions (June 2026)

### Currency Integrity (migration 0046)

`transactions.currency` and `planned_transactions.currency` are now:

- `NOT NULL` (backed by backfill — NULL rows set to `'EUR'`)
- `DEFAULT 'EUR'`
- `CHECK (currency REGEXP '^[A-Z]{3}$')` in the SQLite baseline (`chk_transactions_currency_iso`, `chk_planned_transactions_currency_iso`); historical migration 0046 added it as a PostgreSQL `NOT VALID` constraint

Any INSERT path that previously wrote explicit NULL must now write `'EUR'`. See [[docs/adr/086-currency-integrity|ADR-086]].

> [!note] Part of the baseline
> Historical Alembic migration `0046_currency_integrity` is applied in
> `db/migrations/0001_baseline.sql` (`chk_transactions_currency_iso`,
> `chk_planned_transactions_currency_iso`).

### One Primary Bank Account Per Recipient (migration 0047)

`recipient_bank_accounts` now has a partial unique index:

```sql
CREATE UNIQUE INDEX uq_recipient_primary_account
    ON recipient_bank_accounts (recipient_id)
 WHERE is_primary
```

This moves the "at most one primary per recipient" invariant from application code into the database. Pre-existing duplicates were demoted (lowest `id` wins) before the index was built.

> [!note] Part of the baseline
> Historical Alembic migration `0047_one_primary_bank_account_per_recipient` is applied in
> `db/migrations/0001_baseline.sql` (`uq_recipient_primary_account`).

### Category FK ON DELETE SET NULL (migration 0048)

The three FKs from `transactions.category_id`, `recipients.default_category_id`, and `planned_transactions.category_id` to `categories(id)` are now `ON DELETE SET NULL`. Previously they had the implicit `NO ACTION` (RESTRICT) behavior, so deleting an in-use category surfaced as a raw 500. After this migration, deleting a category un-categorizes the affected rows rather than blocking the delete.

FKs that protect financial history (e.g. `transactions.recipient_id`) are deliberately left as RESTRICT.

> [!note] Part of the baseline
> Historical Alembic migration `0048_category_fk_on_delete_set_null` is applied in
> `db/migrations/0001_baseline.sql`.

---

## Anti-Patterns to Avoid

| Anti-Pattern                          | Why Bad                                       | Solution                                                                  |
| ------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| Dynamic SQL without parameters        | SQL injection risk                            | Build with Kysely or its `sql` tag so values are bound                    |
| SELECT * in application code          | Breaks on schema change                       | Explicit column lists                                                     |
| Missing WHERE clause on UPDATE/DELETE | Accidental data loss                          | Always include WHERE                                                      |
| Unbounded queries                     | Memory exhaustion                             | Always use LIMIT                                                          |
| Dropping columns without migration    | Data loss                                     | Add → backfill → drop in separate migrations                              |
| Returning raw decimal text as-is      | Leaks strings where `number` is declared      | Use `numericColumn()` / `coerceNumericFields()` at the repo read boundary |
| Plain `SUM`, `<`, `ORDER BY` on money | SQLite turns decimal text into floats or compares it as text | Use `dec_sum`, `dec_lt`, `ORDER BY dec_key(...)` ([[docs/reference/sqlite-sql-dialect\|dialect]]) |
| Nullable currency without DEFAULT     | Forces implicit EUR assumptions in read layer | Add `DEFAULT 'EUR' NOT NULL` + ISO CHECK (migration 0046 pattern)         |
| Hand-written row interface for a repository read | Type and runtime shape drift apart | Add a schema to the area's `database/rows/<area>.ts`, read with `queryRows`/`queryOne`, derive the type with `z.output` |

---

## Related Documentation

- [[docs/adr/002-database-schema|ADR-002: Database Schema]]
- [[docs/adr/004-postgresql-table-inheritance|ADR-004: Table Inheritance]]
- [[docs/adr/005-materialized-views|ADR-005: Materialized Views]]
- [[docs/adr/263-sqlite-replaces-postgresql|ADR-263: SQLite replaces PostgreSQL]]
- [[docs/reference/sqlite-sql-dialect|SQLite SQL dialect]]
- [[docs/reference/database-triggers|Database Triggers]]
- [[docs/guides/migrations|Migration Guide]]
- [[docs/performance/caching-strategies|Caching Strategies]]
- [[docs/performance/materialized-views|Materialized Views Performance]]
