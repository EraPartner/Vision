---
title: React Query Keys Reference
type: reference
status: active
date: 2026-03-31
updated: 2026-09-08
tags: [reference, react-query, caching, frontend]
description: Complete reference of all React Query keys used in the Vision frontend
aliases: [react query keys, query keys, cache keys, queryKey, invalidation]
---

# React Query Keys Reference

> [!abstract] Overview
> All React Query keys used in the Vision frontend. Use this reference for cache invalidation, debugging, and writing new data-fetching hooks.

Query hooks use the named freshness policies in `apps/frontend/src/lib/queryPolicies.ts` rather
than repeating millisecond literals. `DEFAULT` and `FREQUENT` preserve the established 30-second
cadence; `STANDARD` preserves the one-minute cadence. Longer feature-specific policies remain
named beside their owning feature when they express a distinct backend or prefetch contract.

## Query Keys by Feature

### Transactions

| Query Key                                                                                     | Variables                                                                                                  | Used By             | Description                                |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------ |
| `['transactions', params]`                                                                    | `{ active, search, ... }`                                                                                  | `useTransactions()` | Paginated transaction list                 |
| `['transactions', id]`                                                                        | `id: number`                                                                                               | `useTransactions()` | Single transaction by ID                   |
| `['transactions-virtual', params]`                                                            | `{ active, search, transactionIdFilter, recipientIdFilter, categoryIdFilter, sortKey, sortDir, pageSize }` | `TransactionsPage`  | Virtual table with server-side sort/filter |
| `['transactions', 'all-for-stats', targetCurrency]`                                           | `targetCurrency: string`                                                                                   | `useStatistics()`   | All transactions for statistics            |
| `['transactions', 'owes-recipient', recipientId]`                                             | `recipientId: number`                                                                                      | `OwesPage`          | Transactions for a specific recipient      |
| `['dashboardRecentTransactions', excludedCategoryIds, excludedRecipientIds, exclusionsApply]` | Arrays + boolean                                                                                           | `DashboardPage`     | Recent transactions for dashboard          |

**Invalidation:** Mutations invalidate `['transactions']`, `['transactions-virtual']`, and `['monthlySummary']`.

### Monthly Summary

| Query Key                                                                 | Variables             | Used By         | Description                        |
| ------------------------------------------------------------------------- | --------------------- | --------------- | ---------------------------------- |
| `['monthlySummary', 'filtered', targetCurrency, filteredExclusionParams]` | Currency + exclusions | `DashboardPage` | Filtered monthly income/spending   |
| `['monthlySummary', 'unfiltered', targetCurrency]`                        | Currency              | `DashboardPage` | Unfiltered monthly income/spending |

### Cash Flow

| Query Key                                                                     | Variables             | Used By         | Description                  |
| ----------------------------------------------------------------------------- | --------------------- | --------------- | ---------------------------- |
| `['cashflowComparison', 'filtered', targetCurrency, filteredExclusionParams]` | Currency + exclusions | `DashboardPage` | Filtered period comparison   |
| `['cashflowComparison', 'unfiltered', targetCurrency]`                        | Currency              | `DashboardPage` | Unfiltered period comparison |

### Categories

| Query Key                               | Variables                 | Used By                                                                                 | Description                                                                                                                                |
| --------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `['categories', params]`                | `{ active, search, ... }` | `useCategories()`                                                                       | Paginated category list                                                                                                                    |
| `['categories', 'all']`                 | —                         | `useAllCategories()` — i.e. `useExcludedIds()` + Settings → Statistics exclusion picker | Full list (`limit: CATEGORY_FETCH_LIMIT`). ONE entry: 2026-08-11 folded the duplicate `['categories', 'all-for-exclusions']` into this key |
| `['categories', 'all-for-tax-profile']` | —                         | `IncomeSourcesStep`                                                                     | Active categories only (`limit: 500, active: true`) — a different payload, so a separate entry                                             |

**Invalidation:** Mutations invalidate `['categories']`, which covers every key above.

### Recipients

| Query Key                           | Variables                                                       | Used By           | Description                                |
| ----------------------------------- | --------------------------------------------------------------- | ----------------- | ------------------------------------------ |
| `['recipients', params]`            | `{ active, search, ... }`                                       | `useRecipients()` | Paginated recipient list                   |
| `['recipients', 'virtual', params]` | `{ active, search, uncategorized, sortKey, sortDir, pageSize }` | `RecipientsPage`  | Virtual table with server-side sort/filter |

**Invalidation:** Mutations invalidate `['recipients']` and `['transactions']` (when merging).

### Portfolio / Investments

| Query Key                                   | Variables                                 | Used By          | Description                                  |
| ------------------------------------------- | ----------------------------------------- | ---------------- | -------------------------------------------- |
| `['investments']`                           | —                                         | `usePortfolio()` | All holdings, including archived investments |
| `['portfolio-transactions', investmentIds]` | `investmentIds: string` (comma-separated) | `usePortfolio()` | History for active and archived investments  |

`usePortfolio()` derives active current-view data and an inactive discovery list from the shared
cache. **Invalidation:** create, edit, archive, restore, and delete mutations invalidate
`['investments']` and `['portfolio-transactions']`.

### Portfolio Performance

| Query Key                                    | Variables                 | Used By           | Description                 |
| -------------------------------------------- | ------------------------- | ----------------- | --------------------------- |
| `['portfolio-performance', defaultCurrency]` | `defaultCurrency: string` | `PerformancePage` | Daily performance snapshots |
| `['net-worth', targetCurrency]`              | `targetCurrency: string`  | `NetWorthPage`    | Net worth time series       |

### Exchange Rates

| Query Key                            | Variables                | Used By                  | Description                            |
| ------------------------------------ | ------------------------ | ------------------------ | -------------------------------------- |
| `['exchange-rates', targetCurrency]` | `targetCurrency: string` | Multiple portfolio pages | Exchange rates for currency conversion |
| `['exchangeRates']`                  | —                        | `ExchangeRatesPage`      | All exchange rates                     |

### Watchlist

| Query Key                       | Variables                           | Used By                                                | Description                          |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| `['watchlist']`                 | —                                   | `useWatchlist()` (`WatchlistPage`, `ResearchHomePage`) | Watchlist items                      |
| `['watchlist-quotes', symbols]` | `symbols: string` (comma-separated) | `WatchlistPage`, `ResearchHomePage`                    | Current quotes for watchlist symbols |

### Splits / Owes

| Query Key                                  | Variables               | Used By       | Description                         |
| ------------------------------------------ | ----------------------- | ------------- | ----------------------------------- |
| `['splits', 'owed']`                       | —                       | `useSplits()` | All owed summaries                  |
| `['splits', 'owed', recipientId]`          | `recipientId: number`   | `useSplits()` | Owed summary for specific recipient |
| `['splits', 'transaction', transactionId]` | `transactionId: number` | `useSplits()` | Splits for a specific transaction   |

**Invalidation:** All split mutations invalidate `['splits']`.

### Saved Charts

| Query Key          | Variables | Used By            | Description                |
| ------------------ | --------- | ------------------ | -------------------------- |
| `['saved-charts']` | —         | `useSavedCharts()` | Saved chart configurations |

**Invalidation:** All mutations invalidate `['saved-charts']`.

### Market Lookup

| Query Key                                   | Variables                               | Used By               | Description                       |
| ------------------------------------------- | --------------------------------------- | --------------------- | --------------------------------- |
| `['market-search', debouncedSearch]`        | `debouncedSearch: string`               | `MarketLookupPage`    | Market search results             |
| `['market-quote', symbol]`                  | `symbol: string`                        | `useMarketLookupData` | Real-time quote for symbol        |
| `['market-chart', symbol, range, interval]` | `symbol, range, interval`               | `useMarketLookupData` | Yahoo historical price chart data |
| `['provider-chart', investmentId, range]`   | `investmentId: number`, `range: string` | `useMarketLookupData` | Holding-provider price history    |
| `['market-news', symbol]`                   | `symbol: string`                        | `MarketLookupPage`    | News for symbol                   |

### Recipient Insights

| Query Key                                                                                                       | Variables                        | Used By                              | Description                               |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------ | ----------------------------------------- |
| `['aggregations', 'recipient-insights', targetCurrency]`                                                        | currency                         | `useStatistics`                      | Unfiltered Statistics recipient analytics |
| `['aggregations', 'recipient-insights', 'filtered', targetCurrency, excludedCategoryIds, excludedRecipientIds]` | currency and exclusion ID arrays | `useStatistics`                      | Filtered Statistics recipient analytics   |
| `['aggregations', 'recipient-insights', targetCurrency, excludedCategoryIds, excludedRecipientIds]`             | currency and exclusion ID arrays | `RecipientInsightsTab` in Statistics | Recipient spending analytics              |

### AI Insights Digest

| Query Key            | Variables | Used By             | Description                                       |
| -------------------- | --------- | ------------------- | ------------------------------------------------- |
| `['insightsDigest']` | —         | Statistics panel    | Server-filtered, non-LLM insights digest          |
| `['insightsCount']`  | —         | Insights navigation | Persisted undismissed count and projection status |

**Invalidation:** Every transaction mutation invalidates this digest through
`invalidateTransactionData()` so create, update, bulk update, delete, import, and reconciliation
cannot leave stale insights in the interface. A successful dismissal invalidates both keys.

### Planned Transactions

| Query Key                                     | Variables           | Used By                         | Description                                       |
| --------------------------------------------- | ------------------- | ------------------------------- | ------------------------------------------------- |
| `['plannedTransactions', showInactive]`       | `showInactive`      | `usePlannedPayments()`          | Planned-payment management list                   |
| `['upcomingPlannedPayments', ...]`            | Forecast parameters | Dashboard cash-flow forecast    | Upcoming planned payments                         |
| `['account-planned-transactions', accountId]` | `accountId: number` | `useAccountPlannedTransactions` | Active, unexecuted plans for one account forecast |

**Invalidation:** Planned-payment mutations invalidate the management, upcoming, and
account-scoped trees. Transaction mutations also invalidate all three because execution,
auto-linking, imports, and reconciliation can change whether a plan remains upcoming.

## Invalidation Patterns

### After Transaction Mutation

```ts
invalidateTransactionData(queryClient);
```

The helper invalidates transaction lists, virtualized transaction lists, monthly summaries,
filtered dashboard statistics, aggregations, recent dashboard transactions, and the Insights
digest, plus upcoming and account-scoped planned transactions, as one transaction-derived fan-out
contract.

### After Category Mutation

```ts
queryClient.invalidateQueries({ queryKey: ["categories"] });
```

### After Recipient Mutation

```ts
queryClient.invalidateQueries({ queryKey: ["recipients"] });
// If merge/unmerge: also invalidate transactions
queryClient.invalidateQueries({ queryKey: ["transactions"] });
```

### After Investment Mutation

```ts
queryClient.invalidateQueries({ queryKey: ["investments"] });
queryClient.invalidateQueries({ queryKey: ["portfolio-transactions"] });
```

### After Split Mutation

```ts
queryClient.invalidateQueries({ queryKey: ["splits"] });
```

### After Saved Chart Mutation

```ts
queryClient.invalidateQueries({ queryKey: ["saved-charts"] });
```

## Related

- [[docs/components/hooks\|Custom Hooks]] - Data fetching hooks
- [[docs/performance/caching-strategies\|Caching Strategies]] - Backend caching
- [[docs/features/views\|Views & Pages]] - Pages that use these queries
