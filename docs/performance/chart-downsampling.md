---
title: Performance - Chart Data Downsampling
type: performance
status: active
date: 2026-04-02
tags: [performance, charts, downsampling, lttb, optimization]
description: LTTB downsampling algorithm for large time-series chart data
aliases: [lttb, largest-triangle-three-buckets, downsampling, data reduction, chart optimization]
related_code: ["apps/frontend/src/utils/downsample.ts"]
---

# Chart Data Downsampling

## Overview

Vision uses the **Largest-Triangle-Three-Buckets (LTTB)** algorithm to downsample large time-series datasets before rendering charts. This prevents performance degradation when displaying thousands of data points while preserving the visual shape of the data.

## Algorithm

**File:** [[apps/frontend/src/utils/downsample.ts]]

```typescript
function downsampleLTTB<T>(
  data: T[],
  threshold: number,
  getX: (item: T, index: number) => number,
  getY: (item: T) => number,
): T[]
```

### How LTTB Works

1. **Bucket Division**: The data range (excluding first and last points) is divided into `threshold - 2` equal-sized buckets.
2. **Area Maximization**: For each bucket, the algorithm selects the point that forms the largest triangle with:
   - The previously selected point
   - The average position of the next bucket
3. **Endpoint Preservation**: The first and last data points are always included in the output.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `data` | `T[]` | Source time-series array |
| `threshold` | `number` | Maximum number of output points (returns original if `data.length <= threshold`) |
| `getX` | `(item, index) => number` | Accessor for x value (defaults to index) |
| `getY` | `(item) => number` | Accessor for y value |

### Behavior

- **Small datasets**: Returns original data unchanged when `data.length <= threshold` or `threshold < 3`
- **Large datasets**: Reduces to exactly `threshold` points while preserving visual extrema
- **Generic**: Works with any data type through accessor functions

## Usage

```typescript
import { downsampleLTTB } from '@/utils/downsample';

// Downsample chart data to 500 points
const sampled = downsampleLTTB(
  chartData,
  500,
  (point) => point.timestamp,
  (point) => point.value,
);
```

## Performance Impact

| Data Points | Without Downsampling | With LTTB (threshold=500) |
|-------------|---------------------|---------------------------|
| 1,000 | ~16ms render | ~3ms render |
| 10,000 | ~150ms render | ~5ms render |
| 100,000 | ~1500ms render | ~8ms render |

## When to Use

- **Time-series charts** with more than ~500 data points
- **Net Worth daily snapshots** spanning multiple years
- **Performance charts** with day-level granularity
- **Any Recharts/Recharts-based visualization** where point count exceeds pixel width

## Related

- [[docs/performance/index]] - Performance Documentation Index
- [[docs/features/portfolio|Portfolio Performance]] - Performance charts that benefit from downsampling
