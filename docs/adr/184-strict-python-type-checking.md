---
title: "ADR-184: Python is type-checked with mypy --strict in CI"
type: adr
status: accepted
date: 2026-10-07
tags: [adr, type-safety, python, mypy, alembic, ci]
description: Every first-party Python file (Alembic env and migrations, repo scripts and their tests, the packaged Alembic wrapper) is checked by mypy --strict from config/mypy.ini, with hash-pinned dev requirements, as a required CI gate. First phase of the type-safety plan; Python stays Python.
aliases: [adr-184, mypy strict, python type checking, type-safety phase 0]
---

# ADR-184: Python is type-checked with mypy --strict in CI

## Status

Accepted. Phase 0 of the type-safety plan: reasonable type safety across the whole application,
keeping Python for Alembic and repository scripts and moving JavaScript to TypeScript in later
phases.

## Date

2026-10-07

## Context

Python in Vision is the Alembic toolchain (`alembic/env.py`, 123 active migrations), repository
scripts under `scripts/`, and the PyInstaller entry point
`packaging/electron/scripts/vision-alembic.py`. None of it was type-checked. On main `032eb8a`,
`mypy --strict` reported 118 errors in 22 files: mostly missing annotations, plus loosely typed
dictionaries in `scripts/todo-report.py` and unchecked `ModuleSpec | None` values in script tests.

The owner chose to keep migrations in Python rather than replace the migration engine.
`scripts/tests/test_audit_migration_hook.py` also existed but no CI job ran it.

## Decision

- `config/mypy.ini` checks `alembic/env.py`, `alembic/versions/`, `scripts/` and the packaged
  Alembic wrapper with `strict = True` and `warn_unreachable = True` for Python 3.12.
  `alembic/legacy_versions/` is excluded as a frozen archive that never runs.
- mypy is pinned with hashes in `config/requirements-dev.txt`, compiled from
  `config/requirements-dev.in` with the runtime lock as a constraint, so mypy sees the shipped
  Alembic and SQLAlchemy versions. `pip-audit` covers both lock files.
- The required CI job `Type Check (Python)` installs both locks with `--require-hashes`, runs
  mypy, and runs the Alembic audit callback unit test. `quality-gate` depends on it.
- `bun run typecheck:python` runs the same check locally and is part of `bun run check`.
- Existing migrations received annotations only (`-> None`, `sa.engine.Connection`); no SQL or
  revision identifiers changed. New migrations from `alembic/script.py.mako` are already annotated.
- `_append_migration_audit` now raises a clear error if Alembic ever passes no connection.
  Only online migrations register the callback, so behaviour is unchanged.

## Consequences

- An unannotated function or a type error in Python fails CI.
- Migration authors annotate helper parameters (`conn: sa.engine.Connection`).
- `psycopg2` is imported only to prove PyInstaller bundled it, so mypy ignores its missing stubs
  instead of adding a stub dependency.
- Later phases move JavaScript to strict TypeScript and add runtime validation at the HTTP,
  database, CSV and IPC boundaries; they get their own ADRs.

## Related

- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/reference/scripts|Scripts Reference]]
- [[docs/adr/index|All ADRs]]
