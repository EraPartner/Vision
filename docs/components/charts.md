---
title: Chart Primitives
type: component
status: active
date: 2026-04-24
updated: 2026-06-10
tags: [components, charts, visx, d3, visualization, phase-9, phase-h, accessibility, aria-label, screen-reader, i18n, localization, premium-v3, chart-scrub, chart-sync, chart-skeleton, sweep-reveal, sparkline-scrub, june-2026]
description: Low-level chart primitives built on visx + d3, replacing Recharts with design-token-aware styling. 2026-05-29: chartAria.ts generators now accept t()/kindKey for fully localized chart screen-reader summaries across all 7 chart types and both supported languages. June 2026 Premium v3 (ADR-071): scrubbable prop + useChartScrub (scrub-to-compare), syncId prop + ChartSyncContext (synced crosshairs), sweep reveal on AreaChart, ChartSkeleton ghost waveform. V9: Sparkline activeIndex prop (hairline + dot indicator for stat-card scrub).
aliases: [charts, chart-components, visx-charts, charting, visualization]
related_code:
  - apps/frontend/src/components/charts
  - apps/frontend/src/components/charts/chartAria.ts
  - apps/frontend/src/components/charts/__tests__/chartAria.test.ts
  - apps/frontend/src/components/charts/scrub.tsx
  - apps/frontend/src/components/charts/ChartSyncContext.tsx
  - apps/frontend/src/components/charts/ChartSkeleton.tsx
---

# Chart Primitives

Vision frontend uses **visx + d3** for low-level chart primitives, replacing Recharts. All charts consume design tokens directly and support reduced-motion via conditional animation.

## Migration from Recharts (Phase 9)

**Rationale:** Recharts provided good defaults but lacked control for design-token integration and tight aesthetic alignment. visx + d3 enables:

- **Design token consumption**: Colors, spacing, typography all inherit from token system
- **Bundle savings**: ~35kb gzipped reduction (Recharts ~50kb → visx ~15kb)
- **Visual cohesion**: Seamless integration with liquid-glass aesthetic
- **Performance**: d3 scales and shapes are battle-tested; optional downsampling via LTTB for large datasets

See [[docs/adr/018-visx-d3-chart-migration|ADR-018: visx/d3 Chart Migration]] for architectural decision.

## Chart Library

**Location:** `apps/frontend/src/components/charts/`

### Core Primitives

| Component | Purpose | Use Case | Example Consumer |
|-----------|---------|----------|------------------|
| `AreaChart` | Stacked time-series areas | Monthly income/expense trends | DashboardPage, StatisticsPage |
| `BarChart` | Grouped or stacked bars | Category breakdown, monthly comparison | StatisticsPage, DashboardPage |
| `StackedBarChart` | Multi-series bar stacks | Side-by-side category comparison | PerformancePage, StatisticsPage |
| `PieChart` | Basic pie distribution | Category spending pie | StatisticsPage |
| `DonutChart` | Donut/ring distribution | Segmented breakdown with center label | StatisticsPage |
| `LineChart` | Multi-line trends + reference lines | Portfolio performance, rolling cashflow forecast | PerformancePage, WatchlistPage, CashFlowForecastChart (Phase H) |
| `Sparkline` | Mini inline sparkline with optional hover indicator | Micro-charts in stat cards or tables | StatCard, NetSummaryCard scrub surface, performance tables |
| `Candlestick` | OHLC price action | Stock/crypto price visualization | StocksPage, CryptoPage |
| `TreemapChart` | Hierarchical rectangles | Category spending breakdown | StatisticsPage |
| `SankeyChart` | Flow diagram with d3-sankey | Income-to-category allocation | StatisticsPage Flow tab |

### Shared Components

| Component | Purpose |
|-----------|---------|
| `ChartTooltip` | Shared tooltip renderer with design-token colors |
| `ChartLegend` | Shared legend component respecting reduced-motion |
| `ChartAxis` | Shared axis renderer (x, y) with token-based styling |
| `ChartSkeleton` | Ghost waveform + shimmer loading placeholder (Premium v3) |

### Interaction Modules (Premium v3)

| Module | Exports | Purpose |
|--------|---------|---------|
| `scrub.tsx` | `useChartScrub`, `formatScrubDelta` | Scrub-to-compare: pointer-drag range, glass Δ pill |
| `ChartSyncContext.tsx` | `ChartSyncProvider`, `useChartSync` | Synced crosshairs across charts sharing a `syncId` |

## Usage Patterns

### Basic AreaChart

```tsx
import { AreaChart } from '@/components/charts/AreaChart';

function MonthlyTrendsPage() {
  const data = [
    { month: 'Jan', income: 5000, expenses: 3200 },
    { month: 'Feb', income: 4800, expenses: 3100 },
    // ...
  ];

  return (
    <AreaChart
      data={data}
      xKey="month"
      areas={[
        { key: 'income', color: 'emerald', label: 'Income' },
        { key: 'expenses', color: 'red', label: 'Expenses' },
      ]}
      height={300}
      margin={{ top: 10, right: 30, bottom: 30, left: 60 }}
      showLegend
      showTooltip
    />
  );
}
```

### Sparkline in StatCard

> [!note] Surface class update (June 2026)
> The example below uses `surface-elevated premium-frame` (pre-ADR-070 style). Current canonical recipe for KPI/stat cards is `glass-regular premium-frame micro-lift` or use the `<Card>` component with `className="glass-regular micro-lift"` (`premium-frame` is now baked into `Card`).

```tsx
import { Sparkline } from '@/components/charts/Sparkline';

function StatCard() {
  const sparkData = [100, 120, 110, 150, 130, 160, 140];

  return (
    <div className="surface-elevated premium-frame">
      <div className="mb-2">
        <h3>Monthly Income</h3>
        <p className="text-2xl font-semibold">€5,000</p>
      </div>
      <Sparkline
        data={sparkData}
        width={200}
        height={40}
        strokeColor="emerald"
        fillColor="emerald"
        opacity={0.2}
      />
    </div>
  );
}
```

### Sparkline `activeIndex` Prop (V9)

`Sparkline` accepts an optional `activeIndex?: number` prop. When set:

- A vertical hairline is drawn at the corresponding data point's x position.
- A dot is rendered on the line at that point.
- Used by `NetSummaryCard` to show which month is being scrubbed when the user hovers or drags over the sparkline strip.

```tsx
const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined);

<Sparkline
  data={netHistory}
  width={200}
  height={32}
  activeIndex={activeIndex}
  strokeColor="emerald"
/>
```

**Code:** [[apps/frontend/src/components/charts/Sparkline.tsx]]

### LineChart with Multiple Series

```tsx
import { LineChart } from '@/components/charts/LineChart';

function PerformanceChart() {
  const data = [
    { date: '2026-01-01', stocks: 10000, crypto: 2000 },
    { date: '2026-01-02', stocks: 10200, crypto: 2100 },
    // ...
  ];

  return (
    <LineChart
      data={data}
      xKey="date"
      lines={[
        { key: 'stocks', color: 'emerald', label: 'Stocks' },
        { key: 'crypto', color: 'gold', label: 'Crypto' },
      ]}
      height={400}
      showLegend
      showTooltip
      showGrid
    />
  );
}
```

### LineChart with Vertical Reference Line (Phase H)

`LineChart` supports an optional vertical reference line to mark a point-in-time (e.g., "today" in a rolling forecast):

```tsx
import { LineChart, LineReferenceLine } from '@/components/charts/LineChart';

function RollingForecastChart() {
  const data = [
    { date: new Date('2026-04-28'), cumulative: 3450.75 },
    { date: new Date('2026-04-29'), cumulative: 3365.75 },
    { date: new Date('2026-05-01'), cumulative: 6865.75 },
  ];

  return (
    <LineChart
      data={data}
      xKey="date"
      xIsDate={true}  // Enable date-based X-axis scaling
      lines={[
        { key: 'cumulative', color: 'emerald', label: 'Cumulative' },
      ]}
      height={300}
      referenceLines={[
        {
          x: new Date('2026-04-28'),  // Vertical line at today's date
          label: 'Today',
          color: 'var(--color-text-muted)',
          strokeDasharray: '4 4'
        }
      ]}
    />
  );
}
```

**Props:**

- `xIsDate?: boolean` — When `true`, interprets `xKey` values as `Date` objects and scales X-axis to date range
- `referenceLines?: LineReferenceLine[]` — Array of vertical reference lines
  - `x?: Date | number` — Vertical line position (Date when `xIsDate=true`, numeric value otherwise)
  - `y?: number` — Horizontal line position (for compatibility with existing usage)
  - `label?: string` — Optional label for the reference line
  - `color?: string` — Line color (CSS color or token variable)
  - `strokeDasharray?: string` — Line dash pattern (e.g., "4 4" for dashed)

## Design Token Integration

All charts automatically consume tokens from `apps/frontend/src/styles/tokens.css`:

```tsx
// Colors are token-aware
<AreaChart
  areas={[
    { key: 'income', color: 'var(--color-emerald)' },
    { key: 'expenses', color: 'var(--color-red)' },
  ]}
/>

// Typography inherits font families
<ChartAxis
  fontSize="var(--font-size-xs)"
  fontFamily="var(--font-family-body)" // Inter Tight
/>

// Spacing uses token spacing
margin={{ 
  top: 'var(--space-2)',     // clamp-based responsive
  right: 'var(--space-4)',
  bottom: 'var(--space-4)',
  left: 'var(--space-6)',
}}
```

## Reduced-Motion Compliance

All charts disable animations when `prefers-reduced-motion: reduce` is active:

```tsx
import { useReducedMotion } from '@/lib/motion';

export function MyChart() {
  const prefersReduced = useReducedMotion();

  return (
    <AreaChart
      data={data}
      animate={!prefersReduced}  // Skip animations if reduced-motion
      transitionDuration={300}
      // ...
    />
  );
}
```

### ChartTooltip Behavior

- **Normal**: Spring entry + fade exit (150ms)
- **Reduced-motion**: Instant appearance, no animation

```tsx
<ChartTooltip
  content={<div>{value}</div>}
  prefersReduced={prefersReduced}
/>
```

## Performance Considerations

### Large Datasets (>1000 points)

Use LTTB (Largest-Triangle-Three-Buckets) downsampling on the backend (see [[docs/adr/008-performance-page-server-computed-response|ADR-008]]):

```tsx
// Backend computes downsampled data (e.g., ~400 points)
const response = await apiClient.getPerformanceData({
  period: '1y',
  // Backend returns pre-downsampled snapshots
});

<LineChart data={response.data.snapshots} />
```

### Medium Datasets (100-1000 points)

Chart rendering is performant with visx; no client-side downsampling needed.

### Small Datasets (<100 points)

All chart types perform optimally; no optimization required.

## Accessibility

### Generated `aria-label` Summaries (2026-05-29)

**Location:** `apps/frontend/src/components/charts/chartAria.ts`

All 7 chart components (`BarChart`, `LineChart`, `AreaChart`, `StackedBarChart`, `PieChart`, `DonutChart`, `Sparkline`) now generate a meaningful one-line `aria-label` by default. Previously the `ariaLabel` prop existed but no caller populated it, so screen readers announced only "Bar chart" or "Pie chart" with no data context. The initial implementation used hardcoded English; as of 2026-05-29 all strings are fully localized (audit finding [[docs/reference/codebase-audit-2026-05#ux.4|ux.4]]).

Three generator functions handle the main chart shapes. Each now accepts `t` (the `TFn` translator from `useLanguage()`) and a `kindKey` string instead of a hardcoded English label:

| Function | Signature | Output example (EN) |
|----------|-----------|---------------------|
| `summarizeSeriesChart` | `(t, kindKey, categoryCount, seriesLabels?)` | `"Bar chart with 12 categories, series: Income, Expenses"` |
| `summarizeProportionChart` | `(t, kindKey, names)` | `"Pie chart with 5 segments"` |
| `summarizeSparkline` | `(t, values)` | `"Sparkline of 7 points, ranging 100 to 160"` |

Chart kind keys live in the `chart.aria.kind.*` namespace (e.g. `chart.aria.kind.bar`, `chart.aria.kind.pie`). All callers pass the appropriate key:

```tsx
// BarChart.tsx — example caller
const { t } = useLanguage();
const ariaLabel = ariaLabelProp ?? summarizeSeriesChart(t, 'chart.aria.kind.bar', data.length, series.map(s => s.label));
```

The generated label is used as the default value for `role="img"` on the outermost SVG element. The `ariaLabel` prop still overrides the default when callers supply a custom description.

**Tests:** `apps/frontend/src/components/charts/__tests__/chartAria.test.ts` — unit tests covering all three generators (empty data, single series, multiple series, label-key variation, Dutch locale).

> [!tip] When to supply a custom `ariaLabel`
> The generated summaries describe shape and axis dimensionality. For charts showing specific business KPIs (e.g., "Year-to-date tax spend by asset class"), supply a custom `ariaLabel` that describes the *data story*, not just the chart structure.

### Color

- Use semantic colors (emerald = positive, red = negative, gold = accent)
- Tooltip always shows numeric values (not just color coding)
- Avoid red-green-only color schemes for color-blind users

### Tooltips & Legends

- All charts include `ChartTooltip` on hover for numeric values
- Legends are keyboard-accessible (tab to focus, arrow keys to navigate)
- SVG elements carry a generated `aria-label` describing chart type and data dimensions (see above)

### Keyboard Navigation

- Tab navigates to interactive chart areas
- Arrow keys navigate data points within tooltips/legends
- Escape dismisses tooltip/legend

## Responsive Design

All charts use SVG viewBox for automatic scaling:

```tsx
<AreaChart
  width="100%"          // Fills container width
  height={300}          // Fixed height
  responsive={true}     // Auto-resize on window change
/>
```

Mobile breakpoints automatically adjust:

- **320px–375px**: Reduced margins, smaller fonts, single-line legend
- **375px–768px**: Standard margins, standard fonts
- **768px+**: Enhanced margins, larger fonts, multi-column legend

## SankeyChart (d3-sankey)

**Purpose:** Directed flow diagram showing income allocation to spending categories.

**Location:** `apps/frontend/src/components/statistics/SankeyChart.tsx`

**Implementation:**

- Uses `d3-sankey` library for layout computation
- SVG rendering with curved links, rectangular nodes, and text labels
- Deep-clones input data (d3-sankey mutates nodes/links in-place)
- Interactive hover with opacity-based highlighting

**Critical Detail:** Node IDs must be **strings** (not integers) for d3-sankey's `nodeId` accessor to resolve link source/target. Passing integers causes silent layout failure (graph = null).

**Example:**

```tsx
import { SankeyChart } from '@/components/statistics/SankeyChart';

function FlowTab() {
  const flowData = {
    nodes: [
      { id: "__income__", label: "Income", value: 5000 },
      { id: "cat:Groceries", label: "Groceries", value: 2000 },
      { id: "__savings__", label: "Savings", value: 3000 }
    ],
    links: [
      { source: "__income__", target: "cat:Groceries", value: 2000 },
      { source: "__income__", target: "__savings__", value: 3000 }
    ],
    year: 2026
  };

  return <SankeyChart data={flowData} height={420} />;
}
```

**Related:** [[docs/features/sankey-flow|Sankey Flow Feature]], [[docs/components/statistics|Statistics Components]]

---

## Premium v3 Chart Features (ADR-071, June 2026)

### Scrub-to-Compare (`scrubbable` prop)

**File:** [[apps/frontend/src/components/charts/scrub.tsx]]

`AreaChart` and `LineChart` accept a `scrubbable?: boolean` prop. When enabled:

- A `useChartScrub` hook tracks pointer events via pointer capture (works on desktop and touch).
- While the user drags, a semi-transparent range band rect is drawn over the chart.
- A glass Δ pill shows the absolute change and percentage change across the selected range (`formatScrubDelta`).
- The standard `ChartTooltip` is suppressed during scrubbing.
- Pointer capture ensures the drag works even when the pointer leaves the SVG element.

**Enabled on:** `CashFlowComparisonChart`, `ForecastInner`, `ForecastInnerRolling`, `BankBalancesWidget`, `PerformancePage` (×2), `NetWorthChart`.

### Synced Crosshairs (`syncId` prop + `ChartSyncContext`)

**Files:** [[apps/frontend/src/components/charts/ChartSyncContext.tsx]]

Charts sharing the same `syncId` string under a `ChartSyncProvider` mirror hover position:

- `ChartSyncProvider` maintains a shared hovered x-key via React context.
- Each participating chart calls `useChartSync(syncId)` to read the hovered position and to publish its own hover.
- **Domain guard**: If the hovered x-key falls outside a chart's domain, no crosshair is shown (prevents edge-pinning across disjoint timelines).
- **Dashboard usage**: All dashboard time-series share `syncId="dashboard-timeline"`. `ChartSyncProvider` wraps `DashboardPage`.
- **BarChart excluded**: The categorical `MonthlyTrendsChart` uses a band scale and is not synced.

```tsx
// DashboardPage wraps with provider
<ChartSyncProvider>
  <CashFlowComparisonChart syncId="dashboard-timeline" ... />
  <BankBalancesWidget syncId="dashboard-timeline" ... />
</ChartSyncProvider>
```

### Sweep Reveal (AreaChart)

`AreaChart` animates a `clipPath` on mount: a `motion.rect` inside a `<defs>` clipPath starts at `width=0` and expands to the full chart width. The series group is clipped to this rect, producing a left-to-right sweep reveal. Skipped when `useReducedMotion()` is true.

`LineChart` retains its per-series fade-in; sweep is area-only.

### ChartSkeleton

**File:** [[apps/frontend/src/components/charts/ChartSkeleton.tsx]]

Renders an SVG ghost waveform path with a shimmer animation as a chart loading state. Used in `DashboardPage` to replace plain rectangle `Skeleton` placeholders for chart card sections. Accepts a `height` prop.

---

## Related Documentation

- [[docs/adr/071-premium-v3-effects-toggle|ADR-071: Premium v3 (chart scrub, sync, skeleton)]]
- [[docs/adr/018-visx-d3-chart-migration|ADR-018: visx/d3 Chart Migration]]
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/008-performance-page-server-computed-response|ADR-008: Performance Page Server-Computed Response]]
- [[docs/components/dashboard|Dashboard Components]]
- [[docs/features/statistics|Statistics Feature]]
- [[docs/features/sankey-flow|Sankey Flow Feature]]
- [[docs/features/portfolio|Portfolio Feature]]
- [[docs/performance/chart-downsampling|Chart Downsampling (LTTB)]]
