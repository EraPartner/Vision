---
title: Performance - Chart Data Downsampling
type: performance
status: removed
date: 2026-04-16
tags: [performance, charts, downsampling, lttb, optimization, historical]
description: LTTB downsampling algorithm for large time-series chart data (removed 2026-07)
aliases: [lttb, largest-triangle-three-buckets, downsampling, data reduction, chart optimization]
related_code: []
---

# Chart Data Downsampling

> **Status: REMOVED (2026-07).** LTTB downsampling is no longer used anywhere in
> Vision. It was removed from **both** the frontend (the `utils/downsample.ts`
> re-export was deleted; Net Worth and Performance charts render full daily
> resolution deliberately, so scrubbing stays day-granular) and the
> **backend** `/api/info/portfolio-performance` path (see
> `apps/node-backend/src/routes/info/_performanceHelpers.js` — at daily
> granularity even ~10 years (~3.6k points) renders fine at full resolution, and
> removing the shared downsampler also closed a correctness bug). This page is
> retained only as a historical description of the algorithm; do not treat it as
> a live code reference.

## Overview

Vision **previously** used the **Largest-Triangle-Three-Buckets (LTTB)** algorithm to downsample large time-series datasets before rendering charts, to avoid performance degradation when displaying thousands of data points while preserving the visual shape of the data. It has since been removed (see the status note above) — daily-granularity series render acceptably at full resolution.

## Algorithm

**Frontend:** [[apps/frontend/src/utils/downsample.ts]]
**Backend (ported):** [[apps/node-backend/src/utils/downsample.js]]

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
- **Backend responses** to reduce API payload before transmission (e.g., `/api/info/portfolio-performance`)

## Backend Usage (historical — removed)

Between 2026-04-16 and 2026-07, the Performance page (`/api/info/portfolio-performance`)
used server-side LTTB to downsample period-filtered snapshots to ~400 points
before response. **This has been removed** — at daily granularity even ~10 years
(~3.6k points) renders fine at full resolution, and dropping the shared
downsampler also closed a correctness bug (see
`apps/node-backend/src/routes/info/_performanceHelpers.js`). Metrics and heatmap
always used full historical data regardless.

See [[docs/adr/008-performance-page-server-computed-response|ADR-008]] for the
architectural rationale of the (server-computed) Performance response.

## Related

- [[docs/performance/index]] - Performance Documentation Index
- [[docs/features/portfolio|Portfolio Performance]] - Performance charts that benefit from downsampling
- [[docs/adr/008-performance-page-server-computed-response|ADR-008: Performance Page Server-Computed Response]] - Backend downsampling implementation
