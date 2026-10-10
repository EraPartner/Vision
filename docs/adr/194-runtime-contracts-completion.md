---
title: "ADR-194: Runtime contracts cover the backend reads and the frontend client"
type: adr
status: accepted
date: 2026-10-10
tags: [adr, type-safety, zod, validation, backend, frontend, typescript, adr-193]
description: "Completes ADR-193. Almost every backend query whose rows are read is checked against a zod row schema kept per area in database/rows/, query<R>() defaults to unknown rows, and no explicit any remains in backend source. Backend source and tests turn on noUncheckedIndexedAccess. The OpenAI egress helper stays .mjs, is type-checked through JSDoc, and its stdout is checked. The frontend checks about 170 more API reads and the save responses the UI uses, with wire schemas that require every field the backend always sends. Supersedes ADR-193's identity-fields-only rule for frontend schemas."
aliases: [adr-194, runtime contracts completion, type-safety phase 4 completion]
---

# ADR-194: Runtime contracts cover the backend reads and the frontend client

## Status

Accepted. Completes [[docs/adr/193-zod-runtime-contracts|ADR-193]] (phase 4 of the type-safety
plan). It supersedes one rule in ADR-193: frontend wire schemas no longer require only identity
fields (see [[#Frontend API responses]]). The rest of ADR-193 stands.

## Date

2026-10-10 (frontend save responses and `noUncheckedIndexedAccess` scope decided by the owner
2026-10-09)

## Context

ADR-193 put the row, adapter, request and response checks in place but applied the row checks to
four repositories (accounts, planned transactions, splits, transactions) and the response checks
to seven frontend reads. The remaining queries still trusted `query<R>()`'s generic, which
defaulted to `any`, and most frontend reads still trusted the response. ADR-193's frontend schemas
were also loose on purpose (identity fields required, every other field optional) because many
screen-test fixtures were partial. A loose schema misses exactly the drift the check exists for:
a field the backend stopped sending.

## Decision

### Backend rows

- Every repository and service query whose rows are read goes through `queryRows`, `queryOne` or
  `checkRows` (`apps/node-backend/src/database/rowContracts.ts`). Not checked, by design: queries
  whose rows are never read, DDL and other infrastructure queries (migrations, role bootstrap),
  and queries over tables only known at run time (the admin database-editor rows and analysis
  custom SQL).
- New row schemas live per area in `apps/node-backend/src/database/rows/<area>.ts`: `admin`,
  `ai`, `analysis`, `audit`, `catalog`, `imports`, `info`, `ledger`, `portfolio` and
  `portfolioImport`. They import the `pg*` primitives and the shared ledger schemas from
  `src/database/rowSchemas.ts`, which keeps the primitives and the schemas of the four original
  repositories. Each area module exports `z.output` row types; the hand-written raw-row
  interfaces in `src/types/rows.ts` became re-exports of those types. Types there that describe a
  mapped shape (after `mapInvestmentRow`, a formatter) stay hand-written.
- `requireRow(row, label)` in `rowContracts.ts` returns the single row of an
  `INSERT … RETURNING` (or another always-one-row query) and throws when it is missing, because a
  missing row there is an internal fault, not a "not found".
- Catch blocks that used to swallow any failure and fall back (report data fetchers,
  `autoResolveFxRateToEur`, the exchange-rate cache warm-up and full-history repair, the
  historical price fallback, quote backfill, the forecast accuracy read and the broker-account
  label lookup) rethrow `RowContractError`. A contract violation is a data fault, not a transient
  failure, and must not be hidden behind a fallback.

### Backend types

- `query<R>()` in `src/database/connection.ts` and `QueryRunner` in `src/types/rows.ts` default
  to `unknown` rows instead of `any`. A type argument on `query<R>()` is an unchecked claim; the
  checked path is `queryRows`/`checkRows`. No explicit `any` remains in backend source.
- `noUncheckedIndexedAccess` is on for backend source (`tsconfig.json`) and tests
  (`tsconfig.tests.json`, which extends it). The owner chose both, 2026-10-09.
- The OpenAI egress helper (`src/integrations/openai/egress-helper.mjs`) stays an `.mjs` entry
  point because it runs under a deny-by-default macOS Seatbelt profile, and changing how the
  runtime loads it there can only be verified on macOS. It is type-checked through `// @ts-check`
  and JSDoc and is listed in the backend `tsconfig.json`. `brokerClient.ts` checks the helper's
  stdout against a zod schema; a mismatch fails with `BROKER_INVALID_OUTPUT`.

### Frontend API responses

- About 170 more API calls are checked against schemas in `packages/types/src/contracts/`
  (`@vision/types/contracts`), one module per API area: planned, splits, tags, settings, admin,
  analysis, ai, attachments, imports, crossWorkspace, portfolio, portfolioImports, market, info,
  aggregations, research, researchAi, researchDossiers and charts, next to the original
  transactions, accounts, categories and recipients. `common.ts` adds `WireDateSchema`,
  `WireTimestampSchema`, `CurrencyCodeSchema`, `wirePageOf` and `wireCollectionOf`.
- Wire schemas require every field the backend always sends. `.optional()` marks a key the
  backend omits on some responses and `.nullable()` a SQL-nullable value. They stay
  `z.looseObject`, so an added backend field does not break a screen. This supersedes ADR-193's
  "identity fields required, other fields optional" rule; test fixtures must be shaped like real
  responses.
- Save (mutation) responses whose result the UI reads are checked too (owner, 2026-10-09).
- `requestWithQuery(endpoint, params, options)` accepts `{ signal, schema }`; a bare
  `AbortSignal` is still accepted.

## Consequences

- A drifted column in any checked read now fails the request with a 500 in production, as
  ADR-193 already decided for the four original repositories. Fallback paths no longer turn such
  a failure into an empty section or a missing rate.
- Backend tests that mock `query` must build rows shaped like node-postgres returns them. The
  builders live in `tests/helpers/pgRows.ts`, `tests/helpers/portfolioPgRows.ts` and
  `tests/helpers/aiRows.ts`. Frontend tests build full transaction, account, category and
  recipient rows with `apps/frontend/src/test/msw/rowFixtures.ts`; other fixtures are written
  out in full.
- Indexed access returns `T | undefined` in the backend, so code handles a missing element
  explicitly instead of assuming it.
- The per-area row modules are large (the two portfolio modules are about 900 lines each) but
  keep each schema next to the queries of its area.
- Writing the full schemas surfaced and fixed several bugs: the tags list filter now sends
  `active`; zero-argument `COUNT`, `SUM`, `AVERAGE`, `MIN` and `MAX` analysis formulas return an
  `ARITY` error; the Wise adapter skips a row whose currency is not an ISO-4217 code; report
  section ids such as `constructor` no longer resolve to inherited object members; broker
  snapshot dates no longer shift a day east of UTC; portfolio summaries keep the investment row's
  calendar-day maturity date.

## Related

- [[docs/adr/193-zod-runtime-contracts|ADR-193]]
- [[docs/adr/192-backend-tests-strict-typescript|ADR-192]]
- [[docs/adr/191-retire-backend-checkjs|ADR-191]]
- [[docs/reference/database-query-patterns#Row contracts (ADR-193)|Row contracts]]
- [[docs/reference/code-patterns#Row contracts for new queries (ADR-193)|Row contracts for new queries]]
- [[docs/reference/frontend-api-client#Response contracts|Response contracts]]
- [[docs/reference/typescript-types|TypeScript types]]
- [[docs/adr/index|All ADRs]]
