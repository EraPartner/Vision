---
title: "ADR-186: Backend source moves to strict TypeScript by directory"
type: adr
status: accepted
date: 2026-10-07
tags: [adr, type-safety, typescript, backend, checkjs, ratchet, adr-185]
description: "The Node backend converts from JSDoc-annotated JavaScript to strict TypeScript one directory group at a time. Converted .ts files are checked by a separate strict tsconfig in CI while the remaining JavaScript keeps the checkJs gate and noImplicitAny ratchet. Phase 2 of the type-safety plan; the first step converts lib, config, types, backup, jobs, startup, middleware and database."
aliases: [adr-186, backend strict typescript, type-safety phase 2]
---

# ADR-186: Backend source moves to strict TypeScript by directory

## Status

Accepted. Phase 2 of the type-safety plan after
[[docs/adr/185-shared-packages-typescript|ADR-185]].

## Date

2026-10-07

## Context

`apps/node-backend/src` was about 425 JavaScript files checked by `tsconfig.check.json` with
`strict: false`, plus a `noImplicitAny` ratchet against a recorded baseline. Turning on full
`strict` for the whole tree reported 3,078 errors, too many for one reviewable change. Bun runs
`.ts` files directly, in development and in `bun build --compile` for the native app, so converting
needs no build step.

## Decision

- Backend source converts from `.js` to `.ts` one directory group per pull request. The first group
  is the leaf layer: `lib`, `config`, `types`, `backup`, `jobs`, `startup`, `middleware` and
  `database`. Later groups follow: repositories, integrations, routes and services. `main.js`
  converts last, together with the packaging paths that name it.
- Files are renamed with `git mv` and every relative import of them is rewritten to the `.ts`
  specifier. JSDoc types become TypeScript annotations; JSDoc `@typedef` blocks become exported
  `interface` or `type` declarations with the same names, so JavaScript callers keep resolving them.
  Runtime behaviour does not change.
- `apps/node-backend/tsconfig.json` checks every `src/**/*.ts` file with `strict`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly` and `allowJs` (JavaScript imports resolve but are not
  checked by this program). It uses the real `@types/express`, `@types/pg`, `@types/multer` and
  `@types/node` packages, added as development dependencies.
- The remaining JavaScript keeps `tsconfig.check.json` and the noImplicitAny ratchet. That program
  also compiles imported `.ts` files, so converted code must stay valid for it too. Ratchet baseline
  entries for converted files are removed in the same change. The ambient `express`, `pg` and
  `multer` shims in `src/types/thirdPartyModules.d.ts` stay until the JavaScript program no longer
  needs them.
- `bun run --filter 'financial-transaction-manager-node' typecheck` (and the root
  `bun run typecheck:backend`, part of `bun run check`) runs both programs. The `Type Check
  (Backend)` CI job adds a "strict TypeScript" step.
- ESLint applies the `typescript-eslint` recommended rules to `src/**/*.ts`. Explicit `any` is a
  warning, not an error, because the shared Express shim types still carry it at the request and
  response boundary until phase 4 adds runtime schemas there.
- Vitest coverage counts `.ts` sources. Repository guard scripts and tests that scan backend source
  by extension accept `.ts`.

## Consequences

- Converted files cannot regress to implicit `any` or unchecked `null`.
- During the migration two type-check programs run; a type change in a `.ts` file must satisfy both.
- Documentation that names converted files uses the `.ts` paths. Historical ADRs keep their
  original paths.

## Related

- [[docs/adr/184-strict-python-type-checking|ADR-184]]
- [[docs/reference/typescript-types|TypeScript Types Reference]]
- [[docs/adr/index|All ADRs]]
