---
title: "ADR-223: Adopt databases stopped at Alembic 0126 or 0127 through a bridge"
type: adr
status: accepted
date: 2026-10-19
tags: [adr, database, migrations, kysely, alembic, baseline, electron, startup]
description: "Accepted on 2026-10-19. Amends ADR-222. The installed database was at Alembic 0126, not 0128, so the first Kysely build refused it and the app waited at Almost ready. Adoption now applies the frozen 0127 and 0128 SQL from db/alembic-bridge/ in the migrator's transaction, then requires the baseline fingerprint. Electron shows a backend startup failure instead of polling for minutes."
aliases: [adr-223, alembic bridge, adopt 0126]
---

# ADR-223: Adopt databases stopped at Alembic 0126 or 0127 through a bridge

## Status

Accepted. Amends [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]] (adoption rule).

## Date

2026-10-19

## Context

ADR-222 adopted an existing database only at exactly `0128_category_path_on_legacy_rename`. The
installed database was at `0126_income_recognition_check_name`, because the build that last ran
on it predated `0127_bank_chronology` and `0128`. The first Kysely build therefore refused to
start. The backend exited within a second of each launch, while Electron kept polling for about
three minutes behind the "Almost ready…" splash. Separately, `bun run db:drift-check` used
`DATABASE_URL` from a checkout `.env` that Bun loads automatically, so it targeted the wrong host.

## Decision

- **Bridge.** `db/alembic-bridge/` keeps the SQL of the last two Alembic revisions, `0127` and
  `0128`, frozen. A database at `0126` or `0127` gets the missing steps inside the migrator's
  transaction, each with a `revision_applied` audit event. Then the normal adoption runs: the
  catalog fingerprint must equal the baseline's or the whole transaction rolls back. Older
  revisions still fail closed.
- **Drift check.** `db:drift-check` reads Vision's `runtime.env` by default. `--from-env` opts into
  `DATABASE_URL_MIGRATIONS`/`DATABASE_URL`. Bridge steps run in a transaction that is rolled back,
  so the checked database does not change.
- **Startup failure.** When the native backend exits before it is ready, Electron stops polling,
  shows the error page and a dialog with the last `Failed to start application` message from
  `backend.log`.

## Consequences

- The bridge files are history and are never edited. They can be removed once no database at
  `0126` or `0127` remains.
- A refused database is reported right away instead of after a long wait.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/guides/migrations|Database Migration Guide]]
- [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]
