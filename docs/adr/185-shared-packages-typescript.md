---
title: "ADR-185: Shared packages are strict TypeScript source"
type: adr
status: accepted
date: 2026-10-07
tags: [adr, type-safety, typescript, packages, shared-utils, types, adr-184]
description: "@vision/types and @vision/shared-utils move from JavaScript with hand-written .d.ts files to strict TypeScript source that Bun, Vite, Node type stripping and the backend checkJs program consume directly; a CI step type-checks them with their own strict tsconfig. Phase 1 of the type-safety plan."
aliases: [adr-185, shared packages typescript, type-safety phase 1]
---

# ADR-185: Shared packages are strict TypeScript source

## Status

Accepted. Phase 1 of the type-safety plan after
[[docs/adr/184-strict-python-type-checking|ADR-184]].

## Date

2026-10-07

## Context

`@vision/types` (14 modules) and `@vision/shared-utils` (7 modules) were JavaScript with
hand-written `.d.ts` files. Nothing checked the JavaScript against its declarations, and some had
drifted: `portfolio.d.ts` typed transaction amounts as `number | string | null` while the code
emitted Decimal values, and omitted the `...Conv` cost-basis fields and the `defaultFxMultiplier`
option the code already used. Checking the JavaScript strictly reported 146 errors.

## Decision

- Every module is a `.ts` file that holds both the implementation and its exported types. The
  `.d.ts` files are deleted. Runtime behaviour is unchanged; public type names are kept, and types
  are only made more precise where the declarations were wrong (listed in the PR).
- `package.json` `exports`, `main` and `types` point at the `.ts` sources. There is no build step:
  Bun (dev server and `bun build --compile` for the native app), Vite, Vitest and Node's built-in
  type stripping (Node 22.18 or later) load the files directly.
- Each package has a `tsconfig.json` with `strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax` and `erasableSyntaxOnly`, so the sources stay loadable by type stripping
  (no enums, namespaces or parameter properties; relative imports use `.ts`).
- `bun run typecheck:packages` runs both configurations; the `Type Check` CI job and
  `bun run check` run it.
- The backend's checkJs program (`strict: false`) also compiles these sources and allows `.ts`
  import extensions. Until the backend itself becomes strict TypeScript, package code must also
  type-check without `strictNullChecks`. Two places need an explicit form for that:
  `numericColumn` narrows with separate returns, and the exported analysis schemas use a
  `ContractSchema` helper type that is a no-op under strict settings.

## Consequences

- Package types can no longer drift from their implementation.
- Scripts run with plain `node` that import backend code (the `evaluate:*` scripts) need Node 22.18
  or later. Bun-run paths are unaffected.
- The non-strict compatibility shims disappear when the backend moves to strict TypeScript in a
  later phase.

## Related

- [[docs/reference/typescript-types|TypeScript Types Reference]]
- [[docs/adr/index|All ADRs]]
