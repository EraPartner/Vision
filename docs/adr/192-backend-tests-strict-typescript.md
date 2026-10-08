---
title: "ADR-192: Backend tests move to strict TypeScript"
type: adr
status: accepted
date: 2026-10-08
tags: [adr, type-safety, typescript, backend, testing, vitest, adr-191]
description: "Backend Vitest suites convert from JavaScript to strict TypeScript in a few pull requests, starting with the shared helpers, service tests and route tests. A separate strict tsconfig.tests.json checks converted tests together with the sources they import, in the backend typecheck script and CI. Phase 3 of the type-safety plan."
aliases: [adr-192, backend tests typescript, type-safety phase 3]
---

# ADR-192: Backend tests move to strict TypeScript

## Status

Accepted. Phase 3 of the type-safety plan, after
[[docs/adr/191-retire-backend-checkjs|ADR-191]] made all backend source strict TypeScript.

## Date

2026-10-08

## Context

After ADR-191 the backend source is strict TypeScript, but its roughly 480 Vitest files (about
135,000 lines) are JavaScript and are not type-checked. A test can mock a function with the wrong
shape or assert on a field that no longer exists and still compile. Checking the JavaScript tests
under strict rules as they stand reports about 9,300 errors, too many for one reviewable change.

## Decision

- Backend tests convert from `.js` to `.ts` in a few pull requests. The first converts the shared
  support code (`tests/helpers`, `setup`, `builders`, `fixtures`, `golden`, `property`,
  `repositories`) together with `tests/services` and `tests/routes`. Later pull requests convert
  the remaining top-level test files.
- Files are renamed with `git mv`, and every relative import and `vi.mock` path that names them is
  rewritten. Test behaviour does not change: no assertion is weakened, removed or skipped.
- `apps/node-backend/tsconfig.tests.json` extends the strict `tsconfig.json`, adds the Vitest
  globals and checks `src/**/*.ts` and `tests/**/*.ts`. JavaScript tests that have not converted
  yet are imported but not checked.
- The backend `typecheck` script runs both programs, and the `Type Check (Backend)` CI job gains a
  "strict TypeScript tests" step.
- Vitest collects `tests/**/*.test.{js,ts}`.
- `tests/types/vendor.d.ts` types the slice of `supertest` and `archiver` the tests use, until
  `@types/supertest` and `@types/archiver` can be added as development dependencies.

## Consequences

- A converted test that mocks or asserts against a stale source shape fails the type check.
- A source type change must now also satisfy the converted tests that use it.
- Test-only casts (`as unknown as T` for partial mocks and fixtures) are accepted; `@ts-ignore` and
  `@ts-nocheck` are not, and `@ts-expect-error` is kept for deliberate invalid-input cases.

## Related

- [[docs/adr/186-backend-strict-typescript|ADR-186]]
- [[docs/adr/191-retire-backend-checkjs|ADR-191]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/adr/index|All ADRs]]
