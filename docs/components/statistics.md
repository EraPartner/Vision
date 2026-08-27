---
title: Statistics Components
type: component
status: active
date: 2026-04-24
updated: 2026-08-26
tags: [components, statistics, charts, frontend, refactoring, lazy-loading, memoization, performance, phase-13, drillthrough]
description: Statistics page sub-components and shared utilities for composable analytics widgets with lazy-loading per tab and component memoization. Phase 13 adds pivot table drillthrough to transactions page.
related_code:
  - apps/frontend/src/pages/StatisticsPage.tsx
  - apps/frontend/src/features/statistics/
  - apps/frontend/src/hooks/useChartCurrencyFormatter.ts
aliases: [statistics components, stats components, analytics components]
---

# Statistics Components

Vision's Statistics page is composed of 11 specialized sub-components plus shared utilities. This modular architecture enables independent testing, reuse, and maintenance.

## Overview

**Page:** `[[apps/frontend/src/pages/StatisticsPage.tsx]]` (232 lines)  
**Components:** `[[apps/frontend/src/features/statistics/]]`

The page acts as a thin orchestrator with lazy-loading and memoization:

```tsx
import { lazy, Suspense, useMemo } from "react";

const MonthlyChart = lazy(() =>
  import("@/features/statistics/MonthlyChart").then((m) => ({ default: m.MonthlyChart }))
);

function StatisticsPage() {
  const { data, getGraphData, toggleGraphExclusion } = useStatistics();
  const { isVisible } = useWidgetVisibility("statistics", STATISTICS_WIDGETS);
  
  // Memoize props to prevent unnecessary child re-renders
  const chartCardProps = useMemo(
    () => ({ getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply }),
    [getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply],
  );
  
  return (
    <Tabs>
      {isVisible("summaryCards") && <MonthlyRhythm data={data} />}
      {isVisible("monthly") && (
        <Suspense fallback={<ChartSkeleton />}>
          <ChartCard {...chartCardProps}><MonthlyChart /></ChartCard>
        </Suspense>
      )}
      {/* ... 9 more widgets across 4 tabs, each lazy-loaded ... */}
    </Tabs>
  );
}
```

**Performance Features:**
- **Lazy-loading**: 8 chart components deferred until tab is opened (reduces initial bundle)
- **Memoization**: All charts wrapped with `React.memo()` to prevent unnecessary re-renders
- **Prop memoization**: `chartCardProps` memoized to stabilize `ChartCard` children

## Component Catalog

### ChartCard

**File:** `ChartCard.tsx` (48 lines)  
**Purpose:** Reusable card wrapper with built-in ExclusionToggle

**Props:**

```typescript
interface ChartCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  graphKey: string;
  graphExclusions: Record<string, boolean>;
  onToggleExclusion: (key: string) => void;
  exclusionsApply: boolean;
}
```

**Features:**

- Wraps any chart in a `Card` with title + description
- Renders exclusion toggle (radio button showing "Include / Exclude Filtered")
- Communicates toggle state to parent via `onToggleExclusion(graphKey)`

**Usage:**

```tsx
<ChartCard
  title="Monthly Income vs Spending"
  graphKey="monthly"
  graphExclusions={graphExclusions}
  onToggleExclusion={toggleGraphExclusion}
  exclusionsApply={exclusionsApply}
>
  <MonthlyChart data={data} />
</ChartCard>
```

---

### MonthlyRhythm

**File:** `MonthlyRhythm.tsx`  
**Purpose:** The page's opening lede — the *shape* of the months. Replaced
`SummaryCards`, whose first three tiles restated the dashboard hero row (total
income / total spending / net) and whose fourth ("Months tracked") was page
metadata minted to complete a four-up grid.

**Props:**

```typescript
interface MonthlyRhythmProps {
  data: StatisticsData;
}
```

**Anatomy:**

| Slot | Value | Notes |
|------|-------|-------|
| Headline | `monthlyData[i].net` for the scrubbed month (latest by default) | Compact + `RollingNumber`; `DeltaPill` vs the month before |
| Typical month in / out | `averageMonthlyIncome` / `averageMonthlySpending` | Exact (`Money`) |
| Bar strip | `monthlyData[].net`, above/below a zero baseline | Pointer hover + ←/→ · Home/End · Escape via `useChartKeyboardNav` |
| Strongest / Toughest month | max / min `net` with its period label | Exact (`Money`) |
| Months in the black | count of `net >= 0` over `monthlyData.length` | — |

Only the hero abbreviates; every detail figure renders exact.

**Usage:**

```tsx
{isVisible("summaryCards") && <MonthlyRhythm data={data} />}
```

> [!note] Widget id
> The widget id stays `summaryCards` — it is the persisted key in the
> `widget_visibility` setting, so renaming it would silently un-hide the page
> opening for anyone who had hidden it. Only its label key changed
> (`statsPage.widget.monthlyRhythm`).

---

### MonthlyChart

**File:** `MonthlyChart.tsx` (42 lines)  
**Purpose:** Monthly income vs spending bar chart with optional 3-month rolling average overlay

**Props:**

```typescript
interface MonthlyChartProps {
  data: StatisticsData;  // Non-null; parent handles loading/error states
}
```

**Chart Type:** Grouped bar chart with optional line overlay  
**Dimensions:** Income (emerald) vs Spending (red) by month  
**Overlay:** 3-month rolling average (toggle button)  
**Interaction:** Hover tooltip shows currency values

**Performance:**

Wrapped with `React.memo()` to prevent re-renders when parent props change. Uses `useMemo()` internally to compute rolling averages only when `data.monthlyData` changes.

**Usage:**

```tsx
<ChartCard graphKey="monthly" ...>
  <Suspense fallback={<ChartSkeleton />}>
    <MonthlyChart data={getGraphData("monthly")} />
  </Suspense>
</ChartCard>
```

---

### NetTrendChart

**File:** `NetTrendChart.tsx` (44 lines)  
**Purpose:** Net balance area chart over time

**Props:**

```typescript
interface NetTrendChartProps {
  data: StatisticsData;  // Non-null; parent handles loading/error states
}
```

**Chart Type:** Area chart  
**Dimension:** Net balance (income - spending) by month  
**Styling:** Emerald fill with gradient, respects reduced-motion

**Performance:**

Wrapped with `React.memo()` to prevent re-renders when parent props change.

**Usage:**

```tsx
<ChartCard graphKey="netTrend" ...>
  <Suspense fallback={<ChartSkeleton />}>
    <NetTrendChart data={getGraphData("netTrend")} />
  </Suspense>
</ChartCard>
```

---

### CategoryPieChart

**File:** `CategoryPieChart.tsx` (64 lines)  
**Purpose:** Category spending donut chart (top 10, year-filterable)

**Props:**

```typescript
interface CategoryPieChartProps {
  data: StatisticsData;
  allYears: number[];
}
```

**Features:**

- Donut chart showing top 10 spending categories
- Year filter: "All Years" or specific year
- Shows category name + percentage on hover

**Performance:**

Wrapped with `React.memo()` to prevent re-renders when parent props change.

**Usage:**

```tsx
<ChartCard graphKey="categoryPie" ...>
  <Suspense fallback={<ChartSkeleton />}>
    <CategoryPieChart data={data} allYears={data.allYears} />
  </Suspense>
</ChartCard>
```

---

### CategoryTrendChart

**File:** `CategoryTrendChart.tsx` (50 lines)  
**Purpose:** Top-5 category spending trend line chart

**Props:**

```typescript
interface CategoryTrendChartProps {
  data: StatisticsData;
}
```

**Chart Type:** Multi-line chart  
**Dimensions:** Top 5 categories by spending, tracked over all months  
**Interaction:** Click legend to toggle category visibility

**Performance:**

Wrapped with `React.memo()` to prevent re-renders when parent props change.

**Usage:**

```tsx
<ChartCard graphKey="categoryTrend" ...>
  <Suspense fallback={<ChartSkeleton />}>
    <CategoryTrendChart data={data} />
  </Suspense>
</ChartCard>
```

---

### CategoryPivotTable

**File:** `CategoryPivotTable.tsx` (240 lines, Phase 13)  
**Purpose:** Hierarchical category × month pivot table with mode/year filters and clickable drillthrough

**Props:**

```typescript
interface CategoryPivotTableProps {
  data: StatisticsData;
  graphKey: string;
  isFiltered: boolean;
  onToggle: (key: string) => void;
  exclusionsApply: boolean;
}
```

**Features:**

1. **Hierarchy:** Groups `GENERAL:DETAIL` categories under their GENERAL parent. Expandable parent groups show a chevron toggle; flat categories (no `:`) render without a chevron.
2. **Collapse/Expand:** Per-row chevron buttons on parent groups with real children. CardHeader hosts a master "Expand all / Collapse all" button (hidden when no group is expandable). State is session-scoped.
3. **Value modes:** Absolute (default), Net, Income-only, Expense-only (via dropdown)
4. **Year filtering:** "All Periods" or specific year (via dropdown)
5. **Sorting:** By total descending
6. **Sticky columns:** Category name stays visible during horizontal scroll
7. **Column totals:** Footer row with per-period and grand totals
8. **Accessibility:** Tab through rows; chevron buttons expose `aria-expanded`/`aria-controls`, activated via Enter or Space
9. **Drillthrough (Phase 13):** Clickable cells navigate to `/transactions` with pre-populated filters

**Drillthrough Behavior (Phase 13):**

All pivot cells are clickable and drill through to the TransactionsPage with pre-populated filters:

| Cell Type | URL Query Params | Notes |
|-----------|------------------|-------|
| Detail row × month | `category_id={id}`, `start_date`, `end_date`, `transaction_type` (if income/expense mode) | Single category detail |
| Detail row × total | `category_id={id}`, `transaction_type` (if income/expense mode) | Entire detail across all periods |
| Group header × month | `category_ids={id1,id2,...}`, `start_date`, `end_date`, `transaction_type` (if income/expense mode) | All children in month |
| Group header × total | `category_ids={id1,id2,...}`, `transaction_type` (if income/expense mode) | All children across all periods |
| Footer × month | `category_ids={all}`, `start_date`, `end_date`, `transaction_type` (if income/expense mode) | All categories in month |
| Footer × grand total | `category_ids={all}`, `transaction_type` (if income/expense mode) | All categories across all periods |

**Collapse/Expand Detail:**
- Each parent group with at least one child whose `detailName` differs from the parent name renders a `ChevronRight` (collapsed) / `ChevronDown` (expanded) button.
- The CardHeader master button label is "Collapse all" when any group is expanded; "Expand all" when all are collapsed. Hidden when no group is expandable.
- State is `useState<Set<string>>` (session-only); not persisted to localStorage or URL. Survives Year/Metric/Exclusion filter changes — collapsed keys remain stable across filter changes.
- Flat categories (no `:` in name, `detailName === general`) do not receive a chevron.

**URL Construction:**
- `lastDayOfMonth(period)` helper computes the last day of a month (e.g., `2026-03` → `2026-03-31`)
- `buildDrillUrl()` helper constructs the drill URL with params; zero-value cells remain non-clickable ([[apps/frontend/src/features/statistics/CategoryPivotTable.tsx]])
- `filter_label` param contains a human-readable label for UX context

**Usage:**

```tsx
<ChartCard graphKey="pivotTable" ...>
  <CategoryPivotTable data={data} graphKey="pivotTable" isFiltered={isFiltered} onToggle={onToggle} exclusionsApply={exclusionsApply} />
</ChartCard>
```

---

### TopRecipientsChart

**File:** `TopRecipientsChart.tsx` (67 lines)  
**Purpose:** Top recipients horizontal bar chart (year-filterable)

**Props:**

```typescript
interface TopRecipientsChartProps {
  data: StatisticsData;
  allYears: number[];
}
```

**Features:**

- Horizontal bar chart showing top 20 recipients by total spending
- Year filter: "All Years" or specific year
- Recipient name + currency amount on hover

**Performance:**

Wrapped with `React.memo()` to prevent re-renders when parent props change.

**Usage:**

```tsx
<ChartCard graphKey="topRecipients" ...>
  <Suspense fallback={<ChartSkeleton />}>
    <TopRecipientsChart data={data} allYears={data.allYears} />
  </Suspense>
</ChartCard>
```

---

### YearlyComparisonChart

**File:** `YearlyComparisonChart.tsx` (41 lines)  
**Purpose:** Year-over-year income/spending comparison bar chart

**Props:**

```typescript
interface YearlyComparisonChartProps {
  data: StatisticsData;
}
```

**Chart Type:** Grouped bar chart  
**Dimensions:** Income (emerald) vs Spending (red) by year

**Performance:**

Wrapped with `React.memo()` to prevent re-renders when parent props change.

**Usage:**

```tsx
<ChartCard graphKey="yearlyComparison" ...>
  <Suspense fallback={<ChartSkeleton />}>
    <YearlyComparisonChart data={data} />
  </Suspense>
</ChartCard>
```

---

### YearlySummaryTable

**File:** `YearlySummaryTable.tsx` (67 lines)  
**Purpose:** Yearly summary table (income, spending, net, transaction count)

**Props:**

```typescript
interface YearlySummaryTableProps {
  data: StatisticsData | null;
  isLoading: boolean;
}
```

**Columns:**

| Column | Computed From |
|--------|---------------|
| Year | `yearlyComparison[].year` |
| Income | `yearlyComparison[].totalIncome` |
| Spending | `yearlyComparison[].totalSpending` |
| Net | Income - Spending |
| Transactions | `yearlyComparison[].transactionCount` |

**Features:**

- Footer row with totals across all years
- Sortable columns (click header to sort)
- Currency-formatted values

**Usage:**

```tsx
<ChartCard graphKey="yearlySummary" ...>
  <YearlySummaryTable data={data} isLoading={isLoading} />
</ChartCard>
```

---

### SavedChartsSection

**File:** `SavedChartsSection.tsx` (42 lines)  
**Purpose:** Renders all saved custom category charts

**Props:**

```typescript
interface SavedChartsSectionProps {
  graphExclusions: Record<string, boolean>;
  onToggleExclusion: (key: string) => void;
  exclusionsApply: boolean;
}
```

**Features:**

- Fetches saved charts via `useSavedCharts()` hook
- For each saved chart, renders a `CustomCategoryChart` component
- Each chart has independent exclusion toggle via graphKey

**Usage:**

```tsx
<SavedChartsSection
  graphExclusions={graphExclusions}
  onToggleExclusion={toggleGraphExclusion}
  exclusionsApply={exclusionsApply}
/>
```

---

### RecipientInsightsTab

**File:** `RecipientInsightsTab.tsx` (311 lines)  
**Purpose:** Merchant spending insights with MoM alerts and filters

**Props:**

```typescript
interface RecipientInsightsTabProps {
  // Provided by parent StatisticsPage
}
```

**Features:**

- Month-over-month spending change detection
- Filters: recipient name, min/max change amount
- Recipient list with insights (spending trend, MoM change %)
- Keyboard navigation

**Usage:**

```tsx
<TabsContent value="recipients">
  <RecipientInsightsTab />
</TabsContent>
```

---

### SankeyChart

**File:** `SankeyChart.tsx` (208 lines)  
**Purpose:** D3-based Sankey flow diagram showing income allocation to spending categories

**Props:**

```typescript
interface SankeyChartProps {
  readonly data: SankeyFlowData;
  readonly height?: number;
}

interface SankeyFlowData {
  nodes: Array<{
    id: string;      // Must be string: "__income__", "cat:{name}", "__savings__"
    label: string;   // Display name
    value: number;   // Total amount
  }>;
  links: Array<{
    source: string;  // Source node ID
    target: string;  // Target node ID
    value: number;   // Flow amount
  }>;
  year: number;
}
```

**Implementation:**

- Uses `d3-sankey` library for layout computation
- SVG-rendered with:
  - `<path>` elements for curved links (via `sankeyLinkHorizontal`)
  - `<rect>` elements for nodes with rounded corners
  - Automatic text label positioning (left/right based on node x-position)
  - Value tooltip on node hover
- Deep-clones data before layout because d3-sankey mutates node/link objects in-place
- **Critical:** Node IDs must be **strings** (not integers) for d3-sankey's `nodeId` accessor to properly resolve link source/target references. Integer indices cause silent layout failures.

**Features:**

- Responsive width (fills container via `ParentSize` wrapper)
- Interactive hover: highlights related nodes/links with opacity transitions
- Color-coded nodes: each node gets a consistent color from a 14-color palette
- Currency-aware value display on node hover

**Usage:**

```tsx
<SankeyChart data={flowData} height={420} />
```

---

### SankeyTab

**File:** `SankeyTab.tsx` (88 lines)  
**Purpose:** Year selector + ExclusionToggle + SankeyChart wrapper for the Statistics Flow tab

**Props:**

```typescript
interface SankeyTabProps {
  graphExclusions: Record<string, boolean>;
  onToggleExclusion: (key: string) => void;
  exclusionsApply: boolean;
}
```

**Features:**

- Year selector dropdown (current year ± 5 years)
- **ExclusionToggle button** in card header: Shows/hides exclusion filters (consistent with MonthlyChart and other charts)
- Fetches Sankey data via `getSankeyFlow()` API client method
- Conditionally includes excluded category/recipient IDs in query key and API call based on `exclusionsApply && isFiltered`
- Displays loading skeleton during fetch
- Shows error state if fetch fails
- Renders SankeyChart with fetched data

**Data Flow:**

```
SankeyTab
  ├─ [selectedYear state]
  ├─ [currency from useChartCurrencyFormatter]
  ├─ [ExclusionToggle] → toggles graphExclusions["sankey"]
  ├─ [useQuery] → getSankeyFlow({ year, currency, excluded_category_ids?, excluded_recipient_ids? })
  └─ SankeyChart (renders fetched data)
```

**Usage:**

```tsx
<Tabs defaultValue="overview">
  {/* ... other tabs ... */}
  <TabsContent value="flow">
    <SankeyTab
      graphExclusions={graphExclusions}
      onToggleExclusion={toggleGraphExclusion}
      exclusionsApply={exclusionsApply}
    />
  </TabsContent>
</Tabs>
```

---

## Shared Utilities

### statisticsUtils.ts

**Location:** `[[apps/frontend/src/features/statistics/statisticsUtils.ts]]`

**Exports:**

```typescript
// Widget definitions
export const STATISTICS_WIDGETS: WidgetDefinition[] = [
  { id: "summaryCards", labelKey: "statsPage.widget.summaryCards", defaultVisible: true },
  { id: "monthly", labelKey: "statsPage.widget.monthly", defaultVisible: true },
  // ... 7 more widgets
];

// Value mode for pivot table
export type PivotValueMode = "absolute" | "net" | "income" | "expense";

// Period formatting
export function formatPeriodLabel(period: string): string;
  // "2026-03" → "Mar 2026"

export function formatPeriodShort(period: string): string;
  // "2026-03" → "Mar 26"

// Collapse/Expand helpers (Phase 13)
export interface ExpandableGroupInput {
  general: string;
  children: ReadonlyArray<{ detailName: string }>;
}

export function isExpandableGroup(group: ExpandableGroupInput): boolean;
  // Returns true if any child's detailName differs from parent general
  // Flat categories (detailName === general) return false

export function computeMasterToggleState(
  expandableGroupNames: ReadonlyArray<string>,
  collapsedGroups: ReadonlySet<string>
): { hasExpandable: boolean; allCollapsed: boolean };
  // Returns { hasExpandable, allCollapsed } for master toggle button state
  // allCollapsed = true when all expandable groups are in collapsedGroups set
```

---

## Shared Hooks

### useChartCurrencyFormatter

**Location:** `[[apps/frontend/src/hooks/useChartCurrencyFormatter.ts]]`

**Purpose:** Shared currency formatting for all chart components (eliminates 8+ duplicated definitions)

**API:**

```typescript
export interface ChartCurrencyFormatter {
  formatCurrency: (val: number) => string;
  formatCompact: (val: number) => CompactFormatResult;
  formatAxisCompact: (val: number) => string;
  currencySymbol: string;
  locale: string;
  currency: string;
}

export function useChartCurrencyFormatter(): ChartCurrencyFormatter
```

(`CompactFormatResult` is `{ display: string; full: string; isCompact: boolean }` from `utils/currency.ts`.)

**Behavior:**

- Derives currency from `AppSettingsContext.defaultCurrency` (default: "EUR")
- Derives locale from `AppSettingsContext.numberFormat`
- Returns `formatCurrency()` function formatted with decimal places from settings
- Returns `formatCompact()` — uses length-based threshold (>9 chars) to abbreviate large values via `Intl.NumberFormat({ notation: 'compact' })`; always returns `full` string for tooltip; falls back to full when compact is not shorter
- Returns `formatAxisCompact()` — always-bounded `k/M/B/T` axis labels with locale-aware decimal separators and currency ordering, including locales where `Intl` does not compact ordinary thousands
- Returns `currencySymbol` (e.g., "€" for EUR)
- Statistics chart axes use `formatAxisCompact(value)`; they do not concatenate `currencySymbol`, `toFixed()`, and a hard-coded `k`, because that bypasses the app's number-format locale and currency ordering

**Usage:**

```tsx
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";

function MyChart() {
  const { formatCurrency, formatCompact } = useChartCurrencyFormatter();
  const r = formatCompact(1_253_632);
  
  return (
    <div>
      <p>Income: {formatCurrency(5000)}</p>
      <p>Large: <span title={r.isCompact ? r.full : undefined}>{r.display}</span></p>
    </div>
  );
}
```

---

## Tab Organization

The Statistics page is organized into 4 tabs:

### Overview Tab

- `MonthlyRhythm` — monthly-trends lede (page opening, above the tabs)
- `MonthlyChart` — Monthly income vs spending
- `NetTrendChart` — Net balance trend

### Categories Tab

- `CategoryPieChart` — Top 10 spending distribution
- `CategoryTrendChart` — Top 5 category trends
- `CategoryPivotTable` — Full category × month breakdown

### Recipients Tab

- `TopRecipientsChart` — Top 20 recipients by spending
- `RecipientInsightsTab` — Merchant MoM insights

### Yearly Tab

- `YearlyComparisonChart` — Year-over-year comparison
- `YearlySummaryTable` — Year totals table

Plus `SavedChartsSection` renders custom charts across all tabs.

---

## Design Patterns

### Render-Prop Pattern

`ChartCard` uses render-prop children to accept any chart component:

```tsx
<ChartCard title="My Chart" graphKey="myChart" ...>
  {/* Any React element */}
  <BarChart ... />
</ChartCard>
```

### Per-Graph Exclusion Toggle

Each chart independently toggles exclusions via `graphExclusions[graphKey]`:

```tsx
const excluded = graphExclusions["monthly"];
const chartData = excluded ? data : unfilteredData;
```

### Shared Currency Formatting

All charts use `useChartCurrencyFormatter()` for consistent formatting:

```tsx
const { formatCurrency } = useChartCurrencyFormatter();
const yAxisTickFormatter = (val) => formatCurrency(val);
```

---

## Related Documentation

- [[docs/features/statistics|Statistics Feature]] — Feature overview and data processing
- [[docs/api/info|Info API]] — Backend endpoints for statistics data
- [[docs/components/charts|Chart Primitives]] — Recharts integration
- [[docs/components/hooks|Custom Hooks]] — `useStatistics()`, `useSavedCharts()`
