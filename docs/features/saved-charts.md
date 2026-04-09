---
title: Saved Charts Feature
type: feature
status: active
date: 2026-04-09
tags: [feature, saved-charts, charts, customization, statistics]
description: User-defined custom category charts that persist across sessions and render within the Statistics page
aliases: [custom charts, chart presets, saved chart configurations]
related_code:
  - apps/frontend/src/hooks/useSavedCharts.ts
  - apps/frontend/src/components/statistics/CustomCategoryChart.tsx
  - apps/node-backend/src/routes/savedCharts.js
  - apps/node-backend/src/repositories/savedChartsRepository.js
---

# Saved Charts Feature

## Overview

The Saved Charts feature allows users to create, save, and reuse custom category-based line/bar/area charts. Saved charts appear on the Statistics page alongside the built-in widgets, each with its own per-graph exclusion toggle.

## Data Model

### TypeScript Types

```typescript
interface SavedChart {
  id: number;
  name: string;
  chart_type: 'line' | 'bar' | 'area';
  category_ids: number[];
  created_at: string;
  updated_at: string;
}

interface SavedChartCreate {
  name: string;
  chartType: 'line' | 'bar' | 'area';
  categoryIds: number[];
}
```

### Database Table: `saved_charts`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Primary key |
| `name` | VARCHAR | User-defined chart name |
| `chart_type` | VARCHAR | 'line', 'bar', or 'area' |
| `category_ids` | INTEGER[] | Array of category IDs to display |
| `created_at` | TIMESTAMP | Creation timestamp |
| `updated_at` | TIMESTAMP | Last update timestamp |

## API Endpoints

### GET /api/saved-charts

Returns all saved charts for the current workspace.

### POST /api/saved-charts

Creates a new saved chart.

**Request body:**
```json
{
  "name": "My Custom Chart",
  "chartType": "line",
  "categoryIds": [1, 5, 12]
}
```

### PATCH /api/saved-charts/:id

Updates an existing saved chart.

### DELETE /api/saved-charts/:id

Deletes a saved chart.

Implementation note:
- Backend route refactor extracted shared id parsing and payload validation helpers (`parseChartIdParam`, `validateChartType`, `validateCategoryIds`) to remove duplication while keeping route contracts unchanged ([[apps/node-backend/src/routes/savedCharts.js]]).

## Frontend Hooks

Located in `[[apps/frontend/src/hooks/useSavedCharts.ts]]`:

| Hook | Purpose |
|------|---------|
| `useSavedCharts()` | Fetches all saved charts (query key: `['saved-charts']`) |
| `useCreateSavedChart()` | Creates a new chart, invalidates cache on success |
| `useUpdateSavedChart()` | Updates a chart by ID |
| `useDeleteSavedChart()` | Deletes a chart by ID |

All mutations show toast notifications for success/failure and invalidate the `['saved-charts']` query cache.

## Rendering

Saved charts are rendered within the Statistics page via the `SavedChartsSection` component:

```typescript
{savedCharts.map((chart) => (
  <CustomCategoryChart
    key={chart.id}
    data={getGraphData(`savedChart_${chart.id}`) || data}
    graphKey={`savedChart_${chart.id}`}
    isFiltered={graphExclusions[`savedChart_${chart.id}`] ?? true}
    onToggle={toggleGraphExclusion}
    exclusionsApply={exclusionsApply}
    savedChart={chart}
  />
))}
```

Each saved chart:
- Gets a unique graph key (`savedChart_${id}`)
- Has independent exclusion toggle support
- Renders as a `CustomCategoryChart` component
- Appears below the built-in Statistics widgets

## Query Configuration

- **Query key**: `['saved-charts']`
- **Stale time**: 60 seconds
- **Invalidation**: Triggered by all CRUD mutations

## Related Features

- [[docs/features/statistics|Statistics]] — Saved charts render within the Statistics page
- [[docs/features/transactions|Categories]] — Charts are built from category selections
