---
title: "ADR-193: Zod runtime contracts at the boundaries"
type: adr
status: accepted
date: 2026-10-08
tags: [adr, type-safety, zod, validation, backend, frontend, electron, adr-192]
description: "Data crossing a boundary is checked at runtime with zod: HTTP requests through one parseInput helper (400 on failure), bank and portfolio adapter output, stored parser configs and PostgreSQL rows through data contracts (strict in tests and development, one production switch, never a 400), selected frontend API reads, and every Electron IPC channel. Phase 4 of the type-safety plan."
aliases: [adr-193, zod runtime contracts, type-safety phase 4]
---

# ADR-193: Zod runtime contracts at the boundaries

## Status

Accepted. Phase 4 of the type-safety plan, after
[[docs/adr/192-backend-tests-strict-typescript|ADR-192]] made every backend test strict
TypeScript.

## Date

2026-10-08

## Context

Strict TypeScript only describes data the program built itself. Values that cross a boundary are
whatever the other side sent: Express hands routes `any` for `req.body` and loosely typed
`req.query`, node-postgres returns rows typed by a generic the database never checks, bank CSV
adapters emit rows the import pipeline trusts, and Electron IPC handlers receive arbitrary
renderer arguments. Validation existed, but each router had its own helpers and messages, some
routes read `req.body.x` before any check (a missing JSON body became a 500), and a database
column whose type drifted from its TypeScript type went unnoticed.

## Decision

### HTTP requests: one parsing helper, a 400 on failure

- Routes parse `req.params`, `req.query` and `req.body` with
  `parseInput(schema, value, options)` from `apps/node-backend/src/lib/zodInput.ts`. A failure
  throws `ValidationError`, so the response is the usual 400 `VALIDATION_ERROR` with the issues
  joined into one message. Options keep established texts: `prefix`, `separator` and `omitPaths`.
- `bareMessages` (reports nested issues without a path prefix) and `guardField` (wraps an
  existing throwing guard) live in the same module. Shared route schemas live in
  `src/routes/_requestSchemas.ts`, `_inputBridges.ts` and `_importInput.ts`.
- Accepted values and existing 400 texts stay the same unless a change is listed in the pull
  request. Lenient query knobs that already fell back (pagination clamps, unknown flags) keep
  their fallbacks.
- `parseInput` is only for untrusted input. A zod check on data Vision produced (stored JSON,
  model output, rows) is a server fault and never a 400. The error handler has no blanket
  `ZodError` to 400 mapping.
- The structural `ExpressRequest` type (`src/types/express.ts`) now types `body` as `unknown` and
  `query` as `Record<string, unknown>`. Handlers typed by `express`'s own `Router` still receive
  `any` from `@types/express`; the convention there is to pass the raw value to `parseInput` or to
  a service function that validates it with zod.

### Data Vision produced: data contracts

- Bank adapter output is checked once in the adapter registry
  (`services/importPipeline/adapters/index.ts`) against `parsedBankTransactionSchema`, including
  the generic adapter used for custom parser configs. Portfolio adapter output is checked once in
  `portfolioGenericAdapter.parseWithConfig`. Saved parser configs are re-checked when
  `customParserConfigRepository` reads them.
- PostgreSQL rows from the main transaction, planned-transaction, split and account repository
  reads are checked with `checkRows`, `queryRows` and `queryOne` from
  `src/database/rowContracts.ts`. Schemas in `src/database/rowSchemas.ts` describe what
  node-postgres actually returns (NUMERIC and BIGINT as strings, DATE and TIMESTAMPTZ as `Date`);
  `src/types/rows.ts` derives those row types from the schemas. Schemas only check: callers
  receive pg's own objects, and a schema with a transform does not compile as a row schema.
- A mismatch is a bug in Vision, not bad input. `dataContractMode()` in `src/lib/dataContract.ts`
  throws in tests and development (including an unset `ENVIRONMENT`/`NODE_ENV`) and follows
  `PRODUCTION_DATA_CONTRACT_MODE` everywhere else. That one constant is the production switch for
  adapter output, parser configs and rows. It is `"log"`: warn with issue paths and codes, then
  pass the data through unchanged.
- Messages and logs carry paths, codes and type names only, never values, because the values are
  personal financial data.

### Frontend API responses

- `apiRequest` in `apps/frontend/src/lib/api/client.ts` takes an optional `schema`, and
  `checkResponseContract` checks reads that go through `requestWithQuery`. Strict in development
  and tests (`ApiContractError`, not retried); in production `PRODUCTION_RESPONSE_CONTRACT_MODE`
  is `"warn"`: log the endpoint path without its query string and the issue paths, return the
  data unchanged.
- The schemas live in `packages/types/src/contracts` (`@vision/types/contracts`). The first
  checked reads are transactions, accounts, categories (list and tree) and recipients (list,
  detail, patterns). Their runtime schemas require only identity fields and type-check every
  other field when present, because many screen-test fixtures are partial.

### Electron IPC

- `packaging/electron/runtime/ipc-schemas.js` holds one contract per IPC channel, and
  `registerHandler` in `main.js` refuses to register a channel without one. The preload stays
  sandboxed and has no zod; the main process validates.

### Zod 4 pitfalls recorded here

- In `z.object`, a missing key fails even for `z.unknown()`; absent fields need `.optional()`.
  `z.unknown().optional().transform(fn)` still runs `fn` for an absent key.
- `z.record` and `z.looseObject` silently drop a `__proto__` key, so key allow-lists that must
  reject it run on the raw object.

## Consequences

- Malformed requests that used to reach a handler and fail with a 500 now return a 400, and some
  previously tolerated wrong types (for example a string where a boolean is documented) are
  rejected. Each is listed in the pull request and pinned by a route test.
- A schema or fixture that disagrees with the real data fails tests loudly. Test fixtures for the
  checked repositories and responses must be shaped like real rows and responses.
- Changing the production behaviour from logging to blocking is a one-line change per side
  (`PRODUCTION_DATA_CONTRACT_MODE`, `PRODUCTION_RESPONSE_CONTRACT_MODE`).
- Checking costs a few microseconds per row. Most repository queries (about 850 sites) are not
  checked yet; they convert one repository at a time, starting with NUMERIC, BIGINT, `COUNT(*)`
  and JSON-aggregate columns.

## Related

- [[docs/adr/192-backend-tests-strict-typescript|ADR-192]]
- [[docs/adr/191-retire-backend-checkjs|ADR-191]]
- [[docs/adr/026-unified-api-response-envelope|ADR-026]]
- [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021]]
- [[docs/security/input-validation|Input validation]]
- [[docs/adr/index|All ADRs]]
