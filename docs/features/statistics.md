---
title: Statistics Feature
type: feature
status: active
date: 2026-04-02
tags: [feature, statistics, analytics, charts, frontend, backend]
description: Complete analytics and statistics system with per-graph exclusions, pivot tables, year-over-year comparisons, and saved custom charts
aliases: [stats, analytics, charts, pivot table, yearly comparison]
related_code:
  - apps/frontend/src/pages/StatisticsPage.tsx
  - apps/frontend/src/hooks/useStatistics.ts
  - apps/frontend/src/hooks/statisticsProcessing.ts
  - apps/frontend/src/hooks/useSavedCharts.ts
  - apps/frontend/src/components/statistics/RecipientInsightsTab.tsx
  - apps/frontend/src/components/statistics/CustomCategoryChart.tsx
  - apps/node-backend/src/routes/info.js
  - apps/node-backend/src/repositories/infoRepository.js
---

# Statistics Feature

## Overview

The Statistics page (`/statistics`) is the primary analytics dashboard for transaction data. It provides comprehensive financial insights through multiple chart types, a category pivot table, year-over-year comparisons, and recipient spending analysis. It is the most complex single page in the frontend with 9 configurable widgets, per-graph exclusion toggles, and 4 tabbed sections.

## Current Status (Phase 2, April 2026)

> [!warning] Dashboard Stat Cards vs. Statistics Page
> **Phase 2 (April 2026) updated only the Dashboard stat cards** to use `/api/aggregations/monthly-summary`. The full **Statistics page remains on client-side computation** (blocked on MV history extension). See [[docs/api/aggregations|Aggregations API]] for dashboard details.

## Architecture

### Data Flow (Statistics Page)

```
StatisticsPage → useStatistics() → processTransactions() → StatisticsData
                                    ↓
                    Fetches ALL transactions (paginated, 1000/page)
                    Fetches ALL categories (limit 500)
                    Computes stats client-side via useMemo
```

The Statistics page **is still computed entirely on the frontend**. The `useStatistics` hook fetches all transactions (with currency normalization) and categories, then `processTransactions()` performs client-side aggregation.

### Key Design Decisions

1. **Client-side computation**: All statistics are computed in the browser, not on the server. This enables instant per-graph exclusion toggles without additional API calls.
2. **Dual computation**: Both filtered (with exclusions) and unfiltered stats are computed simultaneously, enabling per-graph toggle between the two views.
3. **Per-graph exclusions**: Each chart independently decides whether to apply category/recipient exclusions via `GraphExclusions` state.

## Data Processing Pipeline

### processTransactions()

Located in `[[apps/frontend/src/hooks/statisticsProcessing.ts]]`, this pure function processes transaction arrays into a `StatisticsData` object:

```typescript
processTransactions(
  transactions: Transaction[],
  categories: Category[],
  excludedCategoryIds: Set<number>,
  excludedRecipientIds: Set<number>,
): StatisticsData
```

**Algorithm**: Single-pass O(n) iteration over transactions with 4 parallel aggregation maps:

1. **Monthly aggregation** (`monthlyMap`): Groups by `YYYY-MM` period, tracking income, spending, net, and transaction count per month.
2. **Category pivot** (`categoryMonthlyMap`): Groups by category ID, tracking absolute/income/expense/net values per month and total.
3. **Recipient spending** (`recipientMap`): Aggregates spending (expenses only) by recipient name, with per-year breakdowns.
4. **Yearly comparison** (`yearlyMap`): Groups by year, tracking income, spending, net, and transaction count.

### StatisticsData Interface

```typescript
interface StatisticsData {
  monthlyData: MonthlyData[];           // Per-month income/spending/net
  categoryPivot: CategoryMonthlyData[]; // Per-category monthly breakdown
  topRecipients: RecipientSpending[];   // Top 20 spending recipients
  topRecipientsByYear: Record<string, RecipientSpending[]>; // Per-year top recipients
  yearlyComparison: YearlyComparison[]; // Year-over-year totals
  allPeriods: string[];                 // Sorted YYYY-MM periods
  allYears: number[];                   // Sorted years
  totalIncome: number;
  totalSpending: number;
  averageMonthlySpending: number;
  averageMonthlyIncome: number;
}
```

### Exclusion System

The exclusion system is one of the most sophisticated features:

1. **Global exclusions**: Defined in `SettingsContext` (`excludedCategoryIds`, `excludedRecipientIds`, `excludeHiddenCategories`).
2. **Exclusion scope**: Controlled by `settings.exclusionScope` — can be `'everywhere'`, `'statistics'`, or `'nowhere'`.
3. **Per-graph override**: Each chart has an independent toggle (`graphExclusions[graphKey]`) to show/hide exclusions for that specific chart.
4. **Dual computation**: When exclusions apply globally, both filtered and unfiltered stats are computed. `getGraphData(key)` returns the appropriate view based on per-graph toggle state.

## Widget System

The Statistics page uses the `useWidgetVisibility` hook with 9 configurable widgets:

| Widget ID | Label Key | Default | Description |
|-----------|-----------|---------|-------------|
| `summaryCards` | `statsPage.widget.summaryCards` | Visible | 4 KPI cards (income, spending, net, months tracked) |
| `monthly` | `statsPage.widget.monthly` | Visible | Monthly income vs spending bar chart |
| `netTrend` | `statsPage.widget.netTrend` | Visible | Net balance area chart over time |
| `categoryPie` | `statsPage.widget.categoryPie` | Visible | Category spending donut chart (top 10) |
| `categoryTrend` | `statsPage.widget.categoryTrend` | Visible | Top 5 category spending trend lines |
| `pivotTable` | `statsPage.widget.pivotTable` | Visible | Category × Month pivot table with hierarchy |
| `topRecipients` | `statsPage.widget.topRecipients` | Visible | Top recipients bar chart (horizontal) |
| `yearlyComparison` | `statsPage.widget.yearlyComparison` | Visible | Year-over-year income/spending comparison |
| `yearlySummary` | `statsPage.widget.yearlySummary` | Visible | Yearly summary table with net and transaction counts |

## Tab Structure

The page is organized into 4 tabs:

### Overview Tab
- Monthly Income/Expense bar chart
- Net Balance Trend area chart
- Both support per-graph exclusion toggles

### Categories Tab
- Category Spending Pie (donut chart, top 10, year-filterable)
- Category Spending Trend (line chart, top 5 categories)
- Category Pivot Table (hierarchical GENERAL:DETAIL, 4 value modes: absolute/net/income/expense)

### Recipients Tab
- Top Recipients bar chart (horizontal, year-filterable)
- Embedded `RecipientInsightsTab` component for MoM alerts

### Yearly Tab
- Year-over-Year Comparison bar chart
- Yearly Summary table (year, income, spending, net, transaction count)

## Charts and Visualizations

### Chart Library
All charts use **Recharts** with consistent styling:
- Theme-aware colors via CSS variables (`hsl(var(--card))`, `hsl(var(--border))`)
- Custom tooltip styling matching card appearance
- 10-color palette for categorical data

### Category Pivot Table

The most complex widget — a hierarchical table showing categories × months:

- **Hierarchy**: Groups `GENERAL: DETAIL` categories under their GENERAL parent
- **Value modes**: Absolute (default), Net, Income-only, Expense-only
- **Year filtering**: Filter to specific year or show all periods
- **Sorting**: By total descending (absolute value for net mode)
- **Sticky columns**: Category name column stays visible during horizontal scroll
- **Column totals**: Footer row with per-period and grand totals

### Saved Charts Integration

Users can create custom category charts via the Saved Charts feature. These render as additional `CustomCategoryChart` components below the built-in widgets, each with its own per-graph exclusion toggle.

## Performance Considerations

### Data Fetching Strategy
- **Pagination**: Transactions are fetched in pages of 1000 until all are retrieved
- **Currency normalization**: Uses `normalize_to_eur: true` and `target_currency` params
- **Stale time**: 60 seconds for both transactions and categories queries
- **Client-side processing**: All aggregation happens in `useMemo`, re-computed only when dependencies change

### Memory Efficiency
- **No object spread in loops**: The net worth page (which shares data patterns) avoids spread on large arrays
- **Map-based aggregation**: Uses `Map` objects for O(1) lookups during aggregation
- **Deferred data**: Uses `useDeferredValue` for search filtering to avoid blocking renders

## Backend Dependencies

The statistics feature relies on these backend endpoints via `[[apps/node-backend/src/routes/info.js]]`:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/transactions` | Fetch all transactions (paginated, with currency conversion) |
| `GET /api/categories` | Fetch all categories |
| `GET /api/info/recurring-patterns` | Recurring pattern detection (used in Planned Payments) |
| `GET /api/info/recipient-insights` | Merchant spending insights |
| `GET /api/info/exchange-rates` | Exchange rates for currency normalization |

## Related Features

- [[docs/features/splits|Splits & Owes]] — Owed summary uses similar aggregation patterns
- [[docs/features/belgian-tax|Belgian Tax]] — Tax calculations use transaction data
- [[docs/features/saved-charts|Saved Charts]] — Custom charts render within Statistics page
- [[docs/features/recipient-insights|Recipient Insights]] — Embedded as a tab within Statistics
- [[docs/features/portfolio|Portfolio Performance]] — Separate analytics for investment data
