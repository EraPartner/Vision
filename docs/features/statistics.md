---
title: Statistics Feature
type: feature
status: active
date: 2026-04-24
updated: 2026-09-08
last_modified: 2026-09-08
tags:
  [
    feature,
    statistics,
    analytics,
    charts,
    frontend,
    backend,
    refactor,
    phase-7,
    phase-13,
    sankey-flow,
    rolling-averages,
    pdf-export,
    year-selector,
    useMemo,
    drillthrough,
    exclusion-filters,
    recipient-insights,
    smart-insights,
    rolling-window,
  ]
description: Complete analytics and statistics system with per-graph exclusions, pivot tables with clickable drillthrough, Smart Insights, year-over-year comparisons, saved custom charts, Sankey flow visualization, rolling average overlays, and PDF export. Category overspend findings disclose their exact partial-month comparison window.
aliases: [stats, analytics, charts, pivot table, yearly comparison]
related_code:
  - apps/frontend/src/pages/StatisticsPage.tsx
  - apps/frontend/src/features/statistics/
  - apps/frontend/src/hooks/useStatistics.ts
  - apps/frontend/src/hooks/useChartCurrencyFormatter.ts
  - apps/frontend/src/features/statistics/statisticsUtils.ts
  - apps/frontend/src/features/statistics/InsightsDigestPanel.tsx
  - apps/frontend/src/hooks/useSavedCharts.ts
  - apps/node-backend/src/services/categoryOutlierService.js
  - apps/node-backend/src/services/cashForecastInsightService.js
  - apps/node-backend/src/routes/info.js
  - apps/node-backend/src/repositories/infoRepository.js
---

# Statistics Feature

## Overview

The Statistics page (`/statistics`) is the primary analytics dashboard for transaction data. It provides comprehensive financial insights through multiple chart types, a category pivot table, year-over-year comparisons, and recipient spending analysis. It is the most complex single page in the frontend with 9 configurable widgets, per-graph exclusion toggles, and 6 tabbed sections (including the new Custom Charts tab added April 2026).

## Refactoring and Performance Optimization (April 2026)

**Component Refactoring:** The Statistics page was refactored from a 920-line monolith into a thin 232-line orchestrator that composes sub-components from `apps/frontend/src/features/statistics/`. This improves testability, reusability, and maintainability while preserving all functionality.

**Performance Optimization (April 25):** All 8 chart components are now lazy-loaded via `React.lazy()` and `Suspense` per tab. The `chartCardProps` is memoized with `useMemo()` to prevent unnecessary child re-renders. The 6 statistics chart components (MonthlyChart, NetTrendChart, YearlyComparisonChart, TopRecipientsChart, CategoryPieChart, CategoryTrendChart) are wrapped with `React.memo()`, along with the 5 settings tab components (GeneralTab, AppearanceTab, AppTab, DashboardTab, BackupTab). This reduces bundle size for initial page load and improves rendering performance when switching tabs.

## Current Status

The Statistics page uses server-side aggregation endpoints. Its default date range is the latest
24 calendar months, including the current partial month. The page header shows the active range and
offers an explicit **All time** option. The choice is encoded as `?window=all`; the default omits the
parameter so shared links remain compact.

The same inclusive `start_date` and `end_date` bounds are applied to monthly summary, category
pivot, recipient insights, and recipient-by-year requests. All-time monthly requests use
`all_time=true`; the other endpoints omit date bounds. Both modes preserve per-date historical
foreign-exchange conversion.

> [!info] Component Refactoring Complete
> **April 2026 refactored StatisticsPage** into a thin orchestrator + 11 composable sub-components. See [[#component-architecture|Component Architecture]] below.

### Smart Insights partial-month labels

Insight dismissals are authoritative server records. They are applied before subscription lists
are capped at five and before the shared digest reaches either the panel or AI narration. The
navigation badge reads only a versioned persisted count. Database statement triggers dirty that
projection for transaction, category, recipient, planned-transaction, and dismissal changes; a
dirty badge request starts a coalesced background refresh and does not show a stale number.

Category overspend detection compares like-for-like calendar windows: day 1 through the current
comparison day for both the current month and every baseline month. Each category finding includes
`comparisonEndDay`, and `InsightsDigestPanel` shows that exact boundary in both the current amount
and typical baseline labels. The UI therefore does not imply that a partial month was compared with
complete prior months.

The calculation remains owned by
`[[apps/node-backend/src/services/categoryOutlierService.js|categoryOutlierService]]`; the frontend
only presents the returned boundary. See [[docs/features/ai-chat|AI Chat]] for the separate narration
surface that can consume the same digest.

### Category-outlier calibration

The threshold contract was backtested on 8 September 2026 against the only supported user's live
history through the loopback API. The calibration discarded category labels, recipients, accounts,
memos, and comments before analysis and did not write to the database. It covered 3,615 categorized
expenses, 50 category histories, 111 source months, and 330 evaluation snapshots across days 8, 15,
and 28.

The current policy (modified-z threshold 3.5 and EUR 50 flat-baseline floor) produced 118 historical
signals. A more sensitive 3.0/EUR 25 policy produced 18 additional signals, which are potential
false negatives under the current policy. A more conservative 4.0/EUR 75 policy removed 17 current
signals, which are potential false positives. Twelve day-8 signals were absent by day 28, confirming
that early-month timing can add noise even with like-for-like windows. These are tradeoff proxies,
not labelled ground truth.

No threshold was changed from one user's data. The current middle policy remains in place: it avoids
the extra noise of the sensitive policy without hiding as many signals as the conservative policy.
Repeat the aggregate-only backtest with `bun run calibrate:category-outliers` when a genuinely
independent sanitized history becomes available.

## Architecture

### Component Architecture

**Location:** `[[apps/frontend/src/features/statistics/]]`

The Statistics page (`StatisticsPage.tsx`, 232 lines) is a thin orchestrator that:

1. Fetches data via `useStatistics()` hook
2. Manages widget visibility via `useWidgetVisibility()` hook
3. Composes 11 sub-components into 6 tabs

**Sub-components:**

| Component                     | Lines | Purpose                                                                                                                                                                                                                                                   | Tabs           |
| ----------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `ChartCard.tsx`               | 48    | Card wrapper with ExclusionToggle and render-prop children                                                                                                                                                                                                | All            |
| `MonthlyRhythm.tsx`           | —     | Page-opening lede: scrubbable per-month net strip + typical-month figures + strongest/toughest/in-the-black facts (replaced `SummaryCards`, whose income/spending/net tiles restated the dashboard hero and whose 4th tile, "Months tracked", was filler) | Above the tabs |
| `MonthlyChart.tsx`            | 42    | Monthly income/spending bar chart                                                                                                                                                                                                                         | Overview       |
| `NetTrendChart.tsx`           | 44    | Net balance area chart over time                                                                                                                                                                                                                          | Overview       |
| `CategoryPieChart.tsx`        | 64    | Category spending donut chart (top 10, year-filterable)                                                                                                                                                                                                   | Categories     |
| `CategoryTrendChart.tsx`      | 50    | Top-5 category trend line chart                                                                                                                                                                                                                           | Categories     |
| `CategoryPivotTable.tsx`      | —     | Hierarchical pivot table with mode/year filters                                                                                                                                                                                                           | Categories     |
| `TopRecipientsChart.tsx`      | 67    | Top recipients horizontal bar chart (year-filterable)                                                                                                                                                                                                     | Recipients     |
| `YearlyComparisonChart.tsx`   | 41    | Year-over-year bar chart                                                                                                                                                                                                                                  | Yearly         |
| `YearlySummaryTable.tsx`      | 67    | Yearly summary table (income, spending, net, tx count)                                                                                                                                                                                                    | Yearly         |
| `SavedChartsSection.tsx`      | 42    | Full tab content rendering user-created saved charts in grid with builder modal                                                                                                                                                                           | Custom Charts  |
| `CustomChart.tsx`             | —     | Pure read-only chart display merging category + recipient pivot data                                                                                                                                                                                      | Custom Charts  |
| `CustomChartBuilderModal.tsx` | —     | Two-column dialog (form left, live preview right) for creating/editing charts                                                                                                                                                                             | Custom Charts  |
| `RecipientInsightsTab.tsx`    | 311   | Merchant spending insights (MoM alerts, filters)                                                                                                                                                                                                          | Recipients     |
| `InsightsDigestPanel.tsx`     | —     | Dismissible subscription, category-overspend, and cash-forecast findings; category rows label the exact day 1 through N comparison window                                                                                                                 | Above the tabs |
| `SankeyTab.tsx`               | 88    | Sankey flow diagram with year selector and exclusion toggle                                                                                                                                                                                               | Flow           |

**Shared utilities:**

| Export                | File                 | Purpose                                                    |
| --------------------- | -------------------- | ---------------------------------------------------------- |
| `STATISTICS_WIDGETS`  | `statisticsUtils.ts` | Widget definitions (id, labelKey, defaultVisible)          |
| `PivotValueMode` type | `statisticsUtils.ts` | Mode union: `"absolute" \| "net" \| "income" \| "expense"` |
| `formatPeriodLabel()` | `statisticsUtils.ts` | Format period "2026-03" → "Mar 2026"                       |
| `formatPeriodShort()` | `statisticsUtils.ts` | Format period "2026-03" → "Mar 26"                         |

**Shared hooks:**

| Hook                          | File                                                       | Purpose                                                                                    |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `useChartCurrencyFormatter()` | `[[apps/frontend/src/hooks/useChartCurrencyFormatter.ts]]` | Shared currency formatting for all chart components (eliminates 8+ duplicated definitions) |

See [[docs/components/statistics|Statistics Components]] for detailed component documentation.

### Data Flow (Statistics Page)

```
StatisticsPage → useStatistics(window) → aggregation endpoints → mapToStatisticsData()
                          ↓                         ↓
             24 months or All time       monthly/category/recipient data
```

The backend performs the expensive scans and exact historical currency conversion. The frontend
maps the endpoint payloads into the shared `StatisticsData` view model. When exclusions are active,
the hook fetches matching filtered and unfiltered payloads so each graph can toggle exclusions
without changing the selected date window.

### Key Design Decisions

1. **Bounded default**: Cold page loads request 24 calendar months. All-time history is explicit.
2. **Server-side aggregation**: PostgreSQL groups the data and conversion uses each transaction
   date's foreign-exchange rate.
3. **Dual payloads**: Filtered and unfiltered results are kept separately when exclusions apply.
4. **Per-graph exclusions**: Each chart independently chooses the filtered or unfiltered payload
   through `GraphExclusions` state.

## Data Processing Pipeline

### processTransactions()

Located in `[[apps/frontend/src/features/statistics/statisticsUtils.ts]]`, this pure function processes transaction arrays into a `StatisticsData` object:

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
  monthlyData: MonthlyData[]; // Per-month income/spending/net
  categoryPivot: CategoryMonthlyData[]; // Per-category monthly breakdown
  topRecipients: RecipientSpending[]; // Top 20 spending recipients
  topRecipientsByYear: Record<string, RecipientSpending[]>; // Per-year top recipients
  yearlyComparison: YearlyComparison[]; // Year-over-year totals
  allPeriods: string[]; // Sorted YYYY-MM periods
  allYears: number[]; // Sorted years
  totalIncome: number;
  totalSpending: number;
  averageMonthlySpending: number;
  averageMonthlyIncome: number;
}
```

### Exclusion System

The exclusion system is one of the most sophisticated features:

1. **Global exclusions**: Defined in `SettingsHydration` (`excludedCategoryIds`, `excludedRecipientIds`, `excludeHiddenCategories`).
2. **Exclusion scope**: Controlled by `settings.exclusionScope` — can be `'everywhere'`, `'statistics'`, or `'nowhere'`.
3. **Per-graph override**: Each chart has an independent toggle (`graphExclusions[graphKey]`) to show/hide exclusions for that specific chart.
4. **Dual computation**: When exclusions apply globally, both filtered and unfiltered stats are computed. `getGraphData(key)` returns the appropriate view based on per-graph toggle state.

## Widget System

The Statistics page uses the `useWidgetVisibility` hook with 9 configurable widgets:

| Widget ID          | Label Key                           | Default | Description                                          |
| ------------------ | ----------------------------------- | ------- | ---------------------------------------------------- |
| `summaryCards`     | `statsPage.widget.summaryCards`     | Visible | 4 KPI cards (income, spending, net, months tracked)  |
| `monthly`          | `statsPage.widget.monthly`          | Visible | Monthly income vs spending bar chart                 |
| `netTrend`         | `statsPage.widget.netTrend`         | Visible | Net balance area chart over time                     |
| `categoryPie`      | `statsPage.widget.categoryPie`      | Visible | Category spending donut chart (top 10)               |
| `categoryTrend`    | `statsPage.widget.categoryTrend`    | Visible | Top 5 category spending trend lines                  |
| `pivotTable`       | `statsPage.widget.pivotTable`       | Visible | Category × Month pivot table with hierarchy          |
| `topRecipients`    | `statsPage.widget.topRecipients`    | Visible | Top recipients bar chart (horizontal)                |
| `yearlyComparison` | `statsPage.widget.yearlyComparison` | Visible | Year-over-year income/spending comparison            |
| `yearlySummary`    | `statsPage.widget.yearlySummary`    | Visible | Yearly summary table with net and transaction counts |

## Tab Structure

The page is organized into 6 tabs:

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

> [!info] June 2026 — All-Years Top Recipients Exclusion Fix
> The "all years" view of the Top Recipients chart previously ignored active category/recipient exclusion toggles. The per-year sub-query already used filtered data, but the all-years aggregate (`GET /api/aggregations/recipient-insights`) did not accept exclusion params. The endpoint now accepts `excluded_category_ids[]` and `excluded_recipient_ids[]`; `useStatistics.ts` fires a second filtered query (`recipientInsightsFilteredQuery`) when exclusions are active and passes its payload into `mapToStatisticsData`. The all-years and per-year charts now react consistently to exclusion toggles.

### Yearly Tab

- Year-over-Year Comparison bar chart
- Yearly Summary table (year, income, spending, net, transaction count)

### Custom Charts Tab

- Grid of user-created saved charts (empty state with "Create Chart" button when none exist)
- Each chart displays with its configured chart type, variant, and time bucket
- Per-chart exclusion toggles
- Edit and delete buttons on each chart card
- Chart builder modal (two-column: form on left, live preview on right) for creating/editing charts

## Charts and Visualizations

### Chart Library

All charts use **Recharts** with consistent styling:

- Theme-aware colors via CSS variables (`hsl(var(--card))`, `hsl(var(--border))`)
- Custom tooltip styling matching card appearance
- 10-color palette for categorical data

### Category Pivot Table

The most complex widget — a hierarchical table showing categories × months with drillthrough to transactions:

- **Hierarchy**: Groups `GENERAL: DETAIL` categories under their GENERAL parent
- **Value modes**: Absolute (default), Net, Income-only, Expense-only
- **Year filtering**: Filter to specific year or show all periods
- **Sorting**: By total descending (absolute value for net mode)
- **Sticky columns**: Category name column stays visible during horizontal scroll
- **Column totals**: Footer row with per-period and grand totals
- **Drillthrough (Phase 13)**: All cells (except zero-value cells) are clickable and navigate to `/transactions` with pre-populated filters (category, period, transaction type)

**Drillthrough Details (Phase 13):**

- **Detail row × period**: Filters to single category within the month/period
- **Detail row × total**: Filters to single category across all periods
- **Group header × period**: Filters to all detail categories in the GENERAL group within the month
- **Group header × total**: Filters to all detail categories in the GENERAL group across all periods
- **Footer × period**: Filters to all categories within the month
- **Footer × total**: Filters to all categories across all periods
- **Transaction type propagation**: When viewing "Income-only" or "Expense-only" modes, the drillthrough URL includes the corresponding `transaction_type` filter
- **URL params**: Uses new backend filters `category_ids` (comma-separated for groups) and `transaction_type` (income/expense) ([[docs/api/transactions#query-parameters|Transactions API]])

### Saved Charts Integration

Users can create custom category charts via the Saved Charts feature. These render as additional `CustomCategoryChart` components below the built-in widgets, each with its own per-graph exclusion toggle.

## Performance Considerations

### Lazy-Loading and Code Splitting (April 25)

All non-critical chart components are lazy-loaded per tab via `React.lazy()` and `Suspense`:

```tsx
const MonthlyChart = lazy(() =>
  import("@/features/statistics/MonthlyChart").then((m) => ({
    default: m.MonthlyChart,
  })),
);

<Suspense fallback={<ChartSkeleton />}>
  <MonthlyChart data={getGraphData("monthly")} />
</Suspense>;
```

This pattern:

- **Reduces initial bundle**: Defers loading chart logic until the tab is opened
- **Improves TTI**: Initial page render shows only the `MonthlyRhythm` lede (inline), other tabs load on-demand
- **Maintains UX**: Skeleton fallbacks provide loading feedback
- **9 components lazy-loaded**: MonthlyChart, NetTrendChart, CategoryPieChart, CategoryTrendChart, TopRecipientsChart, YearlyComparisonChart, RecipientInsightsTab, SankeyTab, SavedChartsSection

### Component Memoization (April 25)

6 statistics chart components are wrapped with `React.memo()` to prevent re-renders when parent props change:

```tsx
export const MonthlyChart = memo(function MonthlyChart({
  data,
}: MonthlyChartProps) {
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
  () => ({
    getGraphData,
    graphExclusions,
    toggleGraphExclusion,
    exclusionsApply,
  }),
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

| Endpoint                                   | Purpose                                                                                                            | Location                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `GET /api/transactions`                    | Fetch all transactions (paginated, with currency conversion)                                                       | [[apps/node-backend/src/routes/transactions.js]] |
| `GET /api/categories`                      | Fetch all categories                                                                                               | [[apps/node-backend/src/routes/categories.js]]   |
| `GET /api/info/recurring-patterns`         | Recurring pattern detection (used in Planned Payments)                                                             | [[apps/node-backend/src/routes/info.js]]         |
| `GET /api/info/insights-digest`            | Server-filtered Smart Insights findings, including zero-based month-end net cash flow                              | [[apps/node-backend/src/routes/info.js]]         |
| `GET /api/info/insights-count`             | Cheap versioned undismissed-count projection for navigation                                                        | [[apps/node-backend/src/routes/info.js]]         |
| `PUT /api/info/insight-dismissals`         | Persist a strict subscription or category-outlier dismissal                                                        | [[apps/node-backend/src/routes/info.js]]         |
| `GET /api/aggregations/recipient-insights` | Merchant spending insights; now accepts `excluded_category_ids[]` / `excluded_recipient_ids[]` (June 2026 bug fix) | [[apps/node-backend/src/routes/aggregations.js]] |
| `GET /api/info/exchange-rates`             | Exchange rates for currency normalization                                                                          | [[apps/node-backend/src/routes/info.js]]         |

**Phase G Migration (April 2026):** Recipient insights now use the aggregations endpoint. The apiClient method `getRecipientInsights()` transparently unwraps the aggregation envelope to maintain compatibility.

### Smart Insights cash forecast semantics

The cash finding reports expected month-end **net cash flow**: income minus outflows accumulated
from zero across the forecast month. Positive means forecast inflows exceed outflows; negative means
forecast outflows exceed inflows. It is not an account balance, available cash, runway, or an
overdraft prediction. A negative value alone remains a standing finding. It becomes an alert only
when the expected net cash flow moved significantly from the prior observation for the same
month, currency, and forecast method. Vision retains the current and previous two calendar months
of these derived observations. The first observation is standing; later moves require both a 15%
change and an absolute EUR 100 floor, which prevents routine small recalculation noise from
becoming an alert.

**June 2026 — All-Years Exclusion Fix:** `useStatistics.ts` now issues a `recipientInsightsFilteredQuery` (keyed on `effectiveExcludedCategoryIds` and `settingsExcludedRecIds`) alongside the baseline unfiltered query. When `filteredEnabled` is true, the filtered payload is used for `topRecipients` in `mapToStatisticsData` so the "all years" bar chart reacts to exclusion toggles in the same way the per-year view does.

## Phase 13 Additions: Pivot Table Drillthrough (April 2026)

The CategoryPivotTable now supports clickable drillthrough to filtered transaction lists:

### Backend Filter Enhancements

Two new query parameters added to `GET /api/transactions`:

- **`category_ids` (comma-separated string):** Filters by multiple category IDs. Enables drilling through entire category groups (e.g., "FOOD:GROCERIES", "FOOD:DINING", "FOOD:ALCOHOL"). Takes precedence ignored if `category_id` (singular) is set.
- **`transaction_type` (enum: 'income' | 'expense'):** Filters by transaction sign. Enables income-only or expense-only views in pivot drillthrough.

**Backend Implementation:**

- `[[apps/node-backend/src/lib/filterBuilder.js]]` — `buildTransactionWhere()` now accepts `categoryIds` and `transactionType` params
- `[[apps/node-backend/src/routes/transactions.js]]` — `parseTransactionListQuery()` parses comma-separated `category_ids` and `transaction_type` from query string
- `[[apps/node-backend/src/repositories/transactionRepository.js]]` — `getAllWithCount()` destructures and forwards filter params to service layer

### Frontend Drillthrough Implementation

**Component:** `[[apps/frontend/src/features/statistics/CategoryPivotTable.tsx]]`

The page defaults to a rolling 24-month range; `?window=all` exposes full
history. The pivot mounts at most 12 period columns at once. It starts on the
newest period window, renders that window chronologically, and exposes every
older or newer window through keyboard-operable Previous and Next controls.
Totals and export input still cover the complete selected range. Backend pivots
are protected by the shared five-minute statistics cache. The current scale boundary is recorded in
[[docs/performance/index#Accepted Scale Boundaries|Performance Documentation]].

**Helpers:**

- `lastDayOfMonth(period: string): string` — Computes the last day of a month (e.g., `2026-03` → `2026-03-31`)
- `buildTransactionDrillUrl(params)` in `lib/transactionDrillUrl.ts` is the shared production URL builder for statistics and Dashboard drills.

**Interaction:**

- All non-zero pivot cells contain an href-backed link padded to cover the numeric cell. Keyboard activation, href preview, and modified or middle click use native link behavior.
- At most 12 period columns are mounted. Previous and Next traverse the complete period history, and the visible range is announced through a polite live region.
- Group expanders expose every owned child row through a space-separated `aria-controls` list. Each child row has one unique id.
- Detail rows drill to single category or multiple categories (for group headers)
- Period column drills include start/end date filters
- Total column drills omit date filters (all periods)
- Income-only/expense-only modes propagate `transaction_type` to the drill URL

**Test Coverage:**

- `[[apps/frontend/src/lib/__tests__/transactionDrillUrl.test.ts]]` covers leap-month bounds, transaction modes, one/many categories, uncategorised rows, and the plain fallback.
- `[[apps/frontend/src/features/statistics/__tests__/CategoryPivotTable.a11y.test.tsx]]` covers exact drill hrefs, focusable-cell boundaries, and unique controlled child-row ids.
- `[[apps/frontend/src/features/statistics/__tests__/CategoryPivotTable.windowing.test.tsx]]` covers the 12-period mount bound, full-history totals, oldest-window keyboard traversal, sticky labels, and drill links over a 120-period fixture.

> [!warning] General-category group drills previously wedged TransactionsPage
> Drillthrough URLs with `?category_ids=1,2,3` (produced by GENERAL group header clicks) triggered an infinite render loop in `TransactionsPage` — the multi-value array was rebuilt on every render, causing cascading memo + effect re-runs. Fixed in June 2026 by memoizing `categoryIdsFilter` on the raw param string. Detail-cell (scalar `?category_id=…`) drills were not affected. See [[docs/features/transactions#multi-value-filter-memoization-june-2026|Multi-Value Filter Memoization]] for details.

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
- **Implementation**: Server-side via Puppeteer (headless Chrome); `pdfkit` was removed (see [[docs/adr/038-dependency-slim-down-supply-chain-risk|ADR-038]])
- **Download**: Browser automatically downloads as `financial-report-{YYYY-MM-DD}.pdf`

See [[docs/features/pdf-report-export|PDF Report Export Feature]].

### Browser print layout

Printing `/statistics` prints the visible analytics page. The print stylesheet removes the sidebar,
top bar, notifications, dialogs, and header actions; it also replaces glass materials with a light
paper surface and asks the browser to keep cards, tables, and charts intact across page breaks. This
is separate from the server-generated PDF export above.

## Related Features

- [[docs/features/splits|Splits & Owes]] — Owed summary uses similar aggregation patterns
- [[docs/features/belgian-tax|Belgian Tax]] — Tax calculations use transaction data
- [[docs/features/saved-charts|Saved Charts]] — Custom charts with recipients + variants (6th tab, April 2026 extension)
- [[docs/features/recipient-insights|Recipient Insights]] — Embedded as a tab within Statistics
- [[docs/features/portfolio|Portfolio Performance]] — Separate analytics for investment data
- [[docs/features/sankey-flow|Sankey Flow]] — Phase 7 income flow visualization
- [[docs/features/rolling-averages|Rolling Averages]] — Phase 7 trend overlays
- [[docs/features/pdf-report-export|PDF Report Export]] — Phase 7 financial report download
- [[docs/features/ai-chat|AI Chat]] — local narration surface for the Insights digest
