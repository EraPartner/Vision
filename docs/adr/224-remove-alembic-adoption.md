---
title: "ADR-224: Remove Alembic adoption"
type: adr
status: accepted
date: 2026-10-19
tags: [adr, database, migrations, kysely, alembic, baseline]
description: "Accepted on 2026-10-19. Supersedes the adoption rules of ADR-222 and ADR-223. The only database has moved to the Kysely baseline, so the bridge, the takeover and the drift check are removed. A database that still carries alembic_version is refused unchanged; restore a post-switch backup or reset the Demo."
aliases: [adr-224, remove alembic adoption]
---

# ADR-224: Remove Alembic adoption

## Status

Accepted. Supersedes the adoption parts of
[[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]] and
[[docs/adr/223-adopt-alembic-0126-through-bridge|ADR-223]].

## Date

2026-10-19

## Context

Adoption existed to move the one real Vision database from Alembic onto `0001_baseline`. That
happened on 2026-10-19, and the Demo database had already been opened on a build with adoption.

## Decision

- Remove `db/alembic-bridge/`, the takeover in `migrate.ts`, `bun run db:drift-check` and its
  hashed baseline inventory.
- A database that still carries `alembic_version` is refused without changes. Recovery is a
  backup taken after the switch, or `bun run demo:reset-native` for the Demo.
- Fresh installs keep the baseline fingerprint check. Backups with Alembic metadata stay refused.

## Consequences

- Less migration code to maintain; no frozen Alembic SQL in the package.
- An install still on an Alembic-era build cannot upgrade in place.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/guides/migrations|Database Migration Guide]]
