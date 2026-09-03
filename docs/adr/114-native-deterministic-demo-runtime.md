---
title: ADR-114 Native deterministic Vision Demo runtime
type: adr
status: accepted
date: 2026-08-31
updated: 2026-09-03
tags:
  [adr, macos, electron, demo, native-runtime, postgresql, packaging, testing]
description: Vision Demo uses the same bundled native PostgreSQL runtime as Vision, with an isolated identity and an atomically activated deterministic synthetic seed instead of a Demo-specific Docker stack.
aliases: [native Vision Demo, deterministic Demo seed, Demo PostgreSQL runtime]
---

# ADR-114: Native deterministic Vision Demo runtime

## Status

Accepted — 2026-08-31. This supersedes only the statements in
[[docs/adr/113-native-macos-runtime|ADR-113]] that retained Docker for the seeded Demo app. Docker
Compose remains an explicit provider for normal Vision deployments and development.

## Context

ADR-113 removed Docker from normal macOS development and the packaged Vision application, but left
Vision Demo on a separate Compose stack. That meant the app used for browser and visual testing
still required Docker Desktop, duplicated lifecycle and packaging work, and did not exercise the
native runtime used by the real application.

Demo data is deterministic and synthetic. It must remain isolated from real Vision data, but it
does not need a logical migration from its former Docker volume. Rebuilding the dataset from its
canonical generator is safer and more reproducible than transferring a disposable volume.

## Decision

Vision Demo always selects the native provider. It has a separate macOS application identity,
application-data directory, runtime identifier, PostgreSQL cluster, database roles, attachment
tree, logs, and fixed private database port:

- application data: `~/Library/Application Support/Vision Demo`;
- runtime root: `native/vision_demo/`;
- PostgreSQL: `127.0.0.1:54330`;
- production Vision remains at `native/vision/` and `127.0.0.1:54329`.

The release build creates the Demo seed rather than checking in a schema dump. It starts a
disposable native PostgreSQL 18 runtime, runs Vision's guarded migration runner to the current
head, applies data-only SQL from `packaging/electron/demo-db/generate.mjs` as the migration owner in
one transaction, verifies the generator's row counts, and writes a PostgreSQL custom-format dump.
The packaged `demo-seed` resource contains that dump plus a manifest with the schema revision,
complete table counts, important row counts, and SHA-256 hashes. Plain seed SQL is not packaged.

On first launch, after an explicit reset, or when the packaged seed hash changes, Electron:

1. verifies the seed manifest and dump checksum;
2. validates the custom dump before modifying the active Demo database;
3. restores it into a fresh staging database with error-on-first-failure and one transaction;
4. compares the schema, complete table set, and every exact row count;
5. atomically switches database names while retaining the previous database for rollback;
6. starts the native backend and waits for database-backed detailed readiness;
7. rechecks stable user-data counts, then finalizes the switch and seed marker.

Any failed start, readiness check, or count check stops the Demo backend and restores the previous
database. A persisted interrupted switch is rolled back before a later retry. The reset-request
marker is retained until finalization succeeds. `bun run demo:reset-native` creates that request;
the canonical seed is restored when Vision Demo next opens.

The Demo installer and packaged application do not discover, start, stop, or invoke Docker. The
old Demo-specific Dockerfile, generated SQL dump, onboarding fragment, Compose file, and
regeneration script are removed. The canonical root and embedded production Compose files remain
for the optional Docker provider and are not duplicated for Demo.

## Consequences

**Positive**

- Visual and live-contract testing exercises the same native lifecycle, migrations, PostgreSQL,
  backend, frontend, and report browser as packaged Vision.
- Vision Demo starts without Docker or a running Homebrew PostgreSQL service.
- The Demo and real application cannot share a database, attachment path, runtime marker, or
  fixed PostgreSQL port.
- Schema drift is caught while building the seed instead of on an end-user first launch.
- Seed activation is repeatable and recoverable without maintaining a second backup or restore
  implementation.

**Negative**

- Building Vision Demo now runs a disposable PostgreSQL migration and dump step.
- A changed seed intentionally replaces local Demo mutations after the new package has passed
  readiness. Demo data is not a durable user-data contract.
- A previously created Demo Docker volume may remain on the host until it is deliberately removed;
  the native Demo never reads or writes it.

**Neutral**

- Production Vision data, its completed native cutover marker, and the preserved original Docker
  volumes are outside the Demo paths and are not touched.
- No application schema migration or API change is required.
- Docker Compose remains supported for normal Vision deployments and container-focused tests.

## Rollback

Before a seed switch is finalized, Vision Demo automatically restores the previous Demo database.
After finalization, reinstalling the prior Demo application reuses the isolated Demo directory;
use that version's normal reset workflow if its seed differs. Returning the Demo app itself to
Docker would require restoring the removed Demo packaging and is not an application-data rollback.

## Follow-up: build-date-relative scenario (2026-09-03)

The seed remains deterministic for a supplied ISO reference date, but it no
longer freezes the household at 2026-06-18. The generator shifts every emitted
application date by the UTC-day difference from that original scenario anchor
to the seed build date. This includes transactions, planned payments, price and
exchange-rate history, portfolio events, maturity dates, statement dates, tax
year, and the year-bearing holiday tag. The logical scenario and pseudorandom
values remain stable while current and planned views stay useful in later
packages.

The manifest records `referenceDate`. Unit tests pin repeatability for a fixed
date, reject invalid calendar dates, require historical transactions not to
exceed the reference date, and require planned rows at and after it. The
generator remains data-only and never writes `alembic_version`.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/113-native-macos-runtime|ADR-113 Native macOS runtime]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
- [[docs/testing/testing|Testing Guide]]
- [[packaging/electron/runtime/native-demo.js|Native Demo activation]]
- [[packaging/electron/scripts/build-demo-seed.js|Demo seed builder]]
