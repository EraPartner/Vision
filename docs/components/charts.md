---
title: Chart Primitives
type: component
status: active
date: 2026-04-24
tags: [components, charts, visx, d3, visualization, phase-9]
description: Low-level chart primitives built on visx + d3, replacing Recharts with design-token-aware styling
aliases: [charts, chart-components, visx-charts, charting, visualization]
related_code: ["apps/frontend/src/components/charts"]
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
| `LineChart` | Multi-line trends | Portfolio performance, watchlist trends | PerformancePage, WatchlistPage |
| `Sparkline` | Mini inline sparkline | Micro-charts in stat cards or tables | StatCard, performance tables |
| `Candlestick` | OHLC price action | Stock/crypto price visualization | StocksPage, CryptoPage |
| `TreemapChart` | Hierarchical rectangles | Category spending breakdown | StatisticsPage |
| `SankeyChart` | Flow diagram with d3-sankey | Income-to-category allocation | StatisticsPage Flow tab |

### Shared Components

| Component | Purpose |
|-----------|---------|
| `ChartTooltip` | Shared tooltip renderer with design-token colors |
| `ChartLegend` | Shared legend component respecting reduced-motion |
| `ChartAxis` | Shared axis renderer (x, y) with token-based styling |

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

### Color

- Use semantic colors (emerald = positive, red = negative, gold = accent)
- Tooltip always shows numeric values (not just color coding)
- Avoid red-green-only color schemes for color-blind users

### Tooltips & Legends

- All charts include `ChartTooltip` on hover for numeric values
- Legends are keyboard-accessible (tab to focus, arrow keys to navigate)
- Aria labels on SVG elements describe chart purpose

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

## Related Documentation

- [[docs/adr/018-visx-d3-chart-migration|ADR-018: visx/d3 Chart Migration]]
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/008-performance-page-server-computed-response|ADR-008: Performance Page Server-Computed Response]]
- [[docs/components/dashboard|Dashboard Components]]
- [[docs/features/statistics|Statistics Feature]]
- [[docs/features/sankey-flow|Sankey Flow Feature]]
- [[docs/features/portfolio|Portfolio Feature]]
- [[docs/performance/chart-downsampling|Chart Downsampling (LTTB)]]
