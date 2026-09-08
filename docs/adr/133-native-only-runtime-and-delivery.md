---
title: ADR-133 Native-only runtime and delivery
type: adr
status: accepted
date: 2026-09-08
tags:
  [
    adr,
    native-runtime,
    postgresql,
    electron,
    ci-cd,
    release,
    macos,
    apple-container,
  ]
description: Vision retires active Docker and Compose support across product runtime, development, CI, and releases while preserving native PostgreSQL checks and a fail-closed legacy migration boundary.
aliases: [native-only Vision, Docker retirement, Compose retirement]
---

# ADR-133: Native-only runtime and delivery

## Status

Accepted — 2026-09-08. This supersedes [[docs/adr/039-docker-container-hardening|ADR-039]],
[[docs/adr/051-docker-compose-sync-named-volumes|ADR-051]], and the optional-provider and importer
parts of [[docs/adr/113-native-macos-runtime|ADR-113]].

## Context

Vision already runs the packaged app and deterministic Demo with a bundled PostgreSQL 18 cluster,
the native Bun backend, Alembic migrations, and a packaged report browser. Keeping a second
Compose lifecycle duplicated startup, backup, restore, update, CI, release, and support paths.
It also implied a Docker requirement that the current product no longer needs.

Database-backed verification is still required. Removing a container runtime does not justify
replacing PostgreSQL integration tests with mocks or skipping live application checks.

Some older installations may still have their only data in the retired runtime. Starting a fresh
native database over that state would be unsafe.

## Decision

- The Electron app and Demo support only the native runtime.
- Development, cloud setup, continuous integration, live API contracts, and end-to-end tests use
  disposable native PostgreSQL 18 clusters.
- Releases contain macOS native artifacts and source artifacts. They do not build or publish an
  application container image.
- Backup and restore use the native runtime transport only.
- The least-privilege database grant template lives under `config/postgres/`, independent of any
  delivery mechanism.
- The hardened agent sandbox remains. It uses Apple `container`; it is not a product deployment
  option or a Docker dependency.
- Historical ADRs and audits keep truthful references to the retired system. Active guides,
  commands, user interface copy, and contracts do not advertise it.
- A saved legacy runtime marker fails closed with a message directing the user to Vision 1.0.2 for
  migration. The Docker-free release does not contain an importer and never silently creates a
  replacement database over legacy state.

## Consequences

**Positive**

- One startup, health, update, backup, restore, and support path owns the desktop product.
- CI continues to exercise real PostgreSQL and real application processes without a daemon.
- Release promotion matches the artifacts users actually install.

**Negative**

- A legacy installation must migrate with the last Docker-capable release before upgrading.
- Linux/server operators must run the source deployment and provide PostgreSQL 18 themselves.
- The release no longer publishes an operating-system image or scans one for operating-system
  packages; dependency and filesystem security checks remain.

## Rollback

Reintroducing a second runtime is a new architecture decision. It must define data ownership,
migration, split-brain prevention, backup parity, CI coverage, and release support before code is
added. This ADR does not authorize converting native user data back to the retired runtime.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/guides/deployment|Deployment Guide]]
- [[docs/features/application-updates|Application Updates]]
