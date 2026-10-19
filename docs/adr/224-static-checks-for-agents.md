---
title: "ADR-224: Static checks for agents: import boundaries, type-aware lint, dead-code detection"
type: adr
status: accepted
date: 2026-10-19
tags:
  [
    adr,
    frontend,
    backend,
    typescript,
    eslint,
    dependency-cruiser,
    knip,
    ci-cd,
    lint-enforcement,
  ]
description: "Accepted on 2026-10-19. bun run lint now runs frontend ESLint, lint:deps (dependency-cruiser import boundaries) and lint:dead (knip) in parallel. Shared type-aware typescript-eslint rules in config/eslint-type-aware.mjs apply to frontend and backend. The checks run inside the existing CI Lint job; no CI job is added. Intended exports without a static importer carry the @public JSDoc tag. knip's duplicate-export rule is off."
aliases:
  [
    adr-223,
    static checks for agents,
    lint:deps,
    lint:dead,
    knip,
    dependency-cruiser,
    type-aware lint,
  ]
related_code:
  [
    "package.json",
    "config/dependency-cruiser.cjs",
    "config/tsconfig.depcruise.json",
    "config/knip.json",
    "config/eslint-type-aware.mjs",
    "apps/frontend/eslint.config.js",
    "apps/node-backend/eslint.config.js",
    "apps/node-backend/src/lib/math.ts",
  ]
---

# ADR-224: Static checks for agents: import boundaries, type-aware lint, dead-code detection

## Status

Accepted on 2026-10-19 (PR #307, "static checks for agents").

## Date

2026-10-19

## Context

Most changes in Vision are written by coding agents. The compiler and the existing ESLint rules
accepted several defect classes that agents produce repeatedly:

- runtime import cycles, imports between apps, and frontend imports of server-only code such as
  the Belgian tax engine ([[docs/adr/217-belgian-tax-figures-on-the-server|ADR-217]]);
- promises that nobody awaits or handles, and `switch` statements that miss a union member;
- numbers used as conditions or as `||` fallbacks, where a valid amount of 0 behaves like
  "missing";
- exports, files and dependencies left behind after a refactor, which agents then read as live
  code and keep alive.

Tor's constraint: the checks must not add CI jobs. [[docs/adr/221-proportional-ci|ADR-221]] had
just reduced CI to seven jobs.

## Decision

- **One lint entry point.** `bun run lint` runs frontend ESLint, `bun run lint:deps` and
  `bun run lint:dead` in parallel (`concurrently`, which stops the others when one fails). Backend
  ESLint stays `bun run lint:backend`. CI already runs both commands in its `Lint` job, so the new
  checks run there and no CI job is added.
- **Import boundaries (`lint:deps`).** dependency-cruiser (`config/dependency-cruiser.cjs`,
  resolving through `config/tsconfig.depcruise.json`) checks the runtime graph of the frontend,
  backend, shared packages, Electron shell and repository scripts. Type-only imports are ignored.
  Every rule is an error:
  - `no-circular`: no runtime import cycles;
  - `not-to-unresolvable`: every import resolves;
  - `no-undeclared-package`: every npm import is declared by a `package.json` on its path, not
    reached through hoisting;
  - `frontend-not-to-other-apps`, `backend-not-to-other-apps`, `electron-not-to-apps`: apps do
    not import each other's sources; shared code lives in `packages/`;
  - `packages-not-to-apps`: shared packages are leaves and import no app;
  - `types-package-is-a-leaf`: `@vision/types` does not import `@vision/shared-utils`;
  - `frontend-no-belgian-tax-engine`: frontend production code cannot reach the Belgian tax
    calculation modules in `packages/shared-utils/src/belgianTax/` (ADR-217);
  - `production-not-to-tests`: production code does not import tests, test helpers or mocks.

  Layering inside a workspace (routes, services and repositories; features and components) stays
  in each workspace's `eslint.config.js`, which pins exact bindings.

- **Type-aware lint.** `config/eslint-type-aware.mjs` holds typescript-eslint rules that need
  type information. The frontend and backend ESLint configs spread them over their TypeScript
  files: `switch-exhaustiveness-check`, `no-floating-promises`, `no-misused-promises`,
  `await-thenable`, `only-throw-error`, `prefer-promise-reject-errors`, `no-for-in-array`,
  `require-array-sort-compare` (string arrays exempt), `restrict-plus-operands`,
  `no-unnecessary-type-assertion`, `strict-boolean-expressions` (numbers and nullable numbers are
  not allowed as conditions; strings, booleans and nullable objects are) and
  `prefer-nullish-coalescing` (string and boolean operands exempt). The backend gains
  `nanToZero`, `nonZeroOr` and `firstNonZero` in `apps/node-backend/src/lib/math.ts` as explicit
  replacements for the `Number(x) || 0`, `x || fallback` and `byDate || byId` idioms. Branded
  currency codes (ADR-220) are string-and-object intersections, which the rule treats as objects,
  so empty-means-default fallbacks go through `currencyOr` (frontend `utils/currency.ts`) and
  `currencyOrEur` (backend `lib/currencyCode.ts`).
- **Dead code (`lint:dead`).** knip (`config/knip.json`) reports unused files, exports, types and
  dependencies in every workspace. Unused code is deleted rather than kept. An export that must
  stay without a static importer, such as a module contract or a binding reached through an
  injected object, carries the `@public` JSDoc tag with a short reason. knip does not report
  unused exports or types in the frontend `components/ui/**` primitives or in the generated
  `src/types/generated.ts`.
- **Duplicate exports allowed.** knip's `duplicates` rule is off. About 150 imports rely on a
  module exporting the same binding as both a named and a default export; rewriting them would be
  churn without a defect to fix.
- **Initial clean-up.** The branch fixed every existing violation. It deleted unused modules and
  exports (among them `ListFilterToggle`, `components/ui/toggle-group.tsx`, `useDebouncedSetting`,
  `CandlestickChart`, `useCategories()`, `useDeleteCategory()` and the planned-transaction
  repository's `updatePlannedFields`). It broke cycles by moving shared code into its own module:
  `EXPORT_JOINS_SQL` to `services/transactionJoins.ts`, `assertPortfolioUploadSupported` to
  `services/portfolioImportPipeline/uploadSupport.ts`, and `toneClass` to
  `features/portfolio/holdingTone.ts`.

## Consequences

- A cycle, a cross-app import, a frontend import of the tax engine or an unused export now fails
  `bun run lint` locally and in CI, with the rule name and the reason in the message.
- Type-aware ESLint needs the TypeScript program, so frontend and backend lint take longer than
  syntax-only lint. The three root checks run in parallel to limit the cost.
- Code must compare numbers explicitly (`count > 0`, `value !== 0`) and use `??` for fallbacks.
  Deliberately unawaited promises are marked with `void`.
- Adding an export that nothing imports fails `lint:dead` until it is used, deleted or tagged
  `@public`. The tag is a reviewed exception, not a way to silence the check.
- dependency-cruiser does not see type-only imports. A type-only cycle or cross-app type import
  is allowed; shared contracts still belong in `@vision/types`.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/reference/code-patterns#static-checks|Code Patterns: Static checks]]
- [[docs/reference/scripts|Scripts Reference]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/adr/217-belgian-tax-figures-on-the-server|ADR-217]]
- [[docs/adr/221-proportional-ci|ADR-221]]
