---
title: "ADR-226: Kysely query builder over query()"
type: adr
status: accepted
date: 2026-10-19
tags: [adr, database, kysely, queries, type-safety, money, branded-types, row-contracts]
description: "Accepted on 2026-10-19. Backend queries are built with Kysely against the generated schema types instead of SQL strings. The Kysely driver runs every compiled query through query() in connection.ts, so ambient withTransaction() transactions, the slow-query log and query() test mocks keep working, and ADR-193 row schemas stay through checkedRows/checkedRow. Generated types brand entity ids and currency codes and type money NUMERIC columns as MoneyAmount."
aliases: [adr-226, kysely query builder, kysely queries, money column]
---

# ADR-226: Kysely query builder over query()

## Status

Accepted on 2026-10-19. Tor approved moving the backend queries to Kysely and extending the Money
types to row amount columns, as the second step after
[[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]].

## Date

2026-10-19

## Context

About 920 backend queries were SQL strings passed to `query()`, `queryRows()` or `queryOne()`.
Nothing checked table names, column names or parameter types at compile time; only the ADR-193 row
schemas checked results at run time. `kysely-codegen` already generated `schema.generated.ts` from
the migrated database (ADR-222), but nothing used it.

## Decision

- `apps/node-backend/src/database/db.ts` exports `db`, a `Kysely<DB>` over the generated schema.
  Its driver runs each compiled query through `query()` from `connection.ts`. A built query
  therefore joins the ambient `withTransaction()` transaction, keeps the slow-query log, and is seen
  by tests that mock `query()`. `db.transaction()` throws: transactions stay with
  `withTransaction()`.
- `checkedRows(schema, builder, client?)` and `checkedRow(...)` run a builder, or a Kysely `sql`
  template, through `queryRows`/`queryOne`, so the ADR-193 row schemas still check results.
  `compileQuery(builder)` gives SQL and parameters for a connection outside `withTransaction()`.
- Plain reads and writes use the query builder. Analytical SQL that the builder would make harder
  to read (long CTE chains, window functions, recursive CTEs, `LATERAL`, PL/pgSQL calls) uses
  Kysely's `sql` tag with bound parameters. DDL and administration statements and the
  run-time-table code (admin database editor, analysis custom SQL, role bootstrap, migrator) stay
  as they are.
- `bun run db:codegen` reads `apps/node-backend/.kysely-codegenrc.json`. Its column overrides
  brand primary and foreign keys of the branded tables and currency columns
  ([[docs/adr/220-branded-ids-currency-codes-and-money|ADR-220]]), and type money amount NUMERIC
  columns as `MoneyColumn`: selected as `MoneyAmount` (a branded decimal string from
  `@vision/types/brands`), written from `number | string`. Units, prices and rates stay plain
  strings. A new money or id column needs an override line before codegen.

## Consequences

- A wrong table, column or id kind in a query fails `bun run typecheck`.
- Code that takes a `MoneyAmount` only accepts an amount read from a money column, not a
  units, price or rate string.
- Result shapes are unchanged: node-postgres still returns NUMERIC and BIGINT as strings and DATE
  and TIMESTAMPTZ as `Date`.
- Tests that asserted SQL text sent to a mocked `query()` were rewritten or removed under
  [[docs/adr/215-behaviour-boundary-tests|ADR-215]].

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/reference/database-query-patterns|Database Query Patterns]]
- [[docs/reference/code-patterns|Code Patterns]]
- [[docs/adr/193-zod-runtime-contracts|ADR-193]]
