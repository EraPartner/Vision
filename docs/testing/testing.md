---
title: Testing Documentation
type: testing
status: active
date: 2026-04-11T10:19:03.000Z
tags:
  - testing
  - vitest
  - quality
aliases:
  - testing
  - unit tests
  - integration tests
  - vitest
  - test coverage
description: >-
  Comprehensive testing documentation including frameworks, patterns, and best
  practices
related_code:
  - apps/node-backend/tests
  - apps/frontend/src
---

# Testing Documentation

Vision uses comprehensive testing to ensure code quality and prevent regressions.

## Testing Stack

| Tool | Purpose | Location |
|------|---------|----------|
| **Vitest** | Backend unit tests | `apps/node-backend/tests/` |
| **React Testing Library** | Frontend component tests | `apps/frontend/src/` |
| **Bun** | Test runner | `package.json` |

## Running Tests

### Backend Tests

```bash
# Run all tests
bun test

# Watch mode
bun test:watch

# Run specific test file
bun vitest run src/path/to/test.test.js

# Run tests matching pattern
bun vitest run --test-name-pattern="testName"
```

### Frontend Tests

```bash
# Run frontend tests (if configured)
bun test:frontend
```

## Test Structure

### Backend Tests

```
apps/node-backend/tests/
├── config.test.js              # Configuration tests
├── validation.test.js          # Input validation tests
├── iban.test.js                # IBAN validation
├── currencyConversionService.test.js
├── deduplication.test.js       # Deduplication logic
├── recurringDetectionService.test.js
├── loanRepaymentService.test.js
├── investmentRepository.test.js  # Investment inheritance + legacy view compatibility
├── routes/
│   ├── transactions.test.js
│   ├── splits.test.js
│   ├── categories.test.js
│   ├── recipients.test.js
│   ├── investments.test.js
│   └── ...
├── adapters/
│   ├── belfiusAdapter.test.js
│   ├── revolutAdapter.test.js
│   └── ...
```

### Test File Naming

- Pattern: `*.test.js` or `*.test.ts`
- Location: `tests/` folder next to source files
- Example: `src/middleware/validation.js` → `tests/validation.test.js`

## Test Patterns

### Unit Tests

```javascript
import { describe, it, expect } from 'vitest';
import { myFunction } from '../src/module.js';

describe('myFunction', () => {
  it('should do something', () => {
    const result = myFunction(input);
    expect(result).toBe(expected);
  });
});
```

### Integration Tests

```javascript
import { describe, it, expect, beforeAll } from 'vitest';

describe('API Endpoints', () => {
  beforeAll(async () => {
    // Setup test database
  });

  it('should create transaction', async () => {
    const response = await fetch('/api/transactions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    expect(response.status).toBe(201);
  });
});
```

### Mocking

```javascript
import { vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));
```

### Vitest 4 constructor-compatible mocks

With Vitest 4, some module mocks must preserve constructor-compatible behavior when the imported dependency is instantiated.

Example pattern (used for `yahoo-finance2`):

```javascript
vi.mock('yahoo-finance2', () => ({
  default: vi.fn().mockImplementation(function MockYahooFinance() {
    return {
      quote: mockYahooQuote,
      chart: mockYahooChart,
    };
  }),
}));
```

Reference: [[apps/node-backend/tests/priceProviderService.test.js]]

## Test Coverage Areas

### Recent provider propagation coverage

- `apps/node-backend/tests/priceProviderService.test.js` covers Kinesis provider config resolution reuse across live/history, cache-key consistency for investment-scoped Kinesis entries, and Binance batch behavior in live-price detail fetch.
- `apps/node-backend/tests/priceProviderService.test.js` also validates isolated Kinesis spike sanitization, ensuring confirmed single-point up/down needles are interpolated from neighbors while surrounding trend detail is preserved.
- `apps/node-backend/tests/priceProviderService.test.js` includes regression coverage for moderate one-day spike patterns (20 normal, 21 spike, 22 normal) so relaxed Kinesis sanitization thresholds continue catching medium needles.
- `apps/node-backend/tests/priceProviderService.test.js` covers `sanitizePersistedKinesisHistory()` summary/behavior (processed/updated/correctedPoints/failed) when sanitizing persisted `asset_price_history` rows for Kinesis investments.
- `apps/node-backend/tests/priceProviderService.test.js` adds regression coverage for the no-refetch early-return case (`sanitizes covered cached DB points for kinesis without provider refetch`), confirming covered cached DB history is sanitized and corrected points are persisted before response return.
- `apps/node-backend/tests/routes/admin.test.js` covers `POST /api/admin/investments/kinesis/sanitize-history` response handling for success and failure paths.
- `apps/node-backend/tests/routes/investments.test.js` covers refresh eligibility for Kinesis investments when `price_provider_id` is missing but asset name/symbol maps through Kinesis config.

Code links: [[apps/node-backend/tests/priceProviderService.test.js]], [[apps/node-backend/tests/routes/admin.test.js]], [[apps/node-backend/tests/routes/investments.test.js]], [[apps/node-backend/src/services/priceProviderService.js]], [[apps/node-backend/src/routes/admin.js]], [[apps/node-backend/src/routes/investments.js]]

### Backend

| Category | Examples |
|----------|----------|
| **Validation** | Input sanitization, ID validation, date parsing |
| **Services** | Currency conversion, deduplication, recurring detection |
| **Routes** | CRUD operations, edge cases, error handling |
| **Split Routes** | Split amount bounds, batch validation, owed CSV export responses |
| **Adapters** | Bank CSV parsing, normalization |

### Frontend

| Category | Examples |
|----------|----------|
| **Components** | Rendering, user interactions |
| **Hooks** | State management, data fetching |
| **Forms** | Validation, submission |

### Recent Additions

- Settings and middleware validation coverage additions for this branch:
  - [[apps/node-backend/tests/routes/settings.test.js]] covers settings route validation and error semantics: key-length guardrails, missing `value`, `dashboard_settings` `exclusionScope` and `excludedCategoryIds` validation, bulk upsert payload-type rejection, and DELETE not-found behavior.
  - [[apps/node-backend/tests/validation.test.js]] extends middleware coverage for `validateIdParam` in [[apps/node-backend/src/middleware/validation.js]] (missing-id pass-through, invalid-id 400 detail response, valid-id numeric coercion + `next()`).
- Database connection module coverage additions for this branch:
  - [[apps/node-backend/tests/connection.test.js]] covers [[apps/node-backend/src/database/connection.js]] pool idle-client error logging, transient retry behavior (`ECONNRESET`, `08006`), non-transient no-retry behavior, max-retry exhaustion path, plus utility/helper methods (`checkConnection`, `getTableCount`, `getPoolStats`, `closePool`, `queryPrepared`, `getClient`).

- Security/config regression additions for this branch:
  - [[apps/node-backend/tests/config.test.js]] covers optional `ADMIN_AUTH_TOKEN` config mapping and trimming behavior.
  - [[apps/node-backend/tests/main.test.js]] covers admin auth middleware behavior (token required only when configured).
- Route hardening/perf regression additions for this branch:
  - [[apps/node-backend/tests/routes/investments.test.js]] covers bulk-transactions cache-key correctness for differing `limit` values.
  - [[apps/node-backend/tests/routes/transactions.test.js]] covers CSV formula neutralization and sanitized route error responses.
  - [[apps/node-backend/tests/routes/import.test.js]] covers sanitized import errors/SSE error behavior.
  - [[apps/node-backend/tests/routes/admin.test.js]] covers sanitized admin error responses and auth-related expectations.
  - [[apps/node-backend/tests/routes/info.test.js]] covers `/api/info/refresh-views` registration + limiter/security assertions.

- `apps/node-backend/tests/investmentRepository.test.js` covers PostgreSQL inheritance-backed investment writes/reads through compatibility views.
- `apps/node-backend/tests/routes/splits.test.js` validates split amount bounds, per-recipient settle-all behavior, and owed CSV export flows.
- `apps/frontend/src/components/shared/dateUtils.test.ts` adds coverage for semantic month label helpers: `formatMonthYearWithAppSettings(date, appDateFormat, locale?)` and `formatMonthLabelWithLocale(date, locale?, width?)`.
- `apps/frontend/src/hooks/useStatistics.test.ts` now covers category pivot metric mode aggregations (absolute, net, income-only, expense-only) and recipient yearly aggregation (`topRecipientsByYear`) used by year-filtered top-recipient statistics.
- Currency target conversion coverage expanded for analytics and conversion paths: `apps/node-backend/tests/routes/info.test.js`, `apps/node-backend/tests/infoRepository.test.js`, and `apps/node-backend/tests/currencyConversionService.test.js`.
- Final readability/enforcement verification pass: targeted frontend tests passed (3 files, 13 tests), frontend build passed, and grep checks confirmed no `toLocaleDateString(` or `toLocaleString(` under `apps/frontend/src`, no `form.currency || 'EUR'`, and no persisted `defaultBankAccount` (removed — was unused).
- Runtime `ReferenceError` hotfix validation after settings refactor: `bunx tsc -p apps/frontend/tsconfig.json --noEmit --ignoreDeprecations 6.0` passes with no undefined-variable TypeScript errors; frontend build also passes for locale-scoped month-label callsites in [[apps/frontend/src/pages/DashboardPage.tsx]], [[apps/frontend/src/components/dashboard/CashFlowComparisonChart.tsx]], and [[apps/frontend/src/pages/portfolio/NetWorthPage.tsx]].
- Watchlist locale runtime-safety hotfix: `formatDisplayCurrency` moved into component scope in [[apps/frontend/src/components/portfolio/WatchlistChartDialog.tsx]] so `locale` and `appSettings` are in scope at runtime.
- Validation snapshot: locale/language undefined-name sweep after patch reports no `Cannot find name 'locale'` or `Cannot find name 'language'`, and frontend build passes.
- Validation status for this implementation batch: targeted frontend tests passed, frontend build passed, and root build passed.
- Dependency remediation validation snapshot (2026-04): `bun audit` reports no vulnerabilities, backend tests pass on Vitest 4, frontend build passes on Vite 8, and frontend lint still reports pre-existing unrelated issues.
- Schema-init compatibility validation: startup bootstrap now safely skips index/trigger creation on non-base relations (including `investments` view in inheritance setups), preventing `cannot create index on relation "investments"` during idempotent startup re-runs ([[apps/node-backend/src/database/schemaInit.js]], [[docs/api/investments|API: Investments]]).
- Validation code links: [[apps/frontend/src/components/shared/RemoteNewsImage.tsx]], [[apps/frontend/src/components/portfolio/PortfolioNewsFeed.tsx]], [[apps/frontend/src/pages/MarketLookupPage.tsx]], [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]], [[apps/node-backend/src/database/schemaInit.js]]
- News image blank-box regression fix: backend CSP `img-src` now includes `https:` in [[apps/node-backend/src/main.js]], and news-card usage passes `fallbackClassName="hidden"` via [[apps/frontend/src/components/portfolio/PortfolioNewsFeed.tsx]] and [[apps/frontend/src/pages/MarketLookupPage.tsx]] with support added in [[apps/frontend/src/components/shared/RemoteNewsImage.tsx]].
- Historical FX conversion coverage expanded: [[apps/node-backend/tests/currencyConversionService.test.js]] now validates sparse historical backfill behavior (missing `(currency,date)` pairs only), date-aware row conversion options (`useHistoricalRatesByDate`, `dateField`), and nearest-date fallback logic.
- `getBankBalances(targetCurrency)` FX-history coverage expanded: [[apps/node-backend/tests/infoRepository.test.js]] now verifies `convertRowsToEur(..., targetCurrency, { useHistoricalRatesByDate: true, dateField: 'date' })` is used for both current balances and monthly history rows.
- `apps/node-backend/tests/infoRepository.test.js` adds regression coverage for `/api/info/net-worth` snapshot sanitization of isolated one-day unit investment spikes, asserting outlier-day correction between neighbors and stable current investment totals ([[apps/node-backend/src/repositories/infoRepository.js]], [[apps/node-backend/tests/infoRepository.test.js]]).

Code links: [[apps/frontend/src/components/dashboard/MonthlyTrendsChart.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/components/portfolio/AddInvestmentDialog.tsx]], [[apps/frontend/src/components/portfolio/WatchlistChartDialog.tsx]], [[apps/frontend/src/components/ui/chart.tsx]], [[apps/frontend/src/components/shared/dateUtils.ts]], [[apps/frontend/src/hooks/useStatistics.test.ts]], [[apps/frontend/src/hooks/statisticsProcessing.ts]], [[apps/frontend/src/utils/currency.ts]], [[apps/frontend/src/contexts/AppSettingsContext.tsx]], [[apps/frontend/src/contexts/SettingsContext.tsx]], [[apps/node-backend/tests/routes/info.test.js]], [[apps/node-backend/tests/infoRepository.test.js]], [[apps/node-backend/tests/currencyConversionService.test.js]]

Dependency remediation links: [[apps/node-backend/tests/priceProviderService.test.js]], [[apps/node-backend/package.json]], [[apps/frontend/package.json]], [[package.json]]

## Test Examples

### Validation Tests

```javascript
describe('validateId', () => {
  it('should accept valid positive integers', () => {
    expect(validateId('1')).toEqual({ valid: true, value: 1 });
  });

  it('should reject invalid IDs', () => {
    expect(validateId('0').valid).toBe(false);
    expect(validateId('-1').valid).toBe(false);
    expect(validateId('abc').valid).toBe(false);
  });
});
```

### API Route Tests

```javascript
describe('POST /api/transactions', () => {
  it('should create transaction', async () => {
    const res = await apiClient.post('/transactions', {
      transaction_date: '2025-03-18',
      amount: -50.00,
      recipient_id: 1,
    });
    expect(res.status).toBe(201);
  });

  it('should reject invalid data', async () => {
    const res = await apiClient.post('/transactions', {
      amount: -50.00,
      // Missing required fields
    });
    expect(res.status).toBe(400);
  });
});
```

## Best Practices

### Test Naming

Use descriptive names that explain what is being tested:

```javascript
// ✅ Good
it('should return 400 when amount is missing')

// ❌ Bad
it('test1')
```

### AAA Pattern

Follow Arrange-Act-Assert:

```javascript
it('should calculate correctly', () => {
  // Arrange
  const input = { amount: 100, rate: 0.1 };

  // Act
  const result = calculateTax(input);

  // Assert
  expect(result).toBe(10);
});
```

### Test Coverage Goals

- **New features**: 100% test coverage required
- **Critical paths**: All user-facing behaviors
- **Edge cases**: Error handling, invalid inputs
- **Integration**: API endpoint tests

### Avoiding Flaky Tests

```javascript
// ❌ Bad - relies on time
it('should process within 100ms', () => {
  const start = Date.now();
  process();
  expect(Date.now() - start).toBeLessThan(100);
});

// ✅ Good - tests behavior, not timing
it('should process data correctly', () => {
  const result = process();
  expect(result).toEqual(expected);
});
```

## CI/CD Integration

Tests run automatically on:

- Every pull request
- Every push to main branch
- Before deployment

```yaml
# Example GitHub Actions (if configured)
- name: Run tests
  run: bun test
```

## Debugging Failed Tests

```bash
# Run with verbose output
bun vitest run --reporter=verbose

# Run only failed tests
bun vitest run --reporter=basic --only --update

# Debug with browser (if UI tests)
bun vitest --ui
```

## Related Documentation

- [[docs/testing/index]] - Testing Index
- [[docs/adr/002-database-schema]] - Database Schema
- [Vitest Docs](https://vitest.dev)
- [React Testing Library Docs](https://testing-library.com)

## Test Additions (2026-04-10)

- [[apps/node-backend/tests/rateLimiter.test.js]] adds middleware-factory coverage for allow-under-limit, `429` over-limit, window reset behavior, and client key fallback order (`req.ip` → `remoteAddress` → `unknown`). It also verifies stricter presets: `adminRateLimiter` (`10 req/min`) and `importRateLimiter` (`5 req/min`).
- [[apps/node-backend/tests/routes/admin.test.js]] adds admin update endpoint coverage:
  - `GET /api/admin/update/check` for GitHub release payload handling, `APP_VERSION`/`APP_IMAGE_TAG` resolution, no-release fallback payload, and invalid JSON path returning sanitized `500`.
  - `POST /api/admin/update/apply` and `POST /api/admin/update/apply-and-restart` success responses.
- [[apps/node-backend/tests/routes/marketLookup.test.js]] adds market endpoint coverage:
  - `GET /api/market/quote` missing `symbols` (`400`), quote+summary mapping, and quote failure fallback to `quotes: []`.
  - `GET /api/market/news` dedup by title, thumbnail normalization, and partial-failure tolerance (`articles: []` when news search fails).

Validation run (passed): `bun vitest run tests/rateLimiter.test.js tests/routes/admin.test.js tests/routes/marketLookup.test.js`

## Related

- [[docs/api/admin]]
- [[docs/api/marketLookup]]
- [[docs/security/rate-limiting]]

## Coverage Update (2026-04-11)

- [[apps/node-backend/tests/currencyConversionService.test.js]] adds fallback/edge coverage for unsupported currencies, `warmCache` dual-API failure fallback, and ECB 90-day historical backfill behavior.
- [[apps/node-backend/tests/routes/plannedTransactions.test.js]] adds route coverage for loan term bounds validation, `recipient_name`/`category_name` patch name-to-id resolution, and loan toggle-off schedule/field clearing.
- [[apps/node-backend/tests/routes/transactions.test.js]] adds route coverage for `normalize_to_eur` conversion path behavior, duplicate detection (`409`), and unresolved recipient/category validation branches in patch flow.

Validation runs (passed):
- `bun vitest run tests/currencyConversionService.test.js tests/routes/plannedTransactions.test.js tests/routes/transactions.test.js`
- `npm test -- --coverage`

Related code: [[apps/node-backend/src/services/currencyConversionService.js]], [[apps/node-backend/src/routes/plannedTransactions.js]], [[apps/node-backend/src/routes/transactions.js]]

### Additional backend repository/schema coverage (2026-04-11)

- [[apps/node-backend/tests/schemaInit.test.js]] adds schema bootstrap coverage for warm-start short-circuit behavior (skip DDL/materialized-view helpers when current schema version is present) and fallback initialization/stamping when `schema_version` lookup fails.
- [[apps/node-backend/tests/categoryRepository.test.js]] adds repository coverage for `createOrGet` normalization (`general/detail` trim+uppercase), insert success (`created: true`), and conflict fallback returning the existing enriched category (`created: false`).
- [[apps/node-backend/tests/plannedTransactionRepository.test.js]] adds pagination and query-efficiency coverage for `getAll`: fallback count query on empty pages and no execution/loan-schedule follow-up queries when no planned rows exist.

Related code: [[apps/node-backend/src/database/schemaInit.js]], [[apps/node-backend/src/repositories/categoryRepository.js]], [[apps/node-backend/src/repositories/plannedTransactionRepository.js]]

Validation run (passed): `bun vitest run tests/schemaInit.test.js tests/categoryRepository.test.js tests/plannedTransactionRepository.test.js`; `npm test -- --coverage`


### Incremental coverage addendum (2026-04-11)

- [[apps/node-backend/tests/currencyConversionService.test.js]] now includes historical miss-cache coverage to ensure duplicate historical-rate DB lookups are avoided for repeated misses.
- Related code: [[apps/node-backend/src/services/currencyConversionService.js]]
- Validation context (passed): `bun vitest run tests/currencyConversionService.test.js`; `npm test -- --coverage` (`74.18/59.54/78.47/77.68`).


### Incremental backend repository coverage addendum (2026-04-11)

- [[apps/node-backend/tests/categoryRepository.test.js]] expanded coverage for:
  - `getAll` filtered query + enrichment
  - `getCount`
  - `getById` null path
  - `update` no-op and normalization paths
  - `hardDelete`
  - `assignToRecipients`
- [[apps/node-backend/tests/plannedTransactionRepository.test.js]] expanded coverage for:
  - `getAll` rows-present branch with executions + loan schedule hydration
  - `getById` null and loan hydration paths
  - `create` loan success, rollback-on-schedule-failure, and non-loan no-schedule path
  - `update` empty sanitized-field fallback, null update result, and loan hydration path
  - `hardDelete` true/false
  - `addExecution` with provided date and default current-date behavior
  - `replaceLoanSchedule` success and rollback paths
- Validation runs (passed):
  - `bun vitest run tests/categoryRepository.test.js tests/plannedTransactionRepository.test.js`
  - `npm test -- --coverage`
- Latest coverage snapshot: statements **76.84%**, branches **61.72%**, functions **80.74%**, lines **80.29%**.
- Related code: [[apps/node-backend/src/repositories/categoryRepository.js]], [[apps/node-backend/src/repositories/plannedTransactionRepository.js]]


### Incremental backend test addendum (2026-04-11, adapter + raw import branches)

- Added bank-adapter parsing regression coverage:
  - [[apps/node-backend/tests/wiseAdapter.test.js]]
  - [[apps/node-backend/tests/sabbAdapter.test.js]]
  - [[apps/node-backend/tests/visionAdapter.test.js]]
- Expanded [[apps/node-backend/tests/rawTransactionImportService.test.js]] with additional branch coverage for:
  - dedup fallback (`isRawDuplicate` throws → `isDuplicateByFields` fallback)
  - generic bank delegation to `importCSV`
  - non-fatal raw-reference create failure path
  - existing recipient + new bank-account insertion
  - new recipient + primary bank account + notes update path
  - sabb/wise/vision raw repository routing

Related code: [[apps/node-backend/src/services/bankAdapters.js]], [[apps/node-backend/src/services/rawTransactionImportService.js]]

Validation runs (passed):
- `bun vitest run tests/wiseAdapter.test.js tests/sabbAdapter.test.js tests/visionAdapter.test.js` (3 files, 15 tests)
- `bun vitest run tests/rawTransactionImportService.test.js tests/wiseAdapter.test.js tests/sabbAdapter.test.js tests/visionAdapter.test.js` (4 files, 31 tests)
- `bun vitest run --coverage --exclude tests/config.test.js` → coverage snapshot: statements **79.59%**, branches **65.78%**, functions **81.55%**, lines **82.97%**

Known unrelated local issue:
- Full `npm test -- --coverage` can fail in [[apps/node-backend/tests/config.test.js]] when local `.env.local` DB URL overrides expected default config behavior.


### Incremental backend info-route test addendum (2026-04-11)

- [[apps/node-backend/tests/routes/info.test.js]] expanded coverage for route-level dependency interactions in [[apps/node-backend/src/routes/info.js]] using explicit mocks for:
  - [[apps/node-backend/src/database/connection.js]] query behavior
  - [[apps/node-backend/src/services/recurringDetectionService.js]]
  - [[apps/node-backend/src/services/materializedViewService.js]]
  - [[apps/node-backend/src/services/currencyConversionService.js]] cache helpers
  - [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]]
- Added assertions for:
  - `GET /recurring-patterns` success + detector-failure fallback (`{ patterns: [], total: 0 }`)
  - `GET /exchange-rates` stale-rate background refresh behavior, current-date no-refresh behavior, warm-failure warning log path, and DB-failure `500`
  - `POST /exchange-rates/refresh` success + error path
  - `POST /refresh-views` success (duration payload) + failure path
  - `GET /portfolio-performance` mapped snapshot payload + default date range, invalid-currency fallback to EUR, and error `500`
  - `warmInfoCaches` export behavior: net-worth + portfolio prewarm, net-worth failure isolation, and portfolio warm-failure logging
- Date-sensitive assertions now use deterministic fake timers for stable route behavior validation.

Validation runs (passed):
- `bun vitest run tests/routes/info.test.js`
- `npm test -- --coverage`

Coverage snapshot after this update: overall `81.12/66.86/84.49/84.53` and [[apps/node-backend/src/routes/info.js]] `93.62/78.72/100/94.58` (statements/branches/functions/lines).

### Incremental backend repository coverage addendum (2026-04-11, portfolio transactions)

- [[apps/node-backend/tests/portfolioTransactionRepository.test.js]] expanded branch coverage for:
  - `getAllByInvestmentIds`: empty-normalized-id early return, id/type sanitization, clamped `perInvestmentLimit`/`limit`/`offset`, and omitted type/limit branch
  - `getCount`: single `investmentId` + `type`, normalized `investmentIds` array, and all-invalid-ids branch that skips `ANY(...)` and applies type-only filtering
  - `getSummary`: grouped summary row return path
- Related code: [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]
- Validation runs (passed):
  - `bun vitest run tests/portfolioTransactionRepository.test.js` (25 tests)
  - `npm test -- --coverage` (827 tests)
- Coverage snapshot after full run: overall `81.81/67.61/85.42/85.25`; repositories bucket `68.47/63.45/67.02/72.66`; `portfolioTransactionRepository.js` `78.73/71.5/84.84/82.95` (statements/branches/functions/lines).


### Incremental backend coverage addendum (2026-04-11, managed loop safe/sequential)

- Managed loop coverage run completed with stop condition met.
- Latest backend coverage snapshot: **Statements 87.78%**, **Branches 75.00%**, **Functions 91.71%**, **Lines 90.89%**.
- Latest passing suite snapshot: **54 test files**, **871 tests passing**.

Expanded/updated test files:
- [[apps/node-backend/tests/routes/marketLookup.test.js]]
- [[apps/node-backend/tests/priceProviderService.test.js]]
- [[apps/node-backend/tests/investmentRepository.test.js]]
- [[apps/node-backend/tests/streamingImportService.test.js]]
- [[apps/node-backend/tests/portfolioPerformanceSnapshotService.test.js]]
- [[apps/node-backend/tests/infoRepository.test.js]]
- [[apps/node-backend/tests/materializedViewService.test.js]]

Coverage loop artifacts:
- [[.claude/baselines/test-coverage-baseline-20260411-101903.md]]
- [[.claude/plans/test-coverage-sequential-safe-runbook.md]]

Related areas: market lookup routes, price-provider behavior, investment repository compatibility, streaming import pipeline, portfolio snapshot calculation paths, info repository aggregation, and materialized view refresh behavior.
