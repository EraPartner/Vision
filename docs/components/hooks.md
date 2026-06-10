---
title: Custom Hooks
type: component
status: active
date: 2026-04-23
updated: 2026-06-10
last_modified: 2026-06-10
tags: [components, hooks, react-query, zustand, form-state, data-table, phase-4, phase-13, phase-c, phase-d, i18n, notifications, export-filters, bug-hunt-2026-05-05, bug-hunt-2026-05-06, bug-hunt-2026-05-08, mount-guard, query-key-fix, prefetch, memoization, useCallback, parseLocaleNumber, currency-utilities, exclusion-ids, ssrf-correctness, loading-states, error-states, isError, refetch, recipient-insights-filter, optimistic-updates, optimistic-create, liquid-glass-v2, premium-v3, june-2026]
description: Custom React hooks for data fetching and state management. Includes toast notifications for mutations via i18n keys. Phase 13 adds useBankAccounts hook for export filtering. May 2026 bug hunt adds mount guard to usePlannedPayments, fixes queryKey mismatch in usePortfolioPrefetch, and documents parseLocaleNumber utility for locale-aware number parsing. 2026-05-29 adds useExcludedIds as a shared exclusion-resolution hook and exposes isLoading/isError/error/refetch from usePortfolio so asset pages can distinguish loading/error from empty. 2026-06-01: useStatistics adds recipientInsightsFilteredQuery so the all-years Top Recipients chart reacts to exclusion toggles. 2026-06-10: useUpdateTransaction/useDeleteTransaction made optimistic (ADR-070 Tier 5). 2026-06-10 Premium v3 (ADR-071): useCreateTransaction made optimistic (temp negative-id row, server swap, rollback, onSettled invalidate; 6 tests total).
related_code: ["apps/frontend/src/hooks"]
---

# Custom Hooks

Vision uses custom hooks for data fetching, state management, and reusable logic.

## Hook List

### Settings & State Store Hooks (Phase 4)

| Hook | Description | File |
|------|-------------|------|
| `useSettingsStore()` | Zustand store access (full state) | [[apps/frontend/src/stores/settingsStore.ts\|settingsStore.ts]] |
| `useAppSettings()` | App settings slice with shallow selection | [[apps/frontend/src/contexts/AppSettingsContext.tsx\|AppSettingsContext.tsx]] |
| `useSettings()` | Dashboard/exclusion settings slice | [[apps/frontend/src/contexts/SettingsContext.tsx\|SettingsContext.tsx]] |
| `useTheme()` | Theme settings slice | [[apps/frontend/src/contexts/ThemeContext.tsx\|ThemeContext.tsx]] |

### Data Fetching Hooks

| Hook | Description | File |
|------|-------------|------|
| `useTransactions()` | Transaction CRUD | [[apps/frontend/src/hooks/useTransactions.ts\|useTransactions.ts]] |
| `useCategories()` | Category management | [[apps/frontend/src/hooks/useCategories.ts\|useCategories.ts]] |
| `useRecipients()` | Recipient management | [[apps/frontend/src/hooks/useRecipients.ts\|useRecipients.ts]] |
| `useBankAccounts()` | Distinct bank account IBANs (Phase 13) | [[apps/frontend/src/hooks/useBankAccounts.ts\|useBankAccounts.ts]] |
| `usePortfolio()` | Investment portfolio | [[apps/frontend/src/hooks/usePortfolio.ts\|usePortfolio.ts]] |
| `usePlannedPayments()` | Planned transactions | [[apps/frontend/src/hooks/usePlannedPayments.ts\|usePlannedPayments.ts]] |
| `useStatistics()` | Analytics data | [[apps/frontend/src/hooks/useStatistics.ts\|useStatistics.ts]] |
| `useSplits()` | Debt tracking | [[apps/frontend/src/hooks/useSplits.ts\|useSplits.ts]] |
| `useSavedCharts()` | Saved chart configs | [[apps/frontend/src/hooks/useSavedCharts.ts\|useSavedCharts.ts]] |

### UI State Hooks

| Hook | Description | File |
|------|-------------|------|
| `useWidgetVisibility()` | Widget visibility | [[apps/frontend/src/hooks/useWidgetVisibility.ts\|useWidgetVisibility.ts]] |
| `useFilteredDashboardStats()` | Filtered dashboard data | [[apps/frontend/src/hooks/useFilteredDashboardStats.ts\|useFilteredDashboardStats.ts]] |
| `useExcludedIds(scope)` | Single source of truth for excluded category/recipient IDs (2026-05-29) | [[apps/frontend/src/hooks/useExcludedIds.ts\|useExcludedIds.ts]] |
| `useConfirmDialog()` | Confirmation dialogs | [[apps/frontend/src/hooks/useConfirmDialog.tsx\|useConfirmDialog.tsx]] |
| `useFormState()` | Generic typed form state with dirty tracking (Phase 4) | [[apps/frontend/src/hooks/useFormState.ts\|useFormState.ts]] |

### Utility Hooks

| Hook | Description | File |
|------|-------------|------|
| `useDebounce()` | Debounce value changes | `useDebounce.ts` |
| `useIsMobile()` | Responsive breakpoint check | `use-mobile.tsx` |
| `useDataTableColumns()` | Memoized column definitions for DataTable (Phase 4) | [[apps/frontend/src/hooks/useDataTableColumns.ts\|useDataTableColumns.ts]] |

### Portfolio Hooks

| Hook | Description | File |
|------|-------------|------|
| `usePortfolioTaxAdjustments()` | Per-investment tax/fee adjustments by year | `usePortfolioTaxAdjustments.ts` |
| `usePortfolioPrefetch()` | Prefetch portfolio performance data with corrected queryKey | [[apps/frontend/src/hooks/usePortfolioPrefetch.ts\|usePortfolioPrefetch.ts]] |

### Chart & Formatting Hooks

| Hook | Description | File |
|------|-------------|------|
| `useChartCurrencyFormatter()` | Currency formatting for chart components | `useChartCurrencyFormatter.ts` |

---

## useTransactions

Hook for managing transactions.

### Optimistic Create (Premium v3, June 2026, ADR-071)

`useCreateTransaction` is now optimistic as of the Premium v3 batch (ADR-071):

- **Pattern**: insert temp row → swap on success → remove + rollback on error → `onSettled` invalidate.
- `onMutate`: generates a temp id (`-Date.now()`) and inserts the new row at the head of all plain `['transactions', params]` caches via `queryClient.setQueriesData`.
- `onSuccess`: swaps the temp row with the server-returned row (matching on the temp id).
- `onError`: removes the temp row and restores the snapshot.
- `onSettled`: invalidates `['transactions']` so server truth (correct ordering, filters, derived fields) wins.
- **`['transactions-virtual']` deliberately not patched**: same rationale as update/delete — the virtual list mirrors cached first-page data into local React state; patching mid-scroll would collapse the list.
- **Derived fields**: the optimistically inserted row may lack `category_name` and `recipient_name` (only ids are in the payload). The `onSettled` refetch corrects this within one round-trip.
- 6 tests total in `hooks/__tests__/useOptimisticTransactions.test.tsx`.

### Optimistic Update / Delete (June 2026, ADR-070)

`useUpdateTransaction` and `useDeleteTransaction` are now optimistic as of June 2026 (ADR-070 Tier 5):

- **Pattern**: snapshot-all → optimistic-patch-all → rollback-on-error → `onSettled` invalidate.
- `onMutate`: calls `queryClient.setQueriesData` across all `['transactions', params]` cache entries to apply the change immediately before the network request returns.
- `onError`: restores the snapshot so every patched cache key reverts to its previous value.
- `onSettled`: calls `queryClient.invalidateQueries(['transactions'])` so server truth always wins after settlement.
- **`['transactions-virtual']` deliberately not patched**: `useTransactionListData` mirrors the virtual list's first page into local state; patching that cache key while the user is scrolled would collapse the list. It is invalidated by `onSettled` like the rest.
- **`tags` excluded from merge**: the mutation payload carries `string[]` tag slugs but the cached row holds `Tag[]` objects; merging them would produce wrong shapes. Tags are corrected by the `onSettled` refetch.
- 4 new tests in `hooks/__tests__/useOptimisticTransactions.test.tsx`.

> [!note] Stale category/recipient name
> An optimistic update can briefly show a stale `category_name` or `recipient_name` when only the id changed (the id is in the payload but the joined name is not). The `onSettled` invalidation corrects this within one round-trip. Amounts always come from user input, never derived.

### API

```typescript
const {
  data,              // Transaction list
  isLoading,        // Loading state
  error,            // Error state
  refetch,          // Refetch data
} = useTransactions(options);

// Mutations
const createMutation = useCreateTransaction();
const updateMutation = useUpdateTransaction();   // optimistic since ADR-070
const deleteMutation = useDeleteTransaction();   // optimistic since ADR-070
```

### Options

```typescript
interface UseTransactionsOptions {
  limit?: number;
  offset?: number;
  transaction_id?: number;
  start_date?: string;
  end_date?: string;
  category_id?: number;
  recipient_id?: number;
  recipient_name?: string;
  bank_account?: string;
  uncategorised?: boolean;
  active?: boolean;
  search?: string;
}
```

### Usage

```tsx
const { data, isLoading } = useTransactions({
  limit: 50,
  start_date: "2025-01-01",
  end_date: "2025-03-18",
  transaction_id: 123,
});

// Create transaction
const create = useCreateTransaction();
create.mutate({
  transaction_date: "2025-03-18",
  amount: -50.00,
  recipient_id: 1,
});
```

---

## useCategories

Hook for managing categories.

### API

```typescript
const { data, isLoading } = useCategories(options);

const createMutation = useCreateCategory();
const updateMutation = useUpdateCategory();
const deleteMutation = useDeleteCategory();
```

### Options

```typescript
interface UseCategoriesOptions {
  limit?: number;
  active?: boolean;
  search?: string;
}
```

---

## usePortfolio

Hook for managing investment portfolio.

### Memoization (Phase C)

- **Module-level `EMPTY_TRANSACTIONS` constant** — Prevents fresh array ref per render (Phase C fix), improving memoization stability
- Implementation: `const EMPTY_TRANSACTIONS = [];` at module scope, reused across renders instead of creating new refs
- Impact: React.memo and useMemo hooks referencing this constant now receive stable references, avoiding spurious re-renders

### API

```typescript
const {
  summaries,              // Investment summaries
  totalPortfolioValue,   // Total value
  totalGainLoss,         // Total gain/loss
  totalRealizedGain,     // Realized gains
  totalUnrealizedGain,   // Unrealized gains
  refreshPrices,         // Refresh all prices
  isRefreshingPrices,    // Refreshing state
  // Query state (2026-05-29) — allows pages to distinguish loading/error from empty
  isLoading,             // boolean — true while initial fetch is in flight
  isError,               // boolean — true when the fetch has failed
  error,                 // Error | null
  refetch,               // () => void — re-trigger the failed query
} = usePortfolio();

// Mutations
const deleteInvestment = useDeleteInvestment();
const createInvestment = useCreateInvestment();
```

### Loading / Error State Exposure (2026-05-29)

Prior to this change, a failed investments fetch resolved to an empty `investments` array, causing asset pages to silently render the "no holdings" empty state. `usePortfolio` now forwards `isLoading`, `isError`, `error`, and `refetch` from the underlying `useInvestmentsQuery` so callers can render a skeleton while loading and a `PageError` with retry on failure.

All four asset pages (Stocks, Crypto, Savings, Real Estate; Metals via `StocksPage`) use this to gate their rendering. See [[docs/features/portfolio#portfolio-asset-page-loading-and-error-states-2026-05-29|Portfolio — Loading/Error States]] for the full state table.

### Investment Summary

```typescript
interface InvestmentSummary {
  id: number;
  name: string;
  symbol?: string;
  assetClass: string;
  totalUnits: number;
  totalBuyCost: number;
  currentValue: number;
  gainLoss: number;
  gainLossPercent: number;
  totalIncome: number;
}
```

Code links: [[apps/frontend/src/hooks/usePortfolio.ts]]

---

## usePlannedPayments

Hook for planned/scheduled transactions.

### Settings-Aware Mapping

- API-to-UI mapping fallback currency derives from configured app defaults (`appSettings.defaultCurrency` context) rather than fixed literals

### Mount Guard (2026-05-05)

- Added `mountedRef` to prevent `setState` after component unmount (prevents memory leaks and React warnings)
- Implementation: `useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; } }, [])`
- All state updates check `if (mountedRef.current)` before calling `setData()` etc.
- Impact: Prevents stale state updates on unmounted instances; ensures clean teardown

Code links: [[apps/frontend/src/hooks/usePlannedPayments.ts]], [[apps/frontend/src/contexts/AppSettingsContext.tsx]]

### API

```typescript
const { data, isLoading } = usePlannedPayments(options);

const createMutation = useCreatePlannedPayment();
const updateMutation = useUpdatePlannedPayment();
const deleteMutation = useDeletePlannedPayment();
const executeMutation = useExecutePlannedPayment();
```

### Options

```typescript
interface UsePlannedPaymentsOptions {
  limit?: number;
  upcoming?: boolean;
  includeExecuted?: boolean;
}
```

---

## useStatistics

Hook for analytics/statistics data with per-graph exclusion support.

### API

```typescript
const {
  data,              // Filtered statistics data
  unfilteredData,    // Statistics without exclusions
  getGraphData,      // (key: string) => StatisticsData | null
  graphExclusions,   // Record<string, boolean>
  toggleGraphExclusion, // (key: string) => void
  exclusionsApply,   // boolean
  isLoading,         // Loading state
  isError,           // Error state
  error,             // Error object
} = useStatistics();
```

### Returns

```typescript
interface StatisticsData {
  monthlyData: MonthlyData[];      // Monthly income/expense
  categoryPivot: CategoryPivot[]; // Category spending breakdown (mode-dependent)
  topRecipients: RecipientSpending[]; // Top spending recipients
  topRecipientsByYear: Record<string, RecipientSpending[]>; // Year key (or all) -> recipients
  yearlyComparison: YearlyComparison[]; // Year-over-year data
  allPeriods: string[];           // Available periods (YYYY-MM)
  allYears: number[];             // Available years
  totalIncome: number;            // Total income
  totalSpending: number;          // Total spending
  averageMonthlySpending: number; // Average monthly spending
  averageMonthlyIncome: number;   // Average monthly income
}

interface CategoryPivot {
  categoryName: string;  // "GENERAL: DETAIL" format
  categoryId: number;
  months: Record<string, number>; // period -> total
  total: number;
}
```

### Features

- **Shared exclusion resolution**: Delegates exclusion-ID resolution to `useExcludedIds('statistics')` (2026-05-29) — no longer owns a separate category-list fetch; ensures exclusion set is identical to the Dashboard surface
- **Per-graph exclusion toggle**: Each chart can independently toggle category/recipient exclusions
- **Filtered recipient-insights query (2026-06-01)**: Issues a separate `recipientInsightsFilteredQuery` (keyed on `effectiveExcludedCategoryIds` + `settingsExcludedRecIds`) when exclusions are active. The filtered payload is used for `topRecipients` in `mapToStatisticsData` so the "all years" Top Recipients chart reacts to exclusion toggles. Previously only the per-year view was filtered; the all-years aggregate silently ignored exclusions.
- **Category normalization**: Ensures consistent `GENERAL: DETAIL` formatting across all charts
- **Automatic query invalidation**: Reacts to settings changes
- **Currency-aware stats fetching**: Uses `appSettings.defaultCurrency` as target currency for normalized transaction pulls (`normalize_to_eur=true` + `target_currency`)
- **Currency in query keys**: Includes selected currency in React Query cache keys to prevent stale cross-currency reuse
- **Large dataset support**: Fetches all transactions in paginated batches
- **Year-aware category pie support**: Works with year-filtered pie slices while preserving normalized labels
- **Shared processing module**: `useStatistics` delegates aggregation to `statisticsProcessing.ts` for consistent cross-widget calculations
- **Pivot aggregation variants**: Processing emits pivot months/totals for absolute, income, expense, and net views
- **Recipients yearly aggregation**: Processing emits `topRecipientsByYear` for `All years` and per-year recipient spending views

### Usage

```tsx
const { data, getGraphData, toggleGraphExclusion } = useStatistics();

// Get data for a specific graph
const pieData = getGraphData('categoryPie');

// Toggle exclusions for a graph
toggleGraphExclusion('categoryPie');
```

---

## useSplits

Hook for transaction splitting and debt tracking.

### API

```typescript
const { data, isLoading } = useSplits();

// Mutations
const createSplits = useCreateSplits();
const addPayment = useRecordPayment();
const settleSplit = useSettleSplit();
const settleAllByRecipient = useSettleAllSplitsByRecipient();
const removeSplit = useDeleteSplit();
```

### User Feedback

All mutations provide toast notifications via `useLanguage()` i18n hook:

| Mutation | Success Toast | Error Toast |
|----------|---|---|
| `useSettleSplit()` | `splits.settled` | `splits.settledFailed` |
| `useSettleAllSplitsByRecipient()` | `splits.allSettled` | `splits.allSettledFailed` |
| `useRecordPayment()` | `splits.paymentRecorded` | `splits.paymentFailed` |

See [[docs/i18n/translations]] for key definitions.

---

## useWidgetVisibility

Hook for managing widget visibility on pages.

### API

```typescript
const {
  isVisible,         // (id: string) => boolean
  setWidgetVisible,  // (id: string, visible: boolean) => void
  setAllVisible,     // () => void
  resetToDefaults,   // () => void
  widgets,           // WidgetDefinition[]
} = useWidgetVisibility(pageId, widgetDefinitions);
```

### Usage

```tsx
const WIDGETS = [
  { id: 'stats', label: 'Statistics' },
  { id: 'chart', label: 'Chart' },
];

function Page() {
  const { isVisible, setWidgetVisible } = useWidgetVisibility('page-id', WIDGETS);
  
  return (
    <>
      {isVisible('stats') && <StatsWidget />}
      {isVisible('chart') && <ChartWidget />}
    </>
  );
}
```

---

## useFilteredDashboardStats

Hook for fetching dashboard statistics with exclusions.

### API

```typescript
const {
  data,              // Stats data
  isLoading,         // Loading
  error,             // Error
} = useFilteredDashboardStats();
```

### Features

- Delegates exclusion-ID resolution to `useExcludedIds('dashboard')` (2026-05-29) — no longer owns a separate category-list fetch
- Applies category/recipient filters
- Requests monthly summary in selected app currency via `currency` query param
- Includes selected app currency in query key for cache isolation
- Uses the **latest month with data** for dashboard income/spending cards
- Computes card totals from live transactions for that month to avoid stale materialized-view lag
- Fetches month transactions in pages so totals remain complete on large datasets

---

## useExcludedIds (2026-05-29)

Single source of truth for "which category/recipient IDs are excluded from money totals" across the dashboard and statistics surfaces.

**File:** [[apps/frontend/src/hooks/useExcludedIds.ts]]

### Problem it solves

Previously, exclusion ID resolution was duplicated across three call sites (`useFilteredDashboardStats`, `useStatistics`, `DashboardPage`). Each call fetched the full category list under a different React Query cache key and a different `limit` (500 vs 1000). A deployment with more than 500 categories would get a different hidden-category set on the Dashboard vs Statistics, silently producing different income/spending/net totals across screens.

### API

```typescript
const {
  excludedCategoryIds,   // number[] — settings exclusions + hidden categories, sorted asc
  excludedRecipientIds,  // number[] — settings recipient exclusions, sorted asc
  exclusionsApply,       // boolean — false when scope doesn't include this surface
  isReady,               // boolean — true once category data resolved (or not needed)
} = useExcludedIds(scope);  // scope: 'dashboard' | 'statistics'
```

### Behavior

- Calls `apiClient.getCategories({ limit: CATEGORY_FETCH_LIMIT })` (limit: 1000) under the stable cache key `['categories', 'all-for-exclusions']`. One shared query instance — no duplication.
- The category fetch is skipped entirely when `settings.excludeHiddenCategories` is false or when `exclusionsApply` is false (no wasted request).
- If the category list hits the 1000-item cap, a `console.warn` is emitted rather than silently truncating (the exclusion set is still uniform across screens).
- Returned arrays are de-duplicated and sorted ascending; a stable `EMPTY` reference (`[]`) is reused when exclusions do not apply, maintaining memoization stability for downstream `useMemo`/`useCallback` dependencies.

### Consumers

| Consumer | Before | After |
|----------|--------|-------|
| `useFilteredDashboardStats` | Fetched categories with limit 500, own cache key | Calls `useExcludedIds('dashboard')` |
| `useStatistics` | Fetched categories with limit 1000, own cache key | Calls `useExcludedIds('statistics')` |
| `DashboardPage` | Inline `useMemo` over `categoriesData` from separate query | Calls `useExcludedIds('dashboard')` |

### Constants

```typescript
export const CATEGORY_FETCH_LIMIT = 1000;  // shared across all consumers
```

---

## useConfirmDialog

Hook for showing confirmation dialogs.

### API

```typescript
const { confirm, ConfirmDialog } = useConfirmDialog();

// Usage
const confirmed = await confirm({
  title: "Delete Transaction",
  description: "Are you sure?",
  confirmText: "Delete",
});

// In component render
<ConfirmDialog />
```

---

## React Query Integration

All data hooks use [TanStack Query](https://tanstack.com/query) for:

- **Caching**: Automatic request caching
- **Deduplication**: Prevents duplicate requests
- **Background refetching**: Keeps data fresh
- **Optimistic updates**: Instant UI updates
- **Error handling**: Built-in error states

### Query Keys

```typescript
// Example query keys
['transactions', { limit: 50 }]
['categories', 'all']
['portfolio']
['planned-payments', { upcoming: true }]
```

---

## useIsMobile

Responsive breakpoint hook for mobile detection.

### API

```typescript
const isMobile = useIsMobile();
```

### Behavior

- Returns `true` when viewport width is less than 768px
- Uses `window.matchMedia` for efficient change detection
- Returns `false` during SSR/initial render (before hydration)
- Breakpoint constant: `MOBILE_BREAKPOINT = 768`

### Usage

```tsx
const isMobile = useIsMobile();

return (
  <div className={isMobile ? "mobile-layout" : "desktop-layout"}>
    {/* Responsive content */}
  </div>
);
```

---

## usePortfolioTaxAdjustments

Hook for managing per-investment tax and fee adjustments by tax year. Used by the Portfolio Tax page to manually adjust tax calculations for individual holdings.

### API

```typescript
const {
  isLoading,           // Loading state (waiting for preloaded setting)
  adjustments,         // Full adjustment map: { "year:investmentId": { taxes, fees } }
  getAdjustment,       // (taxYear, investmentId) => { taxes, fees }
  setAdjustment,       // (taxYear, investmentId, { taxes, fees }) => void
  setManyForYear,      // (taxYear, { investmentId: { taxes, fees } }) => void
  saveManyForYear,     // (taxYear, { investmentId: { taxes, fees } }) => Promise<void>
  saveAdjustments,     // (next?) => Promise<void>
  byYear,              // (taxYear) => { investmentId: { taxes, fees } }
} = usePortfolioTaxAdjustments();
```

### Storage

- **Key**: `portfolio_tax_adjustments_v1` (stored via settings API)
- **Format**: `Record<string, { taxes: number, fees: number }>` where key is `"taxYear:investmentId"`
- **Preloading**: Uses `SettingsPreloadContext` for fast initial load

### Usage

```tsx
const { getAdjustment, saveManyForYear, byYear } = usePortfolioTaxAdjustments();

// Get adjustment for a specific investment and year
const adj = getAdjustment(2025, 42);
console.log(adj.taxes, adj.fees);

// Save adjustments for multiple investments in one year
await saveManyForYear(2025, {
  42: { taxes: 150, fees: 25 },
  43: { taxes: 80, fees: 10 },
});

// Get all adjustments for a year
const yearAdjustments = byYear(2025);
```

---

## Utility Modules

### sanitize.ts

Input sanitization and XSS prevention utilities. These are pure functions (not React hooks) used throughout the frontend to sanitize user input before rendering or API submission.

**Code**: [[apps/frontend/src/utils/sanitize.ts]]

| Function | Description |
|----------|-------------|
| `escapeHtml(str: string)` | Escapes HTML special characters (`&`, `<`, `>`, `"`, `'`) to prevent XSS when rendering user content as text |
| `stripHtml(str: string)` | Removes all HTML tags from a string using regex |
| `sanitizeFilename(filename: string)` | Sanitizes filenames: replaces non-alphanumeric chars with `_`, collapses dots, prevents leading dots, truncates to 255 chars |
| `sanitizeInput(input: string, maxLength?: number)` | Validates and sanitizes string input: trims whitespace, strips HTML tags, limits to max length (default 1000) |
| `isValidUrl(url: string)` | Validates that a string is a safe URL (http/https protocol only) |
| `sanitizeNumber(value: string | number)` | Sanitizes numeric input: returns `NaN` for non-numeric strings, passes through valid numbers |

### statisticsProcessing.ts

Shared processing module for statistics aggregation. `useStatistics` delegates pivot aggregation and recipient yearly aggregation to this module.

**Code**: [[apps/frontend/src/components/statistics/statisticsUtils.ts]]

| Export | Description |
|--------|-------------|
| `aggregatePivotData()` | Computes pivot table aggregations for the Statistics page category/recipient breakdowns |
| `aggregateRecipientYearly()` | Computes yearly aggregations per recipient for the Recipient Insights view |

### currency.ts

Currency formatting and parsing utilities.

**Code**: [[apps/frontend/src/utils/currency.ts]]

| Function | Description |
|----------|-------------|
| `formatCurrency(amount, currency?, locale?)` | Formats a number as currency string using `Intl.NumberFormat` |
| `getCurrencyFormatDefaults(currency)` | Returns default formatting options (decimals, symbol) for a currency |
| `numberFormatToLocale(appSettings)` | Derives the locale string from app settings for number formatting |
| `parseLocaleNumber(input)` | Intelligently parses locale-aware numeric strings (comma or period decimal/thousands) back to a number (see [[docs/reference/code-patterns#Number Parsing Pattern|code-patterns]]) |
| `getCurrencySymbol(currencyCode)` | Returns currency symbol for ISO currency code |
| `formatAmountWithSymbol(amount, currencyCode?)` | Simple currency formatting with symbol |

---

---

## useChartCurrencyFormatter

Shared hook for currency formatting in chart components. Eliminates duplicated `formatCurrency` / `currencySymbol` pattern across statistics charts.

### API

```typescript
const {
  formatCurrency,    // (val: number) => string
  currencySymbol,    // string (e.g. "€")
  locale,            // string (e.g. "en-US")
  currency,          // string (e.g. "EUR")
} = useChartCurrencyFormatter();
```

### Features

- Derives currency from `AppSettingsContext.defaultCurrency` (default: "EUR")
- Derives locale from `AppSettingsContext.numberFormat`
- Returns `formatCurrency()` function formatted with user's decimal place preference
- Respects app-wide currency and locale settings

### Usage

```tsx
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";

function MyChart() {
  const { formatCurrency, currencySymbol } = useChartCurrencyFormatter();
  
  return (
    <BarChart
      data={data}
      yAxisTickFormatter={(val) => formatCurrency(val)}
      tooltipFormatter={(val) => formatCurrency(val)}
    />
  );
}
```

### Used By

All Statistics page sub-components:
- `MonthlyChart`
- `NetTrendChart`
- `CategoryPieChart`
- `CategoryTrendChart`
- `TopRecipientsChart`
- `YearlyComparisonChart`
- `SummaryCards`
- `YearlySummaryTable`

---

---

## useFormState (Phase 4)

Generic typed form state hook for managing form field changes with dirty tracking.

### API

```typescript
const { form, setField, setForm, reset, isDirty } = useFormState({
  name: '',
  email: '',
  notes: '',
});
```

### Returns

```typescript
interface UseFormStateReturn<T> {
  form: T;                                          // Current form values
  setField: <K extends keyof T>(field: K, value: T[K]) => void;  // Update single field
  setForm: React.Dispatch<React.SetStateAction<T>>; // Replace entire form
  reset: () => void;                                // Reset to initial values
  isDirty: boolean;                                 // Shallow equality check vs. initial
}
```

### Features

- **Type-safe**: Generic over form shape, full TypeScript support
- **Dirty tracking**: Shallow compare to detect unsaved changes
- **Immutable updates**: Field changes create new state object
- **Reference stable**: `setField` and `reset` are memoized with `useCallback`

### Usage

```tsx
const { form, setField, reset, isDirty } = useFormState({
  name: '',
  email: '',
});

return (
  <>
    <Input
      value={form.name}
      onChange={(e) => setField('name', e.target.value)}
    />
    <button onClick={reset} disabled={!isDirty}>
      Reset
    </button>
  </>
);
```

### When to Use

- Forms with multiple fields and dirty state tracking
- Dialog/modal forms where reset is important
- Any controlled form where you want to avoid repetitive `useState` boilerplate

---

## useDataTableColumns (Phase 4)

Memoized column definition factory for DataTable and VirtualDataTable components.

### API

```typescript
const columns = useDataTableColumns<T>(
  () => [
    { key: 'date', header: 'Date', render: (row) => formatDate(row.date) },
    { key: 'amount', header: 'Amount', sortable: true },
  ],
  [t, formatDate] // dependency array
);
```

### Parameters

- **factory**: `() => Column<T>[]` — Function returning column array
- **deps**: `React.DependencyList` — Dependency array (forwarded to `useMemo`)

### Returns

Stable `Column<T>[]` reference that only changes when `deps` changes.

### Features

- **Prevents re-renders**: Inline column arrays cause table re-renders every parent render; this memoizes them
- **Works with both DataTable and VirtualDataTable**
- **Simple wrapper**: Just `useMemo(factory, deps)` for clarity

### Usage

```tsx
const COLUMNS = useDataTableColumns<Transaction>(
  () => [
    { key: 'date', header: t('col.date'), render: (row) => row.date },
    { key: 'amount', header: t('col.amount'), sortable: true },
    { key: 'recipient', header: t('col.recipient') },
  ],
  [t]
);

return <DataTable columns={COLUMNS} data={transactions} />;
```

### When to Use

- Any DataTable/VirtualDataTable with columns defined inline
- Columns that depend on i18n (`t()`) or formatters

---

## useSettingsStore (Phase 4)

Direct Zustand store access for all application settings (app, dashboard, theme).

### API

```typescript
// Full state access
const appSettings = useSettingsStore((s) => s.appSettings);
const theme = useSettingsStore((s) => s.theme);

// Using useShallow for slice selection (recommended)
const settings = useSettingsStore(
  useShallow((s) => ({
    appSettings: s.appSettings,
    isLoading: s.isAppSettingsLoading,
  }))
);

// Calling actions
const { updateAppSettings, setTheme, toggleTheme } = useSettingsStore(
  (s) => ({
    updateAppSettings: s.updateAppSettings,
    setTheme: s.setTheme,
    toggleTheme: s.toggleTheme,
  })
);
```

### Store Shape

```typescript
interface SettingsStore {
  // App settings
  appSettings: AppSettings;
  isAppSettingsLoading: boolean;
  updateAppSettings: (updates: Partial<AppSettings>) => void;
  resetAppSettings: () => void;

  // Dashboard settings
  dashboardSettings: DashboardSettings;
  isDashboardSettingsLoading: boolean;
  updateDashboardSettings: (updates: Partial<DashboardSettings>) => void;

  // Theme
  theme: 'dark' | 'light';
  themeMode: 'light' | 'dark' | 'system' | 'schedule';
  themeSchedule: { lightFrom: string; darkFrom: string };
  themeVariant: ThemeVariant;
  isThemeLoaded: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}
```

### When to Use

- **Direct store access**: Use `useSettingsStore` with `useShallow()` for slice selection
- **Through context wrappers**: Use `useAppSettings()`, `useSettings()`, `useTheme()` for convenience
- **Mutations**: Call actions directly: `useSettingsStore().updateAppSettings({...})`

### Internal Hydration (Provider-only)

The AppSettingsContext, SettingsContext, and ThemeContext Providers call store hydration actions once preloaded data arrives. Components should never call `_hydrateAppSettings()`, etc. directly.

---

## usePortfolioPrefetch

Hook for prefetching portfolio performance data.

### Purpose

Prefetches portfolio performance metrics and snapshots using React Query to populate cache before UI renders. Used in Performance page and portfolio summary pages.

### QueryKey Fix (2026-05-05)

Fixed queryKey mismatch that prevented proper cache reuse:

**Before (Broken):**
```typescript
queryKey: ["portfolio-performance", currency]
// Missing the "all" period, mismatches Performance page query
```

**After (Correct):**
```typescript
queryKey: ["portfolio-performance", currency, "all"]
queryFn: async () => {
  const response = await getPortfolioPerformance(currency, { period: "all" })
  return response.data
}
```

**Impact:** 
- Performance page makes same query with `queryKey: ["portfolio-performance", currency, "all"]`
- Now shares cached data from prefetch instead of making duplicate API call
- Reduces network traffic and improves perceived performance

Code link: [[apps/frontend/src/hooks/usePortfolioPrefetch.ts]]

---

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/api/index]] - API documentation
- [[docs/components/statistics]] - Statistics components
- [[docs/components/dashboard]] - Dashboard components (DashboardPage exclusion flow)
- [[docs/features/settings]] - Settings feature architecture
- [[docs/reference/code-patterns#zustand-store-pattern-phase-4]] - Zustand pattern reference
- [React Query Docs](https://tanstack.com/query)
- [Zustand Docs](https://github.com/pmndrs/zustand)
