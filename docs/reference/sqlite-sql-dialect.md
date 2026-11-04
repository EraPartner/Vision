---
title: SQLite SQL Dialect and Porting Rules
type: reference
status: active
date: 2026-11-04
updated: 2026-11-04
tags: [reference, database, sqlite, sql, decimal, migrations]
description: How Vision stores PostgreSQL types in SQLite, which SQL functions every connection registers, and the rules for writing or porting SQL after ADR-263
aliases: [sqlite-dialect, sqlite-porting-guide]
related_code:
  [
    "apps/node-backend/src/database/connection.ts",
    "apps/node-backend/src/database/sqlite/",
    "apps/node-backend/src/database/writePlugin.ts",
    "db/migrations/",
  ]
---

# SQLite SQL dialect and porting rules

[[docs/adr/263-sqlite-replaces-postgresql]] replaces PostgreSQL with one SQLite file opened
in-process through `node:sqlite`. This page is the contract for every SQL statement Vision runs:
how values are stored, which functions exist, and what must never be written.

The oldest SQLite Vision supports is **3.39.0** (macOS 13 ships 3.39.5). macOS Bun uses the
system library, so SQL must not use a feature added after 3.39.

## Storage types

The declared column type tells the driver how to read a value back. Its spelling also fixes
SQLite's column affinity, so every text-stored type contains `TEXT` and none contains `INT`.

| PostgreSQL | SQLite declared type | Stored as | JavaScript value read |
| --- | --- | --- | --- |
| `integer`, `smallint` | `INTEGER` | integer | `number` |
| `serial` primary key | `INTEGER PRIMARY KEY AUTOINCREMENT` | integer | `number` |
| `bigint` | `BIGINT` | integer | decimal `string` (as node-postgres returned `int8`) |
| `bigint` primary key from a sequence | `BIGINT PRIMARY KEY NOT NULL DEFAULT (nextval('<seq>'))` | integer | `string` |
| `numeric(p,s)` | `DECIMAL_TEXT(p,s)` with `CHECK (vision_numeric_ok(col, p, s))` | canonical decimal text | `string` |
| `numeric` | `DECIMAL_TEXT` with `CHECK (vision_numeric_ok(col, NULL, NULL))` | canonical decimal text | `string` |
| `double precision`, `real` | `REAL` | float | `number` |
| `text`, `varchar(n)`, `char(n)` | `TEXT` (with `CHECK (length(col) <= n)` for a length) | text | `string` |
| `boolean` | `BOOLEAN` with `CHECK (col IN (0, 1))` | 0 or 1 | `boolean` |
| `timestamptz` | `TIMESTAMPTZ_TEXT` with `CHECK (vision_ts_ok(col))` | `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC) | `Date` |
| `date` | `DATE_TEXT` with `CHECK (vision_date_ok(col))` | `YYYY-MM-DD` | local-midnight `Date` |
| `jsonb` | `JSONB_TEXT` with `CHECK (vision_jsonb_ok(col))` | canonical jsonb text | parsed value |
| `json` | `JSON_TEXT` with `CHECK (json_valid(col))` | the text as written | parsed value |
| `text[]`, `integer[]` | `TEXT_ARRAY` with `CHECK (vision_array_ok(col))` | JSON array text | array |
| `uuid` | `UUID_TEXT` with `CHECK (vision_uuid_ok(col))` | lower-case UUID text | `string` |
| enum type | `TEXT` with `CHECK (col IN (...))` | text | `string` |

Notes:

- **Canonical text.** Decimal, timestamp, date and jsonb text is stored in exactly one form, so
  `=`, `GROUP BY`, `DISTINCT` and unique indexes compare values correctly as text. The `CHECK`
  constraints reject any other form, which turns an unported write into a loud error instead of a
  silently wrong row.
- **Decimal text** follows PostgreSQL `numeric` output: no exponent, no leading `+`, a leading
  `0` before the point, trailing zeros up to the declared scale (`12.50` in a `DECIMAL_TEXT(18,2)`
  column), `-0` normalised to `0`.
- **Canonical jsonb** is PostgreSQL's `jsonb` text output: duplicate keys dropped (the last one
  wins), keys ordered by length and then bytewise, `", "` and `": "` separators. Rows therefore
  read back with the key order PostgreSQL returned.
- **Timestamps** are UTC with six fractional digits. A JavaScript `Date` binds to this form.
- **`char(n)`** values are not padded with spaces; the length check replaces the type.
- **Enum ordering** is text ordering. `ORDER BY` on an enum column must use an explicit `CASE`
  when the order matters.
- **Sequences.** `vision_sequences(name, last_value)` holds the bigint sequences, including the
  one `portfolio_transactions`, `portfolio_asset_adjustments` and `portfolio_asset_transfers`
  share. `nextval(name)` advances it on the writer connection, inside the current transaction.

### Expression columns

A column computed by an expression has no declared type, so the driver cannot know it holds a
boolean or a timestamp. Give it a type hint in its alias; the driver removes the hint from the row
key:

```sql
SELECT EXISTS (SELECT 1 FROM tags) AS "has_tags::bool",
       max(created_at) AS "latest::timestamptz",
       json_group_array(id) AS "ids::json",
       count(*) AS "n::bigint"
```

Hints: `::bool`, `::json`, `::timestamptz`, `::date`, `::bigint` (decimal string), `::text`.
Without a hint `count(*)` reads as a `number`; row schemas accept a number or a string for
`dbBigint` and always yield a string.

## Parameters

Hand-written SQL may keep `$1`-style placeholders; the driver rewrites them to `?1`. Kysely emits
`?`. Bound values convert as follows: `Date` to canonical timestamp text, `boolean` to 1 or 0, an
array or a plain object to JSON text, a `Decimal` to its string, `undefined` to `NULL`.

A bound JavaScript number stays a number. Bind money as a **string** (or wrap it in SQL with
`dec(?)`); the `dec_*` functions refuse a non-integer float so float leakage fails loudly.

## Writing money

Every write to a `DECIMAL_TEXT(p,s)` column must store canonical text for that scale:

- Kysely `insertInto`, `updateTable` and `onConflict` writes are canonicalised by
  `writePlugin.ts`, which rounds a value to the column's scale (half away from zero) and refuses
  an overflow with SQLSTATE 22003, as a PostgreSQL assignment cast did.
- Hand-written SQL wraps the value: `vision_numeric(?, 18, 2)` or
  `vision_numeric(dec_mul(price, quantity), 18, 6)`.

## Functions every connection registers

All functions are defined in `apps/node-backend/src/database/sqlite/functions.ts`.

### Decimal arithmetic (exact, PostgreSQL scale rules)

| PostgreSQL | SQLite |
| --- | --- |
| `a + b`, `a - b`, `a * b`, `a / b`, `a % b` on numeric | `dec_add(a, b, ...)`, `dec_sub(a, b)`, `dec_mul(a, b, ...)`, `dec_div(a, b)`, `dec_mod(a, b)` |
| `-a`, `abs(a)`, `sign(a)` | `dec_neg(a)`, `dec_abs(a)`, `dec_sign(a)` |
| `round(a, s)`, `trunc(a, s)`, `floor(a)`, `ceil(a)` | `dec_round(a, s)`, `dec_trunc(a, s)`, `dec_floor(a)`, `dec_ceil(a)` |
| `a = b`, `<>`, `<`, `<=`, `>`, `>=` | `dec_eq`, `dec_ne`, `dec_lt`, `dec_le`, `dec_gt`, `dec_ge` (return 1, 0 or NULL) |
| `sum(a)`, `avg(a)`, `max(a)`, `min(a)` | `dec_sum(a)`, `dec_avg(a)`, `dec_max(a)`, `dec_min(a)` (also as window functions) |
| `greatest(...)`, `least(...)` on numeric | `dec_greatest(...)`, `dec_least(...)` |
| `ORDER BY amount` | `ORDER BY dec_key(amount)` |
| `x::numeric` | `dec(x)` |
| `x::numeric(p,s)` | `vision_numeric(x, p, s)` |
| `x::integer` (from numeric) | `dec_int(x)` (rounds half away from zero) |
| `x::float8` | `dec_real(x)` |

Division uses PostgreSQL's `select_div_scale`, so `dec_div('10', '3')` is
`3.3333333333333333`. Rounding is half away from zero. Overflow raises SQLSTATE 22003, division
by zero 22012.

**Never** apply `+ - * / %`, `sum`, `avg`, `min`, `max`, `abs`, `round`, `<`, `>`, `BETWEEN` or a
bare `ORDER BY` to a decimal column. SQLite would convert the text to a float or compare it as
text. The source check `tests/database/sqlDialect.test.ts` rejects these patterns.

`=` and `<>` between two canonical values of the same column type are correct as text, and so are
`GROUP BY`, `DISTINCT` and unique indexes. Comparing a column with a literal or a value of another
scale needs `dec_eq`.

### Dates and times

| PostgreSQL | SQLite |
| --- | --- |
| `now()`, `CURRENT_TIMESTAMP` | `now()`: transaction start time, as PostgreSQL |
| `CURRENT_DATE`, `now()::date` | `today()`: the date in the backend's local time zone |
| `ts::date`, `$1::date` | `ts_date(x)`: a stored timestamp gives its local date; other text gives the date it was written with, as PostgreSQL date input does |
| `d::timestamptz` | `date_ts(d)`: local midnight |
| `x::timestamptz` (from text) | `vision_ts(x)` |
| `date_trunc('month', x)` | `date_trunc('month', x)`: a date stays a date, a timestamp stays a timestamp |
| `d + interval '1 month'`, `d + make_interval(months => n)` | `add_months(d, n)`: clamps to the month end like PostgreSQL |
| `d + n` (days), `d + interval 'n days'` | `add_days(d, n)` |
| `x + interval '...'`, `x - interval '...'` | `add_interval(x, '...')`, `sub_interval(x, '...')` |
| `a - b` on dates | `date_diff_days(a, b)` |
| `(date_trunc('month', d) + interval '1 month - 1 day')::date` | `month_end(d)` |
| `extract(field FROM x)`, `date_part('field', x)` | `date_part('field', x)` |
| `to_char(x, 'YYYY-MM')` | `to_char(x, 'YYYY-MM')` (formats `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, `MM`, `DD`) |
| `make_date(y, m, d)` | `make_date(y, m, d)` |
| months between month starts | `month_diff(a, b)` |
| `generate_series(a, b, interval '1 month')` | a recursive CTE with `add_months` |

**Never** use SQLite's `date()`, `datetime()`, `julianday()`, `strftime()` modifiers such as
`'+1 month'` (they overflow `2026-01-31 +1 month` into March), `CURRENT_DATE`,
`CURRENT_TIMESTAMP` or `date('now')` (UTC, not the transaction clock). Dates and timestamps are
not interchangeable text: compare a date column with a date, a timestamp column with a
timestamp, or convert one side with `ts_date` or `date_ts`.

### Text and JSON

| PostgreSQL | SQLite |
| --- | --- |
| `a LIKE b` | `a LIKE b`: case-sensitive, `\` escapes, as PostgreSQL |
| `a ILIKE b` | `ilike(a, b)`: ASCII case folding (the C locale) |
| `a ~ b`, `a ~* b` | `a REGEXP b`, `regexp_i(a, b)` |
| `similarity(a, b)`, `a % b` (pg_trgm) | `similarity(a, b)`, `similarity(a, b) >= 0.3` |
| `lower`, `upper` | `lower`, `upper`: ASCII only, as the C locale |
| `string_agg(x, ', ')` | `group_concat(x, ', ')` (no `ORDER BY` inside before 3.44: order a subquery) |
| `array_agg(x)`, `json_agg(x)` | `json_group_array(x)` with a `::json` alias hint |
| `jsonb_build_object(...)` | `json_object(...)` |
| `j ->> 'key'`, `j -> 'key'` | `j ->> 'key'`, `j -> 'key'` (3.38+) |
| `j @> '{"a":1}'` | `json_contains(j, '{"a":1}')` |
| `to_jsonb(x)`, `x::jsonb` | `vision_jsonb(x)`: canonical jsonb text |
| `x = ANY($1)` with an array | `x IN (SELECT value FROM json_each(?))` |
| `unnest($1::int[])` | `json_each(?)` |
| `gen_random_uuid()` | `gen_random_uuid()` |
| `greatest`, `least` | `greatest`, `least`: NULLs ignored, as PostgreSQL |
| `btrim(x, chars)` | `btrim(x, chars)` |
| full-text search (`@@`, `ts_rank_cd`) | `vision_fts_match(text, query)`, `vision_fts_rank(text, query)` |

### Statements

- `INSERT ... ON CONFLICT (...) DO UPDATE` and `RETURNING` work. `RETURNING` does not see a change
  an `AFTER` trigger makes; the write plugin sets `updated_at` in the statement itself.
- `UPDATE ... FROM` works (3.33+). `DELETE ... USING` does not: use `WHERE id IN (SELECT ...)`.
- `SELECT ... FOR UPDATE` and advisory locks are removed. Every write transaction is
  `BEGIN IMMEDIATE` on the single writer connection, so a read inside it is already locked.
- `DISTINCT ON` becomes a window function (`row_number() OVER (PARTITION BY ... ORDER BY ...)`)
  or a correlated subquery.
- `LATERAL` becomes a correlated subquery, a window function, or a join on a CTE.
- `RIGHT JOIN`, `FULL JOIN` and `IS [NOT] DISTINCT FROM` are allowed (3.39). Prefer `IS` and
  `IS NOT` for null-safe equality.
- Aggregate `FILTER (WHERE ...)` works (3.30+). Aggregate `ORDER BY` (3.44), `unixepoch()` (3.38
  is fine, but use the Vision functions), `jsonb()` functions (3.45), `->>` on paths with `#` (3.47)
  and `RETURNING` inside a trigger body are not allowed.
- `::type` casts do not exist. Use the functions above, `CAST(x AS INTEGER)` or `CAST(x AS TEXT)`.
- Boolean columns hold 0 and 1. `WHERE active` and `WHERE NOT active` work; bind booleans as
  JavaScript booleans.
- One statement per `query()` call, except migration and maintenance scripts, which the driver
  runs with `exec()`.

## Errors

The driver translates SQLite errors into the PostgreSQL SQLSTATEs services already check:
`23505` (with `constraint` set to the unique index name, or `<table>_pkey`), `23503`, `23514`
(with the `CHECK` constraint name), `23502`, `42P01`, `42703`, `55P03` (write lock timeout) and
`57014`. A trigger raises `RAISE(ABORT, 'vision:<sqlstate>:<constraint>:<message>')`, which
becomes `code`, `constraint` and `message`.

A foreign key error has no constraint name: SQLite reports only "FOREIGN KEY constraint failed",
so `constraint` is undefined for `23503`, and for `23001`, the code a `RESTRICT` action raises.
Code that needs to know which reference failed checks the referenced row first, inside the same
transaction.

## Transactions and connections

- One writer connection runs every write and every transaction, one at a time behind an async
  lock (`VISION_DB_LOCK_TIMEOUT_MS`, default 60 s, then SQLSTATE 55P03).
- One reader connection (`PRAGMA query_only`) runs reads outside transactions: a statement that
  starts with `SELECT`, `VALUES` or `EXPLAIN`, or a `WITH` whose main statement is a `SELECT`
  (`sqlText.ts`). `CASE ... END` and `replace(...)` do not make a read a write; a misrouted write
  fails on the reader rather than writing.
- Every connection runs with foreign keys on, `synchronous = FULL`, `fullfsync`, a 16 MiB page
  cache (`cache_size = -16384`) and `temp_store = MEMORY`. `closePool()` runs
  `PRAGMA optimize` (bounded by `analysis_limit = 400`) before its WAL checkpoint, so the planner
  has statistics after the first clean shutdown.
- Kysely writes to a money column (`MoneyColumn`) take decimal text. Convert a JavaScript number
  with `decimalText()` from `database/columnTypes.ts`; the write plugin rounds it to the column's
  scale.
- `withTransaction(fn)` runs `fn` in `BEGIN IMMEDIATE`; a nested call becomes a savepoint.
  `withReadSnapshot(fn)` gives a consistent read-only snapshot for long exports.
- Never run unrelated `query()` calls in parallel inside one transaction with `Promise.all`
  if they write; reads in parallel are fine but run one after another.

## Schema changes

Migrations live in `db/migrations/NNNN_name.sql` (optional `NNNN_name.down.sql`). See
[[docs/guides/migrations]] for the runner, the lint rules and the table-rebuild procedure for
changes `ALTER TABLE` cannot make.

## Known differences from PostgreSQL

The baseline and the driver reproduce PostgreSQL's results for everything Vision does. The golden
tests in `apps/node-backend/tests/database/sqlite/` and `tests/database/sqliteBaseline.test.ts`
compare them with values PostgreSQL 18 computed. These differences remain, by design:

- **Foreign key errors** carry no constraint name (see [[#Errors]]).
- **An explicit `NULL` written to an `INTEGER PRIMARY KEY`** stores the next id. PostgreSQL
  refused it with `23502`. No Vision code writes one.
- **Unique violations** report the index PostgreSQL reported: SQLite checks the newest unique
  index first, so the baseline creates a table's unique indexes in reverse PostgreSQL order. A
  rowid key is checked before them and any other primary key after them.
- **`updated_at`** is `NOT NULL ON CONFLICT REPLACE` with a `now()` default: an `UPDATE` that
  writes `NULL` stores `now()`, as PostgreSQL's `BEFORE` trigger did. A `BEFORE INSERT` trigger
  refuses an `INSERT` of `NULL` with `23502`, as PostgreSQL did.
- **`BEFORE` triggers that assigned `NEW.<column>`** are `AFTER` triggers that update the row,
  because a SQLite `BEFORE` trigger cannot change `NEW`. `RETURNING` does not see what they write.
  This covers `update_*_updated_at` (the write plugin also sets `updated_at` in the statement, so
  `RETURNING` sees the same value) and the legacy category sync triggers.
- **`categories.name`** defaults to `'__LEGACY_NAME_PENDING__'`, which the legacy sync trigger
  replaces, because the column is `NOT NULL` and the trigger runs after the insert.
- **The insight digest marker** moves per row, not per statement. A statement that touches no row
  no longer bumps it, and one that touches n rows bumps it n times. Readers compare
  `dirty_version` with `computed_version` for equality only, so the result is the same.
- **The two former materialized views** are ordinary tables that `materializedViewService`
  refills with `DELETE` and `INSERT ... SELECT` in one transaction.
- **`real` columns** are SQLite doubles. A PostgreSQL `real` (float4) value is stored as the
  double of its shortest text, which is the number node-postgres gave Vision 2.0.
- **Enum ordering** is text ordering. No query in the 2.0.0 sources ordered by an enum column
  (checked with `git grep` on 2026-11-03), so no result changes.
- **`lower`, `upper` and `ilike()`** fold ASCII only, as PostgreSQL's C locale did.

## Related

- [[docs/adr/263-sqlite-replaces-postgresql]]
- [[docs/adr/021-decimal-arithmetic-for-monetary-values]]
- [[docs/adr/009-timezone-policy]]
- [[docs/reference/database-query-patterns]]
