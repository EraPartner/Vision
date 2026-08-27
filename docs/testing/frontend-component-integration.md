---
title: Frontend Component-Integration Tests (RTL + MSW)
type: testing
status: active
date: 2026-04-30
updated: 2026-08-26
last-updated: 2026-08-26
last_updated_timestamp: 2026-08-26T00:00:00Z
added_dashboard_error_state_tests: 2026-05-02
added_dialog_integration_tests: 2026-05-01
added_edge_coverage_sweep_e16: 2026-05-02
tags:
  - testing
  - frontend
  - vitest
  - msw
  - rtl
  - integration
  - phase-a
  - phase-b
  - phase-c
description: Render full pages with the real provider stack and HTTP mocked at the network boundary via MSW, validate shared Zod contracts, drive via userEvent, and enforce the frontend coverage ratchet.
---

# Frontend Component-Integration Tests

> [!abstract] What this layer is for
> Render an actual page (or feature surface) with Vision's full provider stack, mock the **network**, drive the UI with `userEvent`, then assert on the DOM. This is the automated equivalent of a developer manually clicking through a flow — fast enough to run in the Vitest fast lane (<60s) and the cheapest layer that can catch broken hooks, broken data flow, and broken render paths.
>
> It complements:
> - **Unit tests** — pure functions / hooks (existing pattern, keep using).
> - **E2E tests** — Playwright + real backend (Phase B); includes smoke tests with a11y checks and visual regression (Phase C; see [[docs/testing/frontend/e2e|E2E Test Guide]]).

## Building Blocks

| Concern | File |
|---|---|
| Provider stack helper | `apps/frontend/src/test/renderWithApp.tsx` |
| MSW server | `apps/frontend/src/test/msw/server.ts` |
| Default HTTP handlers + envelope helpers | `apps/frontend/src/test/msw/handlers.ts` |
| Shared MSW/live Zod resource schemas | `apps/frontend/src/test/contracts/schemas.ts` |
| Lifecycle wiring (MSW + jsdom polyfills) | `apps/frontend/src/test-setup.ts` |
| Coverage gate | `apps/frontend/vite.config.ts` (`test.coverage`) |

`renderWithApp` mirrors the provider tree in `apps/frontend/src/App.tsx`:
`QueryClientProvider` → `SettingsPreloadProvider` → `ThemeProvider` → `SettingsProvider` → `AppSettingsProvider` → `BelgianTaxProfileProvider` → `LanguageBridge` → `TooltipProvider` → `MemoryRouter`. The QueryClient is a fresh per-test instance with `retry: false` and `staleTime: 0`.

## Why MSW (and not `vi.mock(...)`)

- **Centralizes envelope shape.** Handlers return `{ ok: true, data, meta? }` per [[docs/adr/026-unified-api-response-envelope|ADR-026]] — drift caught by contract tests in Phase D.
- **Sidesteps the Bun + Vitest v1.3.13 mock-bleed gotcha** ([[docs/testing/testing#mock-isolation-gotcha-bun--vitest-v1313-critical|here]]). Network-level interception is reset between tests via `server.resetHandlers()`.
- **Tests exercise the real `apiClient`** — retries, timeouts, envelope unwrap, `X-Request-Id` injection — instead of stubbing it out.

## jsdom Polyfills for Radix UI

**Problem:** Radix UI components (Select, Dialog, Tooltip, etc.) rely on DOM APIs that jsdom doesn't fully emulate: `PointerEvent`, `hasPointerCapture`, `setPointerCapture`, `releasePointerCapture`, and `scrollIntoView`. Without polyfills, Radix components may not mount or interact correctly in tests.

**Solution:** `apps/frontend/src/test-setup.ts` guards polyfills with `typeof window !== "undefined"` so they only apply in jsdom tests, not in node-env tests:

```typescript
// Polyfills for Radix UI in jsdom (jsdom tests only — node-env tests have no window).
if (typeof window !== "undefined") {
    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    window.HTMLElement.prototype.scrollIntoView = () => {};
}
```

- **No `PointerEvent` → `MouseEvent` fallback:** Radix uses pointer events for touch + pen + mouse. jsdom doesn't define `PointerEvent`, so we alias it to `MouseEvent`.
- **Capture stubs:** Radix calls these methods to manage focus during multi-input interactions (e.g., dropdown selection). Empty stubs are sufficient for test purposes.
- **`scrollIntoView` stub:** Radix calls this to scroll focused elements into view. A no-op is fine for tests.

**Impact:** Tests can now render and interact with Radix components (`<Select>`, `<Dialog>`, `<Combobox>`) without errors.

## Authoring Pattern

### Basic Render with Default Handlers

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import TransactionsPage from "@/pages/TransactionsPage";

describe("TransactionsPage", () => {
    it("renders with empty data from default handler", async () => {
        // Default handlers return { ok: true, data: { items: [], total: 0, ... } }
        renderWithApp(<TransactionsPage />);

        const heading = await screen.findByRole("heading", { name: /transactions/i });
        expect(heading).toBeInTheDocument();
    });
});
```

### Overriding Handlers Per Test

```tsx
import { http } from "msw";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";

it("shows error UI when endpoint returns 500", async () => {
    server.use(
        http.get("http://localhost:3002/api/transactions", () =>
            err(500, "Database connection failed"),
        ),
    );
    // Default handlers are reset after each test, so this override lasts for this test only
    renderWithApp(<TransactionsPage />);
    // assertions...
});
```

#### Error-State Tests: Account for apiRequest Retry Backoff

When testing error responses (5xx), the `apiRequest` client in `apps/frontend/src/lib/api/client.ts` has an internal retry loop (MAX_RETRIES=2, backoff ~500ms+1000ms) that runs for ~1500ms before finally failing. React Query's `retry: false` does **not** bypass this.

Use `{ timeout: 5000 }` in `findByText` / `findByRole` assertions to outlast the retry cycle:

```tsx
it("shows error alert when API returns 500", async () => {
    server.use(
        http.get("http://localhost:3002/api/planned-transactions", () =>
            err(500, "Database unavailable"),
        ),
    );
    renderWithApp(<PlannedPaymentsPage />);
    
    // Must use timeout: 5000 to account for ~1500ms apiRequest retries + render time
    expect(await screen.findByText(/database unavailable/i, {}, { timeout: 5000 })).toBeInTheDocument();
});
```

This pattern is used in error-state tests across:
- `apps/frontend/src/pages/__tests__/CategoriesPage.integration.test.tsx`
- `apps/frontend/src/pages/__tests__/RecipientsPage.integration.test.tsx`
- `apps/frontend/src/pages/__tests__/StatisticsPage.integration.test.tsx`
- `apps/frontend/src/pages/__tests__/PlannedPaymentsPage.integration.test.tsx`

### Full Dialog Submission Example

```tsx
describe("AddTransactionDialog", () => {
    it("submits POST /api/transactions and closes on success", async () => {
        const user = userEvent.setup();
        let capturedBody: unknown;

        server.use(
            http.post("http://localhost:3002/api/transactions", async ({ request }) => {
                capturedBody = await request.json();
                return ok({ id: 42, amount: 12.5, recipient_id: 7 });
            }),
        );

        renderWithApp(<AddTransactionDialog />);
        
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await user.type(screen.getByLabelText(/amount/i), "12.50");
        await user.click(screen.getByRole("button", { name: /submit/i }));
        
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
        expect((capturedBody as Record<string, unknown>).amount).toBe("12.50");
    });

    it("shows error toast on duplicate detection (409)", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");

        server.use(
            http.post("http://localhost:3002/api/transactions", () =>
                err(409, "Duplicate transaction detected"),
            ),
        );

        renderWithApp(<AddTransactionDialog />);
        // ... fill form and submit ...
        
        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/duplicate transaction detected/i),
            ),
        );
    });
});
```

### Conventions

- **First line is `// @vitest-environment jsdom`** — Vitest 4 stopped honoring `environmentMatchGlobs` reliably for nested test files; the directive is the unambiguous opt-in.
- **One file per page or feature surface.** Name it `<Page>.integration.test.tsx`, place under a sibling `__tests__/` folder.
- **Use `findBy*` / `await screen.findByRole(...)`.** Don't `act()`-fight react-query.
- **Override handlers per case** with `server.use(...)`. The `afterEach` in `test-setup.ts` resets them.
- **Don't mock providers.** The whole point is to render the real provider stack. If a test needs different settings, drive the public APIs (`updateAppSettings`, etc.).
- **Spy on `console.error` only when asserting "no errors"** — restore in `finally` / `afterEach`.

## MSW Envelope Helpers (ADR-026)

`apps/frontend/src/test/msw/handlers.ts` exports two helpers to build envelope-conformant responses:

### `ok<T>(data: T, meta?: EnvelopeMeta)`

Returns a success envelope: `{ ok: true, data, meta? }`

```typescript
server.use(
    http.get("http://localhost:3002/api/transactions", () =>
        ok({ items: [], total: 0, limit: 50, offset: 0, links: [] }),
    ),
);
```

### `err(status: number, message: string, code?: string)`

Returns an error envelope with the given HTTP status: `{ ok: false, error: { message, code? } }`

```typescript
server.use(
    http.post("http://localhost:3002/api/transactions", () =>
        err(409, "Duplicate transaction detected", "DUPLICATE"),
    ),
);
```

### Default MSW Handlers

Covered boot-time endpoints return minimal valid shapes so any page can render:

| Endpoint | Response Shape |
|----------|---|
| `GET /api/settings`, `PUT /api/settings/:key` | `ok({})` or `ok(null)` |
| `GET /api/info`, `GET /api/info/health` | `ok({ version, commit, buildDate })` |
| `GET /api/categories`, `GET /api/recipients`, `GET /api/transactions` | `ok({ items: [], total: 0, limit, offset, links: [] })` |
| `GET /api/planned` | `ok([])` |
| `GET /api/portfolio/summary` | `ok({})` |
| `GET /api/admin/endpoint-liveness` | `ok([])` |

Add new defaults sparingly — most flows belong in per-test overrides via `server.use(...)`.

## Coverage Gate

`bun run test:coverage` runs all Vitest suites with V8 coverage and fails if any of these drop below the configured threshold:

| Metric | Ratchet (2026-08-25) |
|---|---|
| Statements | 62% |
| Branches | 51% |
| Functions | 54% |
| Lines | 64% |

The measured scope includes components, hooks, libraries, pages, utilities, features, contexts, stores, and `App.tsx`. `main.tsx` and `theme-flash.ts` are explicitly excluded because importing either immediately performs boot-time document side effects; their dependencies remain measured, while their execution belongs to end-to-end coverage. Thresholds follow the config's `floor(measured) - 2` convention, so they act as a regression ratchet rather than an aspirational target.

## Dialog Component Integration Tests (2026-05-01 — Phase A)

Three new dialog component integration test files test isolated modal interactions with full provider stack:

| Test File | Scope | Tests |
|---|---|---|
| `apps/frontend/src/features/categories/__tests__/AddCategoryDialog.test.tsx` | Add/Edit Category modal | 10 |
| `apps/frontend/src/features/recipients/__tests__/AddRecipientDialog.test.tsx` | Add Recipient modal (create-only) | 7 |
| `apps/frontend/src/components/shared/__tests__/WidgetVisibilityDialog.test.tsx` | Widget visibility toggles | 8 |

**Coverage Summary:** 3 dialog test files, 25 tests, all passing (Phase A — 2026-05-01)

**Pattern Notes:**

### AddCategoryDialog (10 tests)

**Create Mode:**
- Trigger button renders with "Add Category" label
- Dialog opens on trigger click
- Form shows general, detail, and optional description fields
- Cancel button closes dialog without submission
- Submit closes dialog on success (both fields populated)
- Validation: general field is required (empty blocks submit, dialog stays open)

**Edit Mode:**
- Opens immediately when `open={true}` prop passed with `mode="edit"`
- Form pre-populates from `initialValues` prop (general, detail, description)
- Submit calls `onSave(values)` with uppercase, trimmed values
- Cancel calls `onOpenChange(false)` callback instead of closing internally
- Demonstrates callback-driven control vs. trigger-button-driven create mode

**Key learnings:**
- Dialog can operate in two modes: trigger-driven (create) or prop-driven (edit)
- Uppercase normalization happens at submit time (not input time)
- Both form modes use same underlying `<AddCategoryDialog>` component
- Form validation blocks submit, keeping dialog open

### AddRecipientDialog (7 tests)

**Create-Only Pattern:**
- Trigger button renders with "Add Recipient" label
- Dialog opens on trigger click
- Form shows name (required) and notes (optional) fields
- Cancel closes dialog without submission
- Submit closes dialog on success
- Validation: name is required (empty name blocks submit)
- Submit includes notes even when empty (optional field behavior)

**Key learnings:**
- Simpler than category dialog (single mode, fewer fields)
- Notes field is optional; submission should include it regardless of content
- Similar open/close/validate pattern but simpler form structure

### WidgetVisibilityDialog (8 tests)

**Fully Prop-Driven Pattern:**
- No internal state; all behavior driven by props passed from parent
- Trigger button shows visible count badge (e.g., "2/3" for 2 of 3 widgets visible)
- Dialog opens on trigger click
- Lists all widgets with toggle switches
- Each switch toggle calls `setWidgetVisible(widgetId, isVisible)` callback
- Three action buttons call corresponding callbacks: `setAllVisible(true)`, `setAllVisible(false)`, `resetToDefaults()`

**Key learnings:**
- Fully controlled component: all state lives in parent, dialog is presentational
- Badge in trigger (visible count) updates reactively as parent state changes
- Multiple callback types (single toggle vs. bulk actions) in same dialog
- Similar structure to Radix headless UI patterns (render function, callbacks)

**Common Patterns Across All Three:**

1. **Radix Dialog base** — All use Radix `<Dialog>` for a11y and modal semantics
2. **@vitest-environment jsdom** — Required per-file for Radix UI rendering in jsdom
3. **renderWithApp helper** — Full provider stack ensures contexts (Settings, Language, Theme) work
4. **userEvent for interactions** — Realistic user input: click, type, wait
5. **Callback verification via `vi.fn()`** — Dialog doesn't know about API; parent owns submission logic
6. **Validation testing** — All three test that empty/invalid forms block submission
7. **Dialog open/close flows** — Async finding and waiting for dialog presence/absence

## Phase A Test Inventory (historical snapshot — 2026-04-30)

This table records the original Phase A page-test set plus later edits to the listed files. It is
not a complete current test manifest. Use the filesystem and Vitest collection for current file
and test totals; per-file counts here are updated only when that row is touched.

| Test File | Scope | Tests |
|---|---|---|
| `apps/frontend/src/pages/__tests__/TransactionsPage.integration.test.tsx` | Transactions list page (with export JSON tests + multi-value filter render-loop regression) | 26 |
| `apps/frontend/src/pages/__tests__/ImportPage.integration.test.tsx` | CSV Import page | 23 |
| `apps/frontend/src/pages/__tests__/LanguageSwitch.integration.test.tsx` | Language switching across pages | 32 |
| `apps/frontend/src/pages/__tests__/TaxOverviewPage.integration.test.tsx` | Tax Overview page | 16 |
| `apps/frontend/src/pages/__tests__/AddTransactionDialog.integration.test.tsx` | Add Transaction form | 10 |
| `apps/frontend/src/pages/__tests__/PlannedPaymentsPage.integration.test.tsx` | Planned Payments page | 16 |
| `apps/frontend/src/pages/__tests__/PortfolioOverviewPage.integration.test.tsx` | Portfolio Overview page | 14 |
| `apps/frontend/src/pages/__tests__/OwesPage.integration.test.tsx` | Owes/Splits page (with export CSV tests) | 17 |
| `apps/frontend/src/pages/__tests__/AdminPages.integration.test.tsx` | Admin pages (dashboard, provider health, endpoint liveness) | 25 |
| `apps/frontend/src/pages/__tests__/CategoriesPage.integration.test.tsx` | Categories management | 18 |
| `apps/frontend/src/pages/__tests__/RecipientsPage.integration.test.tsx` | Recipients management | 18 |
| `apps/frontend/src/pages/__tests__/StatisticsPage.integration.test.tsx` | Statistics and embedded recipient insights | 18 |
| `apps/frontend/src/pages/__tests__/portfolio/PortfolioPages.integration.test.tsx` | Portfolio (investments, performance, net worth) | 69 |
| `apps/frontend/src/pages/__tests__/DashboardPage.integration.test.tsx` | Dashboard landing page with error-state coverage | 18 |
| `apps/frontend/src/pages/__tests__/AIChatPage.integration.test.tsx` | AI Chat feature | 15 |
| `apps/frontend/src/pages/__tests__/MarketLookupPage.integration.test.tsx` | Market lookup/quotes | 12 |
| `apps/frontend/src/pages/__tests__/ImportReviewPage.integration.test.tsx` | Import review/staging | 14 |
| `apps/frontend/src/pages/__tests__/DbMaintenancePage.integration.test.tsx` | Database maintenance | 12 |
| `apps/frontend/src/pages/__tests__/NotFound.integration.test.tsx` | 404 page | 5 |

**Coverage note:** Recipient insights are covered through the live Recipients tab in `StatisticsPage.integration.test.tsx`; the deleted standalone page and its test are not part of the route inventory.

### Phase A Gotchas & Patterns

During Phase A completion, four key gotchas were documented for future test authoring:

1. **TaxOverviewPage renders two TaxProfileDialog instances** — use `findAllByRole("dialog")` and take the first; cannot use `findByRole` alone (would error on multiple matches).

2. **Radix Select accessible name without htmlFor link** — locate by traversing `textContent` of child elements rather than expecting a direct label association.

3. **Recipient category regex match in getByRole** — `/employee/i` matches civil_servant desc "Government employee". Use precise `getByRole("radio", { name: /^employee/i })` to anchor to start of string.

4. **VirtualDataTable rows not measurable in jsdom** — skip delete-row tests that require row measurements; focus on interaction flows instead.

## Phasing

| Phase | Focus | Status |
|---|---|---|
| **A** | MSW + `renderWithApp` infrastructure + jsdom Radix polyfills + envelope helpers (`ok`, `err`). 31 page-level component-integration tests covering Transactions, Import, Language Switch, Tax Overview, Add Transaction Dialog, Planned Payments, Portfolio Overview. All tests passing. Infrastructure: Vitest + RTL + MSW v2 with `server.use()` per-test overrides. | COMPLETE (2026-04-30) |
| **B** | Playwright E2E: `playwright.config.ts` + `apps/frontend/e2e/` with five smoke tests (route walk: dashboard, transactions, import, planned, portfolio). Auto-boot dev server locally, Docker Compose in CI. New `test-e2e` CI job with artifact upload. | COMPLETE (2026-04-30) |
| **C** | Visual regression via Playwright screenshots + axe-core accessibility checks. Baselines in `apps/frontend/e2e/__screenshots__/`. CI auto-updates on main branch. | COMPLETE (2026-04-30) |
| **D** | Coverage threshold ratchet + contract tests (zod-validate every MSW fixture against backend's real responses in CI). Thresholds: 17/11/10/18 (statements/branches/functions/lines). 16 contract tests, all passing. | COMPLETE (2026-04-30) |

## MSW & RTL Advanced Patterns (2026-04-30)

### MSW Handler Ordering: Specific Before Wildcard

When MSW handlers share patterns, **specific routes must be registered before wildcard routes**. Order matters because MSW evaluates handlers sequentially:

```typescript
// ✅ CORRECT: Specific handler first
server.use(
    http.get("http://localhost:3002/api/aggregations/monthly-summary", () =>
        ok({ months: [], summary: {...} }),
    ),
    // Generic handler LAST
    http.get("http://localhost:3002/api/:name", () =>
        ok({ items: [], total: 0 }),
    ),
);

// ❌ WRONG: Wildcard catches everything first
server.use(
    http.get("http://localhost:3002/api/:name", () => ok({...})),
    http.get("http://localhost:3002/api/aggregations/monthly-summary", () => ok({...})), // Never matched
);
```

**Why:** MSW's handler registry is FIFO. Once a handler pattern matches the incoming request, no further handlers are evaluated. Place exception handlers above catch-all patterns.

**Example in code:** [[apps/frontend/src/test/msw/handlers.ts]] routes `/api/aggregations/monthly-summary` explicitly before the generic `/:name` catch-all.

### Stale Element Reference: Await findByRole, Don't Assert on Result

When a component re-renders (e.g., loading → data, or loading → empty state), the DOM element reference held during the initial `findByRole` may become stale. Do **not** use `expect(await findByRole(...)).toBeInTheDocument()`:

```typescript
// ❌ WRONG: Result may be stale if DOM re-mounts between find and assertion
const element = await screen.findByRole("heading");
expect(element).toBeInTheDocument(); // May be stale reference

// ✅ CORRECT: Just await the find; it confirms element exists and is stable
await screen.findByRole("heading");
// If component re-mounted, findByRole would have thrown during the re-mount phase
```

**Why:** `findByRole(...)` waits for the element to appear and stabilize. Once it returns, the element is in a stable DOM state. The subsequent `toBeInTheDocument()` check is redundant (already confirmed by the successful find) and risks catching stale references if the component re-mounts during assertion.

**Pattern:** Pages that load async data and render empty states (e.g., PerformancePage) are especially prone to this. Just `await findByRole(...)` is sufficient.

**Example in code:** [[apps/frontend/src/pages/__tests__/portfolio/PortfolioPages.integration.test.tsx]] (PerformancePage) removed `.toBeInTheDocument()` after awaited `findByRole`.

### Multiple Same Elements: Scope the Query or Fix Duplicate Semantics

When repeated visible controls legitimately share a name, scope the query with `within(...)` or use `findAllByRole`. Page-level semantic headings are different: a page and its embedded table should not emit duplicate headings merely to make a test pass. `VirtualDataTable.title` is optional so the page can keep one unique `PageHeader` heading.

```typescript
// A page heading should be unique.
await screen.findByRole("heading", { name: /recipients/i });

// Repeated row actions are legitimate; scope to one row.
const row = screen.getByRole("row", { name: /Alice/i });
await within(row).findByRole("button", { name: /edit/i });
```

**Why:** Indexing the first duplicate can hide an accessibility regression and couples the test to DOM order. Scope genuinely repeated controls; remove accidental duplicate landmarks and headings.

### Role-Based Assertions Preferred Over Text

When text appears in multiple DOM locations (e.g., error banner text appears in both the alert element **and** a sibling span), assert on the role instead of text:

```typescript
// ❌ WRONG: Text appears in multiple elements; findByText may match wrong one
await screen.findByText(/local ai model unreachable/i);

// ✅ CORRECT: Roles are unique; assert on the semantic element
const alert = await screen.findByRole("alert");
expect(alert.textContent).toMatch(/local ai model unreachable/i);

// ✅ OR: Just wait for the role (confirms correct semantics)
await screen.findByRole("alert");
```

**Why:** Text-based queries can match unexpected elements when text appears in multiple sibling or nested locations. Role-based queries target the intended semantic element, ensuring the text is in the right context (e.g., an `alert` role rather than a generic span).

**Example in code:** [[apps/frontend/src/pages/__tests__/AIChatPage.integration.test.tsx]] replaced `findByText` with `findByRole("alert")` to target the semantic alert element instead of the text string.

## DashboardPage Error-State Tests (2026-05-02)

Two new integration tests added to `DashboardPage.integration.test.tsx` to verify error handling when stats APIs return 500:

### Full Error State Test
**"shows full error state when stats API fails and no cached data exists"**

Tests the scenario where the dashboard stats APIs fail and no fallback data is available:
- Mocks `GET /api/aggregations/monthly-summary` → HTTP 500
- Mocks `GET /api/info/transaction-count` → HTTP 500
- No cached stats data (both APIs fail before returning)
- Assertions:
  - Page renders `dashboard.errorLoading` subtitle text: "Error loading dashboard..."
  - Uses `{ timeout: 5000 }` pattern to outlast apiRequest retry backoff (~1500ms)
  - Spies on `console.error` and restores to suppress test output noise

**Pattern:** Per-test `server.use()` overrides returning ADR-026 error envelopes via `err(500, "db unavailable")`

### Partial Data Warning Test
**"shows partial data warning when stats fail but transactions are available"**

Tests graceful degradation when stats APIs fail but core data (transactions) is available:
- Mocks `GET /api/aggregations/monthly-summary` → HTTP 500
- Mocks `GET /api/info/transaction-count` → HTTP 500
- Overrides `GET /api/transactions` to return one item (`TRANSACTION_STUB`)
- Assertions:
  - Page renders `dashboard.partialDataWarning` banner: "Some dashboard data could not be loaded..."
  - Uses same 5000ms timeout pattern
  - Verifies partial error path (shows what data IS available instead of full error)

**MSW Fixture Pattern:** Both tests use the exported `TRANSACTION_STUB` constant from `apps/frontend/src/test/msw/handlers.ts`, ensuring consistent test fixture payloads across all mutation and stub handlers.

**Impact:** DashboardPage now has comprehensive error-state coverage, ensuring users see appropriate feedback when stats APIs fail. Tests catch breaking changes to error message i18n keys and verify the partial-data fallback logic works correctly when some APIs succeed and others fail.

## Frontend Export Tests (2026-05-02)

Completed final integration test gaps by adding export endpoint coverage:

### TransactionsPage Export JSON Tests

Two new tests in `TransactionsPage.integration.test.tsx`:
- **Export JSON shows success toast when download succeeds** — Stubs `URL.createObjectURL` / `URL.revokeObjectURL` (jsdom compatibility), MSW intercepts `GET /api/transactions/export/json`, spies on `toast.success()`, asserts success message fires
- **Export JSON shows error toast when download fails** — MSW returns HTTP 500, spies on `toast.error()`, asserts error message fires

Covers: `TransactionsExportButtons` component integrating with `GET /api/transactions/export/json` endpoint (via `apiClient` with automatic envelope unwrap).

### OwesPage Export CSV Tests

Two new tests in `OwesPage.integration.test.tsx`:
- **Export CSV shows success toast when download succeeds** — Stubs blob URL helpers, MSW intercepts `GET /api/splits/owed/:id/export/csv`, verifies success toast in recipient detail view
- **Export CSV shows error toast when download fails** — MSW returns HTTP 500, verifies error toast in recipient detail view

Covers: Export button in recipient detail view integrating with `GET /api/splits/owed/:id/export/csv` endpoint.

**Historical Phase A coverage included:**
- Full CRUD flows for core entities (Transactions, Recipients, Categories, Planned Payments, Portfolio)
- Export/download endpoints (JSON, CSV)
- Analytics pages (Statistics, Dashboard, Insights)
- Language switching (EN/NL)
- Error states with proper retry-timeout handling (5000ms pattern)
- Dialog/form interactions
- Split tracking and settlement flows
- Admin and maintenance pages

**Test execution:** <60 seconds in fast lane (Vitest + jsdom).

## Related

- [[docs/testing/testing|Testing Guide]]
- [[docs/testing/frontend/e2e|E2E Test Guide (Playwright)]]
- [[docs/testing/test-inventory|Test Inventory]]
- [[docs/adr/026-unified-api-response-envelope|ADR-026: Unified API Response Envelope]]
