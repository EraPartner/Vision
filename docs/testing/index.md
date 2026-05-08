---
title: Testing Documentation Index
type: testing-index
status: active
date: 2026-04-30
updated: 2026-05-08
last-updated: 2026-05-08
modified: 2026-05-08
last_updated_timestamp: 2026-05-08T00:00:00Z
added_phase_f1_backend_drift_detection: 2026-05-02
added_phase_f2_stale_refetch: 2026-05-02
added_phase_f3_dialog_completeness: 2026-05-02
added_phase_f4_playwright_parity: 2026-05-02
added_phase_f5_property_chaos: 2026-05-02
added_phase_f6_mutation_testing: 2026-05-02
added_dialog_integration_tests: 2026-05-01
added_api_client_unit_tests: 2026-05-01
added_dialog_422_validation_tests: 2026-05-03
added_onboarding_notification_dialog_tests: 2026-05-01
added_edge_coverage_sweep_e16: 2026-05-02
added_transaction_tags_test_completion: 2026-05-08
tags:
  - testing
  - index
  - quality
  - vitest
  - playwright
  - a11y
  - visual-regression
  - phase-1
  - frontend-phase-a
  - frontend-phase-b
  - frontend-phase-c
  - frontend-phase-d
  - frontend-phase-e
  - frontend-phase-f
  - contract-testing
  - context-testing
  - react-contexts
description: Testing strategies, patterns, and best practices for the Vision project
aliases:
  - testing
  - tests
  - QA
---

# Testing Documentation

> [!abstract] Overview
> Testing documentation for Vision. Covers frameworks, patterns, and best practices for both backend and frontend.

## Test Documentation

```dataview
TABLE WITHOUT FILE title AS "Topic", description AS "Description", date AS "Updated"
FROM "docs/testing"
WHERE type = "testing"
SORT title ASC
```

## Quick Reference

| Topic | Description |
|-------|-------------|
| [[docs/testing/testing\|Testing Guide]] | Comprehensive testing guide with patterns and best practices |
| [[docs/testing/frontend-component-integration\|Component-Integration Tests]] | RTL + MSW: render full pages, mock at the network boundary, drive with userEvent |
| [[docs/testing/frontend/api-client-unit\|API Client Unit Tests (E10)]] | 46 tests covering apiRequest retry, error parsing, envelope handling, query building |
| [[docs/testing/testing#frontend-phase-e11-virtualdatatable-component-integration-tests-2026-05-01\|VirtualDataTable Tests (E11)]] | 23 tests for rendering, search, sort, inline editing, and clear-all functionality |
| [[docs/testing/testing#frontend-phase-e15-onboarding-notifications-ai-chat-backup-and-import-tests-2026-05-01\|Onboarding/Chat/Backup Tests (E15)]] | 54 tests for wizards, notifications, AI chat, Electron backups, imports with three new conventions |
| [[docs/testing/frontend-component-integration#msw--rtl-advanced-patterns-2026-04-30\|MSW & RTL Advanced Patterns]] | Handler ordering, stale elements, multiple elements, role-based assertions (2026-05-01) |
| [[docs/testing/frontend-component-integration#error-state-tests-account-for-apirequest-retry-backoff\|apiRequest Retry Timeout Pattern]] | 5000ms timeout for error-state tests accounting for ~1500ms internal retry backoff (2026-05-02) |
| [[docs/testing/testing#mock-isolation-gotcha-bun--vitest-v1313-critical\|Mock Isolation Gotcha]] | Bun/Vitest v1.3.13 mock bleed issue — CRITICAL |
| [[docs/testing/testing#property-test-pattern-phase-8\|Property Test Pattern]] | Deterministic seeded-PRNG invariant testing (Phase 8) |
| [[docs/testing/test-inventory\|Test Inventory]] | Current test coverage status and gaps |
| [[apps/node-backend/tests/golden/INVENTORY\|Calculation Inventory]] | G/P/S coverage matrix — merge-gate source-of-truth |

## Test Types

| Type | Scope | Framework |
|------|-------|-----------|
| **Unit Tests** | Individual functions/services | Vitest |
| **Integration Tests** | API endpoints | Vitest + Supertest |
| **Component Tests** | Frontend UI atoms | React Testing Library |
| **Component-Integration Tests** | Frontend pages w/ network mocked | Vitest + RTL + MSW (see [[docs/testing/frontend-component-integration\|guide]]) |
| **E2E Tests** | Critical user flows w/ real backend | Playwright (see [[docs/testing/frontend/e2e\|guide]]) |
| **Property Tests** | Pure-calc invariants (Phase 8) | Vitest + mulberry32 seeded PRNG |
| **Golden Fixtures** | Pure-calc regression lock | Vitest + JSON snapshots (`UPDATE_GOLDENS=1`) |

## Test Coverage Areas

- Input validation
- Currency conversion
- Bank adapters
- API routes
- Security hardening regressions (sanitized errors, auth middleware, CSV export safety)
- Split route validation and CSV export responses
- Investment repository inheritance compatibility tests
- React components

## Tools

- **Vitest** - Backend unit tests; frontend unit and integration tests
- **React Testing Library** - Frontend component unit and integration tests
- **MSW** - HTTP mocking for component-integration tests (Phase A)
- **Playwright** - E2E tests for critical user flows (Phase B)
- **Bun** - Test runner

## Running Tests

```bash
# All tests
bun test

# Watch mode
bun test:watch

# Specific file
bun vitest run src/path/to/test.test.js
```

## Coverage Goals

> [!tip] Testing Guidelines
> - All new features require tests
> - Focus on user-facing behavior
> - Test error handling and edge cases
> - Never modify original code to make testing easier

## Related Documentation

- [[docs/guides/contributing\|Contributing Guide]] - Development workflow
- [[docs/features/index\|Feature Docs]] - What to test for each feature
- [[docs/api/index\|API Documentation]] - Endpoints to test

## Phase F1: Backend Drift Detection Sweep (2026-05-02)

**Status: COMPLETE** — Comprehensive contract testing to detect frontend regressions from backend changes. Every frontend-called endpoint now has MSW + live-API contract test coverage.

**What's new:**

1. **MSW Handlers Expanded** (`src/test/msw/handlers.ts`) — Default handlers for ~50 previously-unstubbed endpoints (admin update-check/vacuum, all aggregations, AI chat, attachments, categories sub-routes, imports, info routes, investments, recipients, reports, saved-charts, splits, transactions sub-routes, watchlist, market chart, planned-transactions).

2. **Contract Tests Expanded** (`src/test/msw/contracts.test.ts`) — Two new describe blocks (Phase F1: extended GET + extended mutations): 40 → **120 total contract tests**. One Zod schema per endpoint validates fixture shape on every PR.

3. **Live-API Contract Tests** (`src/test/live-contracts/live-contracts.test.ts`) — 13 → **37 live tests** hitting real backend on CI (skipped locally unless `LIVE_API_BASE` set).

4. **Playwright E2E Expanded** — Two new spec files:
   - `e2e/dialogs-edge.spec.ts` — backdrop click, Escape, focus-trap Tab/Shift-Tab, autofocus
   - `e2e/critical-flows.spec.ts` — page-load smoke (catches pageerrors), mutation roundtrips (create category/recipient → list refetch)
   - Wired into `test:e2e` script alongside existing `smoke.spec.ts`

**Test count delta:** 1147 → **1204 vitest tests** (+57 contract-level). +24 live-API. +9 Playwright specs (3 files total).

**How drift is caught:**
- Field renamed/type changed → MSW contract test + live-API contract test fire
- Endpoint removed → Live-API `404` or `ok=false`
- Page crashes from undefined data → `critical-flows.spec.ts` `pageerror` listener
- Dialog behavior regression → `dialogs-edge.spec.ts` keyboard/focus tests
- Visual layout drift → `test-e2e-visual` screenshot comparison

**Details:** [[docs/testing/test-inventory#phase-f1--backend-drift-detection-sweep-2026-05-02|Phase F1 in Test Inventory]]

## Phase F2: Stale Refetch / Mutation Invalidation (2026-05-02)

**Status: COMPLETE** — Verify that every CRUD mutation triggers appropriate list refetch via TanStack Query `invalidateQueries`. A failed invalidation means stale UI showing pre-mutation data.

**What's new:**

1. **RecipientsPage**: POST `/api/recipients` → asserts GET refires after Add Recipient submit
2. **OwesPage**: POST `/api/splits/owed/:id/settle-all` → asserts both split endpoints GET counters increment
3. **WatchlistPage**: DELETE `/api/watchlist/:id` → asserts watchlist GET refires after delete
4. **CryptoPage**: POST `/api/investments` → asserts investments GET refires
5. **StocksPage**: POST `/api/investments` → asserts investments GET refires after create flow
6. **StatisticsPage**: Year filter contract guard → asserts monthly-summary handler called with year param

**Pattern:** Stub GET handler with call counter; capture baseline after render; perform mutation; `await waitFor(() => expect(getCalls).toBeGreaterThan(before))`. Catches missing `queryClient.invalidateQueries` in mutation handlers.

**Test count delta:** 1204 → **1210** vitest tests (+6 new mutation-invalidation tests).

**Details:** [[docs/testing/test-inventory#phase-f2--stale-refetch--mutation-invalidation-sweep-2026-05-02|Phase F2 in Test Inventory]]

## Phase F3: Dialog Completeness Sweep (2026-05-02)

**Status: COMPLETE** — Every dialog that takes user input has at least one field-validation test (required guard or button-disabled state) and one submit-error test (5xx response → dialog stays open or toast fires).

**What's new:**

1. **TransactionInfoDialog**: Cancel without edit → no PATCH sent
2. **AddInvestmentFromMarketDialog**: Blank name → no POST (guard test)
3. **LinkTransactionDialog**: "Link & Execute" disabled with no selection; onExecute rejection keeps dialog open
4. **ExecutionHistoryDialog**: transactions GET 5xx → dialog renders without crash
5. **CustomChartBuilderModal**: POST `/api/saved-charts` 5xx → dialog stays open (no premature close)

**Coverage delta:** 1210 → **1219** vitest tests (+9 net; 6 new tests + 3 housekeeping fixes for multi-heading queries).

**Details:** [[docs/testing/test-inventory#phase-f3--dialog-completeness-sweep-2026-05-02|Phase F3 in Test Inventory]]

## Phase E16: Edge-Coverage Sweep (2026-05-02)

**Status: COMPLETE** — 30 test files extended with edge-case `describe('Edge cases')` blocks covering Escape close, data-state="open" modality guard, keyboard-nav focusable check, submit-error toast paths, 4xx/5xx page error tolerance, refetch invalidation, and context mutation/boot/persistence error paths.

**Test count delta:** Baseline 1046 → Post-sweep 1147 frontend tests (+101 tests across 30 files). 100% pass rate maintained.

**Details:** [[docs/testing/test-inventory#edge-coverage-sweep-2026-05-02--phase-e16|Edge-Coverage Sweep in Test Inventory]]

## Phase F4: Playwright Parity Expansion (2026-05-02)

**Status: COMPLETE** — Push browser-only edges (real backdrop, real focus trap, network drift, a11y scanning) to Playwright E2E. Vitest covers unit/component layer; Playwright closes the loop on real-browser signals.

**What's new (3 new e2e specs, 32 new tests):**
- `e2e/mutations-parity.spec.ts` — Full CRUD lifecycle in real browser (4 tests: Category create, Recipient create + persist-after-reload, Planned payment create, navigate-away-and-back invariant)
- `e2e/a11y.spec.ts` — Axe WCAG 2.1 A/AA scans on 9 key pages (9 tests, zero critical violations required)
- `e2e/network-drift.spec.ts` — Network listener catching 5xx/4xx during page boot (10 tests catching frontend → backend route mismatches)
- `test:e2e` script now runs all 3 new specs alongside smoke, dialogs-edge, critical-flows

**Test count delta:** 1219 → **1219 vitest** (unchanged); +**32 Playwright e2e tests**.

**Details:** [[docs/testing/test-inventory#phase-f4--playwright-parity-expansion-2026-05-02|Phase F4 in Test Inventory]]

## Phase F5: Property + Chaos Tests (2026-05-02)

**Status: COMPLETE** — Cover invariants (parser round-trips, envelope passthrough) and verify UI survives transient backend faults via random fault injection.

**What's new (3 new files, 14 new vitest tests):**
- `src/test/property/currency.property.test.ts` — 8 fast-check properties for `parseLocaleNumber` (round-trips, null/empty, stripping, never-throws)
- `src/test/property/envelope.property.test.ts` — 4 properties for `unwrapEnvelope` per ADR-026 (ok:true passthrough, non-envelope passthrough, never-throws)
- `src/test/property/chaos-resilience.test.tsx` — 2 chaos tests wrapping endpoints with random latency + 503 errors
- `src/test/msw/chaos.ts` — `chaos(handler)` decorator with deterministic mulberry32 PRNG; tunable via env (`VISION_CHAOS_ERROR_RATE`, `VISION_CHAOS_LATENCY_MS`, `VISION_CHAOS_SEED`)

**Test count delta:** 1219 → **1233 vitest** (+14 from property + chaos).

**Details:** [[docs/testing/test-inventory#phase-f5--property--chaos-tests-2026-05-02|Phase F5 in Test Inventory]]

## Phase F6: Mutation Testing Harness (2026-05-02)

**Status: COMPLETE** — Wire Stryker mutation testing framework to measure test *quality* (do tests catch realistic faults?) beyond *coverage*.

**What's new:**
- `stryker.config.json` — Vitest runner, TypeScript checker, `coverageAnalysis: perTest`; scope: `src/utils/currency.ts` + `src/lib/api/client.ts`; HTML report to `reports/mutation/mutation.html`
- `package.json` script: `"test:mutation": "stryker run"` (opt-in, not in CI yet)
- Dev deps: `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`, `@stryker-mutator/typescript-checker`

**Why scoped:** Full-codebase mutation testing takes hours. Seed baseline on two highest-leverage pure-logic modules (currency formatting + API client envelope/error parsing) to identify tests with low semantic value (kill rate < 60%).

**Run locally:** `bun run test:mutation` from `apps/frontend`

**Details:** [[docs/testing/test-inventory#phase-f6--mutation-testing-stryker-2026-05-02|Phase F6 in Test Inventory]]

## Coverage Update (2026-04-11)

- Targeted backend coverage was added for currency conversion fallback behavior and planned/transaction route patch validation branches.
- Tests: [[apps/node-backend/tests/currencyConversionService.test.js]], [[apps/node-backend/tests/routes/plannedTransactions.test.js]], [[apps/node-backend/tests/routes/transactions.test.js]]
- Details: [[docs/testing/testing|Testing Documentation]] and [[docs/testing/test-inventory|Test Inventory]]

### Coverage update addendum (2026-04-11)

- Additional backend coverage was added for repository-level regressions (category upsert/get semantics and planned-transaction pagination query paths).
- Tests: [[apps/node-backend/tests/categoryRepository.test.js]], [[apps/node-backend/tests/plannedTransactionRepository.test.js]]
- Related code: [[apps/node-backend/src/repositories/categoryRepository.js]], [[apps/node-backend/src/repositories/plannedTransactionRepository.js]]

> [!note] Schema initialization test archived
> Schema bootstrap testing was removed in Phase 1 (2026-04-21) when `schemaInit.js` was replaced by Alembic migrations ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]).


### Coverage update addendum (2026-04-11, adapters/raw import)

> [!info] Phase C Update (April 2026)
> The raw transaction import service tests have been refactored as part of the Phase C consolidation into the unified `importPipeline` orchestrator. See import route tests and Feature: CSV Import for current implementation.

- Added targeted backend adapter/import branch coverage for Wise, SABB, and Vision adapters plus import orchestration paths.
- Tests: [[apps/node-backend/tests/wiseAdapter.test.js]], [[apps/node-backend/tests/sabbAdapter.test.js]], [[apps/node-backend/tests/visionAdapter.test.js]], [[apps/node-backend/tests/routes/import.test.js]] (Phase C)
- Related code: [[apps/node-backend/src/services/bankAdapters.js]], [[apps/node-backend/src/services/importPipeline/index.js]]
- Details and validation context: [[docs/testing/testing|Testing Documentation]], [[docs/testing/test-inventory|Test Inventory]]


### Coverage update addendum (2026-04-11, info route dependency branches)

- Added targeted backend coverage for info-route dependency orchestration, stale FX refresh branching, recurring-pattern fallback semantics, and cache prewarm failure isolation.
- Tests: [[apps/node-backend/tests/routes/info.test.js]]
- Related source: [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/database/connection.js]], [[apps/node-backend/src/services/recurringDetectionService.js]], [[apps/node-backend/src/services/materializedViewService.js]], [[apps/node-backend/src/services/currencyConversionService.js]], [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]]
- Validation + coverage snapshot: `bun vitest run tests/routes/info.test.js`; `npm test -- --coverage`; overall `81.12/66.86/84.49/84.53`, `info.js` `93.62/78.72/100/94.58` (statements/branches/functions/lines).
- Details: [[docs/testing/testing|Testing Documentation]], [[docs/testing/test-inventory|Test Inventory]]

### 2026-04-17 Phase 8 — Property tests + Calculation Inventory lock

- Six property-test suites under `apps/node-backend/tests/property/*.property.test.js` lock invariants for loan-schedule amortization, recurrence cadence, split allocation, monthly aggregation, category totals, and currency round-trip. All use deterministic `mulberry32` seeded PRNG and bounded 50–500 iterations.
- `apps/node-backend/tests/golden/INVENTORY.md` becomes the merge-gate source-of-truth — every pure-calc function carries a G (golden) / P (property) / S (smoke) marker. New calc code must update the inventory before landing.
- Aggregation shadow-mode middleware (see [[docs/adr/016-aggregation-shadow-mode|ADR-016]]) is exercised by dedicated unit tests covering `diffPayloads`, envelope unwrap, Postgres NUMERIC coercion, threshold edges, and legacy-failure isolation.
- See [[docs/testing/testing#property-test-pattern-phase-8|Property Test Pattern]] for the convention.

### Coverage update addendum (2026-04-11, portfolio transaction repository)

- Added targeted backend repository coverage for portfolio transaction query/filter branches and grouped summary return paths.
- Test: [[apps/node-backend/tests/portfolioTransactionRepository.test.js]]
- Related source: [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]
- Validation + coverage snapshot: `bun vitest run tests/portfolioTransactionRepository.test.js` (25 tests); `npm test -- --coverage` (827 tests); overall `81.81/67.61/85.42/85.25`; repositories bucket `68.47/63.45/67.02/72.66`; `portfolioTransactionRepository.js` `78.73/71.5/84.84/82.95` (statements/branches/functions/lines).
- Details: [[docs/testing/testing|Testing Documentation]], [[docs/testing/test-inventory|Test Inventory]]

## Mock Isolation Fix (2026-04-25)

Fixed critical Bun/Vitest v1.3.13 mock bleed issue in [[apps/node-backend/tests/aiChatTools.test.js]]:

- **Issue:** `vi.resetAllMocks()` does NOT clear `mockResolvedValueOnce` queues, causing unconsumed mock stubs to persist across tests and corrupt subsequent test execution.
- **Root Cause:** Vitest v1.3.13 queue clearing bug under Bun's context model.
- **Fix:** Removed unconsumed `mockResolvedValueOnce` from test 2 ("passes assetClass filter through to repository").
- **Impact:** All 46 tests in aiChatTools suite now pass cleanly.

See [[docs/testing/testing#mock-isolation-gotcha-bun--vitest-v1313-critical|Mock Isolation Gotcha (CRITICAL)]] for full mitigation strategy and detection patterns.

## Frontend Phase C: Accessibility & Visual Regression (2026-04-30)

Added automated accessibility checks (axe-core) and visual regression testing to the E2E suite.

**What's new:**

1. **Accessibility Checks (Axe-Core)** — Every smoke test calls `checkA11y(page)` using `@axe-core/playwright@4.11.2`. Scans for WCAG 2.1 violations (critical/serious fail; minors/warnings informational). Integration in `smoke.spec.ts`.

2. **Visual Regression Tests** — New `visual.spec.ts` captures full-page screenshots of 5 critical pages (dashboard, transactions, import, planned, portfolio). Uses `toHaveScreenshot({ fullPage: true })` with 2% pixel tolerance.

3. **Updated Playwright Configuration** — `apps/frontend/playwright.config.ts` now includes `snapshotDir: './e2e/__screenshots__'` and `expect.toHaveScreenshot.maxDiffPixelRatio: 0.02`.

4. **NPM Scripts** — `apps/frontend/package.json` adds `"test:e2e:visual": "playwright test e2e/visual.spec.ts --update-snapshots"` and `"test:e2e:update-snapshots": "playwright test --update-snapshots"`. Root `package.json` adds `"test:e2e:visual"` workspace script.

5. **CI/CD Jobs** — 
   - Existing `test-e2e` job (smoke + a11y) unchanged: runs on all pushes/PRs.
   - New `test-e2e-visual` job: runs on main branch pushes only (`if: github.event_name == 'push'`), automatically updates baselines with `--update-snapshots`, uploads artifacts with 30-day retention.

6. **Baseline Storage** — `apps/frontend/e2e/__screenshots__/` holds baseline PNG snapshots.

**Running locally (smoke + a11y):**
```bash
bun run test:e2e  # Auto-boots dev server
```

**Running locally (visual regression with update):**
```bash
bun run test:e2e:visual  # Updates baselines
```

**Running in CI:** Automatic — smoke+a11y on all PRs, visual regression on main pushes.

**Reference:** [[docs/testing/frontend/e2e|E2E Test Guide]], `.github/workflows/ci.yml`, `apps/frontend/playwright.config.ts`, `apps/frontend/e2e/smoke.spec.ts`, `apps/frontend/e2e/visual.spec.ts`

## Frontend Phase B: E2E Testing with Playwright (2026-04-30)

Introduced Playwright E2E layer to test critical user flows against a real backend (local dev server or CI Docker Compose stack).

**What's new:**

1. **Playwright Configuration** — `apps/frontend/playwright.config.ts` with baseURL from env (default `http://localhost:8080` locally, `http://localhost:3002` in CI), Chromium only, auto-boot `bun run dev` when not in CI.

2. **Smoke Tests** — `apps/frontend/e2e/smoke.spec.ts` with 5 critical route tests: dashboard, transactions, import, planned, portfolio. Each asserts the page heading is visible.

3. **NPM Scripts** — `apps/frontend/package.json` adds `"test:e2e": "playwright test"`, root `package.json` adds `"test:e2e": "bun run --filter 'vision-frontend' test:e2e"`.

4. **CI/CD Job** — `.github/workflows/ci.yml` new `test-e2e` job: builds Docker image, starts Compose stack, waits for `/health`, installs Playwright, runs tests with `CI=true` and `PLAYWRIGHT_BASE_URL=http://localhost:3002`, uploads artifact, tears down. Skipped for draft PRs.

**Running locally:**
```bash
bun run test:e2e  # Auto-boots dev server
# OR
PLAYWRIGHT_BASE_URL=http://localhost:3002 bun run test:e2e  # Use existing backend
```

**Running in CI:** Automatic via GitHub Actions (smoke tests + a11y checks added in Phase C).

**Reference:** [[docs/testing/frontend/e2e|E2E Test Guide]], Phase B baseline (now superseded by Phase C)

## Frontend Phase E10: API Client Unit Tests (2026-05-01)

Added comprehensive unit test coverage for the frontend API client layer.

**What's new:**

1. **API Client Tests** — `apps/frontend/src/lib/api/client.test.ts` with 46 unit tests covering:
   - Backoff delay (3 tests) — minimum 500ms, exponential with 30,000ms cap
   - Request ID generation (2 tests) — UUID format or fallback when crypto unavailable
   - ApiClientError class (3 tests) — error prototype, name, field storage
   - Envelope error parsing (9 tests) — unified/legacy formats, Pydantic 422, rate-limit 429, status code mapping
   - Envelope unwrapping (5 tests) — extract data, passthrough non-envelopes, no mutation
   - Retryable status codes (2 tests) — 408/429/502/503/504 retryable, 400/401/403/404/409/422/500 not
   - Query building (4 tests) — empty, encode, omit null/undefined, keep false/0
   - Exclusion query building (5 tests) — repeat arrays, set single values, omit empty
   - API request orchestration (7 tests) — GET/POST success, 204, non-OK errors, retry logic, validation error no-retry

**Test Results:** 46 tests, all passing, <2 seconds execution (node environment, no jsdom overhead)

**Key Patterns:**
- `vi.useFakeTimers()` + `vi.runAllTimersAsync()` for backoff delay testing
- `vi.stubGlobal()` for testing crypto fallback
- MSW `server.use()` per-test overrides for HTTP interception
- `Promise.allSettled()` to prevent unhandled rejections in exhausted-retry test
- Status code mapping via `it.each()` for parameterized tests

**Reference:** [[docs/testing/frontend/api-client-unit|API Client Unit Tests (E10)]], [[docs/adr/026-unified-api-response-envelope|ADR-026]]

## Frontend Phase D: Coverage Threshold Ratchet & Contract Tests (2026-04-30, expanded 2026-05-02)

Locked coverage thresholds at current actual levels and added comprehensive contract test layer to catch MSW fixture drifts from backend. Expanded 2026-05-02 with strict schemas, mutation coverage, and error envelope validation.

**What's new:**

1. **Coverage Threshold Ratchet** — Updated `apps/frontend/vite.config.ts` thresholds from placeholder (8/5/3/8) to actual Phase C levels (17/11/10/18) with comment explaining ratchet gates prevent regression. Bump per phase after adding meaningful tests.

2. **MSW Portfolio Summary Fix** — Updated `/api/portfolio/summary` handler in `apps/frontend/src/test/msw/handlers.ts` to return properly typed stub instead of empty `{}`.

3. **Expanded MSW Fixture Stubs** (2026-05-02) — Exported 5 stub constants in `apps/frontend/src/test/msw/handlers.ts`:
   - `TRANSACTION_STUB` — Complete transaction with all fields (balance: null, updated_at: null)
   - `CATEGORY_STUB` — Complete category with derived `category_name` field
   - `RECIPIENT_STUB` — Complete recipient with normalization fields
   - `INVESTMENT_STUB` — Complete investment with 30+ fields including provider config
   - `PLANNED_TRANSACTION_STUB` — Complete planned transaction with loan/recurrence config

4. **Expanded Mutation Handlers** (2026-05-02) — Added 15 POST/PATCH/DELETE handlers to `defaultHandlers`:
   - POST/PATCH endpoints return corresponding stub fixtures
   - DELETE endpoints return message envelopes with optional transaction-specific `details`
   - Covers: transactions, categories, recipients, investments, planned-transactions

5. **Contract Tests Expansion** (`apps/frontend/src/test/msw/contracts.test.ts`) — Node-env Vitest suite expanded from 16 to **40 tests** organized into 3 suites:

   **E1: Strict list item schemas (10 tests)**
   - Empty list envelope is valid (5 tests)
   - Item shape matches strict Zod schema (5 tests)
   - Schemas use explicit per-field validation (no `.passthrough()`)
   - Resources: categories, recipients, transactions, planned-transactions, investments

   **E2: Mutation handler contracts (15 tests)**
   - POST response matches item schema (5 tests)
   - PATCH response matches item schema (5 tests)
   - DELETE response matches delete response schema (5 tests)
   - Ensures endpoints return properly typed items

   **E3: Error envelope compliance (4 tests)**
   - 500, 404, 422, 503 error responses
   - Validates ADR-026 error envelope: `{ ok: false, error: { message, code? } }`
   - Covers both GET and mutation endpoints

   Schemas cover all resource types with strict per-field validation:
   - Paginated endpoints (categories, recipients, transactions, planned-transactions, investments): `{ items[], total, limit, offset, links[] }` with strict item schemas
   - Exchange rates, market news, import batches, portfolio summary
   - Error envelope per ADR-026

**Test Results (2026-05-02):**
- Backend: 871 tests across 54 files, all passing
- Frontend: 421 tests (376 phase A + 40 contract + 5 smoke/visual), all passing
- Coverage: statements 17% | branches 11% | functions 10% | lines 18%

**When to maintain contracts:**
- Backend schema changes → update corresponding Zod schema in E1 before shipping; never weaken schema
- New boot-time endpoint → add default handler + E1/E2 contract tests
- New mutation endpoint → add POST/PATCH/DELETE handlers + E2 tests + stub fixture
- MSW fixture drifts → contract tests catch immediately; fix the fixture, not the schema

Reference: [[docs/testing/frontend-component-integration|Component-Integration Test Guide]], [[docs/testing/test-inventory|Test Inventory]], [[docs/testing/testing#frontend-phase-d-coverage-threshold-ratchet--contract-tests|Phase D Details]], [[apps/frontend/vite.config.ts]], [[apps/frontend/src/test/msw/handlers.ts]], [[apps/frontend/src/test/msw/contracts.test.ts]]

## Frontend Phase A: Component-Integration Testing (2026-05-02 — COMPLETE)

Completed frontend component-integration test infrastructure. Phase A complete with 376 passing tests across 20 page-level test files. Pages render with MSW-mocked network at test time, no backend server needed. All frontend page integration test files are now gap-free. Updated 2026-05-02 with AdminPages (25 tests) and PortfolioPages (69 tests) expansions.

**What's new:**

1. **jsdom Polyfills for Radix UI** — `PointerEvent`, `hasPointerCapture`, `setPointerCapture`, `releasePointerCapture`, `scrollIntoView` stubs so Radix (Select, Dialog, Combobox) renders correctly in jsdom tests. Guarded by `typeof window !== "undefined"` so node tests unaffected.

2. **MSW Envelope Helpers** — `ok()` and `err()` factory functions matching ADR-026 unified envelope: `{ ok: true, data, meta? }` and `{ ok: false, error: { message, code? } }`.

3. **Expanded Default Handlers** — 13 boot-time endpoints covered: `/api/settings`, `/api/info`, `/api/categories`, `/api/recipients`, `/api/transactions`, `/api/planned`, `/api/planned-transactions`, `/api/investments`, `/api/aggregations/:name`, `/api/info/exchange-rates`, `/api/market/news`, `/api/import/batches`, `/api/admin/endpoint-liveness`.

4. **Component-Integration Tests** (20 pages, 376 tests):
   All frontend page test files complete with comprehensive CRUD, error states, export endpoints, and i18n coverage.
   - `TransactionsPage.integration.test.tsx` (18 tests) — empty-list, error state, Add Transaction dialog, form submission, export JSON success/error toasts
   - `ImportPage.integration.test.tsx` (23 tests) — CSV import workflow, bank source selection, file input handling
   - `LanguageSwitch.integration.test.tsx` (32 tests) — EN/NL switching across 8 pages with i18n validation
   - `OwesPage.integration.test.tsx` (17 tests) — splits tracking, Record Payment dialog, Settle all workflow, export CSV success/error toasts
   - `PortfolioPages.integration.test.tsx` (69 tests) — Investments, Performance, Net Worth pages with data loading and chart states (updated 2026-05-02 with 15 additional tests)
   - `CategoriesPage.integration.test.tsx` (18 tests) — Category CRUD, validation, error handling
   - `RecipientsPage.integration.test.tsx` (18 tests) — Recipient CRUD, validation, insights button
   - `AdminPages.integration.test.tsx` (25 tests) — Admin dashboard, provider health, endpoint liveness, database operations (updated 2026-05-02 with 8 new data-rendering tests)
   - `DashboardPage.integration.test.tsx` (16 tests) — Landing page, quick stats, recent activity
   - `PlannedPaymentsPage.integration.test.tsx` (16 tests) — New Payment dialog, loan scheduling, error states
   - `TaxOverviewPage.integration.test.tsx` (16 tests) — Tax profile dialog, employment step selection, deduction workflow
   - `StatisticsPage.integration.test.tsx` (13 tests) — Analytics page, chart rendering, period/category filters
   - `AIChatPage.integration.test.tsx` (15 tests) — AI chat interface, message submission, error handling
   - `ImportReviewPage.integration.test.tsx` (14 tests) — Import staging, transaction preview, conflict resolution
   - `RecipientInsightsPage.integration.test.tsx` (14 tests) — Recipient analytics, spending patterns, history
   - `PortfolioOverviewPage.integration.test.tsx` (14 tests) — Portfolio summary page rendering
   - `MarketLookupPage.integration.test.tsx` (12 tests) — Market data lookup, quote search, news display
   - `DbMaintenancePage.integration.test.tsx` (12 tests) — Database operations, view refresh, cache clearing
   - `AddTransactionDialog.integration.test.tsx` (10 tests) — Dialog open/close, form submission, duplicate detection
   - `NotFound.integration.test.tsx` (5 tests) — 404 page, navigation fallback

**Test Results:** 20 frontend test files, 376 tests, all passing (Phase A COMPLETE). Infrastructure: Vitest + RTL + MSW v2 with `renderWithApp` helper, `server.use()` per-test overrides, `ok()`/`err()` envelope helpers. Updated 2026-05-02: PortfolioPages +15 tests, AdminPages +8 tests.

**Key Gotchas Documented:**
- TaxOverviewPage dialog duplication → use `findAllByRole` + index first
- Radix Select accessible name → locate by `textContent` traversal
- Recipient category regex → use anchored pattern `/^employee/i`
- VirtualDataTable rows → skip row-measurement tests

**Status:** Phase A COMPLETE (all 20 pages, 376 tests, 2026-05-02). Phase B E2E (Playwright) COMPLETE. Phase C visual regression + accessibility COMPLETE. Phase D coverage threshold ratchet + contract tests COMPLETE.

Reference: [[docs/testing/frontend-component-integration|Component-Integration Test Guide]], [[docs/testing/test-inventory|Test Inventory]], [[docs/testing/testing#frontend-phase-a-component-integration-testing-2026-05-02|Phase A Details]], [[apps/frontend/src/test-setup.ts]], [[apps/frontend/src/test/msw/handlers.ts]], [[apps/frontend/src/pages/__tests__]]

## Phase E8+: Hook Unit Tests (2026-05-01, updated 2026-05-03)

Five hook unit test files added covering utility, data-fetching, and portfolio hooks:

| Hook Module | Tests | Coverage |
|-------------|-------|----------|
| useUtilityHooks | 13 | `useDebounce` (delay reset on rapid changes), `useCountUp` (RAF animation), `useOnlineStatus` (window events), `useIsMobile` (matchMedia mock) |
| useChartCurrencyFormatter | 5 | Pure Zustand-backed hook: currency formatting state and computation |
| usePlannedPayments | 8 | Fetch hook with apiClient: loading, error, add/delete/update/refetch paths |
| useQueryHooks | 13 | TanStack Query hooks: accounts, saved charts (queries + mutations), Ollama status/models, currency converter |
| **useInvestments (2026-05-03)** | **25** | **NEW: `useInvestmentsQuery` (3), `usePortfolioTransactionsQuery` (5), `useInvestmentMutations` (17)** — investment CRUD, portfolio transaction queries, price refresh with toast notifications |

**Total:** 5 files, **64 new tests**, all passing

**Key patterns:**
- Fake timers (`vi.useFakeTimers()`) for `useDebounce` and timing-sensitive hooks
- `renderHook` + `act` + `waitFor` for async hook state management
- MSW mocking for API-dependent hooks (`usePlannedPayments`, `useQueryHooks`)
- Provider wrapper stacking for TanStack Query and language context dependencies
- Per-file `// @vitest-environment jsdom` for DOM-dependent hooks
- **NEW (2026-05-03):** Async factory mock for `LanguageContext` with synchronous locale dictionary import (avoids Vitest module-loading complexity)

**Test execution:** <5 seconds

**New Pattern (useInvestments, 2026-05-03):**
- Mocks `LanguageContext` via async factory importing `@/locales/en` synchronously for `t()` translations
- `makeWrapper()` returns `QueryClientProvider` only (LanguageContext mocked, no provider needed)
- `act(() => {...})` for fire-and-forget `.mutate()` calls
- `await act(async () => {...})` for `.mutateAsync()` calls
- Spies on `toast.success`, `toast.warning`, `toast.error` for async toast verification
- Tests portfolio transaction bulk-endpoint fallback to per-investment requests when bulk fails
- Tests refreshPrices with live/stale/cached source differentiation via toast messages

**Related documentation:** [[docs/testing/test-inventory#e12-useinvestments-hook-unit-tests-2026-05-03|useInvestments Hook Tests (E12)]], [[docs/testing/test-inventory|Test Inventory]], [[docs/testing/testing#context-unit-tests-frontend-2026-05-03|Testing Guide]]

## Context Unit Tests Added (2026-05-03)

Five context unit test files added to test React Context hooks and providers:

| Context | Tests | Coverage |
|---------|-------|----------|
| BelgianTaxProfileContext | 8 | Hook guard, loading state, settings fetch, profile mutations, error handling |
| SettingsContexts | 12 | useAppSettings (4), useSettings (4), useTheme (4) with Zustand store mutations |
| LanguageContext | 6 | Hook guard, initial state, language switching behavior |
| SettingsPreloadContext | 5 | API fetch integration, loading state, settings load, MSW mocking |
| WorkspaceContext | 6 | Hook guard, workspace state, switching behavior |

**Total:** 5 files, 37 tests, all passing

**Key techniques:**
- `renderHook` + `waitFor` for async context state
- MSW HTTP mocking for contexts with API calls
- Zustand store reset in `beforeEach` for direct store testing
- Provider wrapper stacking for dependent contexts
- Per-file `// @vitest-environment jsdom` for DOM-dependent contexts

**Related documentation:** [[docs/testing/testing#context-unit-tests-frontend-2026-05-03|Context Unit Tests section]], [[docs/testing/test-inventory|Test Inventory]]

## Dialog Component Integration Tests Added (2026-05-01 — Phase A)

Three new dialog component integration test files test modal interactions with full provider stack:

**New Test Files:**
- `apps/frontend/src/features/categories/__tests__/AddCategoryDialog.test.tsx` — 11 tests covering create/edit modes, form validation, uppercase normalization, **422 validation error handling** (2026-05-03)
- `apps/frontend/src/features/recipients/__tests__/AddRecipientDialog.test.tsx` — 8 tests covering trigger, dialog open, form validation, submission, **422 validation error handling** (2026-05-03)
- `apps/frontend/src/components/shared/__tests__/WidgetVisibilityDialog.test.tsx` — 8 tests covering fully prop-driven widget visibility toggles and bulk actions

**Total dialog tests:** 27 tests, all passing

**422 Error Handling Tests (2026-05-03):**
All three dialogs now include tests for server-side 422 validation errors:
- Test pattern: `vi.spyOn(toast, "error")` + `server.use(http.post(..., () => err(422, "message")))`
- Verify error toast displays with pattern like `"failed to create [resource]"` (AddCategoryDialog, AddRecipientDialog)
- Verify transaction dialog also tests 422 validation error path in AddTransactionDialog.integration.test.tsx
- Ensures user-facing error messages are shown for validation failures returned by backend

**Key patterns demonstrated:**
1. **Trigger-Driven Create Mode** (AddCategoryDialog create, AddRecipientDialog) — Dialog opens from trigger button, closes after submission or cancel
2. **Callback-Driven Edit Mode** (AddCategoryDialog edit) — Dialog controlled via props, parent owns open/close state via callbacks
3. **Fully Presentational Props** (WidgetVisibilityDialog) — No internal state, all behavior via callbacks; parent is state owner
4. **Form Validation** — Empty/invalid forms block submit, keeping dialog open
5. **Callback Verification** — Mock `vi.fn()` callbacks to verify parent receives correct payloads

**Related documentation:** [[docs/testing/frontend-component-integration#dialog-component-integration-tests-2026-05-01---phase-a|Dialog Tests]]

## Dialog 422 Validation Error Tests (2026-05-03)

Three dialog component integration test files now include comprehensive tests for HTTP 422 validation error handling from the backend:

**Pattern (all three dialogs):**
1. `vi.spyOn(toast, "error")` to capture error toast calls
2. `server.use(http.post(..., () => err(422, "validation message")))` to simulate backend validation failure
3. User submits form with valid client-side form data
4. Assert error toast is shown with pattern: `expect.stringMatching(/failed to create [resource]/i)`
5. Use 5000ms timeout in `waitFor` to account for apiRequest retry backoff (~1500ms internal retry)

**Test files:**
- **AddCategoryDialog** — "shows error toast when server returns 422 validation error" (line 70-88)
  - Simulates `category already exists` validation failure
  - Verifies toast message matches `/failed to create category/i`
- **AddRecipientDialog** — "shows error toast when server returns 422 validation error" (line 78-95)
  - Simulates `name already exists` validation failure
  - Verifies toast message matches `/failed to create recipient/i`
- **AddTransactionDialog** — "shows error toast when server returns 422 validation error" (line 204-234)
  - Simulates `amount must be positive` validation failure
  - Verifies toast message matches `/failed to create transaction/i`

**Pattern documentation:** [[docs/testing/frontend-component-integration#dialog-component-integration-tests-2026-05-01---phase-a|Dialog Tests]], [[docs/testing/frontend-component-integration#error-state-tests-account-for-apirequest-retry-backoff|Error-State Test Timeout Pattern]]

## Frontend Phase A Complete: All 20 Page Integration Tests (2026-05-02)

Phase A testing infrastructure now includes comprehensive coverage of all 20 frontend pages. Final gap closures added export endpoint tests:

**TransactionsPage export JSON (2 new tests):**
- Export JSON shows success toast when download succeeds
- Export JSON shows error toast when download fails

**OwesPage export CSV (2 new tests):**
- Export CSV shows success toast when download succeeds (recipient detail view)
- Export CSV shows error toast when download fails (recipient detail view)

**Result:** All 20 frontend page integration test files now gap-free. Total: 376 tests across 20 files (updated 2026-05-02 with AdminPages + PortfolioPages expansions).

**Coverage matrix:**
- Core CRUD: Transactions, Categories, Recipients, Planned Payments ✓
- Portfolio: Investments, Performance, Net Worth ✓
- Exports: JSON (transactions), CSV (owes/splits) ✓
- Analytics: Statistics, Dashboard, Recipient Insights ✓
- Features: AI Chat, Market Lookup, Tax, Import Review, Database Maintenance ✓
- Utilities: 404 fallback, Language Switching (EN/NL) ✓
- Admin: Settings, Version checks, Database operations ✓

**Test execution:** <60 seconds in Vitest fast lane (jsdom environment).

**Pattern documentation:** See [[docs/testing/frontend-component-integration#frontend-export-tests-2026-05-02|Export Tests]] and [[docs/testing/frontend-component-integration#msw--rtl-advanced-patterns-2026-04-30|Advanced Patterns]].

## Integration Test Suite Fixes (2026-05-01)

All 34 integration test files (231 tests) now passing. Fixes discovered four key RTL + MSW patterns:

1. **MSW Handler Ordering** — Specific routes must register before wildcards (FIFO evaluation). Added explicit `/api/aggregations/monthly-summary` handler before generic `/:name` catch-all.

2. **Stale Element References** — Removed `.toBeInTheDocument()` assertions after awaited `findByRole()` calls. Component re-mounts between find and assertion create stale references; `await findByRole()` alone is sufficient.

3. **Multiple Elements Pattern** — Switched to `findAllByRole()` when pages render the same heading in multiple components (e.g., PageHeader + VirtualDataTable). Index the first match.

4. **Role-Based Over Text** — Use `findByRole()` instead of `findByText()` when text spans multiple DOM nodes. Roles are unique; text queries may match wrong elements.

**Pattern Details:** [[docs/testing/frontend-component-integration#msw--rtl-advanced-patterns-2026-04-30|MSW & RTL Advanced Patterns]]

**Test Summary:** 34 files, 231 tests, 0 failures, <60 seconds execution

**Code Fixes:** [[apps/frontend/src/test/msw/handlers.ts]], [[apps/frontend/src/pages/__tests__/CategoriesPage.integration.test.tsx]], [[apps/frontend/src/pages/__tests__/RecipientsPage.integration.test.tsx]], [[apps/frontend/src/pages/__tests__/AIChatPage.integration.test.tsx]], [[apps/frontend/src/pages/__tests__/PortfolioPages.integration.test.tsx]]
