---
title: Testing Documentation
type: testing
status: active
date: 2026-04-30
updated: 2026-08-09
last-updated: 2026-08-09
last_updated_timestamp: 2026-08-09T00:00:00Z
added_portfolio_math_tests: 2026-05-05
added_import_pipeline_tests: 2026-05-05
wired_real_db_harness: 2026-07-27
tags:
  - testing
  - vitest
  - playwright
  - quality
  - a11y
  - visual-regression
  - phase-0
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
| **Vitest** | Backend unit tests; frontend unit/integration tests | `apps/node-backend/tests/`, `apps/frontend/src/` |
| **React Testing Library** | Frontend component unit and integration tests | `apps/frontend/src/` |
| **MSW** | Network mocking at the HTTP boundary (component-integration tests) | `apps/frontend/src/test/msw/` |
| **Playwright** | E2E tests for critical user flows w/ real backend | `apps/frontend/e2e/` |
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

#### Against a real Postgres

Suites gated on `TEST_DATABASE_URL` (see [Database Fixture Helper](#database-fixture-helper-phase-0)) **skip** in a plain `bun test` run. To execute them, use the disposable-database wrapper — it starts a throwaway `postgres:18-alpine` container, migrates it to head, exports the environment and runs vitest, then removes the container on exit:

```bash
# Whole backend suite, DB-backed cases included
bun run test:db

# A single DB-backed suite (arguments are forwarded to vitest)
bun run test:db tests/services/transferReconciliation.db.test.js

# Keep the container after the run to inspect it
VISION_TEST_DB_KEEP=1 bun run test:db
```

Requires Docker and the Python Alembic toolchain (`pip install -r config/requirements.txt`) — migrations are Alembic even though the backend is Node. If `TEST_DATABASE_URL` is already exported the script uses that database as-is and starts no container.

### Frontend Tests

```bash
# Run frontend unit/integration tests (Vitest + React Testing Library + MSW)
bun test:frontend

# Run E2E tests (Playwright)
bun run test:e2e

# Run E2E tests with headed browser (see what Playwright sees)
bun exec playwright test --headed

# Run E2E tests in debug mode (step through)
bun exec playwright test --debug
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

### Frontend Tests

```
apps/frontend/
├── src/
│   ├── hooks/*.test.ts             # Hook unit tests
│   ├── components/**/*.test.tsx    # Component unit tests
│   ├── utils/*.test.ts             # Utility unit tests
│   ├── pages/__tests__/            # Component-integration tests (MSW + RTL)
│   │   └── *.integration.test.tsx
│   └── test/                       # Test infrastructure
│       ├── renderWithApp.tsx       # Provider tree helper
│       ├── test-setup.ts           # MSW lifecycle
│       └── msw/
│           ├── server.ts           # MSW server
│           └── handlers.ts         # Default HTTP handlers
├── e2e/                            # E2E tests (Playwright)
│   └── smoke.spec.ts               # Smoke tests: 5 critical routes
├── playwright.config.ts            # Playwright configuration
└── package.json
```

### Test File Naming

- Pattern: `*.test.{js,ts,tsx}` or `*.spec.{js,ts,tsx}`
- Unit tests: colocated with source file (e.g., `src/utils/foo.ts` → `src/utils/foo.test.ts`)
- Component-integration tests: `__tests__/` subdirectory with `.integration.test.tsx` suffix
- Example: `src/pages/TransactionsPage.tsx` → `src/pages/__tests__/TransactionsPage.integration.test.tsx`

## Test Patterns

### Component-Integration Tests (MSW + RTL)

Render a full page with Vision's real provider stack, mock the network via MSW, drive with userEvent, assert on the DOM. This is the fastest layer that exercises data flow, hooks, and routes together without spinning up a backend server.

**Key files:**
- [[docs/testing/frontend-component-integration|Complete guide]] — conventions, patterns, coverage goals, and advanced RTL/MSW patterns
- `apps/frontend/src/test/renderWithApp.tsx` — Provider stack mirror (QueryClient, contexts, routing)
- `apps/frontend/src/test/msw/server.ts` — MSW server + default handlers
- `apps/frontend/src/test-setup.ts` — MSW lifecycle wiring

**Why MSW instead of vi.mock():**
- Centralizes API contract (ADR-026 envelope shape)
- Avoids Bun/Vitest mock-bleed gotcha
- Tests exercise the real `apiClient` (retries, timeouts, envelope unwrap)

**Advanced patterns (2026-04-30):**
- **Handler ordering:** Register specific routes before wildcard patterns — MSW evaluates handlers FIFO
- **Stale elements:** Just `await findByRole(...)` (don't assert `.toBeInTheDocument()` on result) when component re-mounts
- **Multiple elements:** Use `findAllByRole` when same element appears in multiple locations
- **Role over text:** Prefer `findByRole` over `findByText` when text spans multiple DOM nodes

See [[docs/testing/frontend-component-integration#msw--rtl-advanced-patterns-2026-04-30|Advanced Patterns]] for details.

**Example:**
```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import TransactionsPage from "@/pages/TransactionsPage";

describe("TransactionsPage", () => {
    it("renders with empty data", async () => {
        renderWithApp(<TransactionsPage />);
        const heading = await screen.findByRole("heading", { name: /transactions/i });
        expect(heading).toBeInTheDocument();
    });
});
```

See [[docs/testing/frontend-component-integration|Component-Integration Tests]] for full authoring guide.

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

### Hook Unit Tests (Frontend, 2026-05-01, updated 2026-05-03)

Test custom React hooks in isolation using `renderHook` from React Testing Library. Hook tests verify return values, state mutations, side effects, and integration with external dependencies (timers, window events, API calls).

**Test files (5 new, 2026-05-01–2026-05-03):**
- `apps/frontend/src/hooks/__tests__/useUtilityHooks.test.ts` (13 tests)
- `apps/frontend/src/hooks/__tests__/useChartCurrencyFormatter.test.ts` (5 tests)
- `apps/frontend/src/hooks/__tests__/usePlannedPayments.test.ts` (8 tests)
- `apps/frontend/src/hooks/__tests__/useQueryHooks.test.tsx` (13 tests)
- `apps/frontend/src/hooks/portfolio/__tests__/useInvestments.test.ts` (25 tests) — NEW 2026-05-03

**Key patterns:**

1. **Fake timers for delay-based hooks:**
   ```typescript
   describe("useDebounce", () => {
     beforeEach(() => vi.useFakeTimers());
     afterEach(() => vi.useRealTimers());

     it("delays value update", () => {
       const { result, rerender } = renderHook(
         ({ value }: { value: string }) => useDebounce(value, 300),
         { initialProps: { value: "hello" } },
       );
       rerender({ value: "world" });
       expect(result.current).toBe("hello");
       act(() => vi.advanceTimersByTime(300));
       expect(result.current).toBe("world");
     });
   });
   ```

2. **DOM event hooks:**
   ```typescript
   describe("useOnlineStatus", () => {
     it("responds to offline event", () => {
       const { result } = renderHook(() => useOnlineStatus());
       expect(result.current).toBe(true);
       act(() => { window.dispatchEvent(new Event("offline")); });
       expect(result.current).toBe(false);
     });
   });
   ```

3. **API-dependent hooks with MSW:**
   ```typescript
   it("fetches and refetches data", async () => {
     const { result } = renderHook(() => usePlannedPayments(), { wrapper: makeWrapper() });
     await waitFor(() => expect(result.current.isLoading).toBe(false));
     expect(result.current.data).toEqual([...]);
   });
   ```

4. **TanStack Query hooks with provider:**
   ```typescript
   function makeWrapper() {
     return function Wrapper({ children }) {
       return (
         <QueryClientProvider client={testQueryClient}>
           <LanguageProvider>{children}</LanguageProvider>
         </QueryClientProvider>
       );
     };
   }
   ```

5. **Mocking LanguageContext synchronously in async factory (2026-05-03):**
   ```typescript
   // @vitest-environment jsdom
   vi.mock("@/contexts/LanguageContext", async (importOriginal) => {
     const actual = await importOriginal<typeof import("@/contexts/LanguageContext")>();
     const { default: enDict } = await import("@/locales/en");
     return {
       ...actual,
       useLanguage: () => ({
         language: "en" as const,
         setLanguage: vi.fn(),
         t: (key: string, vars?: Record<string, string | number>) => {
           let str = (enDict as Record<string, string>)[key] ?? key;
           if (vars) {
             for (const [k, v] of Object.entries(vars)) {
               str = str.replaceAll(`{${k}}`, String(v));
             }
           }
           return str;
         },
       }),
     };
   });
   ```
   This pattern avoids Vitest module-loading complexity: import locale dictionary synchronously once per test run instead of mocking the context dynamically per test.

**Total Phase E8+ hook tests:** 64 tests across 5 files, all passing

### Context Unit Tests (Frontend, 2026-05-03)

Test React Context hooks and providers in isolation using `renderHook` with custom wrappers. Context tests verify hook behavior, loading states, state mutations, and integration with dependent contexts.

**Key patterns:**

1. **Hook guard (error boundary test):**
   ```typescript
   it("throws when used outside provider", () => {
     const spy = vi.spyOn(console, "error").mockImplementation(() => {});
     expect(() => renderHook(() => useMyContext())).toThrow(
       "useMyContext must be used within MyProvider",
     );
     spy.mockRestore();
   });
   ```

2. **Loading state verification:**
   ```typescript
   it("isLoading is true on initial render", () => {
     const { result } = renderHook(() => useTaxProfile(), { wrapper: makeWrapper() });
     expect(result.current.isLoading).toBe(true);
   });

   it("isLoading becomes false after data loads", async () => {
     const { result } = renderHook(() => useTaxProfile(), { wrapper: makeWrapper() });
     await waitFor(() => expect(result.current.isLoading).toBe(false));
   });
   ```

3. **State mutation with MSW:**
   ```typescript
   server.use(
     http.post(`${API_BASE}/api/settings`, () =>
       ok({ saved: true }),
     ),
   );
   const { result } = renderHook(() => useSettings(), { wrapper: makeWrapper() });
   await act(async () => {
     await result.current.saveSetting("key", "value");
   });
   expect(result.current.settings.key).toBe("value");
   ```

4. **Zustand store reset (no provider needed):**
   ```typescript
   beforeEach(() => {
     useSettingsStore.setState({
       appSettings: DEFAULT_APP_SETTINGS,
       isAppSettingsLoading: true,
     });
   });
   ```

5. **Provider stacking (dependent contexts):**
   ```typescript
   function makeWrapper() {
     return function Wrapper({ children }) {
       return (
         <SettingsPreloadProvider>
           <BelgianTaxProfileProvider>{children}</BelgianTaxProfileProvider>
         </SettingsPreloadProvider>
       );
     };
   }
   ```

**Test files (2026-05-03):**
- `apps/frontend/src/contexts/__tests__/BelgianTaxProfileContext.test.tsx` (8 tests)
- `apps/frontend/src/contexts/__tests__/SettingsContexts.test.tsx` (12 tests)
- `apps/frontend/src/contexts/__tests__/LanguageContext.test.tsx` (6 tests)
- `apps/frontend/src/contexts/__tests__/SettingsPreloadContext.test.tsx` (5 tests)
- `apps/frontend/src/contexts/__tests__/WorkspaceContext.test.tsx` (6 tests)

Total: 37 context tests, all passing.

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

### Frontend Error-State Test Timeout Gotcha: apiRequest Retry Loop

> [!warning] apiRequest Retry Behavior
> **Problem:** `apiRequest` in `apps/frontend/src/lib/api/client.ts` has an internal retry loop (MAX_RETRIES=2, backoff ~500ms+1000ms). When the server returns a 500 error, the exception is thrown inside a try-catch, causing `apiRequest` to retry (~1500ms total before finally throwing). React Query's `retry: false` configuration does **NOT** bypass this internal retry cycle.
>
> **Impact:** Component-integration tests that assert error UI must use `{ timeout: 5000 }` in `findByText` / `findByRole` calls to outlast the `apiRequest` retry backoff cycle (~1500ms) plus React's render/update time.
>
> **Affected test files:** 
> - `apps/frontend/src/pages/__tests__/CategoriesPage.integration.test.tsx`
> - `apps/frontend/src/pages/__tests__/RecipientsPage.integration.test.tsx`
> - `apps/frontend/src/pages/__tests__/StatisticsPage.integration.test.tsx`
> - `apps/frontend/src/pages/__tests__/PlannedPaymentsPage.integration.test.tsx`
>
> **Example pattern:**
> ```typescript
> server.use(
>     http.get(`${API_BASE}/api/planned-transactions`, () =>
>         err(500, "database unavailable"),
>     ),
> );
> renderWithApp(<PlannedPaymentsPage />);
> // Must use timeout: 5000 to account for ~1500ms apiRequest retry + render time
> expect(await screen.findByText(/database unavailable/i, {}, { timeout: 5000 })).toBeInTheDocument();
> ```
>
> **Root cause:** `apiRequest` wraps the fetch in `try { ... }` where a 500 status throws an exception. This exception is caught, logged, and the retry loop proceeds. The loop completes after ~1500ms (two retries with exponential backoff). Tests waiting for error UI must account for this delay.

### Envelope-Aware Route Testing (ADR-026)

All route tests must validate the unified API response envelope. When testing route handlers:

**Mock response helper:**
```javascript
function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  res.ok = (data, meta) => {
    const body = { ok: true, data };
    if (meta) body.meta = meta;
    return res.json(body);
  };
  return res;
}
```

**Testing success responses:**
```javascript
it('should return 201 on successful import', async () => {
  importCSVWithRawStorage.mockResolvedValue({
    total_processed: 5, imported: 4, duplicates: 1, errors: 0, status: 'completed',
  });

  const req = { file: { path: '/tmp/test.csv', originalname: 'test.csv' }, query: { bank_name: 'belfius' }, body: {} };
  const res = mockResponse();
  await routeHandlers['post:/csv'](req, res);

  expect(res.status).toHaveBeenCalledWith(201);
  const body = res.json.mock.calls[0][0];
  expect(body.ok).toBe(true);
  expect(body.data.total_processed).toBe(5);  // Access wrapped data
  expect(body.data.status).toBe('completed');
});
```

**Testing validation errors:**
```javascript
it('should return 400 when no file uploaded', async () => {
  const req = { file: null, query: { bank_name: 'belfius' }, body: {} };
  const res = mockResponse();

  await expect(routeHandlers['post:/csv'](req, res)).rejects.toBeInstanceOf(ValidationError);
});
```

The envelope middleware (`wrapResponse`) and error handler (`createErrorHandler`) will serialize both success and error cases. Route tests verify the exception type is thrown; the middleware handles serialization to the envelope shape.

Reference: [[docs/adr/026-unified-api-response-envelope|ADR-026]], [[apps/node-backend/tests/routes/import.test.js]]

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

### Mock Isolation Gotcha: Bun + Vitest v1.3.13 (Critical)

> [!warning] Mock Bleed Issue
> **Problem:** Vitest v1.3.13 running under Bun does NOT fully clear `mockResolvedValueOnce` queues when `vi.resetAllMocks()` is called between tests. Unconsumed mock value callbacks remain in the queue and may be consumed by subsequent tests, causing test pollution and false passes/failures.
>
> **Root Cause:** The `vi.resetAllMocks()` helper only resets the mock state but does not drain queued `...Once` call stubs. With Bun's context model, the queue persists across test boundaries.

**Detection pattern:**
- Test N passes all assertions
- Test N+1 calls a mocked function that has `mockResolvedValueOnce` queued from Test N
- Test N+1 unexpectedly receives the stale value from Test N instead of its own mock value

**Mitigation (MANDATORY):**

1. **Audit mock setup in `beforeEach()`:** Review all `beforeEach()` hooks in test files using `mockResolvedValueOnce` / `mockResolvedValue` chains. Ensure every mock is reset before use in each test.

2. **Remove unconsumed `...Once` stubs:** If a test sets up `mockResolvedValueOnce` but the mock is not called (either by early return, skip, or parameter validation), the stub persists to the next test. **Delete unconsumed calls.**

   Example (BAD):
   ```javascript
   describe('getPortfolioHoldings', () => {
     it('test 1', async () => {
       investmentRepository.getAll.mockResolvedValueOnce([...]);
       // test consumes it ✓
     });

     it('test 2', async () => {
       // leftover mockResolvedValueOnce from test 1 still queued!
       investmentRepository.getAll.mockResolvedValueOnce([]);
       await getPortfolioHoldings.run({ assetClass: 'stock' });
       // getAll() is called and returns stale value from test 1, not []
     });
   });
   ```

   Example (GOOD):
   ```javascript
   it('test 2', async () => {
     investmentRepository.getAll.mockResolvedValueOnce([]); // replaces stale queue
     await getPortfolioHoldings.run({ assetClass: 'stock' });
   });
   ```

3. **Use `mockResolvedValue` (permanent) for multiple calls:** If a test makes multiple calls to the same mock, prefer a permanent return value:
   ```javascript
   investmentRepository.getAll.mockResolvedValue([]); // used for all calls
   ```

4. **Explicit `beforeEach()` reset:** In test files with complex mock setups, explicitly reset each mock in `beforeEach()`:
   ```javascript
   beforeEach(() => {
     investmentRepository.getAll.mockReset();
     portfolioTransactionRepository.getAllByInvestmentIds.mockReset();
   });
   ```

**Why this matters:**
- Silent failures: A test consumes a stale mock and passes when it should fail.
- Cross-test pollution: Fixes are localized to individual tests, not the root cause.
- CI flakiness: Other tests may pass locally but fail in CI depending on test order.

**Fix validation:** Run affected tests with `bun vitest run --reporter=verbose` and confirm no mock bleed in test output.

Reference: [[apps/node-backend/tests/aiChatTools.test.js]] (fixed 2026-04-25: removed unconsumed `mockResolvedValueOnce` from "passes assetClass filter" test)

### Golden-Fixture Pattern (Phase 0+)

Regression testing for non-trivial calculations (loan amortization, recurrence expansion, timezone boundary conversions, etc.). Store input + expected output as JSON fixtures.

**Fixture layout:**
```
tests/golden/__fixtures__/
├── loanSchedule/amortizing-standard.input.json
├── loanSchedule/amortizing-standard.expected.json
├── recurrence/addMonthsAtDay.input.json
└── recurrence/addMonthsAtDay.expected.json
```

**Usage in vitest:**
```javascript
import { describe, it } from 'vitest';
import { runGolden } from '../golden/runGolden.js';
import { generateLoanSchedule } from '../../src/services/calculations/loanSchedule.js';

describe('loanSchedule golden', () => {
  it('amortizing-standard', async () => {
    await runGolden('loanSchedule/amortizing-standard', (input) =>
      generateLoanSchedule(input),
    );
  });
});
```

**Updating fixtures:**
```bash
UPDATE_GOLDENS=1 bun vitest run loanSchedule.test.js
```

This pattern isolates test expectations from implementation details, making it easier to verify business logic regressions without brittle assertions.

Reference: [[docs/reference/code-patterns#Golden-Fixture Pattern]], [[apps/node-backend/tests/golden/runGolden.js]]

### Database Fixture Helper (Phase 0+)

Opt-in shared Postgres pool for tests that need a real database. Resolved via `TEST_DATABASE_URL` environment variable.

**Setup:**
```javascript
import { describe, it, beforeAll, afterAll } from 'vitest';
import { getTestPool, closeTestPool, hasTestDatabase } from '../setup/db.js';

describe('transactionRepository', () => {
  let pool;

  beforeAll(() => {
    pool = getTestPool();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it.skipIf(!pool)('should insert and fetch transaction', async () => {
    const result = await pool.query('SELECT 1');
    expect(result.rows).toHaveLength(1);
  });
});
```

**Self-skipping pattern (recommended):**
```javascript
it.skipIf(!hasTestDatabase())('database-dependent test', async () => {
  // test code
});
```

The helper returns `null` when `TEST_DATABASE_URL` is unset, so tests skip gracefully in environments without the test database.

**Where the database comes from:**

| Context | Provider | Migrated by |
|---------|----------|-------------|
| CI — `Test (Backend)` job | `services.postgres` (`postgres:18-alpine`) in `.github/workflows/ci.yml` | "Migrate the test database to head" step |
| Local | throwaway container started by `scripts/with-test-db.sh` (`bun run test:db`) | the same script |

Backend vitest runs in exactly one CI job, so the service is wired only there. `quality-gate` runs no tests — it only aggregates results.

**`DATABASE_URL` must equal `TEST_DATABASE_URL`.** DB-backed suites seed through the *test* pool (`getTestPool()`), but the code under test queries through the *app* pool (`src/database/connection.js`, built from `DATABASE_URL` at import time). Point them at different databases and the seed is invisible to the service. Both the CI job and `with-test-db.sh` set the two to the same value; a suite that depends on it should assert this in `beforeAll` rather than fail mysteriously.

**Cleanup convention.** Prefer per-test `DELETE` of the tables the suite touches over `TRUNCATE ... CASCADE`: the cascade off `transactions` reaches a dozen unrelated tables and costs ~350 ms per test in ACCESS EXCLUSIVE locks versus ~3 ms for targeted deletes. A wrapping transaction is the other option, but it does not suit services that open their own `withTransaction` or that reconcile the whole corpus rather than a scoped batch — there, other tests' rows would still be visible. Whatever the strategy, the suite must leave no rows behind.

**Coverage differs between modes.** Skipped DB suites lower measured coverage, so a no-DB `--coverage` run reports below CI. The thresholds in `vitest.config.js` track the *no-DB* figure deliberately — see the comment there before bumping them.

**Migrations are required, and a bare `alembic upgrade head` will not do it.** Alembic auto-creates `alembic_version.version_num` as `VARCHAR(32)`, and this chain's revision identifiers are longer, so a fresh database dies on the third revision with `value too long for type character varying(32)`. Use `bun run db:migrate` (→ `apps/node-backend/scripts/db-migrate.js`), which runs the same `runMigrations()` path the app runs on boot and preflights that table at `VARCHAR(64)` first. All version-table-writing npm scripts (`db:upgrade`/`db:downgrade`/`db:stamp`/`db:reset`, and the backend workspace's `db:migrate*`) now route through that same wrapper — see [[docs/reference/scripts|Scripts Reference]].

Reference: [[docs/reference/code-patterns#Database Fixture]], [[apps/node-backend/tests/setup/db.js]], [[apps/node-backend/tests/services/transferReconciliation.db.test.js]]

### Property Test Pattern (Phase 8)

Property tests complement golden fixtures by locking **invariants** rather than examples. Where a golden fixture asserts a specific input maps to a specific output, a property test asserts a universal law holds for every randomly generated input in a bounded domain.

**Conventions:**

- **Location:** `apps/node-backend/tests/property/<module>.property.test.js`
- **PRNG:** inline [`mulberry32`](https://en.wikipedia.org/wiki/Xorshift) seeded per-suite — deterministic across runs so CI failures reproduce locally
- **Iterations:** 50–500 cases per invariant (bounded — property tests run on every `bun vitest run`)
- **Shape:** Arrange random case → Act on module-under-test → Assert invariant holds (not a specific numeric value)
- **No external I/O:** DB and `fetch` are mocked so the suite is hermetic (see `currencyRoundTrip` for the fallback-rates stubbing pattern)

**Example skeleton:**

```javascript
import { describe, it, expect } from 'vitest';
import { generateLoanRepaymentSchedule } from '../../src/services/calculations/loanSchedule.js';

const CENT = 0.01;

function seeded(seed) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe('loanSchedule principal invariant', () => {
  it('sum(principal) ≈ principal within 1¢ across all loan_types', () => {
    const rng = seeded(0xC0FFEE);
    for (let i = 0; i < 200; i++) {
      const input = randomCase(rng);          // bounded random generator
      const schedule = generateLoanRepaymentSchedule(input);
      const paid = schedule.reduce((s, r) => s + r.principal_amount, 0);
      expect(Math.abs(paid - input.principal)).toBeLessThanOrEqual(CENT);
    }
  });
});
```

**Invariants locked in Phase 8:**

| Module | Invariant | Test |
|---|---|---|
| `loanSchedule.js` | `sum(principal_amount) ≈ principal ±1¢`; 0% APR; final remaining == 0 | [[apps/node-backend/tests/property/loanSchedule.property.test.js]] |
| `recurrence.js` | Strict monotonic advance + `iterate(n) == iterate(n-1) + step`; Jan-31 clamp | [[apps/node-backend/tests/property/recurrence.property.test.js]] |
| `splits.js` | `split.amount == sum(payments) + remaining`; overpayment blocked; zero-balance filtered | [[apps/node-backend/tests/property/splits.property.test.js]] |
| `aggregation/monthly.js` | `sum(monthly income/expense/net) == yearly ±1¢`; net identity | [[apps/node-backend/tests/property/monthlyYearly.property.test.js]] |
| `aggregation/category.js` | `sum(by_category) + excluded_total == grand_total ±1¢` | [[apps/node-backend/tests/property/categoryTotal.property.test.js]] |
| `calculations/currency.js` | `convert(convert(x, A, B), B, A) ≈ x`; EUR→EUR identity; triangulation | [[apps/node-backend/tests/property/currencyRoundTrip.property.test.js]] |

**When to add a property test vs. a golden fixture:**

- Reach for a **golden** when the output shape is a fixed structure a human should be able to eyeball (amortization schedule, recurrence date, dedup hash).
- Reach for a **property** when the law spans a family of inputs too large to enumerate (every loan config, every FX pair, every split/payment combination).
- Most calc modules deserve both — goldens pin representative shapes, properties catch drift golden tables would miss.

Reference: [[docs/reference/code-patterns#Golden-Fixture Pattern|Golden-Fixture Pattern]], [[apps/node-backend/tests/golden/INVENTORY.md|Calc Inventory Lock]], [[docs/adr/016-aggregation-shadow-mode|ADR-016: Aggregation Shadow Mode]].

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
- Runtime `ReferenceError` hotfix validation after settings refactor: `bunx tsc -p apps/frontend/tsconfig.json --noEmit --ignoreDeprecations 6.0` passes with no undefined-variable TypeScript errors; frontend build also passes for locale-scoped month-label callsites in [[apps/frontend/src/pages/DashboardPage.tsx]], [[apps/frontend/src/components/dashboard/CashFlowComparisonChart.tsx]], and [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]].
- Watchlist locale runtime-safety hotfix: `formatDisplayCurrency` moved into component scope in [[apps/frontend/src/components/portfolio/WatchlistChartDialog.tsx]] so `locale` and `appSettings` are in scope at runtime.
- Validation snapshot: locale/language undefined-name sweep after patch reports no `Cannot find name 'locale'` or `Cannot find name 'language'`, and frontend build passes.
- Validation status for this implementation batch: targeted frontend tests passed, frontend build passed, and root build passed.
- Dependency remediation validation snapshot (2026-04): `bun audit` reports no vulnerabilities, backend tests pass on Vitest 4, frontend build passes on Vite 8, and frontend lint still reports pre-existing unrelated issues.
- Validation code links: [[apps/frontend/src/components/shared/RemoteNewsImage.tsx]], [[apps/frontend/src/components/portfolio/PortfolioNewsFeed.tsx]], [[apps/frontend/src/pages/MarketLookupPage.tsx]], [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]]
- News image blank-box regression fix: backend CSP `img-src` now includes `https:` in [[apps/node-backend/src/main.js]], and news-card usage passes `fallbackClassName="hidden"` via [[apps/frontend/src/components/portfolio/PortfolioNewsFeed.tsx]] and [[apps/frontend/src/pages/MarketLookupPage.tsx]] with support added in [[apps/frontend/src/components/shared/RemoteNewsImage.tsx]].
- Historical FX conversion coverage expanded: [[apps/node-backend/tests/currencyConversionService.test.js]] now validates sparse historical backfill behavior (missing `(currency,date)` pairs only), date-aware row conversion options (`useHistoricalRatesByDate`, `dateField`), and nearest-date fallback logic.
- `getBankBalances(targetCurrency)` FX-history coverage expanded: [[apps/node-backend/tests/infoRepository.test.js]] now verifies `convertRowsToEur(..., targetCurrency, { useHistoricalRatesByDate: true, dateField: 'date' })` is used for both current balances and monthly history rows.
- `apps/node-backend/tests/infoRepository.test.js` adds regression coverage for `/api/info/net-worth` snapshot sanitization of isolated one-day unit investment spikes, asserting outlier-day correction between neighbors and stable current investment totals ([[apps/node-backend/src/repositories/infoRepository.js]], [[apps/node-backend/tests/infoRepository.test.js]]).

Code links: [[apps/frontend/src/components/dashboard/MonthlyTrendsChart.tsx]], [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]], [[apps/frontend/src/components/portfolio/AddInvestmentDialog.tsx]], [[apps/frontend/src/components/portfolio/WatchlistChartDialog.tsx]], `apps/frontend/src/components/charts/` (chart.tsx removed in ADR-018 visx/d3 migration), [[apps/frontend/src/components/shared/dateUtils.ts]], [[apps/frontend/src/hooks/useStatistics.test.ts]], [[apps/frontend/src/components/statistics/statisticsUtils.ts]], [[apps/frontend/src/utils/currency.ts]], [[apps/frontend/src/contexts/AppSettingsContext.tsx]], [[apps/frontend/src/contexts/SettingsContext.tsx]], [[apps/node-backend/tests/routes/info.test.js]], [[apps/node-backend/tests/infoRepository.test.js]], [[apps/node-backend/tests/currencyConversionService.test.js]]

Dependency remediation links: [[apps/node-backend/tests/priceProviderService.test.js]], [[apps/node-backend/package.json]], [[apps/frontend/package.json]], [[package.json]]

## Frontend Phase A: Component-Integration Testing (2026-04-30 — COMPLETE)

Launched initial frontend component-integration test infrastructure to validate page renders, user interactions, and API integration without spinning up a backend server. Phase A now complete with 31 passing tests across 7 pages.

### Key Components

1. **jsdom Polyfills for Radix UI** (`apps/frontend/src/test-setup.ts`)
   - Added `PointerEvent`, `hasPointerCapture`, `setPointerCapture`, `releasePointerCapture`, and `scrollIntoView` polyfills guarded by `typeof window !== "undefined"`
   - Enables Radix UI components (Select, Dialog, Combobox, etc.) to render and interact correctly in tests
   - Node-env tests unaffected (polyfills only apply when `window` exists)

2. **MSW Envelope Helpers** (`apps/frontend/src/test/msw/handlers.ts`)
   - `ok<T>(data: T, meta?: EnvelopeMeta)` → returns `{ ok: true, data, meta? }`
   - `err(status: number, message: string, code?: string)` → returns `{ ok: false, error: { message, code? } }`
   - Matches ADR-026 unified API response envelope
   - Default handlers expanded to 13 endpoints covering boot-time endpoints: `/api/settings`, `/api/info`, `/api/categories`, `/api/recipients`, `/api/transactions`, `/api/planned`, `/api/planned-transactions`, `/api/investments`, `/api/aggregations/:name`, `/api/info/exchange-rates`, `/api/market/news`, `/api/import/batches`, `/api/admin/endpoint-liveness`

3. **Component-Integration Tests** (in `apps/frontend/src/pages/__tests__/`)
   - `TransactionsPage.integration.test.tsx` — 5 tests: empty-list render, error state, Add Transaction button, dialog open, POST form submission with MSW recipient mock
   - `ImportPage.integration.test.tsx` — 5 tests: heading, bank source label, select trigger placeholder, Import Transactions button, CSV file input
   - `LanguageSwitch.integration.test.tsx` — 8 tests: EN/NL switching across 4 pages (PlannedPayments, Transactions, Import, TaxOverview)
   - `TaxOverviewPage.integration.test.tsx` — 5 tests: heading, empty state, CTA button via `findAllByRole`, sheet open, Employment radio via `getByRole` anchored to start
   - `AddTransactionDialog.integration.test.tsx` — 4 tests: dialog open/close, form submission with request body capture, 409 duplicate error handling via toast spy
   - `PlannedPaymentsPage.integration.test.tsx` — 2 tests: heading, New Payment button
   - `PortfolioOverviewPage.integration.test.tsx` — 2 tests: heading, empty state

### Test Authoring Pattern

```tsx
// @vitest-environment jsdom
import { describe, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";

describe("ComponentIntegration", () => {
    it("renders with default handlers", async () => {
        renderWithApp(<MyComponent />);
        expect(await screen.findByRole("heading")).toBeInTheDocument();
    });

    it("overrides endpoint per test", async () => {
        const user = userEvent.setup();
        server.use(
            http.post("http://localhost:3002/api/foo", () =>
                ok({ id: 42, message: "success" }),
            ),
        );
        renderWithApp(<MyComponent />);
        await user.click(screen.getByRole("button"));
        await waitFor(() => expect(screen.getByText("success")).toBeInTheDocument());
    });

    it("spies on async handlers (e.g., toast.error)", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");

        server.use(
            http.post("http://localhost:3002/api/foo", () =>
                err(409, "Conflict"),
            ),
        );
        renderWithApp(<MyComponent />);
        await user.click(screen.getByRole("button"));

        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/conflict/i),
            ),
        );
    });
});
```

### Phase A Gotchas Documented

Four key testing gotchas discovered during Phase A completion:

1. **TaxOverviewPage renders two TaxProfileDialog instances** — use `findAllByRole("dialog")` and index the first; cannot use `findByRole` (would throw on multiple matches).

2. **Radix Select accessible name without htmlFor link** — locate by traversing element `textContent` rather than expecting direct label association via `getByLabelText`.

3. **Recipient category regex in getByRole matches substrings** — `/employee/i` matches civil_servant description "Government employee". Use anchored pattern: `getByRole("radio", { name: /^employee/i })`.

4. **VirtualDataTable rows not measurable in jsdom** — skip delete-row and scroll-position tests; focus on interaction flows (button clicks, form submission, async state changes).

### Coverage Summary

- **Test files:** 7 page test files
- **Tests:** 31 tests, all passing (0 failures)
- **Infrastructure:** Vitest + RTL + MSW v2 with `renderWithApp` helper, `server.use()` per-test overrides, `ok()`/`err()` envelope helpers
- **Default handlers:** 13 endpoints with paginated/envelope-conformant shapes
- **Pages covered:** Transactions, Import, Language Switch, Tax Overview, Add Transaction Dialog, Planned Payments, Portfolio Overview

### Phase B: E2E Testing (2026-04-30) — COMPLETE

- Playwright configuration with auto-boot dev server (local) or Docker Compose (CI)
- 5 smoke E2E tests covering critical routes: dashboard, transactions, import, planned, portfolio
- CI job in GitHub Actions: build Docker image, start Compose, run tests, upload artifact
- See [[docs/testing/frontend/e2e|E2E Test Guide]] for running locally and adding new tests

### Phase C: Accessibility & Visual Regression (2026-04-30) — COMPLETE

**Accessibility Checks (Axe-Core):**
- Every smoke test in `smoke.spec.ts` calls `checkA11y(page)` using `@axe-core/playwright@4.11.2`
- Scans for WCAG 2.1 violations (fails on critical/serious, warns on minor/warning)
- Integrated into all 5 smoke tests (dashboard, transactions, import, planned, portfolio)

**Visual Regression Tests:**
- New `visual.spec.ts` captures full-page screenshots of 5 critical pages
- Playwright `toHaveScreenshot({ fullPage: true })` with 2% pixel tolerance
- Baselines stored in `apps/frontend/e2e/__screenshots__/`
- NPM scripts: `bun run test:e2e:visual` (with update), `bun run test:e2e:update-snapshots` (emergency refresh)
- CI job `test-e2e-visual`: Runs on main branch pushes only, automatically updates baselines

See [[docs/testing/frontend/e2e|E2E Test Guide]] for running, debugging, and updating baselines.

### Phase D: Coverage Threshold Ratchet & Contract Tests (2026-04-30, updated 2026-05-02) — COMPLETE

**Coverage Threshold Ratchet** (`apps/frontend/vite.config.ts`):
- Thresholds updated from placeholder (8/5/3/8) to actual Phase C levels (17/11/10/18)
- Comment explains these are regression-prevention gates, not aspirational targets
- Bump per phase after adding meaningful tests
- Prevents silent coverage erosion across test suite enhancements

**Contract Tests** (`apps/frontend/src/test/msw/contracts.test.ts`) — Expanded 2026-05-02:
- Node-env Vitest suite (no jsdom needed) with **40 tests** (expanded from 16)
- Organized into **three test suites:**

  **E1: Strict list item schemas (10 tests)**
  - Validates empty paginated responses + fixture items for all 5 resources
  - Each resource (categories, recipients, transactions, planned-transactions, investments) has 2 tests:
    - Empty list envelope is valid
    - Item shape matches strict per-field Zod schema
  - **Schema approach:** Replaced `z.object({}).passthrough()` with strict field-by-field validation for robustness

  **E2: Mutation handler contracts (15 tests)**
  - Validates POST/PATCH/DELETE responses for all 5 resource types
  - Each resource has 3 tests (POST, PATCH, DELETE):
    - POST response matches resource item schema
    - PATCH response matches resource item schema
    - DELETE response matches delete response schema (with optional transaction `details` field)
  - Ensures mutation endpoints return properly typed items, not loose blobs

  **E3: Error envelope compliance (4 tests)**
  - Validates ADR-026 error envelope across HTTP status codes and endpoint types
  - Tests: 500 error, 404 error with optional `code`, 422 mutation error, 503 error without code
  - Error schema: `{ ok: false, error: { message: string, code?: string } }`
  - Covers both GET and mutation endpoints

**Schemas covered:**
- Paginated list items: `{ items[], total, limit, offset, links[] }` (categories, recipients, transactions, planned-transactions, investments) with strict per-field schemas
- Resource items: CategoryItemSchema, RecipientItemSchema, TransactionItemSchema, InvestmentItemSchema, PlannedTransactionItemSchema (all with explicit field types, not passthrough)
- Delete responses: `{ message, links[] }` with optional transaction-specific `details`
- Exchange rates: `{ rates[{currency, rate_to_eur, rate_date, fetched_at}], fallback_rates, base, date }`
- Market news: `{ articles[{title, link, publisher, publishedAt, thumbnail, relatedSymbols}] }`
- Import batches: `{ batches[], total }`
- Portfolio summary: `{ currency, computed_at, totals{10 numeric fields}, summaries[] }`
- Singletons: settings, info, health, planned, aggregations, endpoint-liveness
- Error envelope: `{ ok: false, error: { message, code? } }` per ADR-026

**MSW Fixture Stubs** (`apps/frontend/src/test/msw/handlers.ts`) — Expanded 2026-05-02:
- Exported 5 new stub constants matching backend formatters:
  - `TRANSACTION_STUB` — Complete transaction item with all fields (balance: null, updated_at: null)
  - `CATEGORY_STUB` — Complete category with `category_name` derived field
  - `RECIPIENT_STUB` — Complete recipient with normalization fields
  - `INVESTMENT_STUB` — Complete investment with 30+ fields including provider config
  - `PLANNED_TRANSACTION_STUB` — Complete planned transaction with loan/recurrence fields
- All 15 mutation handlers use these stubs (POST/PATCH return stub; DELETE returns message envelope)
- Prevents hand-rolling fixture data in tests; ensures consistency across handlers

**Why contract tests matter:**
- E1 strict schemas catch fixture field mismatches (type, nullability, required fields)
- E2 mutation coverage ensures endpoints return items, not stripped payloads
- E3 error coverage validates error envelope across all status codes and endpoint types
- Acts as living documentation of backend contract
- Catches breaking schema changes before they break component tests

**Maintenance:**
- Backend schema change → update corresponding Zod schema in E1 before shipping
- New boot-time endpoint → add default MSW handler + contract test in E1/E2/E3 as applicable
- Fixture-to-schema mismatch → contract test fails; fix the fixture, never weaken the schema
- New mutation endpoint → add POST/PATCH/DELETE to `defaultHandlers` + E2 tests

### Phase F1: Backend Drift Detection Sweep (2026-05-02) — COMPLETE

**Goal:** Detect frontend regressions from backend contract changes. Scope: every endpoint the frontend calls is covered by both MSW contract tests and live-API contract tests.

**What landed:**
- **MSW handlers expanded** to ~50 previously-unstubbed endpoints (admin, aggregations, AI chat, attachments, categories, imports, info, investments, recipients, reports, splits, transactions, watchlist, planned-transactions)
- **Contract tests expanded** (`apps/frontend/src/test/msw/contracts.test.ts`): 16 → **120 tests** (E1: 10 list schemas, E2: 15 mutation contracts, E3: 4 error envelopes)
- **Live-API contract tests** (`apps/frontend/src/test/live-contracts/live-contracts.test.ts`): 13 → **37 tests** (skipped locally unless `LIVE_API_BASE` set; run on CI against real backend)
- **Playwright e2e specs:** `dialogs-edge.spec.ts` (focus/escape/backdrop), `critical-flows.spec.ts` (smoke + mutation roundtrips)

**Coverage delta:** 1147 → **1204 vitest** (+57 contract-level). +24 live-API tests. +9 Playwright tests.

See [[docs/testing/test-inventory#phase-f1--backend-drift-detection-sweep-2026-05-02|Phase F1 in Test Inventory]]

### Phase F2: Stale Refetch / Mutation Invalidation Sweep (2026-05-02) — COMPLETE

**Goal:** Verify every CRUD mutation triggers appropriate list refetch via TanStack Query `invalidateQueries`.

**What landed:** 6 new mutation-invalidation tests across RecipientsPage, OwesPage, WatchlistPage, CryptoPage, StocksPage, StatisticsPage. Pattern: stub GET with call counter, perform mutation, assert GET fires.

**Coverage delta:** 1204 → **1210 vitest** (+6).

See [[docs/testing/test-inventory#phase-f2--stale-refetch--mutation-invalidation-sweep-2026-05-02|Phase F2 in Test Inventory]]

### Phase F3: Dialog Completeness Sweep (2026-05-02) — COMPLETE

**Goal:** Every dialog taking user input has at least one field-validation test and one submit-error test (5xx response).

**What landed:** 9 new tests ensuring dialogs stay open on error, field guards block submission, validation errors show as toasts. Tests for TransactionInfoDialog, AddInvestmentFromMarketDialog, LinkTransactionDialog, ExecutionHistoryDialog, CustomChartBuilderModal.

**Coverage delta:** 1210 → **1219 vitest** (+9).

See [[docs/testing/test-inventory#phase-f3--dialog-completeness-sweep-2026-05-02|Phase F3 in Test Inventory]]

### Phase F4: Playwright Parity Expansion (2026-05-02) — COMPLETE

**Goal:** Push browser-only edges (real backdrop, real focus trap, network drift, a11y scanning) to Playwright.

**What landed (3 new e2e specs, 32 new tests):**
- `e2e/mutations-parity.spec.ts` — Full CRUD lifecycle in real browser (4 tests: Category/Recipient/Planned create, persist-after-reload invariant)
- `e2e/a11y.spec.ts` — Axe WCAG 2.1 A/AA scans on 9 pages (9 tests, zero critical violations required)
- `e2e/network-drift.spec.ts` — Network listener catching 5xx/4xx during page boot (10 tests catching frontend → backend route mismatches)

**Updated:** `test:e2e` script now runs all 3 new specs alongside smoke, dialogs-edge, critical-flows.

**Coverage delta:** 1219 vitest (unchanged); +**32 Playwright e2e tests**.

See [[docs/testing/test-inventory#phase-f4--playwright-parity-expansion-2026-05-02|Phase F4 in Test Inventory]]

### Phase F5: Property + Chaos Tests (2026-05-02) — COMPLETE

**Goal:** Cover invariants (parser round-trips, envelope passthrough) and verify UI survives transient backend faults.

**What landed (3 new files, 14 new vitest tests):**
- `src/test/property/currency.property.test.ts` — 8 fast-check properties for `parseLocaleNumber` invariants
- `src/test/property/envelope.property.test.ts` — 4 properties for `unwrapEnvelope` per ADR-026
- `src/test/property/chaos-resilience.test.tsx` — 2 chaos tests wrapping endpoints with random latency + 503 errors
- `src/test/msw/chaos.ts` — `chaos(handler)` decorator with deterministic mulberry32 PRNG; tunable via env

**Coverage delta:** 1219 → **1233 vitest** (+14).

See [[docs/testing/test-inventory#phase-f5--property--chaos-tests-2026-05-02|Phase F5 in Test Inventory]]

### Phase F6: Mutation Testing Harness (2026-05-02) — COMPLETE

**Goal:** Measure test *quality* (do tests catch realistic faults?) beyond *coverage*.

**What landed:**
- `stryker.config.json` — Vitest runner, TypeScript checker, scoped to `src/utils/currency.ts` + `src/lib/api/client.ts`
- `package.json` script: `"test:mutation": "stryker run"` (opt-in, not in CI yet)
- Dev deps: `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`, `@stryker-mutator/typescript-checker`

**Why scoped:** Full-codebase mutation testing takes hours. Seed baseline on two highest-leverage pure-logic modules to identify tests with low semantic value (kill rate < 60%). Expand after baseline run.

**Run locally:** `bun run test:mutation` from `apps/frontend`

See [[docs/testing/test-inventory#phase-f6--mutation-testing-stryker-2026-05-02|Phase F6 in Test Inventory]]

### Next Steps (Phase E+)

- E2E performance profiling (LCP, INP, CLS assertions)
- Coverage expansion beyond 17% statements (Phase E goal: 25%+)
- Additional component-integration tests for complex pages (Settings, Analytics, etc.)
- Mutation testing scope expansion (identify low-kill modules from baseline run)

Reference: [[docs/testing/frontend-component-integration|Component-Integration Test Guide]], [[docs/testing/frontend/e2e|E2E Test Guide]], [[docs/testing/test-inventory|Test Inventory]], [[docs/reference/scripts|Scripts Reference]], [[apps/frontend/src/test-setup.ts]], [[apps/frontend/src/test/msw/handlers.ts]], [[apps/frontend/src/test/msw/contracts.test.ts]], [[apps/frontend/e2e/]], [[apps/frontend/stryker.config.json]]

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

- [[apps/node-backend/tests/rateLimiter.test.js]] adds middleware-factory coverage for allow-under-limit, `429` over-limit, window reset behavior, and client key fallback order (`req.ip` → `remoteAddress` → `unknown`). It also verifies presets: `adminRateLimiter` (`500 req/min` for observability reads), `adminMutateLimiter` (`30 req/min` for destructive operations), and `importRateLimiter` (`20 req/min`).
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

Related code: [[apps/node-backend/src/services/currency/currencyConversionService.js]], [[apps/node-backend/src/routes/plannedTransactions.js]], [[apps/node-backend/src/routes/transactions.js]]

### Additional backend repository/schema coverage (2026-04-11)

- [[apps/node-backend/tests/categoryRepository.test.js]] adds repository coverage for `createOrGet` normalization (`general/detail` trim+uppercase), insert success (`created: true`), and conflict fallback returning the existing enriched category (`created: false`).
- [[apps/node-backend/tests/plannedTransactionRepository.test.js]] adds pagination and query-efficiency coverage for `getAll`: fallback count query on empty pages and no execution/loan-schedule follow-up queries when no planned rows exist.

> [!note] Schema initialization test archived
> `schemaInit.test.js` was deleted in Phase 1 (2026-04-21) when `schemaInit.js` was replaced with Alembic migrations ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]).

Related code: [[apps/node-backend/src/repositories/categoryRepository.js]], [[apps/node-backend/src/repositories/plannedTransactionRepository.js]]

Validation run (passed): `bun vitest run tests/categoryRepository.test.js tests/plannedTransactionRepository.test.js`; `npm test -- --coverage`


### Incremental coverage addendum (2026-04-11)

- [[apps/node-backend/tests/currencyConversionService.test.js]] now includes historical miss-cache coverage to ensure duplicate historical-rate DB lookups are avoided for repeated misses.
- Related code: [[apps/node-backend/src/services/currency/currencyConversionService.js]]
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

> [!info] Phase C Update (April 2026)
> These tests predate the Phase C consolidation of the import services. Tests have been refactored to use route-level mocks of the unified `importPipeline` orchestrator; see Phase C addendum below.

- Added bank-adapter parsing regression coverage:
  - [[apps/node-backend/tests/wiseAdapter.test.js]]
  - [[apps/node-backend/tests/sabbAdapter.test.js]]
  - [[apps/node-backend/tests/visionAdapter.test.js]]
- Refactored [[apps/node-backend/tests/routes/import.test.js]] (Phase C) to mock unified orchestrator with coverage for:
  - SSE backpressure and streaming import behavior
  - dedup detection and batch tracking
  - recipient/category matching and creation
  - multer middleware error handling
  - generic bank delegation via orchestrator

**Legacy tests (Phase C, removed 2026-05-29):**
- `rawTransactionImportService.test.js` — Deleted (file and test removed together)
- `streamingImportService.test.js` — Deleted (file and test removed together)
- `iban.test.js` — Deleted (orphan; `iban.js` removed)
- `importService.test.js` — Superseded by route tests

Related code: [[apps/node-backend/src/services/bankAdapters.js]], [[apps/node-backend/src/services/importPipeline/index.js]]

Validation runs (Phase C):
- `bun vitest run tests/routes/import.test.js` — Route-level import test suite with orchestrator mocks


### Incremental backend info-route test addendum (2026-04-11)

- [[apps/node-backend/tests/routes/info.test.js]] expanded coverage for route-level dependency interactions in [[apps/node-backend/src/routes/info.js]] using explicit mocks for:
  - [[apps/node-backend/src/database/connection.js]] query behavior
  - [[apps/node-backend/src/services/recurringDetectionService.js]]
  - [[apps/node-backend/src/services/materializedViewService.js]]
  - [[apps/node-backend/src/services/currency/currencyConversionService.js]] cache helpers
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
- [[apps/node-backend/tests/routes/import.test.js]] (Phase C: updated to mock unified orchestrator)
- [[apps/node-backend/tests/portfolioPerformanceSnapshotService.test.js]]
- [[apps/node-backend/tests/infoRepository.test.js]]
- [[apps/node-backend/tests/materializedViewService.test.js]]

Coverage loop artifacts:
- [[.claude/baselines/test-coverage-baseline-20260411-101903.md]]
- [[.claude/plans/test-coverage-sequential-safe-runbook.md]]

Related areas: market lookup routes, price-provider behavior, investment repository compatibility, import pipeline orchestration (Phase C), portfolio snapshot calculation paths, info repository aggregation, and materialized view refresh behavior.

## Frontend Phase E11: VirtualDataTable Component-Integration Tests (2026-05-01)

Added comprehensive component-integration test coverage for VirtualDataTable, Vision's most complex table UI component.

**What's tested:**

1. **Rendering (6 tests)** — Title, subtitle, headers, rows, empty states, actions slot, footer count
2. **Local Search (4 tests)** — Search placeholder, filtering updates footer, no-results state, clear button
3. **Server-Side Search (3 tests)** — Placeholder changes with callback, 200ms debounce, pre-debounce no-fire
4. **Server-Side Sort (3 tests)** — Click 1→asc, click 2→desc, click 3→clear
5. **Inline Editing (5 tests)** — Double-click to edit, cancel, Escape key, Enter to save with callback, textbox index accounting
6. **Clear All (2 tests)** — Button appears after search, clears state on click

**Test Results:** 23 tests, all passing, <2 seconds execution

**Key Patterns Established:**

- **Mock LanguageContext with async factory:** Import locale dictionary synchronously for test speed
  ```typescript
  vi.mock("@/contexts/LanguageContext", async (importOriginal) => {
    const { default: enDict } = await import("@/locales/en");
    return { ...actual, useLanguage: () => ({ t: (key) => enDict[key] ?? key }) };
  });
  ```

- **Mock TanStack React Virtual to render all items unconditionally:** Avoids DOM layout measurement requirement
  ```typescript
  vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count }) => ({
      getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, key: i, ... })),
    }),
  }));
  ```

- **Debounce testing with fake timers:** Use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` for delay validation
- **Textbox index accounting:** Search input is always first textbox (index 0); edit inputs are offset by +1
- **Stale reference handling:** Use `await waitFor()` when re-querying elements after component re-mounts

**Reference:** [[docs/testing/test-inventory|Test Inventory]], [[docs/testing/frontend-component-integration|Component-Integration Test Guide]]

## Frontend Phase E14: Dialog Component Integration Tests (2026-05-01)

Comprehensive dialog and modal testing patterns established across 11 new test files covering portfolio, recipients, statistics, planned, and tax domains. Tests exercise trigger-based and controlled dialog lifecycles with full MSW network mocking.

**Dialog Types and Patterns:**

1. **Trigger-Based Dialogs** (Portfolio, Statistics, Planned, Tax)
   - Dialog manages its own open/close state via internal state or `trigger` prop
   - Test clicks trigger button to open dialog
   - Dialog closes automatically after successful action or via cancel button
   - Example: `AddPortfolioTxnDialog`, `PortfolioTaxAdjustmentsDialog`

2. **Controlled Dialogs** (Recipients, some Portfolio)
   - Parent owns open state via `open` / `onOpenChange` props
   - Dialog cannot close itself; must call `onOpenChange(false)` for parent to close
   - Test provides `onOpenChange` mock to verify close behavior
   - Example: `AddToWatchlistDialog`, `EditPortfolioTxnDialog`, `LinkTransactionDialog`

3. **Fully Presentational Dialogs** (Portfolio: InvestmentDetailDialog)
   - All state external; dialog is pure render + callbacks
   - Parent controls all behavior via callbacks
   - Example: `InvestmentDetailDialog` with `onEdit`, `onDelete` callbacks

4. **Multi-Step Modals** (Tax)
   - Radix **Sheet** component (slide-out) instead of Dialog
   - Step indicator with back/next/save buttons
   - All steps in same component; no page reload
   - Example: `TaxProfileDialog` with 4-step employment/income/exemptions/region form

**Key Testing Patterns (2026-05-01):**

**Within-Dialog Scoping for Ambiguous Triggers:**
```typescript
// Problem: "Add Investment" button appears both as dialog trigger and inside dialog
// Solution: Use within(dialog) to scope selector to inside the dialog
server.use(http.post(`${API_BASE}/api/investments`, () => ok(INVESTMENT_STUB)));
const user = userEvent.setup();
renderWithApp(<AddInvestmentFromMarketDialog />);
const triggerBtn = screen.getByRole("button", { name: /add investment/i });
await user.click(triggerBtn);

const dialog = await screen.findByRole("dialog");
const addFromMarketBtn = within(dialog).getByRole("button", { name: /add from market/i });
await user.click(addFromMarketBtn);
```

**Icon-Only Button Finding by Index:**
```typescript
// Problem: "Edit" button is icon-only (no accessible name)
// Solution: within(container).getAllByRole("button")[N] by index
const row = within(dialog).getByRole("row", { name: /investment name/i });
const editBtn = within(row).getAllByRole("button")[0]; // Pencil icon
const deleteBtn = within(row).getAllByRole("button")[1]; // Trash icon
await user.click(editBtn);
```

**Combobox Selection by Index:**
```typescript
// Problem: Multiple combobox components in CustomChartBuilderModal
// Solution: getAllByRole("combobox")[N] by positional index
const comboboxes = screen.getAllByRole("combobox");
const categoryCombobox = comboboxes[2]; // Third combobox = category picker
await user.click(categoryCombobox);
await user.click(screen.getByRole("option", { name: /food:groceries/i }));
```

**Raw Fetch vs. apiClient Exception (WatchlistChartDialog):**
```typescript
// WatchlistChartDialog uses raw fetch() instead of apiClient
// MSW handlers must use HttpResponse.json() directly (no ok() envelope)
server.use(
  http.get(`${API_BASE}/api/market/chart`, () =>
    HttpResponse.json({ data: [...] }) // Direct response, no envelope
  )
);
```

**Controlled Dialog with onOpenChange Callback:**
```typescript
const onOpenChange = vi.fn();
renderWithApp(<AddToWatchlistDialog open={true} onOpenChange={onOpenChange} />);
await user.click(screen.getByRole("button", { name: /add to watchlist/i }));
await waitFor(() =>
  expect(onOpenChange).toHaveBeenCalledWith(false) // Parent owns close
);
```

**Multi-Step Form with Step Navigation:**
```typescript
// TaxProfileDialog uses step indicator buttons to jump steps
renderWithApp(<TaxProfileDialog />);
const triggerBtn = screen.getByRole("button", { name: /tax profile/i });
await user.click(triggerBtn);

// Navigate to step 2 (income)
const incomStepBtn = screen.getByRole("button", { name: /income/i });
await user.click(incomStepBtn);
expect(screen.getByText(/household income/i)).toBeInTheDocument();
```

**Confirm Dialogs within Dialogs (RecipientPatternsDialog):**
```typescript
// RecipientPatternsDialog has delete patterns with confirm modal
const deleteBtn = within(patternRow).getAllByRole("button")[1]; // Trash icon
await user.click(deleteBtn);

// Confirm dialog appears
const confirmBtn = screen.getByRole("button", { name: /confirm/i });
expect(server.use).toHaveBeenCalled(); // Verify DELETE was called
```

**Test File Header and Infrastructure:**
```typescript
// @vitest-environment jsdom
import { describe, it, vi, beforeEach, afterEach } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
// server.listen/close/resetHandlers are managed globally in test-setup.ts
// Test files ONLY call server.use(...) for per-test overrides
```

**Form Validation Pattern:**
```typescript
// Submit button disabled until required fields + selections made
const saveBtn = screen.getByRole("button", { name: /save/i });
expect(saveBtn).toBeDisabled(); // Initially disabled

// Fill name
await user.type(screen.getByLabelText(/name/i), "Test Name");
expect(saveBtn).toBeDisabled(); // Still disabled (no selection yet)

// Make selection
await user.click(screen.getByRole("combobox"));
await user.click(screen.getByRole("option", { name: /category/i }));
expect(saveBtn).not.toBeDisabled(); // Now enabled
```

**API Call Verification with vi.spyOn:**
```typescript
// Verify correct endpoint and payload
const postSpy = vi.spyOn(apiClient, "post");
server.use(
  http.post(`${API_BASE}/api/investments/:id/transactions`, () =>
    ok({ id: 123, ... })
  )
);
await user.click(screen.getByRole("button", { name: /submit/i }));
await waitFor(() =>
  expect(postSpy).toHaveBeenCalledWith(
    expect.stringMatching(/\/api\/investments\/\d+\/transactions/),
    expect.objectContaining({ type: "buy" })
  )
);
```

**Total E14 test files:** 11, **88 tests**, all passing (2026-05-01)

**Test execution:** <10 seconds (integrated into main suite)

**Related documentation:** [[docs/testing/test-inventory#e14-portfolio-recipients-statistics-planned-and-tax-dialog-tests-2026-05-01|E14 Test Inventory]], [[docs/testing/frontend-component-integration|Component-Integration Test Guide]], [[docs/adr/026-unified-api-response-envelope|ADR-026]]

## Frontend Phase E15: Onboarding, Notifications, AI Chat, Backup, and Import Tests (2026-05-01)

Six new frontend test files covering multi-step wizards, platform-specific update notifications, AI chat conversation management, Electron-only backup restoration, settings-driven backup controls, and import history workflows. Tests establish three new conventions: Electron stub patterns, stateful harness wrappers for controlled components, and partial fake timer management.

**New Components and Features Tested:**

1. **OnboardingWizard** (11 tests)
   - Multi-step wizard flow: welcome → bank → categories → tour → backup
   - Bank adapter selection step calls `GET /api/info/supported-adapters` (not in defaultHandlers; requires `server.use()` override for `{ adapters, total_count }` shape)
   - Wizard completion calls `onComplete()` callback
   - Navigation between steps via prev/next buttons

2. **UpdateNotification** (8 tests)
   - Version check via `GET /api/admin/update/check`
   - Platform-aware install paths: web (reload hint), Electron (shell update), Docker (pull instructions)
   - Electron branch requires `window.electronUpdater` global stub
   - Platform detection via `apiClient.isElectron()` check

3. **ChatConversationList** (10 tests)
   - List rendering with `onSelect(id | null)` callback
   - Rename dialog: `PATCH /api/ai/conversations/:id`
   - Delete with confirm: `DELETE /api/ai/conversations/:id`
   - Clearing selection when currently-selected conversation is deleted
   - Uses `getByRole("textbox")` for initial values (avoids `getByDisplayValue` timeout with Radix dialogs)

4. **RestoreFromBackupCard** (8 tests)
   - **Electron-only component** — returns `null` on web
   - IPC-based restoration via `window.electronBackup` (no HTTP)
   - Stubs installed per-test in `beforeEach`, restored in `afterEach`
   - Partial `setTimeout` stub to suppress 3s reload timer during tests
   - Encrypted backup triggers passphrase input dialog

5. **BackupTab** (9 tests)
   - Settings page tab with Electron platform detection
   - Controlled component (owns state via test harness)
   - Routes through `window.electronBackup` IPC: `runBackup`, `selectDir`, `setPassphrase`
   - Uses **stateful harness wrapper** to hold state and enable parent re-renders

6. **ImportHistoryCard** (8 tests)
   - Bank import batch list rendering
   - `GET /api/import/batches` in MSW defaultHandlers
   - Rollback workflow: AlertDialog → `DELETE /api/import/batches/:id`
   - Pagination logic: shows pagination UI when `total > PAGE_SIZE` (10)

**Three New Testing Conventions (E15):**

### 1. Electron Stub Pattern

When testing components that conditionally branch on `apiClient.isElectron()` (checks `window.electronUpdater` global):

```typescript
// @vitest-environment jsdom
import { vi, beforeEach, afterEach } from "vitest";

describe("UpdateNotification", () => {
  beforeEach(() => {
    // Install Electron stub as global
    const mockElectronUpdater = {
      installShellUpdate: vi.fn(),
      on: vi.fn(),
    };
    window.electronUpdater = mockElectronUpdater;
  });

  afterEach(() => {
    // Restore (remove stub)
    delete window.electronUpdater;
  });

  it("calls window.electronUpdater.installShellUpdate on Electron", async () => {
    renderWithApp(<UpdateNotification />);
    const installBtn = screen.getByRole("button", { name: /install/i });
    await user.click(installBtn);
    expect(window.electronUpdater.installShellUpdate).toHaveBeenCalled();
  });
});
```

**Key points:**
- Install mock in `beforeEach`, **not** in test body (ensures fresh per-test)
- Delete in `afterEach` to prevent bleed to next test
- Component's `apiClient.isElectron()` checks `window.electronUpdater` existence
- No MSW needed when component uses IPC, not HTTP

### 2. Stateful Harness Wrapper for Controlled Components

When a component is controlled (has `value` + `onChange` props) and you need to test state changes:

```typescript
// Problem: Test cannot directly update BackupTab's value prop
// Solution: Wrap in harness component that manages state

interface BackupTabHarness {
  value: BackupSettings;
  onChange: (newValue: BackupSettings) => void;
}

function BackupTabHarness() {
  const [value, setValue] = useState<BackupSettings>({ ... });
  return <BackupTab value={value} onChange={setValue} />;
}

describe("BackupTab", () => {
  it("calls onChange when directory is selected", async () => {
    const user = userEvent.setup();
    renderWithApp(<BackupTabHarness />);
    
    const selectDirBtn = screen.getByRole("button", { name: /select directory/i });
    await user.click(selectDirBtn);
    
    // window.electronBackup.selectDir resolves; onChange fires
    await waitFor(() => {
      expect(screen.getByText(/backup directory selected/i)).toBeInTheDocument();
    });
  });
});
```

**Key points:**
- Harness holds state locally; component re-renders on `onChange`
- Simpler than attempting `rerender()` with new props
- Test drives UI changes through callbacks, not prop mutations

### 3. Partial Fake Timers (Long-Duration Stubs Only)

When a component uses `setTimeout` for side effects (e.g., 3s page reload) that would break test isolation:

```typescript
// Problem: RestoreFromBackupCard calls window.location.reload() after 3s
// Solution: Stub only long timers (>= 1s); keep short timers real for Radix

import { vi, beforeEach, afterEach } from "vitest";

const realSetTimeout = global.setTimeout;

describe("RestoreFromBackupCard", () => {
  beforeEach(() => {
    // Replace setTimeout with selective stub
    vi.stubGlobal("setTimeout", vi.fn((cb, ms) => {
      // For timers >= 1000ms, return null (suppress)
      if (ms >= 1000) {
        return undefined;
      }
      // For timers < 1000ms, call real setTimeout
      return realSetTimeout(cb, ms);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores backup without triggering page reload", async () => {
    renderWithApp(<RestoreFromBackupCard />);
    
    // Simulate backup file selection and restoration
    // The 3s reload timer is stubbed; test completes without reload
    await waitFor(() => {
      expect(screen.getByText(/backup restored/i)).toBeInTheDocument();
    });
    
    // Verify reload was NOT called (timer was suppressed)
    expect(window.location.reload).not.toHaveBeenCalled();
  });
});
```

**Key points:**
- Use `vi.stubGlobal()` instead of `vi.mock()` for globals (avoids module-wide effects)
- Check timer duration: suppress long timers, allow short ones (Radix uses `requestAnimationFrame` and sub-second timers)
- Restore with `vi.unstubAllGlobals()` in `afterEach`
- Pattern: `ms >= 1000` threshold (adjust per component needs)

### Pattern Integration

**UpdateNotification (Electron stub + partial timers):**
```typescript
// Install Electron stub to route to shell update path
// Stub 3s version-check timeout to prevent async hangs
// MSW mocks GET /api/admin/update/check
```

**RestoreFromBackupCard (Electron stub + partial timers):**
```typescript
// Install window.electronBackup stub for IPC calls
// Stub 3s reload timer to avoid test breakage
// No MSW (IPC path, not HTTP)
```

**ChatConversationList (textbox role pattern):**
```typescript
// Rename dialog opens with initial value pre-filled
// Radix onOpenChange(true) doesn't fire for initially-open dialogs in tests
// Use getByRole("textbox") instead of getByDisplayValue to find input
```

**Total E15 test files:** 6, **54 tests**, all passing (2026-05-01)

**Test execution:** <10 seconds (integrated into main suite)

**Related documentation:** [[docs/testing/test-inventory#e15-onboarding-wizard-notifications-ai-chat-backup-and-import-dialog-tests-2026-05-01|E15 Test Inventory]], [[docs/testing/frontend-component-integration|Component-Integration Test Guide]], [[docs/adr/026-unified-api-response-envelope|ADR-026]]

## Backend Unit Tests — Portfolio Math & Import Pipeline (2026-05-05)

Two new backend test suites covering core calculation and import orchestration logic:

### Portfolio Math Tests

**File:** `apps/node-backend/tests/portfolioMath.test.js` — **21 tests**

Covers portfolio cost basis calculations (FIFO/LIFO), accrued interest computation, and snapshot spike sanitization.

**Test suites:**

1. **calculateCostBasisFIFO** (4 tests)
   - Empty transactions return zeros
   - Buy-only accumulation tracks units and cost
   - FIFO ordering: earliest lot exhausted first (realized gain = sell price - cost)
   - Oversell handling: capped at available units, proceeds scaled by sellRatio

2. **calculateCostBasisLIFO** (3 tests)
   - Empty transactions return zeros
   - LIFO ordering: newest lot exhausted first (opposite realized gain from FIFO)
   - Oversell handling: proportional proceeds scaling

3. **calculateAccruedInterest** (6 tests with fake timers)
   - Zero rate or principal returns 0
   - No buy/interest transactions return 0
   - Exact simple interest calculation: `principal * rate / 365 * daysElapsed`
   - Interest payment date takes precedence over first buy date
   - Future dates return 0 (protection against clock drift)

4. **sanitizeSnapshotSpikes** (4 tests + 1 DST safety test)
   - Non-array input returns empty array
   - Short arrays (< 3 elements) returned unchanged
   - Spike detection: high needle (≥ 1.8× neighbors) and low trough (≤ 1.8× neighbors)
   - Spike replacement: geometric mean of neighbors
   - Input immutability: original array unchanged
   - **UTC day-walk DST safety:** Validates that UTC-based date iteration produces exactly 3 days across European spring-forward boundary (2024-03-31)

**Key patterns:**
- `vi.useFakeTimers()` for deterministic clock control in accrued interest tests
- `expect(...).toBeCloseTo()` for floating-point geometric-mean assertions
- Immutability assertions: `sanitizeSnapshotSpikes(input)` does not mutate input array
- `setUTCDate()` always steps exactly 24 hours regardless of local DST changes

**Related code:** [[apps/node-backend/src/utils/portfolioMath.js]], [[docs/features/portfolio|Portfolio Feature]]

### Import Pipeline Tests

**File:** `apps/node-backend/tests/importPipeline.test.js` — **11 tests**

Covers all four import pipeline phases with comprehensive mocking and error path coverage.

**Test suites:**

1. **validateBatch** (4 tests)
   - Field validation: `tx_date`, `amount` nulls trigger errors
   - Non-numeric amount validation
   - Success path: `{ validated: 1, errors: 0 }`
   - Error path: `{ validated: 0, errors: 1 }`

2. **stageBatch** (2 tests)
   - Unknown adapter throws error
   - Multi-row parse returns `{ rowsTotal: 2 }` count

3. **matchBatch** (2 tests)
   - Pattern-matched row sets `source: "pattern"`
   - Unresolved recipient (`null`) counted as unresolved

4. **commitBatch** (3 tests)
   - Clean insert triggers `refreshAggregations`
   - Duplicate detection skips aggregation refresh
   - Insert error via SAVEPOINT rollback recorded as error

**Mocking strategy:**
- `vi.mock()` for database/connection, logger, adapters, normalization, recipientPatternService, aggregationRefresh
- `withTransaction.mockImplementation(async (fn) => fn(mockClient))` for transaction simulation
- `mockClient.query` chained mocks for INSERT/SELECT/UPDATE sequences
- Per-test error injection: `mockClient.query.mockImplementation()` returns duplicates or throws

**Test execution:** <1 second (pure unit tests, no jsdom or database)

**Related code:** [[apps/node-backend/src/services/importPipeline/validate.js]], [[apps/node-backend/src/services/importPipeline/stage.js]], [[apps/node-backend/src/services/importPipeline/match.js]], [[apps/node-backend/src/services/importPipeline/commit.js]], [[docs/features/import|CSV Import Feature]]

**Impact:** Eliminates gaps in portfolio math calculation coverage and completes the import pipeline orchestration test suite across all four phases.
