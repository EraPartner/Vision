---
title: "ADR-263: SQLite replaces PostgreSQL"
type: adr
status: accepted
date: 2026-11-03
tags:
  [
    adr,
    database,
    sqlite,
    postgresql,
    persistence-contract,
    migrations,
    money,
    decimal,
    backup,
    restore,
    transition,
    adr-113,
    adr-222,
    adr-224,
    adr-226,
    adr-254,
  ]
description: "Accepted on 2026-11-03 by Tor. Vision drops the bundled PostgreSQL 18 server and stores its data in one SQLite file inside the application data directory, opened in-process by the Bun backend through node:sqlite. Money stays exact: NUMERIC columns hold PostgreSQL-formatted decimal text and every SQL calculation on them goes through decimal.js functions registered in SQLite. Month arithmetic keeps PostgreSQL's clamp-to-month-end rule. Existing 2.0.0 data moves once through a standalone script that reads a 2.0.0 backup, never touches PostgreSQL and verifies every table. Supersedes ADR-113's 'SQLite is not acceptable' line and the 'PostgreSQL kept' direction recorded with ADR-254."
aliases: [adr-263, sqlite, replace postgresql, remove postgresql]
related_code:
  [
    "apps/node-backend/src/database/sqlite/",
    "apps/node-backend/src/database/connection.ts",
    "apps/node-backend/src/database/db.ts",
    "apps/node-backend/src/database/migrate.ts",
    "db/migrations/",
    "scripts/vision-v2-to-sqlite.ts",
    "packaging/electron/runtime/native.ts",
    "packaging/electron/backup/",
  ]
---

# ADR-263: SQLite replaces PostgreSQL

## Status

Accepted on 2026-11-03 by Tor. It supersedes the sentence "Replacing PostgreSQL with SQLite would
change application behavior and is not acceptable" in
[[docs/adr/113-native-macos-runtime|ADR-113]], every PostgreSQL-specific part of ADR-113 (cluster,
roles, payload, `pg_dump` backups), the "bundled native PostgreSQL runtime ... stay" line that the
ADR index records for [[docs/adr/254-remove-swift-app|ADR-254]], the role split of
[[docs/adr/262-app-role-maintain-for-admin-vacuum|ADR-262]], and the PostgreSQL dialect of
[[docs/adr/226-kysely-query-builder|ADR-226]]. The migration ledger and refusal rules of
[[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]] and
[[docs/adr/224-remove-alembic-adoption|ADR-224]] carry over to SQLite as described below. The
Electron-only desktop decision of ADR-254 is unchanged.

## Date

2026-11-03

## Context

Tor (2026-11-03): "it's the postgresql dependency and server that I'd like to get rid of, let's go
with the SQLite rewrite", then "make sure that migrations will work from now on in this new
database and that I can safely transition over to SQLite", "let's not have this in-app, a script is
good enough", "as long as it's a perfect and safe script".

The read-only audit of the same day (vault note
`projects/vision/queries/2026-11-03-sqlite-adoption-audit`) inventoried what
Vision used from PostgreSQL: 77 tables, 66 NUMERIC columns, 41 jsonb columns, 45 triggers, 19
PL/pgSQL functions, 4 GIN indexes, three database roles, about 970 hand-written SQL entry points,
and a 3,128-line runtime that ships and manages a private PostgreSQL 18.6 cluster. It measured that
`node:sqlite` in the pinned Bun 1.4.2 supports scalar and aggregate JavaScript functions and an
authorizer, that SQLite's `date('2026-01-31', '+1 month')` is `2026-03-03` where PostgreSQL gives
`2026-02-28`, and that SQLite silently turns integer overflow into a float.

Facts checked for this ADR (2026-11-03, Linux container):

- Backend tests run under Node (`bun vitest` follows Vitest's `#!/usr/bin/env node`); Node 22.23
  `node:sqlite` has `function()`, `aggregate()` and `StatementSync.columns()` but no
  `setAuthorizer()`. Bun 1.4.2 has all four.
- `StatementSync.columns()` returns the declared column type for a direct column reference,
  including through subqueries and views, and `null` for an expression.
- The macOS build of Bun 1.4.2 loads the system `libsqlite3.dylib` at run time for both
  `bun:sqlite` and `node:sqlite` (strings in the darwin-arm64 binary, including the
  `setCustomSQLite` hint in `node:sqlite` errors). `setCustomSQLite` is a no-op on Linux, so a
  bundled library could not be verified from the cloud.

## Decision

### Engine and driver

- One SQLite database file, `vision.sqlite3`, in the database directory below Vision's application
  data directory. No server process, no port, no roles, no credentials file.
- The Bun backend opens it with `node:sqlite` through a thin adapter in
  `apps/node-backend/src/database/sqlite/`. Tests use Node's built-in `node:sqlite` against a
  temporary file. `bun:sqlite` and `better-sqlite3` are not used.
- macOS uses the system SQLite that Bun loads. The backend refuses to start when
  `sqlite_version()` is below **3.39.0** (macOS 13), with a message naming both versions. SQL is
  written for that floor: `->`/`->>` (3.38), `RIGHT`/`FULL JOIN` and `IS [NOT] DISTINCT FROM`
  (3.39) are allowed; `string_agg()`, `concat()`, `unhex()`, ordered aggregates (3.44), the
  `jsonb()` family (3.45) and built-in math functions (a compile option macOS lacks) are not. A
  source check fails the backend tests when one of them appears in SQL.
- Pragmas on every connection: `foreign_keys = ON`, `journal_mode = WAL`, `synchronous = FULL`,
  `fullfsync = ON`, `checkpoint_fullfsync = ON`, `busy_timeout`, `recursive_triggers = OFF`.
- Concurrency: one write connection and one read connection. `withTransaction()` keeps its API and
  its AsyncLocalStorage context, takes an async write lock, runs `BEGIN IMMEDIATE` and nests with
  `SAVEPOINT`. Writes outside a transaction take the same lock. Reads outside a transaction use
  the read connection and see the last committed state, as other pool connections did. A
  transaction that holds the lock longer than 60 s is logged and its lock wait times out, which
  replaces `idle_in_transaction_session_timeout`. `FOR UPDATE` and advisory locks are removed: the
  single writer serializes what they protected.

### Types

| PostgreSQL | SQLite storage | Read by the backend as |
| --- | --- | --- |
| `NUMERIC(p,s)` | TEXT in PostgreSQL's output form (`12.3400`), checked by `vision_numeric_ok(value, p, s)` | the same decimal string as node-postgres |
| `integer`, `serial` | INTEGER (`AUTOINCREMENT`, so ids are never reused) | number |
| `bigint`, `bigserial` | INTEGER declared `BIGINT`; sequence ids from `nextval()` over a `vision_sequences` table, so the three portfolio tables keep their shared id sequence | the decimal string node-postgres returned for `int8` |
| `boolean` | INTEGER 0/1 | boolean |
| `timestamptz` | TEXT, UTC, `YYYY-MM-DDTHH:MM:SS.ffffffZ` (microseconds kept) | `Date` |
| `date` | TEXT `YYYY-MM-DD` | a local-midnight `Date`, as node-postgres returned |
| `jsonb` | TEXT in PostgreSQL's canonical jsonb output (keys deduplicated and ordered as jsonb orders them) | parsed value, with the key order PostgreSQL returned |
| `json` | TEXT JSON as written | parsed value |
| `text[]`, `integer[]` | TEXT JSON array | array |
| enum types | TEXT with `CHECK (... IN (...))` | string |
| `uuid` | TEXT, lower case | string |

The adapter converts by declared column type for direct column reads (`StatementSync.columns()`),
and by an alias suffix for expressions (`AS "is_open::bool"`, `::json`, `::timestamptz`, `::date`),
so what services read stays what node-postgres returned. Bound values convert the other way: a
`Date` becomes the UTC text above, a boolean 0/1, an array or plain object JSON text.

### Money and decimals

- NUMERIC values are never REAL in SQLite. Writes are rounded to the column's scale with ties away
  from zero and refused above its precision (`numeric field overflow`), as PostgreSQL does; the
  check constraint refuses any value that is not in canonical form, so a missed conversion fails
  instead of storing a near value.
- Every calculation on a NUMERIC value in SQL uses an exact BigInt fixed-point function registered
  on each connection (`apps/node-backend/src/database/sqlite/numeric.ts`): `dec_add`, `dec_sub`, `dec_mul`, `dec_div`, `dec_neg`, `dec_abs`, `dec_round`,
  `dec_cmp`, `dec_sign`, `dec_sum`, `dec_avg`, `dec_min`, `dec_max`. Their results carry
  PostgreSQL's display scale (sum and add keep the larger scale, multiply adds scales, divide uses
  PostgreSQL's `select_div_scale`), so the text matches what PostgreSQL returned.
- Native `+ - * /`, `SUM`, `AVG`, comparison operators and `ORDER BY` on a NUMERIC column are
  forbidden, because SQLite would compare text or compute in floating point. A source check in the
  backend tests enforces it for the known NUMERIC columns.

### Dates, text search and other PostgreSQL behaviour

- Calendar month steps go through `add_months(date, n)` and `date_trunc(unit, value)`, which keep
  PostgreSQL's semantics (`2026-01-31` plus one month is `2026-02-28`). SQLite's `+N month`
  modifier is forbidden by the source check; day steps use `add_days(date, n)`.
- `now()` returns the transaction start time inside a transaction and the statement time outside
  one, as in PostgreSQL. "Today" and day boundaries of timestamps use the backend process's time
  zone, which is the zone the PostgreSQL session used.
- `ilike()`, `regexp` (JavaScript regular expressions), `similarity()` (pg_trgm's trigram rule),
  `json_contains()` for `@>`, `gen_random_uuid()` and `to_char()` for the formats Vision uses are
  JavaScript functions. AI research passages drop the tsvector column; `vision_fts_match()` and
  `vision_fts_rank()` reimplement PostgreSQL's `simple` text-search configuration,
  `websearch_to_tsquery()` and `ts_rank_cd()` in JavaScript, so search does not depend on whether
  the system SQLite was built with FTS5.
- `LATERAL`, `DISTINCT ON`, `generate_series`, arrays and `= ANY()` are rewritten as correlated
  subqueries, window functions, recursive CTEs and `json_each()`.
- Triggers keep every integrity rule (immutability guards, split totals, category cycle guard,
  outstanding sync, insight digest dirtiness) as SQLite triggers with `RAISE(ABORT, ...)`.
  `updated_at` is set by the statements that update a row; a trigger fills it in when a statement
  did not.
- The two materialized views become summary tables refreshed by the backend in one transaction.
- SQLite constraint and trigger errors are translated to the PostgreSQL error codes the code
  already handles (`23505`, `23503`, `23514`, `23502`, `P0001`), with the constraint name.

### Least-privilege analysis SQL

- PostgreSQL's analysis role becomes an in-memory sandbox database: the executor copies the rows
  of the approved `vision_analysis_*` views into an attached in-memory database named
  `vision_analysis` (so `vision_analysis.transactions_v2` keeps resolving) and runs the user's
  single read-only statement there with `query_only` on. The sandbox has no connection to the real
  database file, so nothing else is reachable. The same path runs under Bun and under Node in tests.
- Analysis SQL runs in a worker thread with a 5 s limit. On timeout the request fails and the
  worker is terminated; only one analysis worker runs at a time.
- Open question answered by default: saved analyses whose custom SQL was written for PostgreSQL
  are kept unchanged, flagged "needs review" and not executed until the user saves a SQLite
  version. Analyses built in the visual editor are regenerated from their stored definition.

### Migrations

- Numbered SQL files stay in `db/migrations/`, now SQLite SQL, starting again at
  `0001_baseline.sql` (the SQLite translation of the 2.0.0 schema). The PostgreSQL files leave the
  tree (they stay in Git history).
- The runner (`apps/node-backend/src/database/migrate.ts`) records each applied migration with a
  SHA-256 of its text in `vision_migrations`, and runs all pending migrations in one
  `BEGIN IMMEDIATE` transaction with foreign keys switched off for the run and a
  `PRAGMA foreign_key_check` that must be empty before commit, so the twelve-step table rebuild
  SQLite needs for most `ALTER TABLE` changes is safe; any failure rolls the whole run back. It
  refuses a database that has tables but no ledger, records a migration it does not know (a newer
  Vision wrote it) or whose recorded checksum differs. Before applying anything to a database that
  has data it writes a `VACUUM INTO` copy next to the database and keeps the last three. Optional
  `.down.sql` files keep `db:migrate:down`.
- The migration test runs every migration on an empty database and on a database built at each
  earlier version with data, then checks `integrity_check`, `foreign_key_check` and that the
  result equals a fresh install. squawk is replaced by SQLite migration rules checked in the
  backend tests, so no CI step is added.

### Backups and restore

- New backups put a `VACUUM INTO` copy of the database in the `.visionbak` bundle as
  `db.sqlite3`, beside the unchanged attachments, metadata, frontend state and encryption.
  Restore checks `integrity_check`, the migration ledger and the schema, then swaps the file.
- Bundles with a PostgreSQL `db.sql` are not restored in the app. The transition script below
  converts them into a SQLite bundle that the app restores.

### Moving existing 2.0.0 data

A standalone script, `scripts/vision-v2-to-sqlite.ts`, run once with Bun. Nothing of it ships in
the app.

- Input is a Vision 2.0.0 `.visionbak` (plain or encrypted). The script never connects to,
  starts or changes PostgreSQL, and never modifies or deletes the input or the PostgreSQL data
  directory.
- It refuses a bundle whose migration ledger is not 2.0.0's `0005`, and refuses to write over an
  existing SQLite database unless it is the one this script produced from the same input
  (a re-run is then a no-op that re-verifies).
- `--dry-run` converts into a temporary file, verifies and prints the report without installing
  anything. Without it the script installs only after verification passes, through a temporary
  file and an atomic rename.
- Conversion is per column from a typed mapping table covered by tests; decimals stay text from
  end to end, timestamps keep their offset and microseconds, sequences continue after
  PostgreSQL's last value.
- Verification per table: row count, a SHA-256 over the canonical rows in primary-key order, and
  the exact decimal sum of every NUMERIC column, each computed from the dump and from the SQLite
  database through the backend's own reader. Then `integrity_check`, `foreign_key_check` and the
  app invariants (account balances, split totals, open split amounts). The report is JSON.
- Saved analyses with PostgreSQL custom SQL are flagged as described above.
- Vision refuses to start when it finds a 2.0.0 PostgreSQL data directory and no SQLite database,
  and names the script, so a first launch cannot create an empty database over real data.

### Removed

The PostgreSQL 18.6 payload and its release download, `pg`, `@types/pg`, the cluster lifecycle in
`packaging/electron/runtime/native.ts`, role and grant bootstrap, `config/postgres/`,
`pg_stat_statements`, the CI PostgreSQL install, `scripts/with-test-db.sh`'s cluster and squawk.
The admin maintenance page keeps its actions on SQLite terms: `VACUUM`, `ANALYZE`,
`PRAGMA optimize`, `integrity_check`, table sizes from `dbstat` when available, and a query
timing buffer in the adapter instead of `pg_stat_statements`.

## Consequences

- No database server: less memory (about 138 MB of PostgreSQL processes after launch on Tor's
  Mac, 2026-10-25), a smaller app, no port collisions and no cluster recovery code.
- CI drops the PostgreSQL install and cluster start. No job is added.
- Every SQL statement was rewritten. The risk sits in money arithmetic, month arithmetic,
  concurrency and the analysis sandbox; each has boundary tests, and the source checks above make
  the dangerous native forms fail the build.
- macOS 12 is no longer supported (its system SQLite is older than 3.39).
- Users of 2.0.0 must run the script once with Bun from a repository checkout. Older
  PostgreSQL backups restore only after the same script converts them.
- A database file opened with the plain `sqlite3` shell can be read, but writes to tables with
  decimal checks fail there because the functions live in the backend.
- PostgreSQL's per-statement timeout exists only for analysis SQL. A slow application query
  blocks the backend's event loop for its duration, as any synchronous work does.
- jsonb's key order and duplicate-key folding are not reproduced; values read back are equal.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/113-native-macos-runtime|ADR-113]]
- [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]
- [[docs/adr/224-remove-alembic-adoption|ADR-224]]
- [[docs/adr/226-kysely-query-builder|ADR-226]]
- [[docs/adr/233-loopback-only-backend|ADR-233]]
- [[docs/adr/254-remove-swift-app|ADR-254]]
- [[docs/guides/migrations|Database Migration Guide]]
