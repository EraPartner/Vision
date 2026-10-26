---
title: "ADR-253: Strict type-checked TypeScript, typed translation keys and typed routes"
type: adr
status: accepted
date: 2026-10-26
tags: [adr, typescript, type-safety, lint, typescript-eslint, i18n, routing, openapi]
description: "Accepted on 2026-10-26. The frontend and backend lint with typescript-eslint's strict-type-checked rules as errors (minus two stylistic rules), translation keys are a compile-time union generated from the English source, and in-app navigation paths are typed. Untyped boundaries are fixed by typing the boundary, not by deleting runtime checks. No new CI job or step."
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
   `restrict-template-expressions` (`allowNumber`). Both `apps/frontend` (sources and tests) and
   `apps/node-backend/src` use it.
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
6. **Not adopted.** `noPropertyAccessFromIndexSignature` (about 1,900 mechanical `obj.x` →
   `obj["x"]` edits; `noUncheckedIndexedAccess` already types the result as possibly
   `undefined`), and type-aware lint for `packages/`, `packaging/electron` and `scripts/` (that
   would add CI time).

## Consequences

- New `any`, impossible conditions, non-null assertions and unsafe string conversions fail
  `bun run lint` and `bun run lint:backend`.
- A missing or mistyped translation key, or a removed route, fails `bun run typecheck`.
- No runtime behaviour, wire format or stored value changes, apart from bugs fixed with
  regression tests (listed in the PR).
- No new CI job or step.

## Related

- [[docs/adr/198-exact-optional-property-types|ADR-198]]
- [[docs/adr/220-branded-ids-currency-codes-and-money|ADR-220]]
- [[docs/adr/251-exhaustive-api-enums-in-typescript|ADR-251]]
- [[docs/reference/typescript-types|TypeScript Types Reference]]
- [[docs/adr/index|All ADRs]]
