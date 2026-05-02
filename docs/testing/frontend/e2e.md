---
title: Frontend E2E Tests (Playwright)
type: testing
status: active
date: 2026-04-30
updated: 2026-04-30
tags:
  - testing
  - frontend
  - playwright
  - e2e
  - phase-b
  - phase-c
  - a11y
  - visual-regression
description: Playwright E2E tests with a11y checks and visual regression — run locally with dev server or in CI with Docker Compose
---

# Frontend E2E Tests (Playwright)

> [!abstract] What this layer is for
> Run Playwright against a real backend (local dev server or CI Docker Compose stack). Smoke-test critical user journeys: dashboard load, transaction add, CSV import, planned transaction create, portfolio overview. Every smoke test includes automated a11y checks (axe-core). Visual regression tests capture and compare full-page screenshots to catch unintended style changes. Catches integration issues between frontend and backend and design regressions that component-integration tests (MSW + jsdom) cannot.
>
> Complements:
> - **Component-integration tests** — fast, network-mocked, no backend (Phase A)
> - **Unit tests** — pure functions / hooks
> - **Visual regression** — catch unintended layout/style changes (Phase C)
> - **Accessibility checks** — automated WCAG 2.1 violations (Phase C)

## Phase C: Accessibility Checks and Visual Regression (2026-04-30)

> [!info] Phase C Testing Layers
> Added automated accessibility (a11y) and visual regression layers to the E2E suite.

### What's New

**1. Accessibility Checks (Axe-Core)**

Every smoke test now calls `checkA11y(page)` using `@axe-core/playwright`. This scans the rendered page for WCAG 2.1 violations and asserts zero critical/serious violations per page.

- **Tool:** `@axe-core/playwright@4.11.2`
- **Integration:** `smoke.spec.ts` calls `checkA11y(page)` after each route navigation
- **Scope:** Catches missing alt text, low contrast, missing labels, semantic HTML issues, focus management problems
- **Failure behavior:** Test fails if critical or serious violations found; warnings and minors are reported but do not block

**Example:**
```typescript
test('dashboard loads with no a11y violations', async ({ page }) => {
  await page.goto('/');
  await checkA11y(page); // Axe scan + assertion
  await expect(page.getByRole('heading', { name: 'Vision' })).toBeVisible();
});
```

**2. Visual Regression Tests**

New `visual.spec.ts` captures full-page screenshots of 5 critical pages. Subsequent runs compare against baseline, alerting developers to unintended style/layout changes.

- **Tool:** Playwright `toHaveScreenshot({ fullPage: true })`
- **Scope:** Dashboard, Transactions, Import, Planned Payments, Portfolio
- **Baseline storage:** `apps/frontend/e2e/__screenshots__/`
- **CI behavior:** Runs only on main branch pushes; automatically updates baselines on CI (no manual approval needed on main)
- **Max diff ratio:** 2% pixel difference tolerance before flagging

**Example:**
```typescript
test('dashboard visual regression', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveScreenshot({ fullPage: true });
});
```

### NPM Scripts

**Frontend package.json:**
```json
{
  "test:e2e": "playwright test e2e/smoke.spec.ts",
  "test:e2e:visual": "playwright test e2e/visual.spec.ts --update-snapshots",
  "test:e2e:update-snapshots": "playwright test --update-snapshots"
}
```

**Root package.json:**
```json
{
  "test:e2e:visual": "bun run --filter 'vision-frontend' test:e2e:visual"
}
```

### Scripts Explained

| Script | Purpose | Use Case |
|--------|---------|----------|
| `bun run test:e2e` | Run smoke + a11y tests (no visual comparison) | Every PR, local dev |
| `bun run test:e2e:visual` | Run visual regression with snapshot update | After intentional design changes (main only) |
| `bun run test:e2e:update-snapshots` | Update all E2E screenshots | Emergency baseline refresh |

### CI Configuration

**GitHub Actions `test-e2e-visual` job:**

Runs **only on push to main**, automatically updates baselines (no manual intervention):

```yaml
test-e2e-visual:
  name: E2E Visual Regression (Main Only)
  runs-on: ubuntu-latest
  if: github.event_name == 'push'  # Only on push, not PR
  steps:
    # ... build, start stack, install Playwright ...
    - name: Run Visual Regression Tests
      run: bun run test:e2e:visual  # --update-snapshots is implicit
    - name: Upload Visual Snapshots
      uses: actions/upload-artifact@v3
      with:
        name: visual-snapshots
        path: apps/frontend/e2e/__screenshots__/
        retention-days: 30
```

**Existing `test-e2e` job (unchanged):** Runs smoke + a11y on all pushes and PRs.

### Playwright Configuration Update

**File:** `apps/frontend/playwright.config.ts`

```typescript
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8080',
    // ... webServer config ...
  },

  snapshotDir: './e2e/__screenshots__',  // NEW: Visual snapshot baseline dir
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,  // NEW: 2% tolerance for pixel diffs
    },
  },
});
```

### When to Update Baselines

**Do update baselines when:**
- Intentional design/layout changes (styling refresh, component redesign)
- Dependency upgrades that affect rendering (e.g., Radix UI, Tailwind versions)
- Browser rendering differences discovered and accepted as expected

**Do NOT update baselines when:**
- Layout shift is unintended (indicates CSS bug)
- Text rendering differs unexpectedly (may indicate font issue)
- Interactive states don't match (focus/hover styles broken)

**How to update (local):**
```bash
cd /path/to/Vision

# Update just visual tests
bun run test:e2e:visual

# Update all E2E screenshots
bun run test:e2e:update-snapshots
```

Then commit updated `.png` files in `apps/frontend/e2e/__screenshots__/`.

**How to update (CI on main):**
The `test-e2e-visual` job automatically runs `--update-snapshots` on every push to main. Manual intervention is not needed.

## Running Tests Locally

### Prerequisites

1. Frontend dependencies installed: `bun install` in `apps/frontend`
2. Playwright chromium browser: `bun exec playwright install chromium` (automatic on first run)
3. Backend running on `http://localhost:3002` OR let Playwright boot the dev server automatically

### Default: Auto-Boot Dev Server (Smoke + A11y Tests)

```bash
cd /path/to/Vision
bun run test:e2e
```

This:
1. Detects `NODE_ENV !== "test"` (CI not set)
2. Boots `bun run dev` from the workspace root
3. Waits for the frontend dev server on `http://localhost:8080`
4. Runs Playwright smoke tests with a11y checks against it
5. Cleans up after test completion

### Run Visual Regression Tests (with baseline update)

```bash
cd /path/to/Vision
bun run test:e2e:visual
```

This runs `visual.spec.ts` with `--update-snapshots`. Use this when:
- You've made intentional design/styling changes
- You want to refresh all visual baselines after a dependency upgrade
- The comparison test failed because the baseline is stale/incorrect

### Alternative: Use Running Backend

If you have a backend server already running (e.g., Docker Compose, local dev):

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3002 bun run test:e2e
```

Or if running the frontend dev server on a different port:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:5173 bun run test:e2e
```

### Watch Mode

```bash
bun exec playwright test --watch
```

Playwright will re-run tests on file changes. Note: screenshot comparisons will fail in watch mode on first run; use `--update-snapshots` to seed the baseline.

## Running Tests in CI

### Test-E2E Job (Smoke + A11y — All Pushes/PRs)

The GitHub Actions `test-e2e` job handles smoke tests with a11y checks on every push and PR:

1. Builds the Docker image from `Dockerfile`
2. Starts the full stack with `docker compose up` (backend + frontend services)
3. Waits for `/health` endpoint to confirm readiness
4. Installs Playwright chromium: `bun exec playwright install chromium`
5. Sets `CI=true` and `PLAYWRIGHT_BASE_URL=http://localhost:3002`
6. Runs `bun run test:e2e` (smoke + a11y checks) against the Compose stack
7. Uploads Playwright test report as an artifact (always)
8. Tears down with `docker compose down`

**Job config:** `.github/workflows/ci.yml` (`test-e2e` job)

**Skipped for:** Draft PRs

### Test-E2E-Visual Job (Visual Regression — Main Pushes Only)

New GitHub Actions `test-e2e-visual` job runs visual regression tests **only on push to main**:

1. Builds the Docker image from `Dockerfile`
2. Starts the full stack with `docker compose up`
3. Waits for `/health` endpoint to confirm readiness
4. Installs Playwright chromium
5. Sets `CI=true` and `PLAYWRIGHT_BASE_URL=http://localhost:3002`
6. Runs `bun run test:e2e:visual` (visual regression with `--update-snapshots`)
7. Uploads visual snapshots as a 30-day artifact
8. Tears down with `docker compose down`

**Job config:** `.github/workflows/ci.yml` (`test-e2e-visual` job)

**Runs on:** Push to main branch only (`if: github.event_name == 'push'`)

**Rationale:** Visual baselines are updated automatically on main to avoid manual approval and drift. PRs compare against the current main baseline instead of updating it.

## Test Files

**Location:** `apps/frontend/e2e/` and `apps/frontend/e2e/__screenshots__/`

**Smoke tests with a11y checks** — 5 critical user flows + accessibility audit:

| Test | File | Coverage | Assertions |
|------|------|----------|-----------|
| Dashboard loads | `smoke.spec.ts` | `/` (dashboard) | Heading "Vision" visible + no a11y violations |
| Transactions page loads | `smoke.spec.ts` | `/transactions` | Heading "Transactions" visible + no a11y violations |
| Import page loads | `smoke.spec.ts` | `/import` | Heading "Import" visible + no a11y violations |
| Planned page loads | `smoke.spec.ts` | `/planned` | Heading "Planned Payments" visible + no a11y violations |
| Portfolio page loads | `smoke.spec.ts` | `/portfolio` | Heading "Portfolio" visible + no a11y violations |

**Visual regression tests** — 5 full-page screenshots:

| Test | File | Coverage | Baseline |
|------|------|----------|----------|
| Dashboard visual | `visual.spec.ts` | `/` (dashboard) | `dashboard.png` |
| Transactions visual | `visual.spec.ts` | `/transactions` | `transactions.png` |
| Import visual | `visual.spec.ts` | `/import` | `import.png` |
| Planned visual | `visual.spec.ts` | `/planned` | `planned.png` |
| Portfolio visual | `visual.spec.ts` | `/portfolio` | `portfolio.png` |

**File structure:**
```
apps/frontend/
├── e2e/
│   ├── smoke.spec.ts                    # Five smoke tests + a11y checks
│   ├── visual.spec.ts                   # Five visual regression tests
│   └── __screenshots__/
│       ├── dashboard.png
│       ├── transactions.png
│       ├── import.png
│       ├── planned.png
│       └── portfolio.png
├── playwright.config.ts                 # Playwright configuration
├── package.json                         # test:e2e, test:e2e:visual scripts
└── ... (source)
```

## Playwright Configuration

**File:** `apps/frontend/playwright.config.ts`

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  
  // Run chromium only (no webkit/firefox for now)
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8080',
    // ... other options
  },

  // Boot dev server when not in CI
  webServer: process.env.CI ? undefined : {
    command: 'bun run dev',
    cwd: process.cwd().replace(/\/apps\/frontend$/, ''), // Root workspace
    url: 'http://localhost:8080',
    reuseExistingServer: false,
  },
});
```

**Key settings:**
- **baseURL:** Configured from `PLAYWRIGHT_BASE_URL` env var (default `http://localhost:8080`)
- **Browser:** Chromium only
- **webServer:** Automatic dev-server boot when not in CI

## Adding New E2E Tests

### Pattern: Route + A11y Check + Heading Assertion

```typescript
// apps/frontend/e2e/my-feature.spec.ts
import { test, expect } from '@playwright/test';
import { checkA11y } from 'axe-playwright';

test('my feature page loads with no a11y violations', async ({ page }) => {
  await page.goto('/my-feature');
  
  // Accessibility check (Phase C)
  await checkA11y(page);
  
  // Functional assertion
  const heading = page.getByRole('heading', { name: /my feature/i });
  await expect(heading).toBeVisible();
});
```

### Pattern: Visual Regression (New Page)

```typescript
// apps/frontend/e2e/visual.spec.ts
import { test, expect } from '@playwright/test';

test('my feature page visual regression', async ({ page }) => {
  await page.goto('/my-feature');
  await page.waitForLoadState('networkidle');
  
  // Capture full-page screenshot (Phase C)
  await expect(page).toHaveScreenshot('my-feature.png', { fullPage: true });
});
```

### Best Practices

**Functional Testing:**
- **Use semantic selectors:** `page.getByRole('heading', { name: /xyz/i })` preferred over `page.locator('.xyz')`
- **Avoid flaky waits:** Let Playwright retry assertions; don't add manual `waitFor` or `sleep`
- **Test user flows, not implementation:** Click buttons, fill forms, assert on visible results
- **Keep tests fast:** Smoke tests should complete in < 60s total
- **One feature per file:** Group related tests in one `.spec.ts` file

**Accessibility Testing (Phase C):**
- **Always call `checkA11y(page)`** after navigating to a page in smoke tests
- **Understand critical vs. serious violations:** The `checkA11y()` helper fails on critical/serious but reports minors/warnings (informational only)
- **Fix violations in source code, not test mocks:** If a test finds an a11y issue, fix the component/page, not the test

**Visual Regression Testing (Phase C):**
- **Capture visual state after interactions:** Wait for `networkidle` or specific elements before calling `toHaveScreenshot()`
- **Test both light and dark themes** if the page supports theme switching (use `page.emulateMedia({ colorScheme: 'dark' })`)
- **Ignore intentional animations:** Some pages may have intentionally animated elements; capture them in their final stable state
- **Review diffs carefully:** If a baseline update is needed, inspect the diff in the artifact to confirm the change is intentional

### Example: Form Submission

```typescript
test('adds transaction via form', async ({ page }) => {
  await page.goto('/transactions');
  
  // Open dialog
  await page.getByRole('button', { name: /add transaction/i }).click();
  
  // Fill form
  await page.getByLabel(/amount/i).fill('12.50');
  await page.getByLabel(/recipient/i).selectOption('Alice');
  
  // Submit
  await page.getByRole('button', { name: /submit/i }).click();
  
  // Verify result
  await expect(page.getByText(/transaction created/i)).toBeVisible();
});
```

## Commands

### Smoke + A11y Tests

```bash
# Run all smoke tests with a11y checks (auto-boots dev server)
bun run test:e2e

# Run specific smoke test
bun exec playwright test e2e/smoke.spec.ts

# Run smoke tests matching a pattern
bun exec playwright test -g "dashboard"

# Run in headed mode (see browser)
bun exec playwright test --headed

# Run in debug mode (step through)
bun exec playwright test --debug
```

### Visual Regression Tests (Phase C)

```bash
# Run visual regression tests with snapshot update
bun run test:e2e:visual

# Run visual tests only, with comparison (no update)
bun exec playwright test e2e/visual.spec.ts

# Update all E2E screenshots
bun run test:e2e:update-snapshots

# View visual diffs (when comparison fails)
bun exec playwright show-report
```

## CI/CD Integration

**GitHub Actions job:** `.github/workflows/ci.yml`

```yaml
test-e2e:
  name: E2E Tests (Playwright)
  runs-on: ubuntu-latest
  if: github.event.pull_request.draft == false
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - name: Build Docker image
      run: docker build -t vision:latest .
    - name: Start Docker Compose stack
      run: docker compose up -d
    - name: Wait for health
      run: |
        until curl -f http://localhost:3002/health; do
          sleep 1
        done
    - name: Install Playwright
      run: bun exec playwright install chromium
    - name: Run E2E tests
      run: bun run test:e2e
      env:
        CI: true
        PLAYWRIGHT_BASE_URL: http://localhost:3002
    - name: Upload report
      if: always()
      uses: actions/upload-artifact@v3
      with:
        name: playwright-report
        path: apps/frontend/playwright-report/
    - name: Teardown
      if: always()
      run: docker compose down
```

## Debugging

### Browser DevTools

Run in headed mode to see what Playwright sees:

```bash
bun exec playwright test --headed
```

### Step Through Tests

```bash
bun exec playwright test --debug
```

Opens Playwright Inspector — pause and step through each action.

### View Generated Report

After test run:

```bash
bun exec playwright show-report
```

Opens HTML report with:
- Full test output
- Screenshots at each step
- Network logs
- Console logs

### Common Issues

**"Connection refused on localhost:8080"**
- Dev server failed to boot. Check logs and ensure `bun run dev` works standalone.
- Fallback: Start backend on 3002 with `PLAYWRIGHT_BASE_URL=http://localhost:3002`

**"Target page, context or browser has been closed"**
- Test took too long; browser context timed out. Add explicit waits: `page.waitForLoadState('networkidle')`

**"Timeout waiting for selector"**
- Element didn't appear. Check if backend returned expected data. Use `--debug` to inspect state.

### A11y Violation Debugging (Phase C)

**Test output shows a11y violations but CI doesn't fail:**
- Violations at "minor" or "warning" severity are reported but don't fail the test (informational)
- Check `checkA11y()` helper output or run `bun exec axe-playwright --target "page_url"` for detailed violation list
- Fix the violation in the source component/page, then re-run the test

**Example: Missing alt text**
```
FAIL violation: Images must have alternative text (serious)
Target: <img src="chart.png" />
Fix: Add alt="..." attribute
```

### Visual Regression Debugging (Phase C)

**Screenshot comparison fails with "image mismatch":**
1. Run `bun exec playwright show-report` to view the diff
2. Compare "Expected" (baseline) vs. "Actual" (current render)
3. If the change is intentional (design update, theme change), run `bun run test:e2e:visual` to update baseline
4. If the change is unintended (CSS regression, font load issue), fix the source code and re-run

**Screenshot comparison shows slight pixel differences:**
- Minor rendering differences (1-2 pixels on Chrome vs. Firefox) are expected
- The default `maxDiffPixelRatio: 0.02` (2%) allows for browser/OS rendering variation
- If differences exceed 2%, the test fails; increase the tolerance only if variations are expected and benign

**Screenshot is blank or shows wrong content:**
- Ensure `page.waitForLoadState('networkidle')` is called before `toHaveScreenshot()`
- If network request hangs, increase the wait timeout: `await page.waitForLoadState('networkidle', { timeout: 10000 })`
- Check that the backend returned expected data (use `--debug` or `--headed` to inspect network tab)

## Related

- [[docs/testing/frontend-component-integration|Component-Integration Tests]] — fast, mocked network (Phase A)
- [[docs/testing/testing|Testing Guide]] — overall testing strategy and patterns
- [[docs/testing/test-inventory|Test Inventory]] — current coverage metrics
- [[docs/testing/index|Testing Index]] — overview of all test layers
- `@axe-core/playwright` — WCAG 2.1 accessibility checker
- `@playwright/test` — E2E testing framework
