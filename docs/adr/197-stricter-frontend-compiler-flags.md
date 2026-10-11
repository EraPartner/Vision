---
title: "ADR-197: The frontend compiles with the backend's stricter TypeScript flags"
type: adr
status: accepted
date: 2026-10-11
tags: [adr, type-safety, typescript, frontend, adr-194]
description: "Phase 6 of the type-safety plan. The frontend adds noUncheckedIndexedAccess, noImplicitOverride, noImplicitReturns, erasableSyntaxOnly and verbatimModuleSyntax to strict, for source and tests, matching the backend. About 750 errors were fixed by narrowing rather than assertions. exactOptionalPropertyTypes and noPropertyAccessFromIndexSignature stay off. The bundle-size guard becomes TypeScript."
aliases: [adr-197, stricter frontend flags, type-safety phase 6]
---

# ADR-197: The frontend compiles with the backend's stricter TypeScript flags

## Status

Accepted. Phase 6, the last phase of the type-safety plan. Extends the backend decision in
[[docs/adr/194-runtime-contracts-completion|ADR-194]] (`noUncheckedIndexedAccess`) to the
frontend.

## Date

2026-10-11

## Context

The frontend was already `strict`, but indexed access (`array[i]`, `record[key]`, regex groups)
was typed as always present, so a missing element could reach rendering code as `undefined`
without a type error. The backend, scripts and Electron shell had turned on
`noUncheckedIndexedAccess` and the module-syntax flags in earlier phases.

## Decision

- `apps/frontend/tsconfig.json` (inherited by `tsconfig.app.json` and `tsconfig.node.json`) adds
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `erasableSyntaxOnly` and
  `verbatimModuleSyntax`. They apply to source and tests alike.
- Errors are fixed by narrowing: guards, early returns, destructuring with checks, `.at()`, tuple
  and `as const` types, and a fallback only where it matches what the code already did. A non-null
  assertion is allowed only where the invariant is local and obvious (a loop-bounded index, a
  regular expression group that always matches, a fixed list); about ten remain in source. Tests
  may assert fixture data that the test itself guarantees.
- `exactOptionalPropertyTypes` (about 390 errors, mostly `prop?: T` versus `prop: T | undefined`
  in component props) and `noPropertyAccessFromIndexSignature` (a style rule) stay off.
- `apps/frontend/scripts/check-bundle-size.mjs` becomes `check-bundle-size.ts`, run with Bun by
  `size:check` and type-checked by `tsconfig.node.json`.

## Consequences

- Code that reads an array element or record entry must handle its absence; the compiler enforces
  it in new code.
- One reachable crash was fixed with a regression test: the monthly rhythm strip read past the end
  of its data when a refetch returned fewer months while the pointer hovered it. A few paths that
  could not be reached before now do nothing instead of throwing (for example adding an analysis
  filter on a dataset without fields).
- No user-visible behaviour, API contract or data format changed.

## Related

- [[docs/reference/typescript-types|TypeScript Types Reference]]
- [[docs/adr/194-runtime-contracts-completion|ADR-194]]
- [[docs/adr/index|All ADRs]]
