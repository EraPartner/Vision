---
title: State Management Deep Dive
type: component
status: active
date: 2026-04-25
tags: [state-management, react-query, context, frontend, patterns, workspace]
description: Comprehensive guide to Vision's state management architecture — React Query for server state, React Context for global state, and local component state patterns
aliases:
  [state management, react query, context api, frontend state, data fetching]
related_code:
  [
    "apps/frontend/src/hooks/",
    "apps/frontend/src/contexts/",
    "apps/frontend/src/lib/api.ts",
    "apps/frontend/src/App.tsx",
  ]
---

# State Management Deep Dive

> [!abstract] Purpose
> This document provides a comprehensive analysis of Vision's state management architecture. Designed for **developers** building new features, **AI agents** analyzing frontend patterns, and **computer scientists** studying data flow design.

---

## Architecture Overview

Vision uses a **three-layer state management strategy** with no external state library (no Redux, Zustand, or Jotai):

```
┌─────────────────────────────────────────────────────┐
│                  State Layers                        │
├─────────────┬──────────────┬────────────────────────┤
│ Server State│ Global State │    Local State          │
│ React Query │ React Context│ useState / useReducer   │
│             │              │                         │
│ • API data  │ • Settings   │ • Form inputs           │
│ • Cache     │ • Theme      │ • Dialog open/close     │
│ • Invalidation│ • Language │ • Table pagination      │
└─────────────┴──────────────┴────────────────────────┘
```

### Design Rationale

| Decision                           | Why                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------- |
| No Redux/Zustand                   | App is single-user desktop; no need for complex global state            |
| React Query for server state       | Built-in caching, deduplication, background refetch, optimistic updates |
| React Context for global settings  | Infrequently changing values consumed across the tree                   |
| Local state for component-specific | Minimal scope, no cross-component sharing needed                        |

---

## Layer 1: Server State (React Query)

**Configuration:** Set up in [[apps/frontend/src/App.tsx]]

```typescript
<QueryClientProvider client={queryClient}>
```

### QueryClient Configuration

| Setting     | Value            | Purpose                                     |
| ----------- | ---------------- | ------------------------------------------- |
| `staleTime` | 30,000ms (30s)   | Data considered fresh for 30 seconds        |
| `gcTime`    | 300,000ms (5min) | Garbage collection for unused cache entries |

### Query Key Patterns

Query keys follow a hierarchical structure for precise invalidation:

```
['transactions']                    — All transactions
['transactions', params]            — Filtered transactions list
['transactions', id]                — Single transaction
['transactions-virtual']            — Virtual table variant
['monthlySummary']                  — Monthly financial summary
['categories']                      — All categories
['categories', id]                  — Single category
['recipients']                      — All recipients
['recipients', id]                  — Single recipient
['planned-transactions']            — All planned transactions
['planned-transactions', id]        — Single planned transaction
['investments']                     — All investments
['investments', id]                 — Single investment
['investments', id, 'price-history'] — Price history for investment
['investments', id, 'transactions'] — Portfolio transactions
['watchlist']                       — Watchlist items
['splits']                          — Split transactions
['splits', 'owed']                  — Owed summary
['splits', 'owed', recipientId]     — Owed by specific recipient
['splits', 'transaction', txnId]    — Splits for a transaction
['saved-charts']                    — Saved chart configurations
['settings']                        — User settings
['statistics']                      — Statistics data
['net-worth']                       — Net worth snapshots
['portfolio-performance']           — Portfolio performance data
['inflation-rates']                 — Belgian inflation rates
['recurring-patterns']              — Detected recurring patterns
['recipient-insights']              — Recipient analytics
['bank-balances']                   — Bank account balances
['monthly-summary']                 — Monthly summary data
['cashflow-comparison']             — Cash flow comparison data
```

Full reference: [[docs/reference/react-query-keys|React Query Keys Reference]]

### Hook Pattern

All data-fetching hooks follow a consistent pattern:

```typescript
// Query hook — reads data
export function useTransactions(params?: UseTransactionsParams) {
  return useQuery({
    queryKey: ["transactions", params],
    queryFn: () => apiClient.getTransactions(params),
    staleTime: 30_000,
    placeholderData: (prev) => prev, // Keep previous data during refetch
  });
}

// Mutation hooks — write data
export function useCreateTransaction() {
  const queryClient = useQueryClient();
  const { t } = useLanguage();

  return useMutation({
    mutationFn: (transaction: TransactionCreate) =>
      apiClient.createTransaction(transaction),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["transactions-virtual"] });
      queryClient.invalidateQueries({ queryKey: ["monthlySummary"] });
      toast.success(t("transactions.created"));
    },
    onError: (error: Error) => {
      toast.error(t("transactions.createFailedTitle"), {
        description: error.message,
      });
    },
  });
}
```

### Invalidation Strategy

Mutations invalidate related query keys to keep the UI in sync:

| Mutation                                 | Invalidated Keys                                                     |
| ---------------------------------------- | -------------------------------------------------------------------- |
| Create/Update/Delete Transaction         | `['transactions']`, `['transactions-virtual']`, `['monthlySummary']` |
| Create/Update/Delete Category            | `['categories']`                                                     |
| Create/Update/Delete Recipient           | `['recipients']`                                                     |
| Create/Update/Delete Planned Transaction | `['planned-transactions']`                                           |
| Create/Update/Delete Investment          | `['investments']`, `['net-worth']`                                   |
| Split Payment/Settle                     | `['splits']`, `['splits', 'owed']`                                   |

### Optimistic Updates

Vision currently uses **post-mutation invalidation** rather than optimistic updates. This ensures data consistency with the server at the cost of a brief loading state.

### Placeholder Data Pattern

```typescript
placeholderData: (prev) => prev;
```

This keeps the previous query result displayed while a new fetch is in progress, preventing UI flicker during pagination.

---

## Layer 2: Global Client State

Vision uses four actual React contexts under `contexts/`, four Zustand hydration bridges under
`stores/hydration/`, and a route-derived workspace hook under `hooks/`.

### Global State Registry

| Owner               | Kind                              | File                                                            | Purpose                                                 | Consumer Hook                 |
| ------------------- | --------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------- |
| App settings        | Zustand hydration bridge          | [[apps/frontend/src/stores/hydration/AppSettingsHydration.tsx]] | Currency, date format, locale, page size                | `useAppSettings()`            |
| Dashboard settings  | Zustand hydration bridge          | [[apps/frontend/src/stores/hydration/SettingsHydration.tsx]]    | Settings management                                     | `useSettings()`               |
| Settings preload    | React context                     | [[apps/frontend/src/contexts/SettingsPreloadContext.tsx]]       | Preloads settings before app renders                    | `usePreloadedSetting<T>(key)` |
| Theme               | Zustand hydration bridge          | [[apps/frontend/src/stores/hydration/ThemeHydration.tsx]]       | Light/dark theme and DOM effects                        | `useTheme()`                  |
| Language            | Zustand selector/hydration bridge | [[apps/frontend/src/stores/hydration/LanguageHydration.tsx]]    | Lazy locale dictionaries and language side effects      | `useLanguage()`               |
| Belgian tax profile | React context                     | [[apps/frontend/src/contexts/BelgianTaxProfileContext.tsx]]     | Belgian tax profile data                                | `useBelgianTaxProfile()`      |
| Page title          | React context                     | [[apps/frontend/src/contexts/PageTitleContext.tsx]]             | Current page title                                      | `usePageTitle()`              |
| Unsaved changes     | React context                     | [[apps/frontend/src/contexts/UnsavedChangesContext.tsx]]        | Navigation protection                                   | `useUnsavedChanges()`         |
| Workspace           | Router-backed hook                | [[apps/frontend/src/hooks/useWorkspace.ts]]                     | Route-derived workspace with admin-route session memory | `useWorkspace()`              |

### App settings hydration — Detailed Analysis

The most complex context, managing user preferences with auto-save:

```
┌─────────────────────────────────────────────────────┐
│               AppSettingsHydration                     │
├─────────────────────────────────────────────────────┤
│ State:                                               │
│   defaultCurrency: 'EUR'                            │
│   dateFormat: 'DD/MM/YYYY'                          │
│   numberFormat: 'eu'                                │
│   defaultPageSize: 50                               │
│   startOfWeek: 'monday'                             │
│   showDecimalPlaces: 2                              │
│   language: 'en' | 'nl'                             │
├─────────────────────────────────────────────────────┤
│ Auto-Save: 500ms debounce → apiClient.saveSetting() │
│ Preload: SettingsPreloadContext (single fetch)      │
│ Persistence: Backend settings API                   │
└─────────────────────────────────────────────────────┘
```

**Key Patterns:**

- **Debounced Auto-Save:** Changes are batched with a 500ms debounce timer
- **Preload Optimization:** Uses `SettingsPreloadContext` to avoid redundant fetches during app initialization
- **First-Render Skip:** Skips save on initial mount to avoid unnecessary API calls

### SettingsPreloadContext — Race Condition Prevention

This context performs a **single settings fetch** during app initialization that is consumed by `AppSettingsHydration`. This prevents the "double fetch" problem where both contexts would independently request the same settings data.

---

## Layer 3: Local Component State

Local state is managed with `useState` and `useReducer` within individual components:

### Common Patterns

| Pattern             | Hook                       | Example                                         |
| ------------------- | -------------------------- | ----------------------------------------------- |
| Form input          | `useState`                 | Dialog text fields, date pickers                |
| Dialog open/close   | `useState<boolean>`        | `SplitTransactionDialog`, `AddInvestmentDialog` |
| Table pagination    | `useState`                 | Page number, page size                          |
| Search/filter       | `useState` + `useDebounce` | Transaction search with 200ms debounce          |
| Confirmation        | `useConfirmDialog`         | Delete confirmations                            |
| Toast notifications | `sonner/toast`             | Success/error messages                          |
| Mobile detection    | `use-mobile`               | Responsive breakpoints                          |
| Widget visibility   | `useWidgetVisibility`      | Dashboard widget show/hide                      |

### Custom Hooks Reference

| Hook                         | File                                                      | Purpose                             |
| ---------------------------- | --------------------------------------------------------- | ----------------------------------- |
| `useTransactions`            | [[apps/frontend/src/hooks/useTransactions.ts]]            | Transaction CRUD via React Query    |
| `useCategories`              | [[apps/frontend/src/hooks/useCategories.ts]]              | Category CRUD                       |
| `useRecipients`              | [[apps/frontend/src/hooks/useRecipients.ts]]              | Recipient CRUD + merge              |
| `usePortfolio`               | [[apps/frontend/src/hooks/usePortfolio.ts]]               | Investment data fetching            |
| `usePlannedPayments`         | [[apps/frontend/src/hooks/usePlannedPayments.ts]]         | Planned transaction CRUD            |
| `useStatistics`              | [[apps/frontend/src/hooks/useStatistics.ts]]              | Statistics data + processing        |
| `useSplits`                  | [[apps/frontend/src/hooks/useSplits.ts]]                  | Split transaction logic             |
| `useSavedCharts`             | [[apps/frontend/src/hooks/useSavedCharts.ts]]             | Saved chart persistence             |
| `useFilteredDashboardStats`  | [[apps/frontend/src/hooks/useFilteredDashboardStats.ts]]  | Dashboard stats with filter support |
| `usePortfolioTaxAdjustments` | [[apps/frontend/src/hooks/usePortfolioTaxAdjustments.ts]] | Portfolio tax adjustments           |
| `useWidgetVisibility`        | [[apps/frontend/src/hooks/useWidgetVisibility.ts]]        | Widget visibility state             |
| `useConfirmDialog`           | [[apps/frontend/src/hooks/useConfirmDialog.tsx]]          | Confirmation dialog state           |
| `useDebounce`                | [[apps/frontend/src/hooks/useDebounce.ts]]                | Generic debounce utility            |
| `use-mobile`                 | [[apps/frontend/src/hooks/use-mobile.tsx]]                | Mobile breakpoint detection         |

---

## Data Flow Architecture

### Request Lifecycle

```
User Action (click, type, submit)
    │
    ▼
React Component
    │
    ├── Local State Update (useState)
    │       │
    │       ▼
    │   Re-render component
    │
    ├── Hook Call (useCreateTransaction, etc.)
    │       │
    │       ▼
    │   React Query Cache Check
    │       │
    │       ├── Cache HIT → Return cached data
    │       │
    │       └── Cache MISS / Stale
    │               │
    │               ▼
    │       apiClient.request()
    │               │
    │               ├── Timeout (30s)
    │               ├── Retry (max 2, exponential backoff)
    │               └── AbortController support
    │               │
    │               ▼
    │       Express Route → Service → Repository → PostgreSQL
    │               │
    │               ▼
    │       Response → Parse JSON → Update Cache
    │               │
    │               ▼
    │       Invalidate related queries
    │               │
    │               ▼
    │       Re-render affected components
    │
    └── Context Consumption (useAppSettings, useLanguage, etc.)
            │
            ▼
        Global state value read (no re-fetch)
```

### Cache Invalidation Flow

```
Mutation (e.g., createTransaction)
    │
    ▼
onSuccess callback
    │
    ├── invalidateQueries(['transactions'])     → Refetches list
    ├── invalidateQueries(['transactions-virtual']) → Refetches virtual table
    ├── invalidateQueries(['monthlySummary'])   → Refetches dashboard stats
    └── toast.success(...)                       → User feedback
```

---

## Performance Optimizations

### React Query Optimizations

| Technique               | Implementation                      | Benefit                              |
| ----------------------- | ----------------------------------- | ------------------------------------ |
| **Stale Time**          | 30s for lists, 60s for single items | Reduces redundant fetches            |
| **Placeholder Data**    | `(prev) => prev`                    | Prevents UI flicker during refetch   |
| **Query Deduplication** | Same query key = single request     | Eliminates duplicate API calls       |
| **Background Refetch**  | Automatic on window focus           | Keeps data fresh without blocking UI |
| **Garbage Collection**  | 5min for unused queries             | Prevents memory leaks                |

### Context Optimizations

| Technique                 | Implementation                        | Benefit                         |
| ------------------------- | ------------------------------------- | ------------------------------- |
| **Preload**               | `SettingsPreloadContext` fetches once | Eliminates double-fetch race    |
| **Memoized Values**       | `useCallback` for update functions    | Prevents unnecessary re-renders |
| **Selective Consumption** | Hooks read only needed values         | Minimizes re-render scope       |

### Local State Optimizations

| Technique              | Implementation                          | Benefit                                   |
| ---------------------- | --------------------------------------- | ----------------------------------------- |
| **Debounce**           | `useDebounce` for search (200ms)        | Reduces API calls during typing           |
| **Deferred Rendering** | Virtual table renders visible rows only | Handles large datasets efficiently        |
| **AbortController**    | Cancel in-flight requests on unmount    | Prevents memory leaks and race conditions |

---

## Error Handling

### Query Errors

```typescript
// React Query handles errors at the hook level
const { data, error, isLoading } = useTransactions(params);

if (error) {
  // Display error state in component
}
```

### Mutation Errors

```typescript
// Mutations show toast on error
onError: (error: Error) => {
  toast.error(t("transactions.createFailedTitle"), {
    description: error.message,
  });
};
```

### API Client Error Handling

The [[apps/frontend/src/lib/api.ts|API client]] handles:

- **Timeouts:** 30-second default with AbortController
- **Retries:** Up to 2 retries with exponential backoff for idempotent methods (GET, PUT, DELETE)
- **Retryable Status Codes:** 408, 429, 502, 503, 504
- **Validation Errors:** Parses 422 responses into human-readable messages
- **Rate Limits:** Parses 429 `retry_after` field

---

## Adding New State

### When to Use Each Layer

| Scenario               | Layer                | Example                               |
| ---------------------- | -------------------- | ------------------------------------- |
| Fetching data from API | React Query          | `useTransactions()`, `usePortfolio()` |
| Mutating data via API  | React Query Mutation | `useCreateTransaction()`              |
| App-wide settings      | Context              | `useAppSettings()`                    |
| Theme/language         | Context              | `useTheme()`, `useLanguage()`         |
| Form inputs            | Local State          | `useState` in dialog                  |
| Dialog open/close      | Local State          | `useState<boolean>`                   |
| Table pagination       | Local State          | `useState` for page/limit             |
| Search with debounce   | Local State + Hook   | `useState` + `useDebounce`            |

### Adding a New Data-Fetching Hook

```typescript
// 1. Add API method to apiClient
async getNewData(params?: Params): Promise<Response> {
    return this.request(`/api/new-endpoint${this.buildQuery(params)}`);
}

// 2. Create hook
export function useNewData(params?: Params) {
    return useQuery({
        queryKey: ['new-data', params],
        queryFn: () => apiClient.getNewData(params),
        staleTime: 30_000,
    });
}

// 3. Add mutation hook (if needed)
export function useCreateNewData() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (data: NewDataCreate) => apiClient.createNewData(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['new-data'] });
        },
    });
}
```

---

## Related Documentation

- [[docs/reference/react-query-keys|React Query Keys Reference]]
- [[docs/reference/typescript-types|TypeScript Types Reference]]
- [[docs/components/hooks|Hooks Documentation]]
- [[docs/architecture/deep-dive|Architecture Deep Dive]]
- [[docs/reference/code-patterns|Code Patterns]]
