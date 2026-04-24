---
title: Statistics Components
type: component
status: active
date: 2026-04-24
tags: [components, statistics, charts, frontend, refactoring]
description: Statistics page sub-components and shared utilities for composable analytics widgets
related_code:
  - apps/frontend/src/pages/StatisticsPage.tsx
  - apps/frontend/src/components/statistics/
  - apps/frontend/src/hooks/useChartCurrencyFormatter.ts
aliases: [statistics components, stats components, analytics components]
---

# Statistics Components

Vision's Statistics page is composed of 11 specialized sub-components plus shared utilities. This modular architecture enables independent testing, reuse, and maintenance.

## Overview

**Page:** `[[apps/frontend/src/pages/StatisticsPage.tsx]]` (232 lines)  
**Components:** `[[apps/frontend/src/components/statistics/]]`

The page acts as a thin orchestrator:

```tsx
function StatisticsPage() {
  const { data, getGraphData, toggleGraphExclusion } = useStatistics();
  const { isVisible } = useWidgetVisibility("statistics", STATISTICS_WIDGETS);
  
  return (
    <Tabs>
      {isVisible("summaryCards") && <SummaryCards ... />}
      {isVisible("monthly") && <ChartCard><MonthlyChart /></ChartCard>}
      {/* ... 9 more widgets across 4 tabs ... */}
    </Tabs>
  );
}
```

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

### SummaryCards

**File:** `SummaryCards.tsx` (72 lines)  
**Purpose:** 4-card KPI grid (income, spending, net, months tracked)

**Props:**

```typescript
interface SummaryCardsProps {
  data: StatisticsData | null;
  isLoading: boolean;
}
```

**Cards:**

| Card | Value | Format |
|------|-------|--------|
| Income | `totalIncome` | Currency |
| Spending | `totalSpending` | Currency |
| Net | `totalIncome - totalSpending` | Currency |
| Months Tracked | `allPeriods.length` | Count |

**Usage:**

```tsx
<SummaryCards data={data} isLoading={isLoading} />
```

---

### MonthlyChart

**File:** `MonthlyChart.tsx` (42 lines)  
**Purpose:** Monthly income vs spending bar chart

**Props:**

```typescript
interface MonthlyChartProps {
  data: StatisticsData | null;
  isLoading: boolean;
}
```

**Chart Type:** Grouped bar chart (Recharts `BarChart`)  
**Dimensions:** Income (emerald) vs Spending (red) by month  
**Interaction:** Hover tooltip shows currency values

**Usage:**

```tsx
<ChartCard graphKey="monthly" ...>
  <MonthlyChart data={data} isLoading={isLoading} />
</ChartCard>
```

---

### NetTrendChart

**File:** `NetTrendChart.tsx` (44 lines)  
**Purpose:** Net balance area chart over time

**Props:**

```typescript
interface NetTrendChartProps {
  data: StatisticsData | null;
  isLoading: boolean;
}
```

**Chart Type:** Area chart (Recharts `AreaChart`)  
**Dimension:** Net balance (income - spending) by month  
**Styling:** Emerald fill with gradient, respects reduced-motion

**Usage:**

```tsx
<ChartCard graphKey="netTrend" ...>
  <NetTrendChart data={data} isLoading={isLoading} />
</ChartCard>
```

---

### CategoryPieChart

**File:** `CategoryPieChart.tsx` (64 lines)  
**Purpose:** Category spending donut chart (top 10, year-filterable)

**Props:**

```typescript
interface CategoryPieChartProps {
  data: StatisticsData | null;
  isLoading: boolean;
  allYears: number[];
}
```

**Features:**

- Donut chart showing top 10 spending categories
- Year filter: "All Years" or specific year
- Shows category name + percentage on hover

**Usage:**

```tsx
<ChartCard graphKey="categoryPie" ...>
  <CategoryPieChart data={data} allYears={data?.allYears || []} />
</ChartCard>
```

---

### CategoryTrendChart

**File:** `CategoryTrendChart.tsx` (50 lines)  
**Purpose:** Top-5 category spending trend line chart

**Props:**

```typescript
interface CategoryTrendChartProps {
  data: StatisticsData | null;
  isLoading: boolean;
}
```

**Chart Type:** Multi-line chart (Recharts `LineChart`)  
**Dimensions:** Top 5 categories by spending, tracked over all months  
**Interaction:** Click legend to toggle category visibility

**Usage:**

```tsx
<ChartCard graphKey="categoryTrend" ...>
  <CategoryTrendChart data={data} isLoading={isLoading} />
</ChartCard>
```

---

### CategoryPivotTable

**File:** `CategoryPivotTable.tsx` (240 lines)  
**Purpose:** Hierarchical category × month pivot table with mode/year filters

**Props:**

```typescript
interface CategoryPivotTableProps {
  data: StatisticsData | null;
  isLoading: boolean;
}
```

**Features:**

1. **Hierarchy:** Groups `GENERAL:DETAIL` categories under their GENERAL parent, enables expand/collapse
2. **Value modes:** Absolute (default), Net, Income-only, Expense-only (via dropdown)
3. **Year filtering:** "All Periods" or specific year (via dropdown)
4. **Sorting:** By total descending
5. **Sticky columns:** Category name stays visible during horizontal scroll
6. **Column totals:** Footer row with per-period and grand totals
7. **Accessibility:** Keyboard navigation via arrow keys, tab through rows

**Usage:**

```tsx
<ChartCard graphKey="pivotTable" ...>
  <CategoryPivotTable data={data} isLoading={isLoading} />
</ChartCard>
```

---

### TopRecipientsChart

**File:** `TopRecipientsChart.tsx` (67 lines)  
**Purpose:** Top recipients horizontal bar chart (year-filterable)

**Props:**

```typescript
interface TopRecipientsChartProps {
  data: StatisticsData | null;
  isLoading: boolean;
  allYears: number[];
}
```

**Features:**

- Horizontal bar chart showing top 20 recipients by total spending
- Year filter: "All Years" or specific year
- Recipient name + currency amount on hover

**Usage:**

```tsx
<ChartCard graphKey="topRecipients" ...>
  <TopRecipientsChart data={data} allYears={data?.allYears || []} />
</ChartCard>
```

---

### YearlyComparisonChart

**File:** `YearlyComparisonChart.tsx` (41 lines)  
**Purpose:** Year-over-year income/spending comparison bar chart

**Props:**

```typescript
interface YearlyComparisonChartProps {
  data: StatisticsData | null;
  isLoading: boolean;
}
```

**Chart Type:** Grouped bar chart (Recharts `BarChart`)  
**Dimensions:** Income (emerald) vs Spending (red) by year

**Usage:**

```tsx
<ChartCard graphKey="yearlyComparison" ...>
  <YearlyComparisonChart data={data} isLoading={isLoading} />
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

**Location:** `[[apps/frontend/src/components/statistics/statisticsUtils.ts]]`

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
  currencySymbol: string;
  locale: string;
  currency: string;
}

export function useChartCurrencyFormatter(): ChartCurrencyFormatter
```

**Behavior:**

- Derives currency from `AppSettingsContext.defaultCurrency` (default: "EUR")
- Derives locale from `AppSettingsContext.numberFormat`
- Returns `formatCurrency()` function formatted with decimal places from settings
- Returns `currencySymbol` (e.g., "€" for EUR)

**Usage:**

```tsx
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";

function MyChart() {
  const { formatCurrency, currencySymbol } = useChartCurrencyFormatter();
  
  return (
    <div>
      <p>Income: {formatCurrency(5000)}</p>
      <p>Symbol: {currencySymbol}</p>
    </div>
  );
}
```

---

## Tab Organization

The Statistics page is organized into 4 tabs:

### Overview Tab

- `SummaryCards` — 4 KPI cards
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
