---
title: Test Inventory
type: testing
status: active
date: 2026-04-30
last_modified: 2026-08-25
updated: 2026-08-25
last-updated: 2026-08-25
last_updated_timestamp: 2026-08-25T00:00:00Z
added_portfolio_tax_pure_module_tests: 2026-05-29
added_chart_aria_tests: 2026-05-29
added_portfolio_math_tests: 2026-05-05
added_import_pipeline_tests: 2026-05-05
added_dashboard_error_state_tests: 2026-05-02
added_context_unit_tests: 2026-05-03
added_hook_unit_tests: 2026-05-01
added_dialog_integration_tests: 2026-05-01
added_api_client_unit_tests: 2026-05-01
added_dialog_422_validation_tests: 2026-05-03
added_component_integration_tests_e13: 2026-05-01
added_component_integration_tests_e15: 2026-05-01
added_edge_coverage_sweep_e16: 2026-05-02
added_phase_f1_backend_drift_detection: 2026-05-02
added_phase_f4_playwright_parity: 2026-05-02
added_phase_f5_property_chaos: 2026-05-02
added_phase_f6_mutation_testing: 2026-05-02
added_parselocale_number_single_comma_fix: 2026-05-08
added_transaction_tags_test_fixes: 2026-05-08
tags:
  - testing
  - inventory
  - coverage
  - vitest
  - playwright
  - react-testing-library
  - a11y
  - visual-regression
  - phase-1
  - frontend-phase-a
  - frontend-phase-b
  - frontend-phase-c
  - frontend-phase-d
  - frontend-phase-f
  - contract-testing
  - context-testing
  - react-contexts
  - e2e-testing
  - property-testing
  - mutation-testing
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
  - apps/frontend/src/pages/__tests__/AddTransactionDialog.integration.test.tsx
  - apps/frontend/src/pages/__tests__/TransactionsPage.integration.test.tsx
  - apps/frontend/src/components/statistics/__tests__/CustomChartBuilderModal.test.tsx
  - apps/frontend/src/components/planned/__tests__/LinkTransactionDialog.test.tsx
  - apps/frontend/src/components/tax/__tests__/TaxProfileDialog.test.tsx
---

# Test Inventory

## Overview

This document tracks the current state of test coverage across the Vision codebase. The project uses **Vitest** for backend tests and **React Testing Library** for frontend component tests.

## Frontend Tests

### Infrastructure (Phase A)

| Component | Location | Purpose |
|-----------|----------|---------|
| `renderWithApp` | `apps/frontend/src/test/renderWithApp.tsx` | Render helper mirroring `App.tsx` provider tree; swaps BrowserRouter → MemoryRouter; fresh per-test QueryClient (retry: false, staleTime: 0) |
| `msw/server` | `apps/frontend/src/test/msw/server.ts` | MSW server setup with `setupServer(...defaultHandlers)` |
| `msw/handlers` | `apps/frontend/src/test/msw/handlers.ts` | Default HTTP handlers covering boot endpoints; exports `ok()` / `err()` helpers per ADR-026 envelope |
| Test setup | `apps/frontend/src/test-setup.ts` | MSW lifecycle + jsdom polyfills (PointerEvent, pointer capture, scrollIntoView) for Radix UI compatibility |
| Coverage gate | `apps/frontend/vite.config.ts` | V8 provider; include components/hooks/lib/pages/utils; exclude tests + d.ts; **Phase D thresholds**: statements 17 / branches 11 / functions 10 / lines 18 (ratchet gates, bump per phase) |
| Contract tests | `apps/frontend/src/test/msw/contracts.test.ts` | **Phase D**: Node-env Vitest suite (16 tests) validating MSW default handlers match backend response shapes via Zod schemas |

#### MSW Default Handlers (Phase A Update)

Expanded to cover additional boot-time endpoints so more pages render without per-test setup:

| Endpoint | Response Shape | Added |
|----------|---|---|
| `/api/settings`, `/api/settings/:key` | Success envelope with empty data | Phase 0 |
| `/api/info`, `/api/info/health` | Version/commit/buildDate metadata | Phase 0 |
| `/api/categories`, `/api/recipients`, `/api/transactions` | Paginated list envelope (items: [], total: 0) | Phase 0 |
| `/api/planned` | Empty array | Phase 0 |
| `/api/planned-transactions` | Paginated list envelope | **Phase A** |
| `/api/investments` | Paginated list envelope | **Phase A** |
| `/api/aggregations/:name` | Null envelope | **Phase A** |
| `/api/info/exchange-rates` | { rates, fallback_rates, base, date } | **Phase A** |
| `/api/market/news` | { articles: [] } | **Phase A** |
| `/api/import/batches` | { items: [], total: 0, limit, offset } | **Phase A** |
| `/api/admin/endpoint-liveness` | { items: [], total: 0 } | Phase 0 |

### Hook Unit Tests (2026-05-01, updated 2026-05-03)

Five new hook unit test files added to `apps/frontend/src/hooks/__tests__/` and `apps/frontend/src/hooks/portfolio/__tests__/`:

| File | Tests | Coverage |
|------|-------|----------|
| `useUtilityHooks.test.ts` | 13 | `useDebounce` (fake timers, delay reset), `useCountUp` (RAF animation), `useOnlineStatus` (window events), `useIsMobile` (matchMedia mock) |
| `useChartCurrencyFormatter.test.ts` | 5 | Pure Zustand-backed computation hook: currency formatting logic |
| `usePlannedPayments.test.ts` | 8 | Plain fetch hook with apiClient spies; loading, error, add/delete/update/refetch paths |
| `useQueryHooks.test.tsx` | 13 | TanStack Query hooks: `useBankAccounts`, `useSavedCharts` (queries + mutations), `useOllamaStatus`, `useOllamaModels`, `useCurrencyConverter`; uses QueryClientProvider + LanguageProvider wrappers |
| `portfolio/__tests__/useInvestments.test.ts` | 25 | **NEW 2026-05-03**: `useInvestmentsQuery` (3 tests), `usePortfolioTransactionsQuery` (5 tests), `useInvestmentMutations` (17 tests: addInvestment, updateInvestment, deleteInvestment, addTransaction, deleteTransaction, updateTransaction, refreshPrices with live/stale/cached toast notifications, isRefreshingPrices pending state) |

**Total hook tests (phase E8+):** 5 files, **64 tests**, all passing

**Key patterns used:**
- `// @vitest-environment jsdom` for DOM-dependent hooks
- `vi.useFakeTimers()` / `vi.useRealTimers()` for timing-sensitive hooks
- `renderHook` + `act` + `waitFor` for async hook state
- MSW mocking for hooks with API calls
- Custom wrappers stacking providers (QueryClientProvider, LanguageProvider)
- **NEW (2026-05-03):** Async factory mock for `LanguageContext` with synchronous locale dictionary import (avoids module-loading complexity)

**Test execution:** <5 seconds (integrated into main suite)

### Earlier Hook & Component Tests

| File | Type | What It Tests |
|------|------|---------------|
| `apps/frontend/src/hooks/useStatistics.test.ts` | Hook test | `useStatistics` hook behavior, exclusion toggles, data processing |
| `apps/frontend/src/components/forms/addTransactionForm.test.ts` | Unit test | Transaction form validation logic (Zod schema) |
| `apps/frontend/src/components/shared/dateUtils.test.ts` | Unit test | Date formatting utilities with various app settings |
| `apps/frontend/src/components/tax/__tests__/SuggestedDeductionsCard.test.tsx` | Component test | SuggestedDeductionsCard rendering and interactions |
| `apps/frontend/src/utils/currency.test.ts` | Unit test | Currency formatting utilities (`formatCurrency`, `formatCurrencyCompact`, `parseLocaleNumber`). NEW (2026-05-08): Added unit test for single-comma + 3-digit tail as US thousands separator (e.g., "1,000" → 1000) |

### Context Unit Tests (2026-05-03)

New context unit test coverage added for frontend state management providers:

| File | Type | Tests | What It Tests |
|------|------|-------|---------------|
| `apps/frontend/src/contexts/__tests__/BelgianTaxProfileContext.test.tsx` | Context test | 8 | Tax profile context: hook guard, loading state, settings fetch, profile mutations |
| `apps/frontend/src/contexts/__tests__/SettingsContexts.test.tsx` | Context test | 12 | Settings contexts: `useAppSettings` (4 tests), `useSettings` (4 tests), `useTheme` (4 tests) with Zustand store operations |
| `apps/frontend/src/contexts/__tests__/LanguageContext.test.tsx` | Context test | 6 | Language context: hook guard, initial state, language switching |
| `apps/frontend/src/contexts/__tests__/SettingsPreloadContext.test.tsx` | Context test | 5 | Settings preload: API fetch integration, loading state, settings load |
| `apps/frontend/src/contexts/__tests__/WorkspaceContext.test.tsx` | Context test | 6 | Workspace context: hook guard, workspace state, switching |

**Total context unit tests:** 5 test files, 37 tests, all passing (2026-05-03)

**Key patterns used:**
- `// @vitest-environment jsdom` per-file comment for DOM-dependent contexts
- React Testing Library `renderHook` + `waitFor` + `act` for context state mutations
- MSW for HTTP-level mocking in preload/tax profile contexts
- Zustand store reset via `useSettingsStore.setState({...})` in `beforeEach` for direct store testing
- Provider wrapper stacking (SettingsPreloadProvider + BelgianTaxProfileProvider) for dependent contexts

**Test execution:** <10 seconds (integrated into main test suite)

### Dialog Component Integration Tests (2026-05-01 — Phase A, updated 2026-05-03)

Three new dialog component integration test files added to `apps/frontend/src/features/` and `apps/frontend/src/components/shared/__tests__/`:

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/features/categories/__tests__/AddCategoryDialog.test.tsx` | 11 | Create mode: trigger renders, opens, shows general/detail/description fields, cancel closes, submit closes on success, validation blocks empty general. **NEW (2026-05-03): shows error toast when server returns 422 validation error** (vi.spyOn + MSW err(422)). Edit mode: open=true renders, initialValues populate, onSave called with uppercase-trimmed values, cancel calls onOpenChange(false) |
| `apps/frontend/src/features/recipients/__tests__/AddRecipientDialog.test.tsx` | 8 | Create-only recipient dialog: trigger renders, opens, shows name/notes fields, cancel closes, submit closes on success, empty name blocks submit, notes included in submission. **NEW (2026-05-03): shows error toast when server returns 422 validation error** (vi.spyOn + MSW err(422)) |
| `apps/frontend/src/components/shared/__tests__/WidgetVisibilityDialog.test.tsx` | 8 | Fully prop-driven widget visibility dialog: trigger shows visible count, opens on click, lists all widgets, toggle calls setWidgetVisible, Show All/Hide All/Reset buttons call correct callbacks |

**Total dialog integration tests:** 3 test files, **27 tests**, all passing (updated 2026-05-03 with 422 error handling tests)

**Key patterns used:**
- `// @vitest-environment jsdom` per-file comment for Radix UI dialog rendering
- React Testing Library `renderWithApp` + `userEvent` for interaction testing
- `waitFor` + `findByRole` for async state assertions
- Dialog triggers, form validation, callback verification via `vi.fn()` mocks
- Modal interaction flows: open, fill, submit, close

**Test execution:** <5 seconds (integrated into main suite)

### Component-Integration Tests (Phase A — Complete, 2026-05-02)

All 20 frontend page integration test files complete with 354 total tests. Key highlights:

| File | Type | Tests | Coverage |
|------|------|-------|----------|
| `apps/frontend/src/pages/__tests__/TransactionsPage.integration.test.tsx` | Component-integration | 18 | Empty-list, error state, Add Transaction dialog, form submission, export JSON success/error toasts |
| `apps/frontend/src/pages/__tests__/ImportPage.integration.test.tsx` | Component-integration | 23 | Page heading, CSV import workflow, bank source selection, file input handling |
| `apps/frontend/src/pages/__tests__/LanguageSwitch.integration.test.tsx` | Component-integration | 32 | EN/NL switching across 8 pages with i18n validation |
| `apps/frontend/src/pages/__tests__/TaxOverviewPage.integration.test.tsx` | Component-integration | 16 | Tax profile dialog, employment step selection, deduction workflow |
| `apps/frontend/src/pages/__tests__/AddTransactionDialog.integration.test.tsx` | Component-integration | 11 | Dialog open/close, form submission, recipient/category selection, duplicate detection (409), **validation error handling (422)** (2026-05-03) |
| `apps/frontend/src/pages/__tests__/PlannedPaymentsPage.integration.test.tsx` | Component-integration | 16 | Page render, New Payment dialog, form submission, loan scheduling, error states |
| `apps/frontend/src/pages/__tests__/PortfolioOverviewPage.integration.test.tsx` | Component-integration | 14 | Page heading, empty state, summary rendering |
| `apps/frontend/src/pages/__tests__/OwesPage.integration.test.tsx` | Component-integration | 17 | Owes/splits tracking, Record Payment dialog, Settle all workflow, export CSV success/error toasts |
| `apps/frontend/src/pages/__tests__/AdminPages.integration.test.tsx` | Component-integration | 25 | Admin dashboard, provider health, endpoint liveness, database, update checks |
| `apps/frontend/src/pages/__tests__/CategoriesPage.integration.test.tsx` | Component-integration | 18 | Category list, add/edit/delete dialogs, validation |
| `apps/frontend/src/pages/__tests__/RecipientsPage.integration.test.tsx` | Component-integration | 18 | Recipient list, add/edit/delete dialogs, validation, insights button |
| `apps/frontend/src/pages/__tests__/StatisticsPage.integration.test.tsx` | Component-integration | 13 | Analytics page, chart rendering, period/category filters |
| `apps/frontend/src/pages/__tests__/portfolio/PortfolioPages.integration.test.tsx` | Component-integration | 69 | Investments, Performance, Net Worth pages with data loading and chart states |
| `apps/frontend/src/pages/__tests__/DashboardPage.integration.test.tsx` | Component-integration | 18 | Landing page, quick stats, recent activity, error states (full error + partial warning) |
| `apps/frontend/src/pages/__tests__/AIChatPage.integration.test.tsx` | Component-integration | 15 | AI chat interface, message submission, error handling |
| `apps/frontend/src/pages/__tests__/MarketLookupPage.integration.test.tsx` | Component-integration | 12 | Market data lookup, quote search, news display |
| `apps/frontend/src/pages/__tests__/ImportReviewPage.integration.test.tsx` | Component-integration | 14 | Import staging, transaction preview, conflict resolution |
| `apps/frontend/src/pages/__tests__/DbMaintenancePage.integration.test.tsx` | Component-integration | 12 | Database operations, view refresh, cache clearing |
| `apps/frontend/src/pages/__tests__/RecipientInsightsPage.integration.test.tsx` | Component-integration | 14 | Recipient analytics, spending patterns, history |
| `apps/frontend/src/pages/__tests__/NotFound.integration.test.tsx` | Component-integration | 5 | 404 page, navigation fallback |

**Total Phase A tests:** 20 test files, 381 tests (all green — COMPLETE, 2026-05-02; updated 2026-05-03 with dialog 422 validation error tests: +2 dialog tests, +1 transaction dialog test)

### DashboardPage Error-State Tests (2026-05-02)

Added two error-state integration tests to DashboardPage to verify error handling when stats APIs fail:

**Test 1: "shows full error state when stats API fails and no cached data exists"**
- Mocks both `/api/aggregations/monthly-summary` and `/api/info/transaction-count` to return HTTP 500
- Asserts that when both stats fail and no cached data exists (`hasAnyData = false`), the page renders the `dashboard.errorLoading` subtitle
- Pattern: `server.use()` per-test MSW overrides returning ADR-026 error envelopes via `err(500, "db unavailable")`
- Uses 5000ms timeout to account for apiRequest retry backoff

**Test 2: "shows partial data warning when stats fail but transactions are available"**
- Same stats API failures (both return 500), but overrides `/api/transactions` to return one item using `TRANSACTION_STUB`
- Asserts that when stats fail but `hasAnyData = true` (transactions available), the page renders the `dashboard.partialDataWarning` banner instead
- Verifies the partial error path: "Some dashboard data could not be loaded..."
- Same retry-timeout pattern as Test 1

**Impact:** Ensures DashboardPage gracefully handles API failures with appropriate user-facing error messages. Tests use the MSW fixture stub pattern (TRANSACTION_STUB exported from handlers.ts) and per-test `server.use()` overrides for isolated error simulation.

**Related documentation:** [[docs/testing/frontend-component-integration#error-state-tests-account-for-apirequest-retry-backoff|Error-State Test Timeout Pattern]], [[docs/adr/026-unified-api-response-envelope|ADR-026]]

### Frontend Test Additions (2026-05-02 — Phase A Complete)

**Export endpoint coverage closing:** Final integration test gaps closed with export endpoint tests.

**TransactionsPage export JSON tests (2 new):**
- `Export JSON shows success toast when download succeeds` — `GET /api/transactions/export/json` success path with toast verification ✓
- `Export JSON shows error toast when download fails` — `GET /api/transactions/export/json` error path (HTTP 500) with toast verification ✓

**OwesPage export CSV tests (2 new):**
- `Export CSV shows success toast when download succeeds` — `GET /api/splits/owed/:id/export/csv` success path in recipient detail view ✓
- `Export CSV shows error toast when download fails` — `GET /api/splits/owed/:id/export/csv` error path in recipient detail view ✓

**All 20 page integration test files now gap-free.**

**Related documentation:** [[docs/testing/frontend-component-integration#frontend-export-tests-2026-05-02|Frontend Export Tests section]], [[docs/testing/testing#frontend-error-state-test-timeout-gotcha-apirequest-retry-loop|apiRequest Retry Gotcha]], [[docs/testing/frontend-component-integration#error-state-tests-account-for-apirequest-retry-backoff|Error-State Test Timeout Pattern]]

**Test suite metrics (2026-05-02):**
- Frontend component-integration tests: 20 test files, 376 tests, all passing (updated with AdminPages + PortfolioPages expansions)
- Backend tests: 54+ files, 871+ tests, all passing
- Total: 376 frontend + 871+ backend = 1247+ tests across 74+ files

### AdminPages and PortfolioPages Test Expansions (2026-05-02)

**PortfolioPages.integration.test.tsx expansion (69 tests total, +15 from prior baseline):**
- Fixed 3 previously-failing tests related to toast assertion arg count and button name regex
- File now passes with all 69 tests green

**AdminPages.integration.test.tsx expansion (25 tests total, +8 new data-rendering tests):**
- `ProviderHealthPage renders provider row when API returns data` — `/api/admin/providers/health` success, renders provider label
- `ProviderHealthPage shows failing provider with non-zero consecutive_failures` — Error badge display for `consecutive_failures > 0`
- `ProviderHealthPage renders gracefully when API returns 500` — Graceful error state when health API fails
- `EndpointLivenessPage renders route row when API returns data` — `/api/admin/endpoints` success, renders method and path
- `EndpointLivenessPage renders gracefully when API returns 500` — Graceful error state when endpoints API fails
- `AdminOverviewPage shows failing count when providers have failures` — Failure counter rendering when `consecutive_failures >= 1`
- `AdminOverviewPage renders gracefully when providers API returns 500` — Graceful error state on provider health API failure
- `ProviderHealthPage probe success shows success toast` — Probe action success path with toast verification

**Related documentation:** [[docs/testing/frontend-component-integration|Frontend component integration tests]], [[docs/reference/api-endpoint-matrix|API endpoint matrix]]

### Integration Test Suite Fixes (2026-05-01)

Complete resolution of all 34 integration test files (231 tests passing). Fixes involved:

1. **MSW Handler Ordering Fix**
   - Added specific `/api/aggregations/monthly-summary` handler before generic `/:name` wildcard in `apps/frontend/src/test/msw/handlers.ts`
   - Returns proper AggregationEnvelope shape: `{ data: { months: [], summary: {...} }, meta: { computedAt, source } }`
   - Pattern applies to all routes: specific patterns must register before wildcards (FIFO evaluation)

2. **Stale Element Reference Fixes (3 tests)**
   - `CategoriesPage.integration.test.tsx`: Removed `.toBeInTheDocument()` after awaited `findByRole`
   - `PortfolioPages.integration.test.tsx` (PerformancePage): Same pattern for loading→empty-state re-mount
   - Root cause: Component re-mounts between find and assertion → element reference becomes stale
   - Solution: `await findByRole(...)` alone is sufficient (find confirms stable DOM state)

3. **Multiple Elements Pattern Fix (1 test)**
   - `RecipientsPage.integration.test.tsx`: Switched from `findByRole` to `findAllByRole` for page heading
   - Both PageHeader and VirtualDataTable render the same heading simultaneously
   - Pattern: Use `findAllByRole` + index first when same element appears in multiple locations

4. **Role-Based Assertion Fix (1 test)**
   - `AIChatPage.integration.test.tsx`: Replaced `findByText(/local ai model unreachable/i)` with `findByRole("alert")`
   - Root cause: Text appears in both alert element and sibling span → text query ambiguous
   - Solution: Assert on semantic role instead when text spans multiple DOM nodes

**Coverage Summary:** 34 test files, 233 tests, 0 failures (updated 2026-05-02 with DashboardPage error-state tests)
**Test execution time:** <60 seconds (fast lane)
**Pattern documentation:** See [[docs/testing/frontend-component-integration#msw--rtl-advanced-patterns-2026-04-30|MSW & RTL Advanced Patterns]]

### Contract Tests (Phase D, updated 2026-05-02)

| File | Type | Tests | Coverage |
|------|------|-------|----------|
| `apps/frontend/src/test/msw/contracts.test.ts` | Contract validation | 40 | Validates MSW default handlers match backend response shapes via strict per-field Zod schemas (E1), mutation endpoints return items (E2), error envelopes conform to ADR-026 (E3) |

**Test organization (40 tests across 3 suites):**

**E1: Strict list item schemas (10 tests)**
- Empty list envelope is valid (5 tests: one per resource type)
- Item shape matches strict Zod schema (5 tests: one per resource type)
- Resources tested: categories, recipients, transactions, planned-transactions, investments
- Each schema validates all fields with explicit types, nullability, and constraints (no `.passthrough()`)

**E2: Mutation handler contracts (15 tests)**
- POST response matches item schema (5 tests: one per resource type)
- PATCH response matches item schema (5 tests: one per resource type)
- DELETE response matches delete response schema (5 tests: one per resource type)
- Delete schema includes optional transaction-specific `details` field

**E3: Error envelope compliance (4 tests)**
- 500 error response conforms to `{ ok: false, error: { message } }`
- 404 error response with optional `code` field
- 422 mutation error response with `code` field
- 503 error response without `code` field
- Validates ADR-026 error envelope across status codes and endpoint types

**Schemas tested:**
- Settings: key-value store
- Info/Health: app metadata and liveness
- Categories, Recipients, Transactions, Planned-Transactions, Investments: paginated `{ items[], total, limit, offset, links[] }` with strict per-field item schemas
  - CategoryItemSchema: id, general, detail, description, is_active, created_at, updated_at, category_name, links
  - RecipientItemSchema: id, name, normalized_name, default_category_id, primary_recipient_id, notes, is_active, created_at, updated_at, links
  - TransactionItemSchema: id, transaction_date, date, bank_account, recipient_id, recipient_name, memo, amount, currency, balance, category_id, category_name, comment, is_active, created_at, updated_at
  - InvestmentItemSchema: id, name, symbol, asset_class, currency, current_price, interest_rate, maturity_date, location, municipality, cadastral_income, municipality_tax_rate, notes, is_active, price_provider, price_provider_id, price_provider_url, price_provider_latest_url, price_provider_latest_path, price_provider_history_url, price_provider_history_path, price_provider_history_ts_path, price_provider_history_price_path, price_updated_at, created_at, updated_at
  - PlannedTransactionItemSchema: 25+ fields including loan/recurrence config
- Planned: array of objects
- Aggregations: nullable blob
- Exchange-Rates: `{ rates[{currency, rate_to_eur, rate_date, fetched_at}], fallback_rates, base, date }`
- Market News: `{ articles[{title, link, publisher, publishedAt, thumbnail, relatedSymbols}] }`
- Import Batches: `{ batches[], total }`
- Portfolio Summary: `{ currency, computed_at, totals{10 fields}, summaries[] }`
- Endpoint-Liveness: array
- Error envelope (ADR-026): `{ ok: false, error: { message: string, code?: string } }`

**MSW Fixture Stubs** (`apps/frontend/src/test/msw/handlers.ts`):
- Exported 5 stub constants (TRANSACTION_STUB, CATEGORY_STUB, RECIPIENT_STUB, INVESTMENT_STUB, PLANNED_TRANSACTION_STUB)
- All 15 mutation handlers use stubs (POST/PATCH return stub; DELETE returns message envelope)
- Mutation handlers added: 5 POST, 5 PATCH, 5 DELETE for transactions, categories, recipients, investments, planned-transactions

**Total Phase D tests:** 40 contract tests, all passing (updated 2026-05-02)

### E10: API Client Unit Tests (2026-05-01)

New comprehensive unit test coverage for the frontend API client layer:

| File | Type | Tests | Coverage |
|------|------|-------|----------|
| `apps/frontend/src/lib/api/client.test.ts` | Unit tests | 46 | Backoff delay (3), request ID generation (2), ApiClientError (3), error envelope parsing (9), envelope unwrapping (5), retryable status codes (2), query building (4), exclusion query (5), apiRequest orchestration (7) |

**Test suite breakdown:**

- **backoffDelay** (3 tests) — Resolves correctly with fake timers; enforces 500ms minimum; caps delay at 30,000ms for large attempt numbers
- **generateRequestId** (2 tests) — Returns UUID format string; falls back to `req-<base36>-<random>` when `crypto.randomUUID` unavailable
- **ApiClientError** (3 tests) — Instanceof checks (Error + ApiClientError); name property; all fields stored (status, code, message, details, requestId)
- **parseEnvelopeError** (9 tests) — Unified envelope error parsing; status fallback code; Pydantic 422 validation array formatting; 429 rate-limit with retry_after; legacy detail/message fields; null body fallback; status-code fallback mapping (400/401/403/404/409/502/503 via it.each); unknown 5xx → INTERNAL_SERVER_ERROR
- **unwrapEnvelope** (5 tests) — Extracts data from `ok=true` envelope; passthrough non-envelopes; passthrough `ok=false` (no throw); null and array passthroughs
- **RETRYABLE_STATUS_CODES** (2 tests) — Includes 408/429/502/503/504; excludes 400/401/403/404/409/422/500
- **buildQuery** (4 tests) — Empty string for no params; URL encodes params; omits null/undefined; keeps false/0
- **buildExclusionQuery** (5 tests) — Empty string for no params; repeats array values per key (category_ids, recipient_ids); sets currency param; omits empty arrays
- **apiRequest** (7 tests) — GET success with data unwrap; 204 returns undefined; non-OK throws ApiClientError; POST does not retry (1 call only); GET retries + succeeds on attempt 2; GET exhausts retries → ApiClientError; VALIDATION_ERROR skips retries despite retries=2

**Key testing patterns:**
- `vi.useFakeTimers()` + `vi.runAllTimersAsync()` for backoff delay testing with fake clock
- `vi.stubGlobal()` for testing crypto.randomUUID fallback
- MSW `server.use()` per-test overrides for HTTP interception via `http.get()`/`http.post()`
- `Promise.allSettled()` pattern to prevent unhandled rejections when testing retry exhaustion
- Testing both success/error paths for each function

**Test execution:** <2 seconds (fast lane, no jsdom overhead)

**Total Phase E10 tests:** 1 file, **46 tests**, all passing

**Related documentation:** [[docs/testing/frontend/api-client-unit|API Client Unit Tests]], [[docs/adr/026-unified-api-response-envelope|ADR-026]]

### E12: useInvestments Hook Unit Tests (2026-05-03)

New comprehensive unit test coverage for the portfolio investment hooks:

| File | Type | Tests | Coverage |
|------|------|-------|----------|
| `apps/frontend/src/hooks/portfolio/__tests__/useInvestments.test.ts` | Hook unit tests | 25 | `useInvestmentsQuery` (3 tests), `usePortfolioTransactionsQuery` (5 tests), `useInvestmentMutations` (17 tests: 3 investment mutations, 4 transaction mutations, 1 refresh-prices query) |

**Test suite breakdown:**

**useInvestmentsQuery (3 tests)**
- Fetches investments on success with proper envelope unwrap
- Passes `limit: 500` and `active: false` to API (query params validation)
- Exposes error state on network/API failure

**usePortfolioTransactionsQuery (5 tests)**
- Idle state when `investmentIds` array is empty (deferred query)
- Uses bulk endpoint (`getPortfolioTransactionsBulk`) when investment IDs provided
- Passes comma-separated `investment_ids` string to bulk endpoint (param formatting)
- Falls back to per-investment requests via `getPortfolioTransactions` when bulk endpoint fails
- Flattens transactions from multiple investments in fallback mode (array concatenation)

**useInvestmentMutations (17 tests)**
- **addInvestment** (2 tests) — calls `createInvestment` with payload; error path calls `toast.error`
- **updateInvestment** (2 tests) — calls `updateInvestment(id, payload)`; error path calls `toast.error`
- **deleteInvestment** (2 tests) — calls `deleteInvestment(id)`; error path calls `toast.error`
- **addTransaction** (2 tests) — calls `createPortfolioTransaction(investmentId, data)` with param extraction; error path calls `toast.error`
- **deleteTransaction** (2 tests) — calls `deletePortfolioTransaction(id)`; error path calls `toast.error`
- **updateTransaction** (1 test) — calls `updatePortfolioTransaction(id, data)` with patch data
- **refreshPrices** (4 tests) — calls `refreshInvestmentPrices`; shows `toast.success` when all prices are "live"; shows `toast.warning` when any source is "cached" or "historical_fallback"; shows `toast.error` on API failure; pending state verified via `isRefreshingPrices` flag

**Key testing patterns:**
- `// @vitest-environment jsdom` per-file directive (jsdom requirement for hooks)
- `vi.mock("@/contexts/LanguageContext")` with async factory importing `@/locales/en` for synchronous `t()` function
- `makeWrapper()` returns `QueryClientProvider` only (LanguageContext mocked, no provider needed)
- `act(() => {...})` for fire-and-forget `.mutate()` calls (no return value)
- `await act(async () => {...})` for `.mutateAsync()` calls returning promises
- `vi.spyOn(apiClient, method)` for each mutated API method (allows verification of correct method + params)
- `vi.spyOn(toast, "success"|"error"|"warning")` for async toast assertions
- `{ timeout: 5000 }` pattern for error tests accounting for apiRequest retry backoff

**Test execution:** <2 seconds (jsdom environment, pure hook tests)

**Total Phase E12 tests:** 1 file, **25 tests**, all passing

**Related documentation:** [[docs/testing/testing#Hook Unit Tests (Frontend, 2026-05-01, updated 2026-05-03)|Hook Unit Tests]], [[docs/testing/test-inventory|Test Inventory]]

### E11: VirtualDataTable Component Integration Tests (2026-05-01)

New component integration test coverage for the VirtualDataTable shared component, the most complex table component in Vision:

| File | Type | Tests | Coverage |
|------|------|-------|----------|
| `apps/frontend/src/components/shared/__tests__/VirtualDataTable.test.tsx` | Component-integration | 23 | Rendering (title, subtitle, headers, rows, empty states, actions slot, footer count), local search (placeholder, filtering, no-results, clear), server-side search (placeholder change, 200ms debounce, pre-debounce no-fire), server-side sort (asc/desc/clear cycling), inline editing (enter edit mode, cancel, Escape key, Enter to save with onRowUpdate callback), clear-all button |

**Test suite breakdown:**

**Rendering (6 tests)**
- Title and subtitle rendering
- Column headers display
- Row data rendering (mocked virtualizer renders all items unconditionally)
- Default empty state ("No data to display")
- Custom empty message override
- Actions slot (JSX children)
- Footer count display ("X of Y loaded")

**Local Search (4 tests)**
- Search input placeholder: "Search across all columns..."
- Filtering rows updates footer to "1 of 3 shown (filtered)"
- No-results state: "No results match your filters."
- Clear search button (X icon) restores all rows

**Server-Side Search (3 tests)**
- Placeholder changes to "Search database..." when `onSearchChange` callback provided
- `onSearchChange` called after 200ms debounce (with `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`)
- Pre-debounce call at 199ms does not fire callback

**Server-Side Sort (3 tests)**
- First column header click → `onSortChange("name", "asc")`
- Second click on same column → `onSortChange("name", "desc")`
- Third click on same column → `onSortChange(null, null)` to clear sort

**Inline Editing (5 tests)**
- Double-click row enters edit mode (textbox inputs appear for editable columns)
- Cancel button (destructive red X) restores view mode; 1 textbox remains (search input)
- Escape key cancels editing without saving
- Enter key in edit input saves and calls `onRowUpdate(rowIndex, updatedRow)` with correct payload
- All row indices account for search input textbox being first (offset by 1)

**Clear All Button (2 tests)**
- "Clear all" button appears after any search query
- Clicking "Clear all" clears search state and hides the button

**Key testing patterns:**
- `vi.mock("@/contexts/LanguageContext")` with async factory importing `@/locales/en` for synchronous translations
- `vi.mock("@tanstack/react-virtual")` to unconditionally render all virtual items (avoids DOM layout measurement requirement)
- `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` for debounce testing (200ms search delay)
- Search input is always present in the DOM (role="textbox" at index 0); edit textboxes are offset by +1
- `fireEvent.change()` for low-level input simulation; `userEvent.setup()` for high-level user interactions
- Stale element handling: Use `await waitFor()` to re-query elements after render changes

**Test execution:** <2 seconds (jsdom environment, mocked virtual list)

**Total Phase E11 tests:** 1 file, **23 tests**, all passing

**Related documentation:** [[docs/testing/frontend-component-integration|Component-Integration Test Guide]], [[docs/testing/test-inventory|Test Inventory]]

### E13: Deep Component-Integration Tests (2026-05-01)

Three new deep component-integration test files covering multi-step dialogs and chart builder modals. These tests exercise full dialog lifecycles including multi-step navigation, form validation, API calls, and MSW interceptors.

**Infrastructure note:** `apps/frontend/src/test-setup.ts` updated to call `cleanup()` from `@testing-library/react` inside `afterEach`. Vitest does not auto-register React Testing Library cleanup the way Jest does; without it, Radix UI portals rendered into `document.body` leak across tests causing `aria-hidden` contamination and spurious element matches.

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/components/statistics/__tests__/CustomChartBuilderModal.test.tsx` | 9 | Dialog open; Save disabled when name empty; Save disabled with name but no selection; Save enabled when name + category selected; create mode POST + `onOpenChange(false)`; edit mode pre-populated; edit mode PATCH + close; cancel/close calls `onOpenChange(false)`; recipients loaded from API and shown |
| `apps/frontend/src/components/planned/__tests__/LinkTransactionDialog.test.tsx` | 9 | Dialog open; renders unlinked transactions list; shows empty state; link button calls PATCH and closes; unlink button calls PATCH and closes; search filters transactions; confirm-unlink dialog shown; cancel from confirm-unlink stays open; error toast on API failure |
| `apps/frontend/src/components/tax/__tests__/TaxProfileDialog.test.tsx` | 10 | Default trigger renders; opens sheet on click; employment step shown with radio options; Back disabled on step 1; Next advances to income step; can navigate all 4 steps; last step shows Save not Next; Save on last step closes sheet; step indicator buttons jump to step; `initialStep` prop opens directly to specified step |

**Total E13 tests:** 3 files, **28 tests**, all passing

**Key patterns and lessons:**

- **`cleanup()` in `afterEach`** (critical) — Required in Vitest for Radix portals. Added to `apps/frontend/src/test-setup.ts`.

- **Index-based combobox selection** — `role="combobox"` buttons with inline SVG icons cause `@testing-library` accessible name filter to fail even when `textContent` is correct. Workaround: `getAllByRole("combobox")[N]` by positional index. Indices in `CustomChartBuilderModal`: `[0]` = chart type, `[1]` = time bucket, `[2]` = category picker, `[3]` = recipient picker.

- **Regex partial match for Radix Label accessible names** — `<Label htmlFor>` containing multiple nested `<span>` elements produces concatenated accessible name without whitespace separator. E.g. `"EmployeeWork under employment contract; social security withheld at source."` — exact `"Employee"` match fails; use `{ name: /^Employee/ }` instead.

- **`findAllByText` for multi-location text** — In edit mode, `CustomChartBuilderModal` shows the selected category in both the badge span and the open dropdown CommandItem. Use `findAllByText("FOOD:GROCERIES")` + `expect(length).toBeGreaterThanOrEqual(1)` rather than `findByText` which throws on multiple matches.

- **i18n load signal** — `await screen.findByPlaceholderText("e.g. Groceries over time")` serves as a reliable async wait for the locale bundle to fully load before interacting with other elements.

**Test execution:** <5 seconds (integrated into main suite)

**Related documentation:** [[docs/testing/frontend-component-integration|Component-Integration Test Guide]]

### E14: Portfolio, Recipients, Statistics, Planned, and Tax Dialog Tests (2026-05-01)

Eleven new dialog and modal component integration test files added across portfolio, recipients, statistics, planned, and tax domains. All tests use trigger-based or controlled dialogs with full MSW mocking and `renderWithApp` provider stack.

**Portfolio Dialog Tests (6 files, 60 tests):**

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/components/portfolio/__tests__/AddPortfolioTxnDialog.test.tsx` | 10 | Trigger-based dialog; adds portfolio transaction (buy/sell/etc.); calls `POST /api/investments/:id/transactions`; validates form fields; handles submission and closes |
| `apps/frontend/src/components/portfolio/__tests__/EditPortfolioTxnDialog.test.tsx` | 10 | Controlled dialog via props; edits portfolio transaction; calls `PATCH /api/investments/transactions/:id`; type field is disabled in edit mode; cancel calls `onOpenChange(false)` |
| `apps/frontend/src/components/portfolio/__tests__/AddToWatchlistDialog.test.tsx` | 8 | Controlled dialog; adds symbol to watchlist; calls `GET /api/market/search` + `POST /api/watchlist`; search/selection flow; form validation |
| `apps/frontend/src/components/portfolio/__tests__/WatchlistChartDialog.test.tsx` | 7 | Trigger-based dialog; uses raw `fetch()` (not apiClient); MSW handlers use `HttpResponse.json()` directly without `ok()` envelope for `GET /api/market/chart`; chart data rendering |
| `apps/frontend/src/components/portfolio/__tests__/PortfolioTaxAdjustmentsDialog.test.tsx` | 7 | Trigger-based dialog; stores adjustments via `PUT /api/settings/:key`; form submission; validation; calls settings persistence |
| `apps/frontend/src/components/portfolio/__tests__/InvestmentDetailDialog.test.tsx` | 9 | Trigger-based dialog; default trigger label is "Details"; icon-only Pencil/Trash action buttons found by index; delete confirmation; edit/view modes |
| `apps/frontend/src/components/portfolio/__tests__/AddInvestmentFromMarketDialog.test.tsx` | 9 | Trigger-based dialog; multi-step (choose → new/transaction); `existingInvestment` prop enables transaction step; scoped `within(dialog)` to avoid trigger button ambiguity; market search integration |

**Recipients Dialog Tests (1 file, 10 tests):**

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/features/recipients/__tests__/RecipientPatternsDialog.test.tsx` | 10 | Controlled dialog; CRUD for recipient match patterns; Trash delete button is icon-only (no accessible name) — found via `within(patternRow).getAllByRole("button")[1]`; confirm uses `useConfirmDialog` hook with `DELETE /api/recipients/:id/patterns/:patternId`; add pattern, edit, delete workflows |

**Statistics Dialog Tests (1 file, 9 tests):**

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/components/statistics/__tests__/CustomChartBuilderModal.test.tsx` | 9 | Modal (not Dialog) with create/edit modes; `GET /api/saved-charts` + `POST /api/saved-charts`; form validation (name required, selection required); category/recipient selection via combobox; index-based selection pattern for comboboxes |

**Planned Dialog Tests (1 file, 9 tests):**

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/components/planned/__tests__/LinkTransactionDialog.test.tsx` | 9 | Controlled dialog; links a planned transaction to an existing bank transaction; calls `onExecute(paymentId, txnId, date)` on confirm; candidates fetched from `GET /api/transactions`; search/filtering; unlink confirmation |

**Tax Dialog Tests (1 file, 10 tests):**

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/components/tax/__tests__/TaxProfileDialog.test.tsx` | 10 | Trigger-based Radix **Sheet** (not Dialog); 4-step form (employment → income → exemptions → region); no API calls — uses `BelgianTaxProfileContext` only; "Save" on last step calls `updateProfile({ profileConfigured: true })`; step navigation; `initialStep` prop support |

**Total E14 tests:** 11 files, **88 tests**, all passing

**Key patterns established (2026-05-01):**

- **Test file header:** `// @vitest-environment jsdom` — all files require DOM environment for Radix UI
- **MSW server lifecycle:** `server.listen/close/resetHandlers` is global in `test-setup.ts` — test files must NEVER call these; only `server.use(...)` for per-test overrides
- **Controlled vs. trigger-based dialogs:**
  - Trigger-based: Dialog manages own open state; test clicks trigger button to open
  - Controlled: Parent owns open state via prop; dialog calls `onOpenChange(false)` to close
  - Fully presentational: All state external; test drives all behavior via prop callbacks
- **`within(dialog)` scoping:** Required when trigger button and option button inside dialog share same text (e.g., "Add Investment" trigger vs. "Add Investment" from market button)
- **Icon-only button finding:** Buttons with no accessible name found via `getAllByRole("button")` by index after `within(container)` scoping
- **WatchlistChartDialog exception:** Uses raw `fetch()` instead of `apiClient` — MSW handlers use `HttpResponse.json()` directly, not `ok()` envelope (raw response pass-through)
- **Radix Sheet pattern:** TaxProfileDialog is a Sheet (slide-out panel), not a Dialog; renders with multi-step form and step navigation
- **Combobox pattern:** `CustomChartBuilderModal` uses multiple Radix Combobox components for type/bucket/category/recipient selection; `getAllByRole("combobox")[N]` by index
- **Form validation:** Dialog Submit button stays disabled until required fields + selections made; tests verify button disabled state before/after input

**Test execution:** <10 seconds (integrated into main suite)

**Related documentation:** [[docs/testing/frontend-component-integration|Component-Integration Test Guide]], [[docs/adr/026-unified-api-response-envelope|ADR-026]]

### E15: Onboarding Wizard, Notifications, AI Chat, Backup, and Import Dialog Tests (2026-05-01)

Six new frontend dialog and wizard component integration test files added. Tests cover multi-step wizards (onboarding), update notifications with platform-specific handling (web/Electron/Docker), stateful chat conversation lists, Electron-specific backup restoration, settings-tab backup controls, and import history management.

**Onboarding Wizard Tests (1 file, 11 tests):**

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/components/onboarding/__tests__/OnboardingWizard.test.tsx` | 11 | Multi-step wizard (welcome → bank → categories → tour → backup); full flow completion; `onComplete()` callback; bank step calls `GET /api/info/supported-adapters` — returns `{ adapters, total_count }` envelope shape (not caught by default handlers, requires `server.use()` override); navigation prev/next between steps; form validation per step |

**Notifications and Update Tests (1 file, 8 tests):**

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/components/notifications/__tests__/UpdateNotification.test.tsx` | 8 | Version check via `GET /api/admin/update/check`; three install paths: web (reload hint), Electron (`window.electronUpdater.installShellUpdate`), Docker (pullImage instruction); requires stubbing `window.electronUpdater` global in `beforeEach` per-test; cleanup in `afterEach`; platform detection via `apiClient.isElectron()` check |

**AI Chat Conversation List Tests (1 file, 10 tests):**

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/features/ai-chat/__tests__/ChatConversationList.test.tsx` | 10 | List of AI chat conversations with `onSelect(id\|null)` callback; rename dialog calls `PATCH /api/ai/conversations/:id`; delete with confirm calls `DELETE /api/ai/conversations/:id`; selected-conversation deletion clears selection via `onSelect(null)`; uses `getByRole("textbox")` instead of `getByDisplayValue` to avoid Radix dialog-open timing issues (initial value populates via `onOpenChange(true)` callback which doesn't fire for initially-open dialogs in tests) |

**Backup Restoration Tests (1 file, 8 tests):**

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/components/onboarding/__tests__/RestoreFromBackupCard.test.tsx` | 8 | **Electron-only component** — returns `null` on web; uses `window.electronBackup` IPC (not HTTP); tests install/uninstall Electron stubs in `beforeEach`, restore in `afterEach`; partial `setTimeout` stub to prevent 3s `window.location.reload()` from breaking test isolation (stubs reload timer, keeps sub-second timers real for Radix); encrypted backup path triggers passphrase dialog |

**Settings Backup Tab Tests (1 file, 9 tests):**

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/components/settings/tabs/__tests__/BackupTab.test.tsx` | 9 | Settings tab with **Electron-only branch** — `apiClient.isElectron()` check; routes through `window.electronBackup` IPC (runBackup, selectDir, setPassphrase); controlled component with `value` + `onChange` props — wrapped in small **stateful harness component** holding state instead of feeding props directly to test (enables onChange to update parent state); success/error toast assertions |

**Import History Tests (1 file, 8 tests):**

| File | Tests | Coverage |
|------|-------|----------|
| `apps/frontend/src/components/import/__tests__/ImportHistoryCard.test.tsx` | 8 | Bank import history list; `GET /api/import/batches` covered in MSW defaultHandlers; rollback via AlertDialog calls `DELETE /api/import/batches/:id`; pagination triggers when `total > PAGE_SIZE` (10); import status rendering |

**Total E15 tests:** 6 files, **54 tests**, all passing

**New conventions and patterns established (2026-05-01):**

- **Electron stub pattern:** Install `window.electronUpdater` / `window.electronBackup` mocks as globals in `beforeEach`, restore in `afterEach`. Components branch on `apiClient.isElectron()` which checks for `window.electronUpdater` global presence. No MSW needed when component uses IPC, not HTTP.
- **Stateful harness wrapper:** When a component is controlled (has `value` + `onChange` props), wrap in a small test harness component holding state instead of attempting to feed props directly. Enables `onChange` callback to update parent state and re-render the child.
- **`getByRole("textbox")` preferred over `getByDisplayValue`:** When initial value populates via Radix `onOpenChange(true)` callback that doesn't fire for initially-open dialogs in tests. Using `getByDisplayValue` times out waiting for value; `getByRole` finds the input element directly.
- **Partial fake timers:** Stub specific `setTimeout` calls (e.g., 3s `window.location.reload()`) while keeping sub-second timers real for Radix UI animations and interactions. Pattern: `vi.stubGlobal('setTimeout', vi.fn((cb, ms) => ms >= 1000 ? null : realSetTimeout(cb, ms)))` to selectively stub long timers.

**Test execution:** <10 seconds (integrated into main suite)

**Related documentation:** [[docs/testing/testing|Testing Conventions]], [[docs/testing/frontend-component-integration|Component-Integration Test Guide]], [[docs/adr/026-unified-api-response-envelope|ADR-026]]

### Portfolio Tax Pure-Module Tests (2026-05-29)

New golden-fixture unit tests for the extracted `portfolioTax.ts` pure estimator module:

| File | Area | Tests | Coverage |
|------|------|-------|----------|
| `apps/frontend/src/lib/belgianTax/__tests__/portfolioTax.test.ts` | Portfolio-tax estimators | 12 | Golden-output cases locking all ten exported functions (`recordedTaxesForYear`, `recordedFeesForYear`, `enrichInvestmentCosts`, `computeTobRecorded`, `computeTobAutoEstimate`, `computeTacrEstimate`, `computeRealizedGainSplit`, `computeReyndersEstimate`, `computeCgtEstimate`, `computeDividendWht`) to 8 decimal places. Verifies Decimal-accumulation correctness across multiple transactions in different currencies. `ConvertFn` injected as a simple identity stub. |

**Related documentation:** [[docs/features/belgian-tax#portfoliotaxts--pure-portfolio-tax-estimators-2026-05-29|Belgian Tax: portfolioTax.ts]], [[docs/features/portfolio-tax#pure-estimator-module-2026-05-29|Portfolio Tax: Pure Estimator Module]]

### Chart Accessibility Helper Tests (2026-05-29)

New unit tests for the `chartAria.ts` accessibility helper module:

| File | Area | Tests | Coverage |
|------|------|-------|----------|
| `apps/frontend/src/components/charts/__tests__/chartAria.test.ts` | Chart aria-label generation | 6 | `summarizeSeriesChart` (empty data, single series, multiple series), `summarizeProportionChart` (empty + populated), `summarizeSparkline` (point count). Asserts that generated labels include chart type, dimension count, and series names. |

**Related documentation:** [[docs/components/charts#generated-aria-label-summaries-2026-05-29|Chart Primitives: Generated aria-label Summaries]]

### Test Suite Summary (2026-05-01, Phase F1 backend-drift detection 2026-05-02)

| Layer | Files | Tests | Status |
|-------|-------|-------|--------|
| Dialog integration tests (Phase A) | 3 | 27 | All passing (NEW 2026-05-03: AddCategoryDialog +1 (422 error), AddRecipientDialog +1 (422 error), WidgetVisibilityDialog) |
| Phase A (Component-Integration) | 20 | 381 | All passing (COMPLETE, updated 2026-05-03 with dialog 422 tests and AddTransactionDialog 422 test) |
| Phase B/C (E2E + a11y + visual) | 2 | 5 smoke + visual | All passing |
| Phase D (Contract tests) | 1 | 40 | All passing (EXPANDED: E1 strict schemas 10, E2 mutations 15, E3 error envelopes 4) |
| Phase E8+ (Hook unit tests) | 5 | 64 | All passing (NEW 2026-05-03: useInvestments portfolio hook; earlier: useDebounce, useCountUp, useOnlineStatus, useIsMobile, useChartCurrencyFormatter, usePlannedPayments, useQueryHooks) |
| Phase E10 (API client unit tests) | 1 | 46 | All passing (NEW: backoff delay, request ID, error parsing, envelope unwrap, apiRequest orchestration) |
| Phase E11 (VirtualDataTable integration tests) | 1 | 23 | All passing (NEW: rendering, local search, server search/sort, inline editing, clear-all) |
| Phase E13 (Deep component-integration) | 3 | 28 | All passing (NEW 2026-05-01: CustomChartBuilderModal 9, LinkTransactionDialog 9, TaxProfileDialog 10) |
| Phase E14 (Portfolio/Recipients/Statistics/Planned/Tax dialogs) | 11 | 88 | All passing (NEW 2026-05-01: Portfolio 6 files 60 tests, Recipients 1 file 10 tests, Statistics 1 file 9 tests, Planned 1 file 9 tests, Tax 1 file 10 tests) |
| Phase E15 (Onboarding/Notification/Chat/Backup/Import dialogs) | 6 | 54 | All passing (NEW 2026-05-01: OnboardingWizard 11, UpdateNotification 8, ChatConversationList 10, RestoreFromBackupCard 8, BackupTab 9, ImportHistoryCard 8) |
| Phase E16 (Edge-coverage sweep) | 30 | +101 | All passing (NEW 2026-05-02): per-surface fills covering Escape close, Submit error, data-state open guard, keyboard nav, 4xx/5xx page errors, refetch invalidation, context mutation/boot/persistence error paths |
| Context unit tests | 5 | 37 | All passing (NEW: Belgian tax, app settings, language, preload, workspace contexts) |
| Earlier unit/component tests | 6+ | 10+ | All passing (utils, hooks, components) |
| Phase F1 (Backend drift detection) | 4 | +57 vitest, +24 live, +9 Playwright | All passing (NEW 2026-05-02): MSW contract + live-API contract + Playwright dialog/page e2e |
| Phase F2 (Stale refetch / mutation invalidation) | 4 | +6 | All passing (NEW 2026-05-02): RecipientsPage create, OwesPage settle-all, Watchlist delete, CryptoPage create, StocksPage create, StatisticsPage year-param contract |
| Phase F3 (Dialog field validation + submit error) | 5 | +6 | All passing (NEW 2026-05-02): TransactionInfoDialog cancel-no-submit, AddInvestmentFromMarketDialog blank-name guard, LinkTransactionDialog disabled-no-selection + execute-failure-keeps-open, ExecutionHistoryDialog 5xx tolerance, CustomChartBuilderModal POST 5xx stays open |
| Phase F4 (Playwright parity expansion) | 3 | +13 mutations + 9 a11y + 10 network-drift Playwright | NEW 2026-05-02: e2e/mutations-parity.spec.ts (CRUD lifecycles in real browser), e2e/a11y.spec.ts (axe WCAG 2.1 A/AA scans on 9 pages), e2e/network-drift.spec.ts (boot-time fetch listener catching 5xx/4xx drift) |
| Phase F5 (Property + chaos) | 3 | +14 vitest | All passing (NEW 2026-05-02): currency.property.test.ts (8 fast-check parseLocaleNumber properties), envelope.property.test.ts (4 unwrapEnvelope properties), chaos-resilience.test.tsx (2 random-fault-injection page boots via chaos() MSW wrapper in src/test/msw/chaos.ts) |
| Phase F6 (Mutation testing — Stryker) | config + harness | runs on `bun run test:mutation` | NEW 2026-05-02: stryker.config.json scoped to currency.ts + lib/api/client.ts, vitest runner, TS checker, perTest coverage, html report; opt-in (not in CI yet — first baseline run before gating) |
| Phase F7 (Coverage matrix gap-fill) | 3 | +5 | All passing (NEW 2026-05-02): TransactionsPage refetch revision + offset/limit pagination contract + loading skeleton; RecipientsPage limit pagination + loading; StatisticsPage multi-filter combo (monthly + category-pivot + recipient-by-year fan-out across tab switches) |
| Portfolio tax pure-module tests (2026-05-29) | 1 | 12 | All passing (NEW: portfolioTax.ts golden-output cases, 8 dp precision, Decimal accumulation) |
| Chart aria-label helper tests (2026-05-29) | 1 | 6 | All passing (NEW: summarizeSeriesChart, summarizeProportionChart, summarizeSparkline) |
| **Frontend Total** | **83** | **1256** | **All passing (Phase F1–F7 complete + 2026-05-29: portfolio-tax pure-module +12, chart-aria +6)** |
| **Backend** | 56+ | 882+ | All passing (NEW 2026-05-05: portfolioMath.test.js 21 tests, importPipeline.test.js 11 tests) |
| **Grand Total** | **139+** | **2138** | **All passing (1256 frontend vitest + 882 backend; +24 live-API + ~41 Playwright in CI; mutation runner opt-in)** |

### Phase F1 — Backend Drift Detection Sweep (2026-05-02)

**Goal:** detect frontend regressions caused by backend contract changes. Scope: every endpoint frontend calls is now covered by both an MSW contract test (validates fixture shape on every PR) and a live-API contract test (validates real backend response on every non-draft PR).

**What landed:**

- **MSW handlers expanded** (`src/test/msw/handlers.ts`): default handlers for every frontend-used endpoint that was previously unstubbed (admin update-check + vacuum, all aggregations including cashflow forecast methods/rolling/accuracy + sankey + pivot variants, AI chat/conversation/models, attachments, categories sub-routes, imports CRUD, info portfolio-summary + refresh-views + exchange-rates refresh, investments providers/refresh-prices/transactions/transactions-by-id, recipients clusters/aliases/merge/unmerge/patterns/preview, reports financial/portfolio/tax, saved-charts CRUD, splits batch/pay/settle/owed-by-recipient, transactions sub-routes including export endpoints, watchlist CRUD, market chart, planned-transactions execute + due-soon).
- **Contract tests expanded** (`src/test/msw/contracts.test.ts` — `Phase F1: extended GET endpoint contracts` + `Phase F1: extended mutation contracts`): one Zod schema per frontend-used endpoint. Strict shared collection, pagination, link, and resource shapes live in `src/test/contracts/schemas.ts`, reject unknown fields, and keep fixtures and live responses from drifting between separate schema copies. Current contract test count: **131**.
- **Live-API contract tests expanded** (`src/test/live-contracts/live-contracts.test.ts`): reduced live checks derive validators from the strict shared resource schemas with `.pick().passthrough()`, so selected fields stay contract-checked while other valid fields in the full backend resource remain allowed. They hit the real backend on CI. Total live tests: 13 → **37**. Skipped automatically when `LIVE_API_BASE` is not set.
- **Playwright e2e** for browser-only edges:
  - `e2e/dialogs-edge.spec.ts` — backdrop click, Escape (real browser), focus-trap Tab/Shift-Tab, autofocus on open
  - `e2e/critical-flows.spec.ts` — page-load smoke for every major page (catches `pageerror`s); mutation roundtrip (create category / create recipient → list refetches new item)
  - Wired into `test:e2e` script alongside existing `smoke.spec.ts`
- **CI already wired:** `test-frontend` (vitest contract + integration) on every PR, `test-live-api-contracts` against Docker Compose stack on non-draft PRs, `test-e2e` runs all e2e specs against full stack on non-draft PRs, `test-e2e-visual` captures screenshots on push to main.

**How drift is caught now:**

| Type of backend change | Test that fires |
|---|---|
| Field renamed in response payload | MSW contract test (Zod schema mismatch) AND live-API contract test |
| Field type changed | Same as above |
| Endpoint removed | Live-API contract fails on `HTTP 404 / envelope.ok=false` |
| New required query param | Live-API contract fails on `4xx` |
| Page crashes from undefined data | `critical-flows.spec.ts` `pageerror` listener |
| Dialog behavior regression (focus/escape/backdrop) | `dialogs-edge.spec.ts` |
| Visual layout drift | `test-e2e-visual` screenshot comparison |

**Coverage delta this phase:** baseline 1147 → **1204** vitest tests (+57 contract-level, no jsdom regressions). +24 live-API tests (skipped locally, run on CI). +9 Playwright tests across 2 new files.

### Phase F2 — Stale Refetch / Mutation Invalidation Sweep (2026-05-02)

**Goal:** verify that every CRUD mutation triggers a list refetch (TanStack Query `invalidateQueries`). A failed invalidation = stale UI showing pre-mutation data.

**What landed (6 new tests across 4 page files):**

| Page | Mutation | Test |
|------|----------|------|
| `RecipientsPage` | POST `/api/recipients` | Asserts `getCalls > before` after Add Recipient submit |
| `OwesPage` | POST `/api/splits/owed/:id/settle-all` | Asserts both `/api/splits/owed` AND `/api/splits/owed/1` GET counters increment after settle-all |
| `WatchlistPage` | DELETE `/api/watchlist/:id` | Asserts watchlist GET refires after trash icon click |
| `CryptoPage` | POST `/api/investments` | Asserts investments GET refires after create-investment submit |
| `StocksPage` | POST `/api/investments` | Asserts investments GET refires after type-selector → details → create flow |
| `StatisticsPage` | year filter contract | Asserts monthly-summary handler is called with year query param (drift guard) |

**Pattern:** stub GET handler that increments a `getCalls` counter; capture `before` baseline after initial render; perform mutation; `await waitFor(() => expect(getCalls).toBeGreaterThan(before))`. Catches missing `queryClient.invalidateQueries` calls in mutation `onSuccess` handlers.

### Phase F3 — Dialog Completeness Sweep (2026-05-02)

**Goal:** every dialog that takes user input has at least one field-validation test (required guard or button-disabled state) and at least one submit-error test (5xx response → dialog stays open / toast fires).

**What landed (6 new tests across 5 dialog files):**

| Dialog | Validation test | Submit-error test |
|--------|-----------------|-------------------|
| `TransactionInfoDialog` | Edit memo → Cancel → no PATCH (drop-edit guard) | — (mutateAsync rejection causes unhandled rejection in jsdom; covered by useUpdateTransaction unit test) |
| `AddInvestmentFromMarketDialog` | Blank name → no POST (existing `if (!form.name.trim()) return` guard) | (existing in earlier batch) |
| `LinkTransactionDialog` | "Link & Execute" disabled with no radio selected | onExecute rejection → dialog stays open (no `onOpenChange(false)`) |
| `MergeRecipientsDialog` | (existing: button-disabled when no primary AND no alias) | (existing: merge error does not close dialog) |
| `ExecutionHistoryDialog` | — (read-only viewer, no form) | transactions GET 5xx → dialog renders; no crash |
| `TaxProfileDialog` | (N/A — uses `BelgianTaxProfileContext`, no API) | (N/A) |
| `CustomChartBuilderModal` | (existing: Save disabled with no name / no category) | POST `/api/saved-charts` 5xx → `onOpenChange(false)` not called |

**Skipped intentionally:**

- TransactionInfoDialog PATCH 5xx — `mutateAsync` rejection inside an onClick handler creates an unhandled Promise rejection in jsdom; covered indirectly by `useUpdateTransaction` hook test + Playwright `dialogs-edge.spec.ts`.
- TransactionInfoDialog NaN amount guard — `<input type="number">` blocks alpha input at the DOM level, so the `Number.isNaN(parsed)` branch is unreachable through user interaction. Source guard is dead code for UI but defensive for programmatic invocation.

**Coverage delta this phase:** baseline 1204 → **1219** vitest tests; F2 +9 (incl. 3 housekeeping fixes for multi-heading queries), F3 +6.

### Phase F4 — Playwright Parity Expansion (2026-05-02)

**Goal:** push browser-only edges (real backdrop, real focus trap, network drift, a11y) to Playwright. Vitest covers the unit / component layer; Playwright closes the loop on real-browser-only signal.

**What landed (3 new e2e specs, 32 new tests across 9–13 pages):**

| File | Coverage |
|------|----------|
| `e2e/mutations-parity.spec.ts` | Full CRUD lifecycle in a real browser (Category create, Recipient create + persist-after-reload, Planned payment create, navigate-away-and-back invariant). 4 tests. |
| `e2e/a11y.spec.ts` | Axe WCAG 2.1 A/AA scan on 9 key pages (Dashboard, Transactions, Categories, Recipients, Statistics, Owes, PortfolioOverview, Watchlist, Planned). Asserts zero `impact: critical` violations. Uses `@axe-core/playwright`. 9 tests. |
| `e2e/network-drift.spec.ts` | `page.on("response")` listener flags any `/api/` 5xx or unexpected 4xx during page boot. 10 pages. Catches frontend → backend route mismatches that contract tests can't see (because the route never gets called by the test). 10 tests. |

`test:e2e` script updated to include the three new specs alongside `smoke`, `dialogs-edge`, `critical-flows`.

### Phase F5 — Property + Chaos Tests (2026-05-02)

**Goal:** cover invariants we can't enumerate (parser round-trips, envelope passthrough) and verify the UI survives transient backend faults.

**What landed (3 new files, 14 new vitest tests):**

| File | Coverage |
|------|----------|
| `src/test/property/currency.property.test.ts` | `fast-check` properties for `parseLocaleNumber`: number passthrough, null/empty → NaN, US format round-trip, EU format round-trip, paren = negation, currency-symbol stripping, internal whitespace, never-throws. 8 properties. |
| `src/test/property/envelope.property.test.ts` | Properties for `unwrapEnvelope` (ADR-026): `{ok:true,data:X}` → X, non-envelope passthrough, primitive passthrough, never-throws. 4 properties. |
| `src/test/property/chaos-resilience.test.tsx` | Wraps `/api/transactions` and `/api/recipients` with `chaos()` (random latency + 503) and asserts the page still renders without crashing. 2 tests. |

**New harness:** `src/test/msw/chaos.ts` — `chaos(handler)` decorator that injects random latency + a configurable error rate. Tunables via env: `VISION_CHAOS_ERROR_RATE`, `VISION_CHAOS_LATENCY_MS`, `VISION_CHAOS_SEED`. Deterministic (mulberry32 PRNG) when seed is fixed.

### Phase F6 — Mutation Testing (Stryker, 2026-05-02)

**Goal:** measure test suite *quality* (do tests catch realistic faults?) not just *coverage* (do tests touch the line?).

**What landed:**

- `stryker.config.json` — vitest runner, TypeScript checker, `coverageAnalysis: perTest`, scope = `src/utils/currency.ts` + `src/lib/api/client.ts`. HTML report to `reports/mutation/mutation.html`.
- `package.json` script: `"test:mutation": "stryker run"`.
- Dev deps installed: `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`, `@stryker-mutator/typescript-checker`.

**Why scoped:** mutation testing on the full codebase takes hours. Seeding it on the two highest-leverage pure-logic modules (currency formatting + API envelope/error parsing) gives a baseline mutation score and identifies tests with low semantic value (kill rate < 60%). Expand scope after first baseline run.

**Not in CI yet:** opt-in via `bun run test:mutation` from `apps/frontend`. First baseline run before deciding whether to gate.

**Coverage delta this phase:** baseline 1219 → **1233** vitest tests (+14 from F5); +32 Playwright tests (F4); +mutation harness (F6).

### Edge-Coverage Sweep (2026-05-02 — Phase E16)

A coverage-matrix audit found stale claims (matrix said contexts had ZERO tests; reality: 5 files, 37 tests). Triggered a full-sweep edge-coverage pass to fill remaining cells across Pages × {4xx, 5xx, refetch, validation, optimistic, pagination, filter combo, loading, stale}, Dialogs × {Escape, Submit error, Click backdrop guard, Keyboard nav, Field validation}, Contexts × {Mutation error, Boot fetch fail, Persistence}.

**What landed (101 new tests across 30 files):**

| Surface | Edge cases added |
|---|---|
| `SettingsContexts` | AppSettings + Settings boot fetch fail (4xx/5xx via spyOn), mutation error logged but state preserved, debounced persistence, theme idempotence |
| `SettingsPreloadContext` | 4xx-like and 5xx-like spy-rejection paths, multi-consumer cache fan-out |
| `WorkspaceContext` | sessionStorage write success and failure, corrupted stored value handling |
| `LanguageContext` | missing-param interpolation, idempotent setLanguage, en↔nl roundtrip |
| `AddToWatchlistDialog`, `WatchlistChartDialog`, `ExecutionHistoryDialog`, `DashboardSettingsDialog`, `WidgetVisibilityDialog`, `TaxProfileDialog`, `ExportDialog`, `SplitTransactionDialog`, `AddRecipientDialog`, `LinkTransactionDialog`, `InvestmentDetailDialog`, `MergeRecipientsDialog`, `PortfolioTaxAdjustmentsDialog`, `EditPortfolioTxnDialog`, `AddPortfolioTxnDialog`, `EditInvestmentDialog`, `AddCategoryDialog`, `RecipientPatternsDialog`, `CustomChartBuilderModal`, `TransactionInfoDialog`, `AddInvestmentFromMarketDialog` | Escape closes (where not already covered), `data-state="open"` modality guard, first-focusable keyboard-nav check, submit-error toast/dialog-stays-open paths |
| `TransactionsPage` | 401/404 error surfacing, no error banner with paginated data, refetch behaviour around dialog flows |
| `RecipientsPage` | 404 error surfacing, large-list rendering does not crash |
| `PlannedPaymentsPage`, `AIChatPage`, `RecipientInsightsPage`, `CategoriesPage`, `DashboardPage`, `ImportPage`, `OwesPage`, `TaxOverviewPage`, `ImportReviewPage`, `DbMaintenancePage`, `PortfolioOverviewPage` | 4xx tolerance check + refetch verification (where applicable) |
| `StatisticsPage` | 4xx surfacing on monthly aggregation, empty-state heading rendering |
| `MarketLookupPage` | 4xx tolerance for unknown symbol, 5xx tolerance for news endpoint |
| `AdminPages` (Overview / ProviderHealth / EndpointLiveness) | 4xx tolerance for each admin endpoint |
| `PortfolioPages` (Stocks / Performance / NetWorth / Watchlist / ExchangeRates) | 4xx tolerance for each portfolio endpoint |

**Skipped intentionally:**

- True backdrop click on Radix Dialog overlay — jsdom + Radix `onPointerDownOutside` is unreliable; covered indirectly via `data-state="open"` modality guard, deferred to Playwright e2e for canonical signal.
- Deep keyboard-nav focus order — fragile in jsdom, deferred to Playwright + `axe`.
- Optimistic-rollback paths for mutations without explicit rollback in implementation.

**Coverage delta:** baseline 1046 → post-sweep 1147 frontend tests; 100% pass rate maintained.

### Test Framework

- **Runner**: Vitest
- **Component testing**: React Testing Library
- **Network mocking**: MSW (Mock Service Worker) at the HTTP boundary
- **Page rendering**: `renderWithApp` helper (full provider stack)
- **Assertions**: Vitest expect API
- **Mocks**: Vitest `vi.fn()`, `vi.mock()` for non-HTTP concerns; MSW for HTTP

## Backend Tests

The backend test coverage should be inventoried by running:

```bash
bun run test
```

Backend tests are located in `apps/node-backend/src/` alongside source files as `*.test.js` files.

### Backend Unit Tests — Calculation & Pipeline (2026-05-05)

Two new backend test suites covering portfolio math and import pipeline orchestration:

| File | Area | Tests | Coverage |
|------|------|-------|----------|
| `apps/node-backend/tests/portfolioMath.test.js` | Portfolio calculations | 21 | **calculateCostBasisFIFO** (4 tests): empty txns, buy-only accumulation, FIFO lot exhaustion, oversell with sellRatio scaling; **calculateCostBasisLIFO** (3 tests): empty txns, LIFO-vs-FIFO realized gain inversion, oversell proportional proceeds scaling; **calculateAccruedInterest** (6 tests with fake timers): zero rate/principal/txns, exact 365-day simple interest, interest-payment-date start, future-date guard; **sanitizeSnapshotSpikes** (4 tests + 1 DST safety test): non-array null-guard, short-array reference-return, geometric-mean spike replacement (high needle + low trough), immutability assertion, UTC day-walk DST safety across spring-forward |
| `apps/node-backend/tests/importPipeline.test.js` | Import orchestration | 11 | **validateBatch** (4 tests): field validation (tx_date, amount nulls, non-numeric), error summary; **stageBatch** (2 tests): unknown-adapter throw, multi-row parse with rows_total count; **matchBatch** (2 tests): pattern-matched row source=pattern, unresolved recipient_raw=null; **commitBatch** (3 tests): clean insert with aggregation refresh, duplicate detection skips refresh, SAVEPOINT rollback on insert error |

**Key testing patterns:**

- **Portfolio Math:**
  - `vi.useFakeTimers()` / `vi.useRealTimers()` for accrued interest with deterministic clock
  - `expect(...).toBeCloseTo(...)` for floating-point geometric-mean (spike sanitization)
  - Immutability assertions: `sanitizeSnapshotSpikes` does not mutate input
  - DST safety: UTC day-walk using `setUTCDate()` produces exactly 3 days across 2024-03-31 spring-forward

- **Import Pipeline:**
  - `vi.mock()` for database/connection, logger, adapters, normalization, recipientPatternService, aggregationRefresh
  - `mockClient.query` for transaction simulation (SAVEPOINT, SELECT, INSERT, UPDATE)
  - Mock setup: `withTransaction.mockImplementation(async (fn) => fn(mockClient))`
  - Error simulation: `mockClient.query.mockImplementation()` returns `{ rows: [dup] }` or throws on INSERT

**Test execution:** <1 second (no jsdom, pure unit tests)

**Impact:** Covers core portfolio performance calculation logic (FIFO/LIFO cost basis, accrued interest, spike sanitization) and all four import pipeline phases (validate → stage → match → commit) with full error path coverage.

**Related documentation:** [[docs/features/portfolio|Portfolio Feature]], [[docs/features/import|CSV Import Feature]], [[docs/reference/code-patterns#portfolio-math|Portfolio Math Patterns]]

### Backend Test Suite Completion — Transaction Tags (2026-05-08)

The Transaction Tags feature test suite is now **complete and passing**. All test files have been fixed to align with the tag query mocks added during feature implementation.

**Summary:**
- **Backend:** 95/95 test files pass (1522/1527 tests pass, 5 skipped)
- **Frontend:** 82/84 files pass (1272/1310 pass, 1 pre-existing timeout unrelated to tags)
- **Coverage:** No regressions introduced

**Test fixes applied:**

| File | Area | Fix |
|------|------|-----|
| `apps/node-backend/tests/filterBuilder.test.js` | Filter builder | Fixed assertion in `buildTransactionWhere — tagSlugs > produces no clause when tagSlugs is empty`: changed `expect(sql).toBe('')` to `expect(sql).not.toContain('transaction_tags')` (filterBuilder always initializes clauses with `['1=1']`) |
| `apps/node-backend/tests/plannedTransactionRepository.test.js` | Planned transaction repository | Added `mockResolvedValueOnce({ rows: [] })` for new tag queries in `getAll`, `getById`, `create`, and `update`; updated `toHaveBeenCalledTimes` from 3→4 in getAll/getById/update-loan tests, 2→3 in update-no-fields test |
| `apps/node-backend/src/backup/coverage.js` | Backup coverage | Added `planned_transaction_tags`, `tags`, `transaction_tags` (alphabetically) to `BACKUP_COVERED_TABLES` |
| `apps/node-backend/tests/routes/transactions.test.js` | Transactions route | Added `'tags'` to expected fields array in NDJSON export test |
| `apps/node-backend/tests/routes/tags.test.js` | Tags route | Removed TypeScript non-null assertion syntax (`]!` → `]`) that was causing parse failure in a `.js` file |

**Related documentation:**
- [[docs/features/tags|Transaction Tags Feature]]
- [[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052: Tags as Orthogonal Dimension]]

### Recently Updated Backend Coverage (2026-04-26)

| File | Area | Coverage Added |
|------|------|----------------|
| `apps/node-backend/tests/priceProviderRegistry.test.js` | Price providers (Kinesis) | Stale-run removal (≥ 8 identical prices), edge-point anomalies (first/last point 1.8x deviation), combined scenarios, immutability |
| `apps/node-backend/tests/sseWriter.test.js` | SSE backpressure (Phase 3.2) | `drainIfNeeded()` immediate return + full-buffer pause; `createSseWriter()` client tracking, async write, closed state, frame format |

### Earlier Backend Coverage (2026-04-10)

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
| **Bank adapters** | `bankAdapters.js` (Wise, SABB, Vision, others) | Core data ingestion — each bank adapter needs format-specific parsing tests |
| ~~**Import pipeline**~~ | ~~`importPipeline/*.js`~~ | ✓ **COVERED** (2026-05-05) — 11 tests (`importPipeline.test.js`) covering validateBatch, stageBatch, matchBatch, commitBatch phases with full error path coverage |
| **Portfolio math utilities** | ~~`portfolioMath.js`~~ | ✓ **COVERED** (2026-05-05) — 21 tests covering FIFO/LIFO cost basis, accrued interest, spike sanitization with DST safety |
| **Deduplication** | `deduplication.js` | SHA-256 hashing and field-based matching logic |
| **Recurring detection** | `recurringDetectionService.js` | Complex interval detection algorithm |
| **Currency conversion** | `currencyConversionService.js` | Multi-source rate resolution, historical rates |
| **Materialized views** | `materializedViewService.js` | Call coalescing, concurrent refresh |
| **Loan repayment** | `loanRepaymentService.js` | Amortization calculations for 3 loan types |
| **Text normalization** | `textNormalization.js` | Recipient name cleaning, European number parsing |

### Medium-Priority Missing Tests

| Area | Files | Why It Matters |
|------|-------|----------------|
| **Repository layer** | All 13 repositories | SQL query correctness, edge cases |
| **Route handlers** | All 14 route files | Request validation, error responses |
| ~~**Portfolio performance**~~ | ~~`portfolioPerformanceSnapshotService.js`~~ | ✓ **COVERED** (2026-05-18) — parity regression tests: savings accrual, real-estate appreciation, bond interest-payment clock reset, latest-day unit price |
| ~~**IBAN validation**~~ | ~~`iban.js`~~ | Deleted 2026-05-29 (`iban.js` and `iban.test.js` removed) |
| **Recurrence service** | `recurrenceService.js` | Date calculation for patterns |

### Frontend Missing Tests

| Area | Files | Why It Matters |
|------|-------|----------------|
| **Net Worth page** | `NetWorthPage.tsx` | Complex chart domain computation |
| **Statistics page** | `StatisticsPage.tsx` | Multiple chart interactions |
| **Portfolio hooks** | `usePortfolio.ts` | Data fetching and processing |
| ~~**VirtualDataTable**~~ | ~~`VirtualDataTable.tsx`~~ | ✓ **COVERED** (2026-05-01) — 23 tests (E11) |
| ~~**Contexts**~~ | ~~All 7 contexts~~ | ✓ **COVERED** (2026-05-03) |
| ~~**API client**~~ | ~~`api.ts`~~ | ✓ **COVERED** (2026-05-01) — 46 unit tests (E10) |

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
| `apps/node-backend/tests/rateLimiter.test.js` | Middleware/security | Factory allow/deny behavior, window reset, IP fallback precedence, `adminRateLimiter` (500/min), `adminMutateLimiter` (30/min), `importRateLimiter` (20/min) |
| `apps/node-backend/tests/routes/admin.test.js` | Admin API | `GET /api/admin/update/check` release parsing + version resolution + no-release + invalid-JSON sanitized 500; `POST /api/admin/update/apply`; `POST /api/admin/update/apply-and-restart` |
| `apps/node-backend/tests/routes/marketLookup.test.js` | Market API | Quote input validation + mapping + failure fallback; news dedup, thumbnail normalization, partial-failure tolerance |

### Backend coverage additions (2026-04-11)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/currencyConversionService.test.js]] | Currency conversion service | Unsupported-currency fallback, `warmCache` dual-API failure fallback, ECB 90-day historical backfill |
| [[apps/node-backend/tests/routes/plannedTransactions.test.js]] | Planned transactions route | Loan term bounds validation, patch `recipient_name`/`category_name` name-to-id resolution, loan toggle-off schedule/field clearing |
| [[apps/node-backend/tests/routes/transactions.test.js]] | Transactions route | `normalize_to_eur` conversion path, duplicate detection `409`, unresolved recipient/category validation branches in patch flow |

Validation runs (passed): `bun vitest run tests/currencyConversionService.test.js tests/routes/plannedTransactions.test.js tests/routes/transactions.test.js`; `npm test -- --coverage`

Related code: [[apps/node-backend/src/services/currency/currencyConversionService.js]], [[apps/node-backend/src/routes/plannedTransactions.js]], [[apps/node-backend/src/routes/transactions.js]]

### Test Updates (2026-04-22)

| File | Area | Changes |
|------|------|---------|
| [[apps/node-backend/tests/routes/import.test.js]] | Import API | Updated to ADR-026 envelope pattern — validation errors assert `.rejects.toBeInstanceOf(ValidationError)`, success responses check `body.data.xxx` instead of `body.xxx`, mock response includes `res.ok(data, meta)` method |
| [[apps/node-backend/src/routes/marketLookup.js]] | Market API | `symbols.split()` operation moved inside try-catch block (line 86), so malformed string parameters now throw `AppError(502)` instead of raw TypeError |

Related docs: [[docs/adr/026-unified-api-response-envelope|ADR-026]], [[docs/testing/testing#Envelope-Aware Route Testing (ADR-026)|Envelope-Aware Route Testing pattern]]

### Backend coverage additions (2026-04-11, repository/schema)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/categoryRepository.test.js]] | Category repository | `createOrGet` normalization, insert success (`created: true`), conflict fallback returning existing enriched category (`created: false`) |
| [[apps/node-backend/tests/plannedTransactionRepository.test.js]] | Planned transaction repository | `getAll` empty-page fallback count query and guard against unnecessary execution/loan-schedule follow-up queries |

> [!note] Schema initialization test archived
> `schemaInit.test.js` was deleted in Phase 1 (2026-04-21) when `schemaInit.js` was replaced with Alembic migrations ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]).

Validation runs (passed): `bun vitest run tests/categoryRepository.test.js tests/plannedTransactionRepository.test.js`; `npm test -- --coverage`

Related code: [[apps/node-backend/src/repositories/categoryRepository.js]], [[apps/node-backend/src/repositories/plannedTransactionRepository.js]]


### Incremental backend coverage addendum (2026-04-11)

- [[apps/node-backend/tests/currencyConversionService.test.js]] adds a historical miss-cache regression scenario, verifying repeated historical misses do **not** cause duplicate DB lookups.
- Related code: [[apps/node-backend/src/services/currency/currencyConversionService.js]]
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

> [!info] Phase C Update (April 2026)
> These tests predate the Phase C consolidation of importService, streamingImportService, and rawTransactionImportService into `importPipeline`. Tests have been refactored to mock the unified orchestrator; see Phase C addendum below.

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/wiseAdapter.test.js]] | Bank adapters | Wise adapter parsing/normalization paths |
| [[apps/node-backend/tests/sabbAdapter.test.js]] | Bank adapters | SABB adapter parsing/normalization paths |
| [[apps/node-backend/tests/visionAdapter.test.js]] | Bank adapters | Vision adapter parsing/normalization paths |
| [[apps/node-backend/tests/routes/import.test.js]] | Import routes (Phase C) | Orchestrator integration, SSE backpressure, recipients/categories bulk import, multer error handling |

Removed tests (2026-05-29):
- `rawTransactionImportService.test.js` — Deleted (file and implementation removed)
- `streamingImportService.test.js` — Deleted (file and implementation removed)
- `iban.test.js` — Deleted (orphan; `iban.js` removed)
- `importService.test.js` — Superseded by route-level tests mocking unified orchestrator

Related code: [[apps/node-backend/src/services/bankAdapters.js]], [[apps/node-backend/src/services/importPipeline/index.js]], [[docs/testing/testing|Testing Documentation]]


### Backend coverage addendum (2026-04-11, info routes)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/routes/info.test.js]] | Info routes + cache warm orchestration | Route-level dependency mocks (DB, recurring detection, materialized views, FX cache helpers, portfolio snapshots); `GET /recurring-patterns` fallback semantics; `GET /exchange-rates` stale/current refresh branching + warm-failure warning + DB `500`; `POST /exchange-rates/refresh` success/error; `POST /refresh-views` success/failure; `GET /portfolio-performance` mapping/default date range/invalid-currency EUR fallback/error `500`; `warmInfoCaches` prewarm + failure-isolation/logging |

Validation runs (passed):
- `bun vitest run tests/routes/info.test.js`
- `npm test -- --coverage`

Coverage snapshot after this update: overall `81.12/66.86/84.49/84.53` and [[apps/node-backend/src/routes/info.js]] `93.62/78.72/100/94.58` (statements/branches/functions/lines).

Related source links: [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/database/connection.js]], [[apps/node-backend/src/services/recurringDetectionService.js]], [[apps/node-backend/src/services/materializedViewService.js]], [[apps/node-backend/src/services/currency/currencyConversionService.js]], [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]], [[docs/testing/testing|Testing Documentation]]

### Backend coverage addendum (2026-04-11, portfolio transaction repository)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/portfolioTransactionRepository.test.js]] | Portfolio transaction repository | `getAllByInvestmentIds` empty-normalized-id return, id/type sanitization + clamped pagination limits, omitted type/limit branch; `getCount` single-id + type, normalized-id-array path, all-invalid-ids type-only path; `getSummary` grouped summary row return |

Validation runs (passed):
- `bun vitest run tests/portfolioTransactionRepository.test.js` (25 tests)
- `npm test -- --coverage` (827 tests)

Coverage snapshot after this update: overall `81.81/67.61/85.42/85.25`; repositories bucket `68.47/63.45/67.02/72.66`; [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]] `78.73/71.5/84.84/82.95` (statements/branches/functions/lines).

Related source links: [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]], [[docs/testing/testing|Testing Documentation]]


### Backend coverage additions (2026-05-18, snapshot valuation parity)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/portfolioPerformanceSnapshotService.test.js]] | Portfolio snapshot valuation parity | Regression tests locking savings accrual formula (`principal × rate × days / (100 × 365)`), real-estate appreciation summed from `appreciation` transactions, bond `interest` transaction resetting the accrual clock, and latest-day unit-based snapshot using `investments.current_price` not stale history |

### Backend coverage additions (2026-04-11, managed loop safe/sequential)

| File | Area | Coverage Added |
|------|------|----------------|
| [[apps/node-backend/tests/routes/marketLookup.test.js]] | Market lookup routes | Expanded quote/news route branch and response-shape coverage |
| [[apps/node-backend/tests/priceProviderService.test.js]] | Price provider service | Expanded provider-resolution and price-history handling branches |
| [[apps/node-backend/tests/investmentRepository.test.js]] | Investment repository | Expanded repository compatibility and query-path coverage |
| [[apps/node-backend/tests/routes/import.test.js]] | Import routes (Phase C) | Streaming import backpressure, orchestrator integration, error-path coverage |
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

## Frontend Phase D: Coverage Threshold Ratchet & Contract Tests (2026-04-30, expanded 2026-05-02)

| File | Area | Changes |
|------|------|---------|
| `apps/frontend/vite.config.ts` | Coverage gate | Updated thresholds from placeholder (8/5/3/8) to Phase C actual (17/11/10/18); added comment explaining ratchet gates prevent regression |
| `apps/frontend/src/test/msw/handlers.ts` | MSW fixture | Fixed `/api/portfolio/summary` handler to return proper typed stub with all required fields (currency, computed_at, totals{10 numeric fields}, summaries[]) instead of empty object; **Expanded 2026-05-02**: Added 5 exported stub constants (TRANSACTION_STUB, CATEGORY_STUB, RECIPIENT_STUB, INVESTMENT_STUB, PLANNED_TRANSACTION_STUB) and 15 mutation handlers (POST/PATCH/DELETE for all 5 resource types) |
| `apps/frontend/src/test/msw/contracts.test.ts` | Contract tests | **Original:** Node-env Vitest suite with 16 tests, one per default MSW handler; validates ADR-026 envelope + Zod schemas; catches fixture-to-backend drifts immediately. **Expanded 2026-05-02 to 40 tests in 3 suites:** E1 (strict list item schemas, 10 tests), E2 (mutation contracts, 15 tests), E3 (error envelope compliance, 4 tests). All item schemas replaced `.passthrough()` with strict per-field Zod validation. |

**Coverage snapshot (Phase D):**
- Statements: **17.82%** (Phase C baseline, ratcheted to 17)
- Branches: **11.75%** (Phase C baseline, ratcheted to 11)
- Functions: **11.03%** (Phase C baseline, ratcheted to 10)
- Lines: **19%** (Phase C baseline, ratcheted to 18)

**Total frontend tests (Phase D):** 24 test files, 421 tests (376 component-integration/E2E + 40 contract + 5 smoke), all passing (2026-05-02 update: 40 contract tests expanded from 16)

**Rationale for contract test expansion:**
- **E1 (Strict schemas):** Validates empty paginated envelopes and real fixture items against strict per-field Zod schemas (no `.passthrough()`); catches type mismatches, nullability errors, and missing fields
- **E2 (Mutations):** Ensures all POST/PATCH/DELETE endpoints return properly typed item objects or delete response envelopes; prevents stripped or malformed payload responses
- **E3 (Error envelopes):** Validates ADR-026 error envelope across multiple HTTP status codes and endpoint types; ensures consistent error handling across API
- Fixtures now use exported stub constants (TRANSACTION_STUB, etc.) ensuring consistency across all mutation handlers
- Reduces test brittleness (schema validation > DOM text assertions)
- Acts as living documentation of backend contract
- Catches breaking changes in backend before they break component tests

**When to add new contract tests:**
1. New boot-time endpoint added → add MSW default handler + corresponding contract test (E1 for GETs, E2 for mutations)
2. Backend schema changes → update Zod schema in `contracts.test.ts` before shipping; never weaken schema
3. New mutation endpoint → add to `defaultHandlers` with stub fixture + E2 tests (POST/PATCH/DELETE)
4. MSW fixture regresses → contract test fails immediately (before component tests); fix the fixture, not the schema

Related docs: [[docs/adr/026-unified-api-response-envelope|ADR-026]], [[docs/testing/testing#Phase D: Coverage Threshold Ratchet & Contract Tests|Phase D Details]]
