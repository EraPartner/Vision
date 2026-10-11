---
title: "ADR-198: Every TypeScript project uses exactOptionalPropertyTypes and no explicit any"
type: adr
status: accepted
date: 2026-10-11
tags: [adr, type-safety, typescript, adr-197]
description: "Final pass of the type-safety plan. Every TypeScript project (frontend, backend source, tests and scripts, shared packages, Electron shell, repository scripts) turns on exactOptionalPropertyTypes. About 870 errors were fixed by widening our own optional properties to `T | undefined`, or by omitting a key only where the consumer treats a missing key and undefined alike. The last explicit any is removed and the backend lint rule no-explicit-any becomes an error. Supersedes ADR-197's note that exactOptionalPropertyTypes stays off."
aliases: [adr-198, exact optional property types, type-safety final pass]
---

# ADR-198: Every TypeScript project uses exactOptionalPropertyTypes and no explicit any

## Status

Accepted. The owner asked for this final pass on 2026-10-11. Supersedes the
`exactOptionalPropertyTypes` bullet of
[[docs/adr/197-stricter-frontend-compiler-flags|ADR-197]], which left the flag off.
`noPropertyAccessFromIndexSignature` (a style rule) stays off.

## Date

2026-10-11

## Context

After phase 6 every project was strict, but `prop?: T` still accepted an explicit `undefined`.
That hides a real difference: `{ ...defaults, ...{ key: undefined } }` overwrites the default,
`"key" in obj` and `Object.keys` see the key, and `JSON.stringify` drops it, so a PATCH body
built with `key: value || undefined` cannot clear a field. One explicit `any` remained in backend
source (`plannedTransactionService.create`) and a few in backend tests, chiefly the supertest
response body.

## Decision

- `exactOptionalPropertyTypes` is on in `apps/frontend/tsconfig.json`,
  `apps/node-backend/tsconfig.json` (inherited by the tests and scripts projects and by
  `scripts/tsconfig.json`), `packages/types`, `packages/shared-utils` and
  `packaging/electron/tsconfig.base.json`.
- An optional property or option that callers may pass as `undefined` is declared
  `prop?: T | undefined`. That is the default fix because it changes no runtime behaviour.
- Where the type belongs to a library or to the generated `apps/frontend/src/types/generated.ts`,
  the code omits the key instead, only after checking that the consumer treats a missing key and
  `undefined` alike (no spread over defaults, no key-presence check).
- Hand-written interfaces that a zod schema must satisfy declare optional fields as
  `T | undefined`, matching zod's inferred output.
- No explicit `any` remains in source or tests. Supertest response bodies are `unknown` and tests
  read them through `apps/node-backend/tests/helpers/responseBody.ts`, which keeps JavaScript
  property-access semantics. The backend lint rule `@typescript-eslint/no-explicit-any` is an
  error (the frontend already had it through the recommended config).

## Consequences

- New code cannot pass `undefined` to an optional property by accident; to clear a field it must
  send `null` where the API defines it.
- Three bugs surfaced and were fixed with regression tests: emptying a recipient rule's notes
  while editing never cleared them; `POST /api/planned-transactions` returned 500 for a
  non-string memo (memo and tag slugs are now validated as strings, as `openapi.yaml` already
  declared); and toasts got no light or dark styling while the theme followed a schedule.
- No API contract, schema or stored data changed.

## Related

- [[docs/reference/typescript-types|TypeScript Types Reference]]
- [[docs/adr/197-stricter-frontend-compiler-flags|ADR-197]]
- [[docs/adr/index|All ADRs]]
