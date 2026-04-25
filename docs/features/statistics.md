---
title: Statistics Feature
type: feature
status: active
date: 2026-04-24
updated: 2026-04-25
tags: [feature, statistics, analytics, charts, frontend, backend, refactor, phase-7, phase-12, sankey-flow, rolling-averages, pdf-export, year-selector, useMemo]
description: Complete analytics and statistics system with per-graph exclusions, pivot tables, year-over-year comparisons, saved custom charts, Sankey flow visualization, rolling average overlays, and PDF export. Phase 7 adds flow diagram, moving averages, and financial report export.
aliases: [stats, analytics, charts, pivot table, yearly comparison]
related_code:
  - apps/frontend/src/pages/StatisticsPage.tsx
  - apps/frontend/src/components/statistics/
  - apps/frontend/src/hooks/useStatistics.ts
  - apps/frontend/src/hooks/useChartCurrencyFormatter.ts
  - apps/frontend/src/hooks/statisticsProcessing.ts
  - apps/frontend/src/hooks/useSavedCharts.ts
  - apps/node-backend/src/routes/info.js
  - apps/node-backend/src/repositories/infoRepository.js
---

# Statistics Feature

## Overview

The Statistics page (`/statistics`) is the primary analytics dashboard for transaction data. It provides comprehensive financial insights through multiple chart types, a category pivot table, year-over-year comparisons, and recipient spending analysis. It is the most complex single page in the frontend with 9 configurable widgets, per-graph exclusion toggles, and 4 tabbed sections.

## Refactoring and Performance Optimization (April 2026)

**Component Refactoring:** The Statistics page was refactored from a 920-line monolith into a thin 232-line orchestrator that composes sub-components from `apps/frontend/src/components/statistics/`. This improves testability, reusability, and maintainability while preserving all functionality.

**Performance Optimization (April 25):** All 8 chart components are now lazy-loaded via `React.lazy()` and `Suspense` per tab. The `chartCardProps` is memoized with `useMemo()` to prevent unnecessary child re-renders. The 6 statistics chart components (MonthlyChart, NetTrendChart, YearlyComparisonChart, TopRecipientsChart, CategoryPieChart, CategoryTrendChart) are wrapped with `React.memo()`, along with the 5 settings tab components (GeneralTab, AppearanceTab, AppTab, DashboardTab, BackupTab). This reduces bundle size for initial page load and improves rendering performance when switching tabs.

## Current Status (Phase 2, April 2026)

> [!warning] Dashboard Stat Cards vs. Statistics Page
> **Phase 2 (April 2026) updated only the Dashboard stat cards** to use `/api/aggregations/monthly-summary`. The full **Statistics page remains on client-side computation** (blocked on MV history extension). See [[docs/api/aggregations|Aggregations API]] for dashboard details.

> [!info] Component Refactoring Complete
> **April 2026 refactored StatisticsPage** into a thin orchestrator + 11 composable sub-components. See [[#component-architecture|Component Architecture]] below.

## Architecture

### Component Architecture

**Location:** `[[apps/frontend/src/components/statistics/]]`

The Statistics page (`StatisticsPage.tsx`, 232 lines) is a thin orchestrator that:

1. Fetches data via `useStatistics()` hook
2. Manages widget visibility via `useWidgetVisibility()` hook
3. Composes 11 sub-components into 4 tabs

**Sub-components:**

| Component | Lines | Purpose | Tabs |
|-----------|-------|---------|------|
| `ChartCard.tsx` | 48 | Card wrapper with ExclusionToggle and render-prop children | All |
| `SummaryCards.tsx` | 72 | 4-card KPI grid (income, spending, net, months tracked) | Overview |
| `MonthlyChart.tsx` | 42 | Monthly income/spending bar chart | Overview |
| `NetTrendChart.tsx` | 44 | Net balance area chart over time | Overview |
| `CategoryPieChart.tsx` | 64 | Category spending donut chart (top 10, year-filterable) | Categories |
| `CategoryTrendChart.tsx` | 50 | Top-5 category trend line chart | Categories |
| `CategoryPivotTable.tsx` | 240 | Hierarchical pivot table with mode/year filters | Categories |
| `TopRecipientsChart.tsx` | 67 | Top recipients horizontal bar chart (year-filterable) | Recipients |
| `YearlyComparisonChart.tsx` | 41 | Year-over-year bar chart | Yearly |
| `YearlySummaryTable.tsx` | 67 | Yearly summary table (income, spending, net, tx count) | Yearly |
| `SavedChartsSection.tsx` | 42 | Renders saved custom category charts | All |
| `RecipientInsightsTab.tsx` | 311 | Merchant spending insights (MoM alerts, filters) | Recipients |
| `SankeyTab.tsx` | 88 | Sankey flow diagram with year selector and exclusion toggle | Flow |

**Shared utilities:**

| Export | File | Purpose |
|--------|------|---------|
| `STATISTICS_WIDGETS` | `statisticsUtils.ts` | Widget definitions (id, labelKey, defaultVisible) |
| `PivotValueMode` type | `statisticsUtils.ts` | Mode union: `"absolute" \| "net" \| "income" \| "expense"` |
| `formatPeriodLabel()` | `statisticsUtils.ts` | Format period "2026-03" → "Mar 2026" |
| `formatPeriodShort()` | `statisticsUtils.ts` | Format period "2026-03" → "Mar 26" |

**Shared hooks:**

| Hook | File | Purpose |
|------|------|---------|
| `useChartCurrencyFormatter()` | `[[apps/frontend/src/hooks/useChartCurrencyFormatter.ts]]` | Shared currency formatting for all chart components (eliminates 8+ duplicated definitions) |

See [[docs/components/statistics|Statistics Components]] for detailed component documentation.

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

### Lazy-Loading and Code Splitting (April 25)

All non-critical chart components are lazy-loaded per tab via `React.lazy()` and `Suspense`:

```tsx
const MonthlyChart = lazy(() =>
  import("@/components/statistics/MonthlyChart").then((m) => ({ default: m.MonthlyChart }))
);

<Suspense fallback={<ChartSkeleton />}>
  <MonthlyChart data={getGraphData("monthly")} />
</Suspense>
```

This pattern:
- **Reduces initial bundle**: Defers loading chart logic until the tab is opened
- **Improves TTI**: Initial page render shows only SummaryCards (inline), other tabs load on-demand
- **Maintains UX**: Skeleton fallbacks provide loading feedback
- **8 components lazy-loaded**: MonthlyChart, NetTrendChart, CategoryPieChart, CategoryTrendChart, TopRecipientsChart, YearlyComparisonChart, RecipientInsightsTab, SankeyTab, SavedChartsSection

### Component Memoization (April 25)

6 statistics chart components are wrapped with `React.memo()` to prevent re-renders when parent props change:

```tsx
export const MonthlyChart = memo(function MonthlyChart({ data }: MonthlyChartProps) {
  // Component implementation
});
```

This prevents unnecessary re-renders when:
- Parent switches between graph exclusion states (per-graph toggle)
- Other charts on the same tab are re-computed
- Parent re-renders but data props haven't changed

Additionally, `chartCardProps` is memoized in the parent:

```tsx
const chartCardProps = useMemo(
  () => ({ getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply }),
  [getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply],
);
```

This prevents `ChartCard` children from re-rendering when parent scope functions are re-created.

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

The statistics feature relies on these backend endpoints:

| Endpoint | Purpose | Location |
|----------|---------|----------|
| `GET /api/transactions` | Fetch all transactions (paginated, with currency conversion) | [[apps/node-backend/src/routes/transactions.js]] |
| `GET /api/categories` | Fetch all categories | [[apps/node-backend/src/routes/categories.js]] |
| `GET /api/info/recurring-patterns` | Recurring pattern detection (used in Planned Payments) | [[apps/node-backend/src/routes/info.js]] |
| `GET /api/aggregations/recipient-insights` | Merchant spending insights (Phase G: aggregations) | [[apps/node-backend/src/routes/aggregations.js]] |
| `GET /api/info/exchange-rates` | Exchange rates for currency normalization | [[apps/node-backend/src/routes/info.js]] |

**Phase G Migration (April 2026):** Recipient insights now use the aggregations endpoint. The apiClient method `getRecipientInsights()` transparently unwraps the aggregation envelope to maintain compatibility.

## Phase 7 Additions (April 2026)

### New Tab: Flow (Sankey Diagram)

A fourth tab showing income allocation flow to spending categories via d3-sankey visualization:

- **Year selector**: Choose which year to analyze. Defaults to current year via `useMemo(() => new Date().getFullYear(), [])` to handle year-boundary transitions for long-lived sessions without stale-state bugs.
- **ExclusionToggle**: Per-graph toggle to show/hide category and recipient exclusion filters
- **Nodes**: Income source, top 12 spending categories, "Savings/Unspent" node
- **Links**: Weighted flows showing amount allocated to each category
- **Exclusion support**: Backend filters transactions by excluded categories/recipients when computing flows
- **Endpoint**: `GET /api/aggregations/sankey?year=2026&currency=EUR&excluded_category_ids[]=5&excluded_category_ids[]=10`
- **Backend service**: `apps/node-backend/src/services/calculations/aggregation/sankey.js`
- **Component integration**: `SankeyTab` receives `graphExclusions`, `onToggleExclusion`, `exclusionsApply` props from parent `StatisticsPage`

See [[docs/features/sankey-flow|Sankey Flow Feature]].

### Monthly Chart Enhancement: Rolling Average Overlay

The Monthly Chart now supports optional 3-month rolling average visualization:

- **Toggle button**: Show/hide rolling average line overlay
- **Computation**: `computeRollingAverage(values, 3)` with null handling for sparse data
- **Visual**: Line overlay on top of bar chart, distinct color
- **Use case**: Identify trends beneath seasonal variation

See [[docs/features/rolling-averages|Rolling Averages Feature]].

### PDF Export Button

Statistics page header includes "Export PDF" button:

- **Generates**: A4 PDF with summary cards, monthly table, top 10 categories
- **Endpoint**: `GET /api/reports/financial?currency=EUR`
- **Implementation**: Server-side via `pdfkit@0.18.0` with streaming response
- **Download**: Browser automatically downloads as `financial-report-{YYYY-MM-DD}.pdf`

See [[docs/features/pdf-report-export|PDF Report Export Feature]].

## Related Features

- [[docs/features/splits|Splits & Owes]] — Owed summary uses similar aggregation patterns
- [[docs/features/belgian-tax|Belgian Tax]] — Tax calculations use transaction data
- [[docs/features/saved-charts|Saved Charts]] — Custom charts render within Statistics page
- [[docs/features/recipient-insights|Recipient Insights]] — Embedded as a tab within Statistics
- [[docs/features/portfolio|Portfolio Performance]] — Separate analytics for investment data
- [[docs/features/sankey-flow|Sankey Flow]] — Phase 7 income flow visualization
- [[docs/features/rolling-averages|Rolling Averages]] — Phase 7 trend overlays
- [[docs/features/pdf-report-export|PDF Report Export]] — Phase 7 financial report download
