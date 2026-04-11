---
title: Test Inventory
type: testing
status: active
date: 2026-04-11T10:19:03.000Z
tags:
  - testing
  - inventory
  - coverage
  - vitest
  - react-testing-library
description: Inventory of existing tests and coverage areas across frontend and backend
aliases:
  - test coverage
  - test list
  - test inventory
related_code:
  - apps/frontend/src/hooks/useStatistics.test.ts
  - apps/frontend/src/components/forms/addTransactionForm.test.ts
  - apps/frontend/src/components/shared/dateUtils.test.ts
  - apps/frontend/src/components/tax/__tests__/SuggestedDeductionsCard.test.tsx
---

# Test Inventory

## Overview

This document tracks the current state of test coverage across the Vision codebase. The project uses **Vitest** for backend tests and **React Testing Library** for frontend component tests.

## Frontend Tests

### Existing Tests

| File | Type | What It Tests |
|------|------|---------------|
| `apps/frontend/src/hooks/useStatistics.test.ts` | Hook test | `useStatistics` hook behavior, exclusion toggles, data processing |
| `apps/frontend/src/components/forms/addTransactionForm.test.ts` | Unit test | Transaction form validation logic (Zod schema) |
| `apps/frontend/src/components/shared/dateUtils.test.ts` | Unit test | Date formatting utilities with various app settings |
| `apps/frontend/src/components/tax/__tests__/SuggestedDeductionsCard.test.tsx` | Component test | SuggestedDeductionsCard rendering and interactions |
| `apps/frontend/src/utils/currency.test.ts` | Unit test | Currency formatting utilities |

### Test Framework

- **Runner**: Vitest
- **Component testing**: React Testing Library
- **Assertions**: Vitest expect API
- **Mocks**: Vitest `vi.fn()`, `vi.mock()`

## Backend Tests

The backend test coverage should be inventoried by running:

```bash
bun run test
```

Backend tests are located in `apps/node-backend/src/` alongside source files as `*.test.js` files.

### Recently Updated Backend Coverage (2026-04-10)

| File | Area | Coverage Added |
|------|------|----------------|
| `apps/node-backend/tests/config.test.js` | Config/security | `ADMIN_AUTH_TOKEN` mapping + trim behavior |
| `apps/node-backend/tests/routes/investments.test.js` | Performance/regression | Bulk transactions cache-key includes `limit` |
| `apps/node-backend/tests/routes/transactions.test.js` | Security | CSV formula neutralization + sanitized route errors |
| `apps/node-backend/tests/routes/import.test.js` | Security | Sanitized import errors and stream error expectations |
| `apps/node-backend/tests/routes/admin.test.js` | Security | Sanitized admin errors and auth behavior assertions |
| `apps/node-backend/tests/routes/info.test.js` | Security/perf | `/api/info/refresh-views` route + limiter assertions |

## Coverage Gaps

### High-Priority Missing Tests

| Area | Files | Why It Matters |
|------|-------|----------------|
| **Import pipeline** | `bankAdapters.js`, `importService.js`, `streamingImportService.js` | Core data ingestion — each bank adapter needs parsing tests |
| **Deduplication** | `deduplication.js` | SHA-256 hashing and field-based matching logic |
| **Recurring detection** | `recurringDetectionService.js` | Complex interval detection algorithm |
| **Currency conversion** | `currencyConversionService.js` | Multi-source rate resolution, historical rates |
| **Price providers** | `priceProviderService.js` | Spike sanitization, provider fallbacks |
| **Materialized views** | `materializedViewService.js` | Call coalescing, concurrent refresh |
| **Loan repayment** | `loanRepaymentService.js` | Amortization calculations for 3 loan types |
| **Text normalization** | `textNormalization.js` | Recipient name cleaning, European number parsing |

### Medium-Priority Missing Tests

| Area | Files | Why It Matters |
|------|-------|----------------|
| **Repository layer** | All 13 repositories | SQL query correctness, edge cases |
| **Route handlers** | All 14 route files | Request validation, error responses |
| **Portfolio performance** | `portfolioPerformanceSnapshotService.js` | Daily forward-fill, spike sanitization |
| **IBAN validation** | `iban.js` | Mod-97 checksum algorithm |
| **Recurrence service** | `recurrenceService.js` | Date calculation for patterns |

### Frontend Missing Tests

| Area | Files | Why It Matters |
|------|-------|----------------|
| **VirtualDataTable** | `VirtualDataTable.tsx` | Most complex shared component |
| **Net Worth page** | `NetWorthPage.tsx` | Complex chart domain computation |
| **Statistics page** | `StatisticsPage.tsx` | Multiple chart interactions |
| **Portfolio hooks** | `usePortfolio.ts` | Data fetching and processing |
| **Contexts** | All 7 contexts | Provider behavior, default values |
| **API client** | `api.ts` | Retry logic, error handling |

## Running Tests

```bash
# All backend tests
bun run test

# Watch mode
bun run test:watch

# Single test file
bun vitest run src/path/to/test.test.js

# Test name pattern
bun vitest run --test-name-pattern="testName"
```

## Testing Conventions

- Test files are colocated with source files (`*.test.ts` / `*.test.tsx` / `*.test.js`)
- Component tests use `__tests__/` subdirectory for multiple test files
- Hook tests test the hook's return values and side effects
- Unit tests test pure functions with various input/output combinations
- Integration tests test API endpoints with real database queries

### Backend route and middleware coverage updates (2026-04-10)

| File | Area | Coverage Added |
|------|------|----------------|
| `apps/node-backend/tests/rateLimiter.test.js` | Middleware/security | Factory allow/deny behavior, window reset, IP fallback precedence, `adminRateLimiter` (10/min), `importRateLimiter` (5/min) |
| `apps/node-backend/tests/routes/admin.test.js` | Admin API | `GET /api/admin/update/check` release parsing + version resolution + no-release + invalid-JSON sanitized 500; `POST /api/admin/update/apply`; `POST /api/admin/update/apply-and-restart` |
| `apps/node-backend/tests/routes/marketLookup.test.js` | Market API | Quote input validation + mapping + failure fallback; news dedup, thumbnail normalization, partial-failure tolerance |

### Backend coverage additions (2026-04-11)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/currencyConversionService.test.js]] | Currency conversion service | Unsupported-currency fallback, `warmCache` dual-API failure fallback, ECB 90-day historical backfill |
| [[apps/node-backend/tests/routes/plannedTransactions.test.js]] | Planned transactions route | Loan term bounds validation, patch `recipient_name`/`category_name` name-to-id resolution, loan toggle-off schedule/field clearing |
| [[apps/node-backend/tests/routes/transactions.test.js]] | Transactions route | `normalize_to_eur` conversion path, duplicate detection `409`, unresolved recipient/category validation branches in patch flow |

Validation runs (passed): `bun vitest run tests/currencyConversionService.test.js tests/routes/plannedTransactions.test.js tests/routes/transactions.test.js`; `npm test -- --coverage`

Related code: [[apps/node-backend/src/services/currencyConversionService.js]], [[apps/node-backend/src/routes/plannedTransactions.js]], [[apps/node-backend/src/routes/transactions.js]]

### Backend coverage additions (2026-04-11, repository/schema)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/schemaInit.test.js]] | Schema initialization | Warm-start skip path when schema version is current; fallback full initialization + schema version stamp when lookup fails |
| [[apps/node-backend/tests/categoryRepository.test.js]] | Category repository | `createOrGet` normalization, insert success (`created: true`), conflict fallback returning existing enriched category (`created: false`) |
| [[apps/node-backend/tests/plannedTransactionRepository.test.js]] | Planned transaction repository | `getAll` empty-page fallback count query and guard against unnecessary execution/loan-schedule follow-up queries |

Validation runs (passed): `bun vitest run tests/schemaInit.test.js tests/categoryRepository.test.js tests/plannedTransactionRepository.test.js`; `npm test -- --coverage`

Related code: [[apps/node-backend/src/database/schemaInit.js]], [[apps/node-backend/src/repositories/categoryRepository.js]], [[apps/node-backend/src/repositories/plannedTransactionRepository.js]]


### Incremental backend coverage addendum (2026-04-11)

- [[apps/node-backend/tests/currencyConversionService.test.js]] adds a historical miss-cache regression scenario, verifying repeated historical misses do **not** cause duplicate DB lookups.
- Related code: [[apps/node-backend/src/services/currencyConversionService.js]]
- Validation context (passed): `bun vitest run tests/currencyConversionService.test.js`; `npm test -- --coverage` (overall `74.18/59.54/78.47/77.68`).


### Backend coverage addendum (2026-04-11, repository deep-branching)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/categoryRepository.test.js]] | Category repository | `getAll` filtered+enriched branch, `getCount`, `getById` null return, `update` no-op + normalization, `hardDelete`, `assignToRecipients` |
| [[apps/node-backend/tests/plannedTransactionRepository.test.js]] | Planned transaction repository | `getAll` rows-present hydration path (executions + loan schedule), `getById` null/hydrated, `create` loan success + rollback on schedule failure + non-loan no-schedule insert, `update` sanitized fallback + null update + hydration, `hardDelete` true/false, `addExecution` explicit/default date, `replaceLoanSchedule` success/rollback |

Validation runs (passed): `bun vitest run tests/categoryRepository.test.js tests/plannedTransactionRepository.test.js`; `npm test -- --coverage`

Coverage snapshot after this cycle: overall `76.84/61.72/80.74/80.29` (statements/branches/functions/lines).

Related code: [[apps/node-backend/src/repositories/categoryRepository.js]], [[apps/node-backend/src/repositories/plannedTransactionRepository.js]], [[docs/testing/testing|Testing Documentation]]


### Backend coverage addendum (2026-04-11, adapters + raw import service)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/wiseAdapter.test.js]] | Bank adapters | Wise adapter parsing/normalization paths |
| [[apps/node-backend/tests/sabbAdapter.test.js]] | Bank adapters | SABB adapter parsing/normalization paths |
| [[apps/node-backend/tests/visionAdapter.test.js]] | Bank adapters | Vision adapter parsing/normalization paths |
| [[apps/node-backend/tests/rawTransactionImportService.test.js]] | Raw import service | Dedup-throw fallback to `isDuplicateByFields`, generic-bank `importCSV` delegation, non-fatal raw-reference create failure, recipient/account branching (existing + new account, new recipient + primary account + notes), and sabb/wise/vision raw-repo routing |

Validation runs (passed):
- `bun vitest run tests/wiseAdapter.test.js tests/sabbAdapter.test.js tests/visionAdapter.test.js` (3 files, 15 tests)
- `bun vitest run tests/rawTransactionImportService.test.js tests/wiseAdapter.test.js tests/sabbAdapter.test.js tests/visionAdapter.test.js` (4 files, 31 tests)
- `bun vitest run --coverage --exclude tests/config.test.js` → overall `79.59/65.78/81.55/82.97` (statements/branches/functions/lines)

Related code: [[apps/node-backend/src/services/bankAdapters.js]], [[apps/node-backend/src/services/rawTransactionImportService.js]], [[docs/testing/testing|Testing Documentation]]

Known local caveat:
- Full `npm test -- --coverage` may fail in [[apps/node-backend/tests/config.test.js]] when local `.env.local` DB URL overrides expected default behavior (unrelated to this addendum).


### Backend coverage addendum (2026-04-11, info routes)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/routes/info.test.js]] | Info routes + cache warm orchestration | Route-level dependency mocks (DB, recurring detection, materialized views, FX cache helpers, portfolio snapshots); `GET /recurring-patterns` fallback semantics; `GET /exchange-rates` stale/current refresh branching + warm-failure warning + DB `500`; `POST /exchange-rates/refresh` success/error; `POST /refresh-views` success/failure; `GET /portfolio-performance` mapping/default date range/invalid-currency EUR fallback/error `500`; `warmInfoCaches` prewarm + failure-isolation/logging |

Validation runs (passed):
- `bun vitest run tests/routes/info.test.js`
- `npm test -- --coverage`

Coverage snapshot after this update: overall `81.12/66.86/84.49/84.53` and [[apps/node-backend/src/routes/info.js]] `93.62/78.72/100/94.58` (statements/branches/functions/lines).

Related source links: [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/database/connection.js]], [[apps/node-backend/src/services/recurringDetectionService.js]], [[apps/node-backend/src/services/materializedViewService.js]], [[apps/node-backend/src/services/currencyConversionService.js]], [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]], [[docs/testing/testing|Testing Documentation]]

### Backend coverage addendum (2026-04-11, portfolio transaction repository)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/portfolioTransactionRepository.test.js]] | Portfolio transaction repository | `getAllByInvestmentIds` empty-normalized-id return, id/type sanitization + clamped pagination limits, omitted type/limit branch; `getCount` single-id + type, normalized-id-array path, all-invalid-ids type-only path; `getSummary` grouped summary row return |

Validation runs (passed):
- `bun vitest run tests/portfolioTransactionRepository.test.js` (25 tests)
- `npm test -- --coverage` (827 tests)

Coverage snapshot after this update: overall `81.81/67.61/85.42/85.25`; repositories bucket `68.47/63.45/67.02/72.66`; [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]] `78.73/71.5/84.84/82.95` (statements/branches/functions/lines).

Related source links: [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]], [[docs/testing/testing|Testing Documentation]]


### Backend coverage additions (2026-04-11, managed loop safe/sequential)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/routes/marketLookup.test.js]] | Market lookup routes | Expanded quote/news route branch and response-shape coverage |
| [[apps/node-backend/tests/priceProviderService.test.js]] | Price provider service | Expanded provider-resolution and price-history handling branches |
| [[apps/node-backend/tests/investmentRepository.test.js]] | Investment repository | Expanded repository compatibility and query-path coverage |
| [[apps/node-backend/tests/streamingImportService.test.js]] | Streaming import service | Expanded streaming import control-flow and error-path coverage |
| [[apps/node-backend/tests/portfolioPerformanceSnapshotService.test.js]] | Portfolio performance snapshot service | Expanded snapshot generation and edge-case branch coverage |
| [[apps/node-backend/tests/infoRepository.test.js]] | Info repository | Expanded aggregation and conversion-path coverage |
| [[apps/node-backend/tests/materializedViewService.test.js]] | Materialized view service | Expanded refresh/coalescing and failure-path coverage |

Coverage snapshot after managed loop stop condition:
- Statements: **87.78%**
- Branches: **75.00%**
- Functions: **91.71%**
- Lines: **90.89%**
- Passing tests: **54 files**, **871 tests**

Loop artifacts:
- [[.claude/baselines/test-coverage-baseline-20260411-101903.md]]
- [[.claude/plans/test-coverage-sequential-safe-runbook.md]]
