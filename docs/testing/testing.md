---
title: Testing Documentation
type: testing
status: active
date: 2026-03-25
tags: [testing, vitest, jest, quality]
description: Comprehensive testing documentation including frameworks, patterns, and best practices
related_code: ["apps/node-backend/tests", "apps/frontend/src/components/__tests__"]
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

## Test Coverage Areas

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
- Schema-init compatibility validation: startup bootstrap now safely skips index/trigger creation on non-base relations (including `investments` view in inheritance setups), preventing `cannot create index on relation "investments"` during idempotent startup re-runs ([[apps/node-backend/src/database/schemaInit.js]], [[docs/api/investments|API: Investments]]).
- Validation code links: [[apps/frontend/src/components/shared/RemoteNewsImage.tsx]], [[apps/frontend/src/components/portfolio/PortfolioNewsFeed.tsx]], [[apps/frontend/src/pages/MarketLookupPage.tsx]], [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]], [[apps/node-backend/src/database/schemaInit.js]]
- News image blank-box regression fix: backend CSP `img-src` now includes `https:` in [[apps/node-backend/src/main.js]], and news-card usage passes `fallbackClassName="hidden"` via [[apps/frontend/src/components/portfolio/PortfolioNewsFeed.tsx]] and [[apps/frontend/src/pages/MarketLookupPage.tsx]] with support added in [[apps/frontend/src/components/shared/RemoteNewsImage.tsx]].
- Historical FX conversion coverage expanded: [[apps/node-backend/tests/currencyConversionService.test.js]] now validates sparse historical backfill behavior (missing `(currency,date)` pairs only), date-aware row conversion options (`useHistoricalRatesByDate`, `dateField`), and nearest-date fallback logic.
- `getBankBalances(targetCurrency)` FX-history coverage expanded: [[apps/node-backend/tests/infoRepository.test.js]] now verifies `convertRowsToEur(..., targetCurrency, { useHistoricalRatesByDate: true, dateField: 'date' })` is used for both current balances and monthly history rows.

Code links: [[apps/frontend/src/components/dashboard/MonthlyTrendsChart.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/components/portfolio/AddInvestmentDialog.tsx]], [[apps/frontend/src/components/portfolio/WatchlistChartDialog.tsx]], [[apps/frontend/src/components/ui/chart.tsx]], [[apps/frontend/src/components/shared/dateUtils.ts]], [[apps/frontend/src/hooks/useStatistics.test.ts]], [[apps/frontend/src/hooks/statisticsProcessing.ts]], [[apps/frontend/src/utils/currency.ts]], [[apps/frontend/src/contexts/AppSettingsContext.tsx]], [[apps/frontend/src/contexts/SettingsContext.tsx]], [[apps/node-backend/tests/routes/info.test.js]], [[apps/node-backend/tests/infoRepository.test.js]], [[apps/node-backend/tests/currencyConversionService.test.js]]

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
