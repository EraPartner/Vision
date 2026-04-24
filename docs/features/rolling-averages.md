---
title: Rolling Average Overlays
type: feature
status: active
date: 2026-04-24
tags: [feature, statistics, charts, visualization, analytics, phase-7]
description: Optional 3-month rolling average overlays on MonthlyChart income and spending bars; helps smooth seasonal variation and identify trends; toggle per chart.
aliases: [rolling average, trend overlay, moving average, smoothing]
related_code:
  - apps/frontend/src/utils/rollingAverage.ts
  - apps/frontend/src/components/charts/BarChart.tsx
  - apps/frontend/src/components/statistics/MonthlyChart.tsx
---

# Rolling Average Overlays (Phase 7)

> [!abstract] Overview
> Optional rolling average visualization overlay on the Monthly Chart in the Statistics page. Displays a 3-month moving average as a line overlay on top of the income/spending bar chart to identify trends beneath seasonal noise.

## Feature Overview

The Monthly Chart shows income and spending as bars for each month. Users can toggle a "Rolling Average" overlay to see a 3-month moving average line, which helps:

- **Smooth seasonal variation**: Reduces month-to-month noise
- **Identify trends**: Spot gradual increases or decreases in spending
- **Compare to baseline**: See how current month compares to recent average

## User Interface

### Monthly Chart Toggle

Located in the Statistics page (`/statistics`), Overview tab:

**Components:**

1. **Monthly Chart Card**: Shows income (positive bars) and spending (negative bars) for each month
2. **Rolling Average Toggle**: Button/checkbox to show/hide 3-month rolling average line
3. **Legend**: Indicates rolling average line color and label

### Visual Design

- **Bar chart**: Unchanged; income in green/positive, spending in red/negative
- **Rolling average line**: Distinct color (e.g., accent color), 2-3px width
- **Opacity**: Slightly transparent overlay to show bars beneath

## Algorithm: computeRollingAverage()

**Location:** `apps/frontend/src/utils/rollingAverage.ts`

**Function Signature:**

```typescript
function computeRollingAverage<T>(
  values: (number | null)[] | undefined,
  windowSize: number
): (number | null)[]
```

**Algorithm:**

- **Input**: Array of values (possibly with nulls), window size (default 3)
- **Output**: Array of same length, with first (windowSize - 1) entries as `null`, remaining entries as moving averages
- **Computation**: For each position i >= windowSize, compute average of values[i-windowSize+1...i]
- **Null handling**: Ignores nulls in the window, uses only valid numbers for average

**Example:**

```typescript
const values = [100, 150, 120, 140, 160]
const rolling = computeRollingAverage(values, 3)
// rolling = [null, null, 123.33, 136.67, 140]
// First two entries null (not enough window)
// Entry 2: (100 + 150 + 120) / 3 = 123.33
// Entry 3: (150 + 120 + 140) / 3 = 136.67
// Entry 4: (120 + 140 + 160) / 3 = 140
```

## Implementation: BarChart Overlay

**Location:** `apps/frontend/src/components/charts/BarChart.tsx`

The BarChart component supports an optional overlay:

**Props:**

```typescript
interface BarChartProps<Datum> {
  data: Datum[];
  // ... existing props ...
  overlay?: BarOverlay<Datum>;
}

interface BarOverlay<Datum> {
  label: string;
  color: string;
  valueKey: string; // Key to extract value from Datum
  buildPath: (data: Datum[]) => string; // SVG path generator
}
```

**Implementation:**

- BarChart renders bars as usual
- If `overlay` prop provided, after bars, renders SVG `<path>` with the overlay path
- Path uses M (moveto) and L (lineto) commands, skipping null values with M commands

**Path Building Example:**

```typescript
function buildOverlayPath(data: MonthlyChartDatum[]): string {
  let pathD = '';
  let started = false;
  
  data.forEach((d, i) => {
    if (d.rollingAvg !== null) {
      const x = xScale(i);
      const y = yScale(d.rollingAvg);
      
      if (!started) {
        pathD += `M ${x} ${y}`;
        started = true;
      } else {
        pathD += ` L ${x} ${y}`;
      }
    } else if (started) {
      // Null encountered; restart path on next valid value
      started = false;
    }
  });
  
  return pathD;
}
```

## Frontend: MonthlyChart Component

**Location:** `apps/frontend/src/components/statistics/MonthlyChart.tsx`

**Changes from Phase 6:**

1. Added `showRollingAverage` state via toggle button
2. Compute rolling average for income and spending:
   ```typescript
   const rollingIncome = showRollingAverage
     ? computeRollingAverage(monthlyData.map(m => m.income), 3)
     : null;
   const rollingSpending = showRollingAverage
     ? computeRollingAverage(monthlyData.map(m => m.spending), 3)
     : null;
   ```
3. Pass overlay to BarChart:
   ```typescript
   {showRollingAverage && (
     overlay={{
       label: "3-Month Avg",
       color: "var(--accent)",
       valueKey: "rollingAverage",
       buildPath: (data) => buildOverlayPath(data)
     }}
   )}
   ```

## Data Flow

```
MonthlyChart
  ├── Toggle Button → setShowRollingAverage
  ├── Monthly Data (income, spending per month)
  ├── computeRollingAverage(income, 3) → rollingIncome[]
  ├── computeRollingAverage(spending, 3) → rollingSpending[]
  └── BarChart with overlay
        └── SVG <path> for rolling average line
```

## Performance Considerations

- **Computation**: O(n) single-pass for rolling average
- **Rendering**: One additional SVG `<path>` element when overlay enabled
- **No re-computation**: Rolling average recalculated only when toggle changes or data updates
- **Memoization**: `computeRollingAverage` is pure; can be memoized if needed

## Related Features

- [[docs/features/statistics|Statistics Feature]] — Host page
- [[docs/features/cash-flow-forecast|Cash Flow Forecast]] — Related aggregation

## Related

- [[docs/api/aggregations|Aggregations API]]
- [[docs/features/statistics|Statistics Feature]]
- [[docs/components/charts|Chart Components]]
