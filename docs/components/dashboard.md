---
title: Dashboard Components
type: component
status: active
date: 2026-04-17
updated: 2026-05-23
tags: [components, dashboard, charts, widgets, liquid-glass, design-system, phase-9, phase-d, phase-f, phase-h, phase-h-v2, ensemble, visx, url-persistence, rolling-cache, rolling-diagnostics]
description: Dashboard-specific components for financial overview and visualization with liquid-glass aesthetic and visx charts, including dual-mode cash flow forecast with URL state persistence and rolling window diagnostics
aliases: [dashboard-widgets, dashboard-charts, overview-components, stat-cards]
related_code: ["apps/frontend/src/components/dashboard"]
---

# Dashboard Components

Components for the main Dashboard page (`/`), providing financial overview and visualization widgets. As of Phase 9, all dashboard components use the liquid-glass aesthetic, glass surfaces, and visx + d3 charts.

## Visual Design

Dashboard components follow the [[docs/reference/code-patterns#surface-shell-pattern-phase-9|Surface Shell Pattern]] with:

- **StatCard**: `glass-regular` surface with semi-transparent gradient icon tile background
- **Chart containers**: `premium-frame` + `micro-lift` for elevated depth
- **Spacing**: Responsive via clamp-based token system
- **Motion**: Hover states use micro-lift; chart entry uses Framer Motion stagger (if not reduced-motion)

## Component List

| Component | Description | File |
|-----------|-------------|------|
| StatCard | Summary stat card with trend and gradient icon tile | [[apps/frontend/src/components/dashboard/StatCard.tsx\|StatCard.tsx]] |
| MonthlyTrendsChart | Monthly income vs expenses bar chart (visx) | [[apps/frontend/src/components/dashboard/MonthlyTrendsChart.tsx\|MonthlyTrendsChart.tsx]] |
| CategoryPieChart | Spending by category pie chart (visx) | [[apps/frontend/src/components/dashboard/CategoryPieChart.tsx\|CategoryPieChart.tsx]] |
| CashFlowComparisonChart | Current vs previous period comparison (visx) | [[apps/frontend/src/components/dashboard/CashFlowComparisonChart.tsx\|CashFlowComparisonChart.tsx]] |
| CashFlowForecastChart | Dual-mode forecast: Current Month (8-method ensemble + diagnostics, Phase C + F) + Rolling Window (flexible 30/60/90/180-day view, Phase H) | [[apps/frontend/src/components/dashboard/CashFlowForecastChart.tsx\|CashFlowForecastChart.tsx]] |
| ForecastInner | Month-view forecast rendering with multi-method chart, toggles, and diagnostics panel | [[apps/frontend/src/components/dashboard/ForecastInner.tsx\|ForecastInner.tsx]] |
| ForecastInnerRolling | Rolling-window forecast rendering with preset duration chips and "today" reference line | [[apps/frontend/src/components/dashboard/ForecastInnerRolling.tsx\|ForecastInnerRolling.tsx]] |
| CashFlowForecastDiagnostics | Diagnostics sheet showing backtest accuracy and ensemble weights (Phase C + F) | [[apps/frontend/src/components/dashboard/CashFlowForecastDiagnostics.tsx\|CashFlowForecastDiagnostics.tsx]] |
| BankBalancesWidget | Bank account balance display | [[apps/frontend/src/components/dashboard/BankBalancesWidget.tsx\|BankBalancesWidget.tsx]] |
| MonthlySpendingChart | Monthly spending line chart (visx) | [[apps/frontend/src/components/dashboard/MonthlySpendingChart.tsx\|MonthlySpendingChart.tsx]] |

---

## StatCard

Displays a single statistic with optional trend indicator.

### Props

```typescript
interface StatCardProps {
  title: string;           // Card title
  value: string;           // Main value to display
  titleValue?: string;     // Full value for tooltip (e.g., "€5,234.56" when display is "€5.2K")
  change?: string;         // Delta text (e.g., "+12%")
  changeType?: "positive" | "negative" | "neutral";
  subtitle?: string;       // Subtitle when no change
  icon: LucideIcon;        // Icon component
  trend?: "income" | "expense" | "up" | "down" | "neutral";
}
```

### Usage

```tsx
import { DollarSign } from "lucide-react";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";

function MyCard() {
  const { formatCompact } = useChartCurrencyFormatter();
  const { display, full, isCompact } = formatCompact(5234.56);
  
  return (
    <StatCard
      title="Total Income"
      value={display}
      titleValue={isCompact ? full : undefined}  // Tooltip shows full value
      change="+12% vs last month"
      changeType="positive"
      icon={DollarSign}
      trend="income"
    />
  );
}
```

### Visual Features

- Gradient background based on trend type
- Hero glass treatment (`.liquid-glass-hero`) for stronger emphasis over standard cards
- Animated hover effect (lift + shadow)
- Color-coded change indicator
- Large formatted value with gradient text
- **Compact currency display** — Optional `titleValue` prop enables tooltip showing full value when display is compacted (e.g., "€5.2K" with "€5,234.56" on hover)

### Surface Consistency (April 2026)

- Dashboard stat cards and chart wrapper cards are standardized on sanctioned premium surface recipes:
  - `surface-elevated premium-frame micro-lift`
- This replaces ad-hoc elevated class chains (`border-none shadow-lg ... hover:-translate-y-*`) for consistent depth/motion behavior.

Code links: [[apps/frontend/src/pages/DashboardPage.tsx]], [[apps/frontend/src/components/dashboard/StatCard.tsx]], [[apps/frontend/src/components/dashboard/CategoryPieChart.tsx]], [[apps/frontend/src/components/dashboard/MonthlyTrendsChart.tsx]], [[apps/frontend/src/components/dashboard/CashFlowComparisonChart.tsx]], [[apps/frontend/src/index.css]]

---

## MonthlyTrendsChart

Bar chart showing monthly income vs expenses.

### Props

```typescript
interface MonthlyTrendsChartProps {
  data: Array<{
    month: string;
    income: number;
    expenses: number;
  }>;
  currency?: string;
}
```

### Usage

```tsx
<MonthlyTrendsChart
  data={[
    { month: "Jan", income: 5000, expenses: 3200 },
    { month: "Feb", income: 4800, expenses: 3100 },
  ]}
  currency="EUR"
/>
```

### Features

- Dual bar chart (income/expenses)
- Responsive design
- Tooltip on hover
- Dark mode support

---

## CategoryPieChart

Donut/pie chart showing spending distribution by category.

### Props

```typescript
interface CategoryPieChartProps {
  data: Array<{
    category: string;
    amount: number;
    color?: string;
  }>;
  currency?: string;
}
```

### Usage

```tsx
<CategoryPieChart
  data={[
    { category: "Food", amount: 450 },
    { category: "Transport", amount: 200 },
    { category: "Utilities", amount: 150 },
  ]}
  currency="EUR"
/>
```

### Features

- Donut style with center label
- Legend with category colors
- Animated transitions
- Custom colors per category

---

## CashFlowComparisonChart

Compares current period cashflow with previous period.

### Props

```typescript
interface CashFlowComparisonChartProps {
  currentPeriod: {
    income: number;
    expenses: number;
    net: number;
  };
  previousPeriod: {
    income: number;
    expenses: number;
    net: number;
  };
  currency?: string;
}
```

### Usage

```tsx
<CashFlowComparisonChart
  currentPeriod={{ income: 5000, expenses: 3200, net: 1800 }}
  previousPeriod={{ income: 4500, expenses: 2800, net: 1700 }}
  currency="EUR"
/>
```

### Features

- Side-by-side comparison bars
- Percentage change indicators
- Color-coded (green for improvement)

### Date Label Formatting

- Semantic date-label UX pass adds shared month helpers in [[apps/frontend/src/components/shared/dateUtils.ts]]:
  - `formatMonthYearWithAppSettings(date, appDateFormat, locale?)`
  - `formatMonthLabelWithLocale(date, locale?, width?)`
- [[apps/frontend/src/components/dashboard/MonthlyTrendsChart.tsx]] now uses the month-year helper for chart labels (avoids overly detailed full dates while respecting settings)
- [[apps/frontend/src/components/dashboard/MonthlyTrendsChart.tsx]] x-axis readability for dense month labels is reinforced with `interval="preserveStartEnd"` and `minTickGap={20}`
- [[apps/frontend/src/components/dashboard/CashFlowComparisonChart.tsx]] and [[apps/frontend/src/pages/DashboardPage.tsx]] now use the month-year helper for cashflow month descriptions

Code links: [[apps/frontend/src/pages/DashboardPage.tsx]], [[apps/frontend/src/components/dashboard/CashFlowComparisonChart.tsx]], [[apps/frontend/src/components/dashboard/MonthlyTrendsChart.tsx]], [[apps/frontend/src/components/shared/dateUtils.ts]]

---

## CashFlowForecastChart (Phase C + F + H + H v2)

Multi-method cash flow forecast visualization with 8 statistical forecasting methods (7 base + inverse-MSE ensemble), confidence bands, and interactive diagnostics (Phase 10 + Phase C + Phase F). Features dual-mode view: **Current Month** (classical month-view with 8 methods, diagnostics, and walk-forward backtest) and **Rolling Window** (flexible 30/60/90/180-day window with 8-method ensemble, optional walk-forward diagnostics, and 6-hour TTL cache). By default displays 6 methods (5 point methods + ensemble); Monte Carlo methods are hidden by default but toggleable in month view. URL state persistence (`forecastMode=rolling&rollingDays=90`) enables bookmarking and direct-linking to preferred forecast views.

### Props

```typescript
interface CashFlowForecastChartProps {
  excludedCategoryIds?: number[];      // Categories to exclude from forecast
  excludedRecipientIds?: number[];     // Recipients to exclude from forecast
  currency?: string;                   // Target currency (default: EUR)
}
```

### Features

#### Month View (Default)
- **Multi-method ensemble** — Displays all 8 forecasting methods: 5 point methods (Simple Average, Weighted Average, EWMA, Holt-Winters, Prophet Lite) + 2 Monte Carlo methods (Parametric, Block Bootstrap) + 1 ensemble method (inverse-MSE weighted combination)
- **Default visibility** — Shows 6 methods by default: 5 point methods + ensemble inv-MSE. Monte Carlo methods hidden by default but can be toggled on via pill controls
- **View modes** — Tabs toggle between cumulative balance and daily net views
- **Planned transaction overlay** — Switch to include pending planned transactions in cumulative forecast; triggers API refetch
- **Per-method toggles** — Pill-button controls to show/hide individual methods on chart
- **Monte Carlo confidence bands** — Dashed LineSeries rendering P10/P90 percentiles for MC methods (visible when MC methods are toggled on)
- **Diagnostics panel** — Right-side sheet with backtest accuracy table, method rank badges, MAE sparklines, ensemble weights visualization
- **Diagnostics button** — Icon button to open/close sheet

#### Rolling Window View (Phase H + v2)
- **Flexible window duration** — Preset chip row: 30, 60, 90, 180 days; selected window determines forecast horizon and historical lookback
- **Full 8-method ensemble** — All 8 forecasting methods available (5 point + 2 MC + 1 ensemble), same as month view
- **MC confidence bands** — Toggleable P25/P75 bands for Monte Carlo methods
- **Cumulative anchor** — Cumulative balance computed relative to window start (not absolute account balance), enabling rolling trend visualization
- **Today reference line** — Vertical line marking current date within the rolling window
- **Optional diagnostics** — Diagnostics panel available when `include_backtest=true`; shows walk-forward results for rolling window
- **MC rolling cache** — Uses 6-hour TTL cache when using default MC params (1000 paths, [10,50,90] percentiles); skipped when `include_backtest=true`
- **URL state persistence** — `forecastMode=rolling&rollingDays=90` saved to URL via `useSearchParams()` with replace history; users can bookmark and share preferred views

#### Shared
- **Tab segmented control** — `[Current month | Rolling window]` at top of card
- **Self-contained data loading** — Internal query logic with params derived from props and local state

### Usage

```tsx
<CashFlowForecastChart
  currency="EUR"
  excludedCategoryIds={[5, 10]}
  excludedRecipientIds={[3]}
/>
```

### Data Fetching

#### Month View
Component calls `getCashflowForecastMethods()` with parameters:
- `currency` (from props)
- `excluded_category_ids[]`, `excluded_recipient_ids[]` (from props)
- `history_months` (default 36)
- `mc_paths` (default 500)
- `mc_percentiles` (default [25, 75])
- `include_planned` (from local Switch state)
- `include_backtest` (true, always included for diagnostics)

Query refetches when `includePlanned` toggle changes or props change.

#### Rolling Window View
Component calls `getCashflowForecastRolling()` with parameters:
- `currency` (from props)
- `days_forward` (30, 60, 90, or 180 from preset chips, matching selected `rollingDays`)
- `days_back` (same as `days_forward`, symmetric window)
- `history_months` (default 36 for training)
- `mc_paths` (default 500 for reduced computation)
- `mc_percentiles` (default [25, 75] for tighter confidence bands)
- `include_planned` (from local Switch state)
- `include_backtest` (true, always included for diagnostics consistency with month view)

Query refetches when window preset changes (chip selection) or props change.

**State Persistence:**
- `forecastMode` and `rollingDays` stored in URL query params via `useSearchParams()`
- Setters use `{ replace: true }` to prevent building browser history
- Page initialization derives mode/rollingDays from URL on mount

### Default Visibility

Component maintains two method ID constants:
- `ALL_METHOD_IDS`: All 8 methods (simple_avg, weighted_avg, ewma, holt_winters, prophet_lite, ensemble_imse, monte_carlo_parametric, monte_carlo_block_bootstrap)
- `DEFAULT_VISIBLE_METHOD_IDS`: 6 methods (simple_avg, weighted_avg, ewma, holt_winters, prophet_lite, ensemble_imse) — excludes Monte Carlo methods

The `visibleMethodIds` state is initialized to `DEFAULT_VISIBLE_METHOD_IDS`. Users can toggle any method on/off via pill controls, but Monte Carlo methods start hidden to keep the default view less cluttered.

### Visual Design

- Container: `surface-elevated premium-frame micro-lift` (glass surface)
- Chart area: SVG with actual-to-date grey background, forecasts as colorful lines
- MC bands: Dashed lines (P10 lower bound, P90 upper bound)
- Legend: Colored dots with method labels below chart
- Tooltips: Show date, method name, daily value, cumulative value on hover
- Responsive: Mobile-friendly with stacked tabs, single-column legend

### Related

- [[docs/features/cash-flow-forecast|Cash Flow Forecast Feature]]
- [[docs/components/dashboard|Dashboard Components]]
- [[docs/api/aggregations|Aggregations API]]
- [[docs/components/charts|Chart Primitives]]

---

## CashFlowForecastDiagnostics (Phase C + D + F + H v2)

Right-side diagnostics sheet panel for forecast accuracy metrics, persisted accuracy history, and ensemble weight visualization. Supports both month-view (per-calendar-month backtest) and rolling-window (walk-forward rolling backtest) diagnostics by detecting active forecast mode and fetching appropriate data source.

### Props

```typescript
interface CashFlowForecastDiagnosticsProps {
  diagnostics: ForecastDiagnostics | null;  // Backtest results from API (Phase C)
  open: boolean;                             // Sheet open state
  onOpenChange: (open: boolean) => void;    // Callback when sheet open state changes
}
```

### Features

- **Accuracy table** — Shows MAE, RMSE, MAPE per method
  - Sorted by MAE (ascending; lower is better)
  - Rank badge: 🥇 1st, 🥈 2nd, 🥉 3rd place methods
  - Per-method MAE sparkline (24-month trend from persisted accuracy history — Phase D)
  - Helps identify best-performing forecasting method for your data

- **Data loading (Phase D + H v2)** — Sheet-open triggered lazy loading
  - Fetches persisted accuracy history via `useQuery(getCashflowForecastAccuracy)` when open
  - staleTime 10 minutes to avoid excessive refetch
  - Falls back to current session backtest if Postgres table is missing (error code 42P01)
  - **Mode detection (H v2):** Detects active forecast mode (month vs. rolling) and selects appropriate data source
    - Month view: Uses per-calendar-month backtest from API response
    - Rolling view: Uses rolling walk-forward backtest when `include_backtest=true`

- **Ensemble weights visualization (Phase F)** — Bar chart showing inverse-MSE normalized weights per method
  - Heights represent relative weighting of each point method in ensemble combination
  - Labeled with method name and weight percentage
  - Updates dynamically as persisted accuracy metrics improve

- **Sheet positioning** — Right side of screen, overlays chart; dismissible via close button or background click

- **Informational note** — Distinguishes backtest results (current session) from persisted history (nightly updates, Phase D)

- **Multi-mode support (H v2)** — Diagnostics button and sheet visible in both month and rolling modes; content adapts to active mode

### Usage

```tsx
const { diagnostics } = data; // from CashFlowForecastChart parent
const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

<CashFlowForecastDiagnostics
  diagnostics={diagnostics}
  open={diagnosticsOpen}
  onOpenChange={setDiagnosticsOpen}
/>
```

### Data Sources

**Phase C:** Receives `ForecastDiagnostics` object from parent chart's API response:
- `history_months` — Training window (e.g., 36)
- `backtest[]` — Per-method accuracy metrics (MAE, RMSE, MAPE) + per-month breakdown

**Phase D:** Lazily fetches `getCashflowForecastAccuracy()` when sheet opens:
- Per-method latest accuracy record with full history array (24 months)
- Used to construct MAE sparklines for visual trend analysis
- Persisted data allows tracking method stability across nightly batch updates

### Visual Design

- Sheet: Radix UI Sheet, right-aligned, semi-transparent overlay
- Table: Compact rows, monospace numbers for alignment
- Sparklines: Inline 24-point MAE trend per method (Phase D), sourced from persisted history
- Weights chart: Horizontal stacked bar, color-coded per method
- Typography: Tight spacing, hierarchical labels for readability

### Related

- [[docs/features/cash-flow-forecast|Cash Flow Forecast Feature]]
- [[docs/components/dashboard|Dashboard Components]]
- [[docs/api/aggregations|Aggregations API]]

---

## ForecastInnerRolling (Phase H)

Rolling-window cash-flow forecast rendering component — displays actual transactions (past), planned transactions (overlay), and statistical projection across a flexible N-day rolling window.

### Props

```typescript
interface ForecastInnerRollingProps {
  data: CashflowForecastRollingData;  // Merged daily entries from API
  currency: string;                    // Display currency
  isLoading: boolean;                  // Data loading state
  daysForward: 30 | 60 | 90 | 180;    // Active window duration preset
  onDaysForwardChange: (days: 30 | 60 | 90 | 180) => void;  // Preset changed
}
```

### Features

- **Preset window chips** — Four fixed durations: 30, 60, 90, 180 days; user selects via pill buttons
- **Merged daily series** — Shows actual transactions (grey/muted), planned transactions (colored overlay), and statistical simple-average forecast
- **Cumulative balance chart** — LineChart rendering cumulative balance through window, with visual distinction for data sources
- **Today reference line** — Vertical line marking current date within rolling window (enables "before/after today" visualization)
- **Source coloring** — Visually distinct colors for `'actual'` (muted), `'planned'` (highlight), `'forecast'` (projection)
- **Window boundaries** — Displays window start and end dates for context
- **Loading state** — Renders skeleton/spinner during API fetch

> [!info] X-axis month-label locale
> Month abbreviations on the rolling forecast x-axis follow the app **language** setting, not the number-format setting. The component derives `monthLabelLocale` as `language === "nl" ? "nl-NL" : "en-US"` and passes it to `formatDate(d, "MMM d", monthLabelLocale)`. This matches the canonical pattern used by `NetWorthPage` and `PerformancePage`. The y-axis currency formatter continues to use `numberFormatToLocale(appSettings.numberFormat)` — only the x-axis month label was changed.
>
> **Root cause (fixed):** Previously, `ForecastInnerRolling` passed the number-format locale to `formatDate` for `xTickFormat`. Because the default number format is `'eu'` (which maps to `'de-DE'`), the x-axis always showed German month abbreviations (e.g. "Mär", "Mai") regardless of the selected app language. Other charts were unaffected: they either omit the locale argument (defaulting to en-US) or use `formatMonthYearWithAppSettings` whose localized-month branch is unreachable for the 5 numeric `dateFormat` options.

### Data Shape

Receives pre-merged data from `getCashflowForecastRolling()`:

```typescript
interface CashflowForecastRollingData {
  currency: string;
  days_forward: number;
  days_back: number;
  today: string;          // YYYY-MM-DD
  window_start: string;   // today - days_back
  window_end: string;     // today + days_forward
  merged: Array<{
    date: string;                        // YYYY-MM-DD
    net: number;                         // Daily net amount
    cumulative: number;                  // Cumulative from window start
    source: 'actual' | 'planned' | 'forecast';
  }>;
}
```

### Usage (within CashFlowForecastChart)

```tsx
const [daysForward, setDaysForward] = useState(30);

const { data: rollingData } = useQuery({
  queryKey: ['cashflowForecastRolling', daysForward, ...],
  queryFn: () => getCashflowForecastRolling({
    days_forward: daysForward,
    days_back: daysForward * 3,  // 3× lookback
    currency
  })
});

<ForecastInnerRolling
  data={rollingData}
  currency={currency}
  isLoading={isLoading}
  daysForward={daysForward}
  onDaysForwardChange={setDaysForward}
/>
```

### Visual Design

- **Container**: `surface-elevated premium-frame` (glass surface, consistent with month-view)
- **Chart area**: LineChart with cumulative series, muted grid, "today" vertical reference
- **Preset chips**: Horizontally scrollable row of pill buttons (one active)
- **Legend**: Simplified — shows three data sources (actual, planned, forecast)
- **Tooltips**: Show date, source, daily net, cumulative balance on hover
- **Responsive**: Mobile-friendly with stacked chips, responsive chart height

### Related

- [[docs/features/cash-flow-forecast|Cash Flow Forecast Feature]] — Phase H
- [[docs/components/dashboard|Dashboard Components]]
- [[docs/api/aggregations|Aggregations API]] — `/api/aggregations/cashflow-forecast-rolling`
- [[docs/components/charts|Chart Primitives]] — LineChart + vertical reference lines

---

## BankBalancesWidget

Displays current balances for all bank accounts.

### Props

```typescript
interface BankBalancesWidgetProps {
  accounts: Array<{
    bankAccount: string;
    balance: number;
    currency: string;
    transactionCount?: number;
    firstTransaction?: string;
    lastTransaction?: string;
  }>;
}
```

### Usage

```tsx
<BankBalancesWidget
  accounts={[
    { bankAccount: "Main Account", balance: 5000, currency: "EUR" },
    { bankAccount: "Savings", balance: 10000, currency: "EUR" },
  ]}
/>
```

### Features

- List of accounts with balances
- Transaction count per account
- Date range of transactions
- Currency formatting — large balances use compact notation (`formatCurrencyCompact`) with full value in `title` tooltip
- Integer transaction counts use app locale formatter for consistent separators/grouping
- Total net-position card now uses non-glass `premium-frame` treatment for clearer hierarchy against dashboard hero stat cards
- Per-account balance cards use a subtle `premium-frame` treatment (non-glass) to keep dense data readable

Code links: [[apps/frontend/src/components/dashboard/BankBalancesWidget.tsx]], [[apps/frontend/src/pages/DashboardPage.tsx]], [[apps/frontend/src/contexts/AppSettingsContext.tsx]]

---

## MonthlySpendingChart

Renders a Recharts BarChart comparing monthly spending vs income.

### Props

```typescript
interface MonthlySpendingChartProps {
  data: Array<{
    month: string;
    spending: number;
    income: number;
  }>;
}
```

### Usage

```tsx
<MonthlySpendingChart
  data={[
    { month: "2025-01", spending: 3200, income: 5000 },
    { month: "2025-02", spending: 2800, income: 5000 },
  ]}
/>
```

### Features

- Recharts BarChart with two data series (spending in destructive color, income in accent color)
- Responsive container for adaptive sizing
- Formatted currency tooltips
- Compact Y-axis labels for space efficiency
- Legend for series identification
- No-data state when data array is empty

**Code**: [[apps/frontend/src/components/dashboard/MonthlySpendingChart.tsx]]

---

## Widget Visibility System

Dashboard uses a widget visibility system to let users customize their view.

### Usage

```tsx
import { useWidgetVisibility, WidgetVisibilityDialog } from "@/hooks/useWidgetVisibility";

const DASHBOARD_WIDGETS = [
  { id: 'statCards', label: 'Statistics Cards' },
  { id: 'monthlyTrends', label: 'Monthly Trends' },
  { id: 'categoryPie', label: 'Category Distribution' },
];

function Dashboard() {
  const { isVisible, setWidgetVisible } = useWidgetVisibility('dashboard', DASHBOARD_WIDGETS);
  
  return (
    <>
      {isVisible('statCards') && <StatCard ... />}
      {isVisible('monthlyTrends') && <MonthlyTrendsChart ... />}
      
      <WidgetVisibilityDialog
        widgets={DASHBOARD_WIDGETS}
        visibility={isVisible}
        onChange={setWidgetVisible}
      />
    </>
  );
}
```

### Hook API

```typescript
// Hook return values
{
  isVisible: (id: string) => boolean;
  setWidgetVisible: (id: string, visible: boolean) => void;
  setAllVisible: () => void;
  resetToDefaults: () => void;
  widgets: WidgetDefinition[];
}
```

---

## Performance Optimizations (April 2026)

Dashboard Page (`DashboardPage.tsx`) uses `useMemo` to stabilize frequently-recomputed values and prevent unnecessary child re-renders:

| Value | Dependencies | Purpose |
|-------|--------------|---------|
| `integerLocaleFormatter` | `locale` | Reusable `Intl.NumberFormat` for transaction count formatting |
| `DASHBOARD_WIDGETS` | `t` (translation function) | Widget definition array with i18n labels |
| `allExcludedCategoryIds` | `settings`, `categoriesData` | Combined category exclusion list (user-selected + hidden categories) |
| `excludedRecipientIds` | `settings` | Recipient exclusion list derived from settings scope |
| `filteredExclusionParams` | `allExcludedCategoryIds`, `excludedRecipientIds` | Stable query params object for API calls |
| `transactions` | Transaction query key | Memoized transaction list result |
| `monthlyData` | Monthly summary query keys | Memoized filtered/unfiltered monthly summaries |
| `categoryBreakdown` | Category query key | Memoized category spending breakdown |
| `categoryData` | `categoryBreakdown` | Processed category data for chart rendering |
| `recentTransactionsSource` | `recentFilteredTransactions` | Memoized recent transaction array |

> [!info] Memoization Strategy
> These `useMemo` wraps replace previous inline-IIFE patterns and unstable object/array literals. By memoizing derived data and stable references, child components (charts, stat cards) remain stable across exclusion toggling and settings changes, reducing unnecessary chart re-renders and improving perceived responsiveness.

Code: [[apps/frontend/src/pages/DashboardPage.tsx]]

---

## Data Flow — Phase 2 (April 2026)

```
API (/api/aggregations/monthly-summary) → Hook (useFilteredDashboardStats) → Component → Dashboard
                        ↓
         (with category/recipient exclusions applied server-side)
```

**Phase 2 Update:** Dashboard stat cards now fetch from `/api/aggregations/monthly-summary`, a server-computed aggregation endpoint with materialized-view/live source distinction. Category and recipient exclusions are applied server-side; no client-side re-filtering. The hook resolves hidden category IDs (if enabled) and passes `excluded_category_ids[]` and `excluded_recipient_ids[]` as query parameters.

**Source Heuristic:**
- `meta.source === 'mv'` when no exclusions (fast, from materialized view)
- `meta.source === 'live'` when exclusions are applied (dynamic scan, current data)

### Related Hooks

- `useFilteredDashboardStats()` - Fetches `/api/aggregations/monthly-summary` with server-side exclusions (Phase 2)
- `useTransactions()` - Transaction list with filters
- `useWidgetVisibility()` - Widget visibility state

---

## Related Documentation

- [[docs/api/aggregations]] - Aggregations API (Phase 2, includes Phase 10 multi-method forecast and Phase D accuracy endpoint)
- [[docs/features/cash-flow-forecast]] - Cash Flow Forecast Feature (Phase 6/10/C/D)
- [[docs/components/index]] - Components Index
- [[docs/components/charts]] - Chart Primitives (visx/d3)
- [[docs/features/views]] - Dashboard view
- [[docs/api/info]] - Legacy Info API (coexists through Phase 8)
- [[docs/performance/materialized-views]] - Dashboard optimization
