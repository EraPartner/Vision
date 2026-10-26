---
title: "ADR-253: Strict type-checked TypeScript, typed translation keys and typed routes"
type: adr
status: accepted
date: 2026-10-26
tags: [adr, typescript, type-safety, lint, typescript-eslint, i18n, routing, openapi]
description: "Accepted on 2026-10-26. Every TypeScript project (frontend, backend sources, tests and scripts, shared packages, Electron shell, repo scripts) lints with typescript-eslint's strict-type-checked rules as errors (minus two stylistic rules). Translation keys and in-app paths are typed, raw SQL rows are checked against their row schemas at compile time, more API responses and all third-party JSON are parsed at the boundary, and type assertions were audited. Untyped boundaries are fixed by typing the boundary, not by deleting runtime checks. No new CI job or step."
aliases: [adr-253, strict type checked, typed i18n keys, typed routes]
---

# ADR-253: Strict type-checked TypeScript, typed translation keys and typed routes

## Status

Accepted on 2026-10-26. Tor asked for "the strictest type safety one can get" for the
TypeScript app after [[docs/adr/251-exhaustive-api-enums-in-typescript|ADR-251]].

## Date

2026-10-26

## Context

The compiler already runs `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
([[docs/adr/198-exact-optional-property-types|ADR-198]]), and ADR-220 and ADR-251 brand ids and
type API enums. Lint used typescript-eslint's `recommended` preset plus a few type-aware rules. A
probe with the `strict-type-checked` preset on 2026-10-25 found about 1,240 frontend and 1,500
backend errors. They fell into these groups:

- `any` flowing out of `JSON.parse`, `res.json()` and untyped libraries (`no-unsafe-*`);
- conditions the types say are impossible (`no-unnecessary-condition`), which means either dead
  code or a type that lies about a runtime boundary;
- non-null assertions, and objects, `null` or `undefined` interpolated into strings.

Translation keys were `string`, so a mistyped key compiled and rendered the raw key. In-app paths
were string literals at about 65 call sites.

## Decision

1. **Lint.** `config/eslint-type-aware.mjs` exports `strictTypeAwareRules(tseslint)`: every
   `strict-type-checked` rule as an error, with the repo's tuned type-aware rules on top. Two rules
   are left off: `no-confusing-void-expression` (style) and number interpolation in
   `restrict-template-expressions` (`allowNumber`). `apps/frontend` (sources and tests) and
   `apps/node-backend` (`src/`, `tests/`, `scripts/`) use it, and the root
   `eslint.projects.config.mjs` applies it to `packages/*`, `packaging/electron` and `scripts/`
   (`bun run lint:projects`). `bun run lint` runs frontend, backend and project ESLint in one
   parallel group, so CI keeps a single lint step.
2. **Boundaries over deletions.** When a rule calls a runtime check unnecessary on a value that
   crosses an untyped boundary (JSON, database, environment, URL, storage, IPC), the boundary's
   type is corrected (parse with the existing schema or type it `unknown`) and the check stays.
3. **Translation keys.** The locale generator emits the key union from `i18n/source/en.json`.
   `t()` takes that union, and `tc()` takes the plural bases. Dynamic keys are template literals
   over typed unions.
4. **Routes.** In-app navigation goes through a typed route table that the router also uses.
5. **Contract drift.** `openapi.yaml` documents `PortfolioImportUpload.default_type` as any
   `PortfolioTxnType` and `PortfolioImportBatch.account_id`, both as the backend already sends
   them. The frontend-only `cash_account_id` create field, which no route reads, is removed.
6. **SQL rows.** `checkedRows` and `checkedRow` (`apps/node-backend/src/database/db.ts`) fail
   the build when a builder's or `sql<T>`'s declared row cannot satisfy the row schema it is
   checked with. A PostgreSQL 18 test pins node-postgres's runtime types (bigint, `COUNT` and
   numeric as strings, `DATE` as `Date`).
7. **API responses.** Money mutation results and most other mutation results pass a wire schema
   to `apiRequest` ([[docs/adr/193-zod-runtime-contracts|ADR-193]] already blocks on a
   mismatch). `responseContractCoverage.test.ts` lists the remaining calls without a schema,
   each with a reason; the list can only shrink.
8. **Third-party JSON.** Replies from Ollama (including stream lines), the Apple Foundation
   helper, price and FX providers, the GitHub release check, Brave Search, Statbel and Eurostat
   are parsed with tolerant zod schemas. A malformed reply takes the existing fallback path.
9. **Type assertions.** Assertions in backend, package and Electron code were replaced with
   annotations, guards or schemas where one fits. The rest are a known limitation (correlated
   generics, `Object.entries`, brand constructors, library typings), commented where the reason
   is not obvious. Route parameters for id routes are parsed into branded ids.
10. **Not adopted.** `noPropertyAccessFromIndexSignature`: Tor judged it unnecessary on
    2026-10-26 (about 1,900 mechanical `obj.x` → `obj["x"]` edits, while
    `noUncheckedIndexedAccess` already types the result as possibly `undefined`).

## Consequences

- New `any`, impossible conditions, non-null assertions and unsafe string conversions fail
  `bun run lint` in every TypeScript project, tests included.
- A missing or mistyped translation key, or a removed route, fails `bun run typecheck`.
- No runtime behaviour, wire format or stored value changes, apart from bugs fixed with
  regression tests (listed in the PR).
- No new CI job or step: the separate "Lint backend" step was folded into the parallel
  `bun run lint`.

## Related

- [[docs/adr/198-exact-optional-property-types|ADR-198]]
- [[docs/adr/220-branded-ids-currency-codes-and-money|ADR-220]]
- [[docs/adr/251-exhaustive-api-enums-in-typescript|ADR-251]]
- [[docs/reference/typescript-types|TypeScript Types Reference]]
- [[docs/adr/index|All ADRs]]
