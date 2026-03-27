---
title: Custom Hooks
type: component
status: active
date: 2026-03-25
tags: [components, hooks, react-query]
description: Custom React hooks for data fetching and state management
related_code: ["apps/frontend/src/hooks"]
---

# Custom Hooks

Vision uses custom hooks for data fetching, state management, and reusable logic.

## Hook List

### Data Fetching Hooks

| Hook | Description | File |
|------|-------------|------|
| [[docs/components/use-transactions|useTransactions]] | Transaction CRUD | `useTransactions.ts` |
| [[docs/components/use-categories|useCategories]] | Category management | `useCategories.ts` |
| [[docs/components/use-recipients|useRecipients]] | Recipient management | `useRecipients.ts` |
| [[docs/components/use-portfolio|usePortfolio]] | Investment portfolio | `usePortfolio.ts` |
| [[docs/components/use-planned-payments|usePlannedPayments]] | Planned transactions | `usePlannedPayments.ts` |
| [[docs/components/use-statistics|useStatistics]] | Analytics data | `useStatistics.ts` |
| [[docs/components/use-splits|useSplits]] | Debt tracking | `useSplits.ts` |
| [[docs/components/use-saved-charts|useSavedCharts]] | Saved chart configs | `useSavedCharts.ts` |
| [[docs/components/use-watchlist|useWatchlist]] | Watchlist management | `useWatchlist.ts` |

### UI State Hooks

| Hook | Description | File |
|------|-------------|------|
| [[docs/components/use-widget-visibility|useWidgetVisibility]] | Widget visibility | `useWidgetVisibility.ts` |
| [[docs/components/use-filtered-dashboard-stats|useFilteredDashboardStats]] | Filtered dashboard data | `useFilteredDashboardStats.ts` |
| [[docs/components/use-confirm-dialog|useConfirmDialog]] | Confirmation dialogs | `useConfirmDialog.tsx` |

### Utility Hooks

| Hook | Description | File |
|------|-------------|------|
| `useDebounce()` | Debounce value changes | `useDebounce.ts` |
| `useToast()` | Toast notifications | `use-toast.ts` |

---

## useTransactions

Hook for managing transactions.

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
const updateMutation = useUpdateTransaction();
const deleteMutation = useDeleteTransaction();
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
} = usePortfolio();

// Mutations
const deleteInvestment = useDeleteInvestment();
const createInvestment = useCreateInvestment();
```

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

---

## usePlannedPayments

Hook for planned/scheduled transactions.

### Settings-Aware Mapping

- API-to-UI mapping fallback currency derives from configured app defaults (`appSettings.defaultCurrency` context) rather than fixed literals

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

- **Per-graph exclusion toggle**: Each chart can independently toggle category/recipient exclusions
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

- Respects exclusion settings
- Applies category/recipient filters
- Requests monthly summary in selected app currency via `currency` query param
- Includes selected app currency in query key for cache isolation
- Uses the **latest month with data** for dashboard income/spending cards
- Computes card totals from live transactions for that month to avoid stale materialized-view lag
- Fetches month transactions in pages so totals remain complete on large datasets

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

## Related Documentation

- [[docs/components/index]] - Components Index
- [[docs/api/index]] - API documentation
- [React Query Docs](https://tanstack.com/query)
