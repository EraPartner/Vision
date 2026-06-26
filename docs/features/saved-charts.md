---
title: Saved Charts Feature
type: feature
status: active
date: 2026-06-26
tags: [feature, saved-charts, charts, customization, statistics, recipients, tags]
description: User-defined custom charts that persist across sessions, supporting mixed category, recipient, and tag series, multiple chart variants, yearly buckets, and date-range filters
aliases: [custom charts, chart presets, saved chart configurations]
related_code:
  - apps/frontend/src/hooks/useSavedCharts.ts
  - apps/frontend/src/hooks/useRecipientPivot.ts
  - apps/frontend/src/hooks/useTagPivot.ts
  - apps/frontend/src/lib/api/aggregations.ts
  - apps/frontend/src/lib/api/types.ts
  - apps/frontend/src/components/statistics/CustomChart.tsx
  - apps/frontend/src/components/statistics/CustomChartBuilderModal.tsx
  - apps/frontend/src/components/statistics/SavedChartsSection.tsx
  - apps/node-backend/src/routes/savedCharts.js
  - apps/node-backend/src/repositories/savedChartsRepository.js
  - apps/node-backend/src/repositories/infoRepositoryTags.js
  - apps/node-backend/src/services/calculations/aggregation/tagPivot.js
  - alembic/versions/0017_saved_charts_recipients_variants.py
  - alembic/versions/0063_saved_charts_tag_ids.py
---

# Saved Charts Feature

## Overview

The Saved Charts feature lets users build, save, and reuse custom charts that can mix category, recipient, and tag series on a single chart. Charts support multiple rendering variants, monthly or yearly time buckets, and optional date-range filters. Saved charts appear in a dedicated "Custom Charts" tab on the Statistics page.

Tags (see [[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052]]) are the third, orthogonal series dimension: selecting one or more tags renders per-tag spending lines sourced from the `GET /api/aggregations/tag-pivot` endpoint. A chart is saveable when it contains any combination of categories, recipients, and/or tags — all three sets may coexist on one chart.

## Data Model

### TypeScript Types

```typescript
type ChartType = 'line' | 'bar' | 'area';
type ChartVariant = 'default' | 'stacked' | 'grouped';
type TimeBucket = 'monthly' | 'yearly';

interface SavedChart {
  id: number;
  name: string;
  chart_type: ChartType;
  chart_variant: ChartVariant;
  time_bucket: TimeBucket;
  category_ids: number[];
  recipient_ids: number[];
  tag_ids: number[];
  date_range_start: string | null;
  date_range_end: string | null;
  created_at: string;
  updated_at: string;
}

interface SavedChartCreate {
  name: string;
  chartType: ChartType;
  chartVariant?: ChartVariant;
  timeBucket?: TimeBucket;
  categoryIds: number[];
  recipientIds?: number[];
  tagIds?: number[];
  dateRangeStart?: string | null;
  dateRangeEnd?: string | null;
}
```

### Database Table: `saved_charts`

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | SERIAL | — | Primary key |
| `name` | VARCHAR | — | User-defined chart name |
| `chart_type` | VARCHAR | `'line'` | `'line'`, `'bar'`, or `'area'` |
| `chart_variant` | VARCHAR | `'default'` | `'default'`, `'stacked'`, or `'grouped'` |
| `time_bucket` | VARCHAR | `'monthly'` | `'monthly'` or `'yearly'` |
| `category_ids` | INTEGER[] | `'{}'` | Category IDs to include as series |
| `recipient_ids` | INTEGER[] | `'{}'` | Recipient IDs to include as series |
| `tag_ids` | INTEGER[] | `'{}'` | Tag IDs to include as series |
| `date_range_start` | DATE | NULL | Filter periods from this date (inclusive) |
| `date_range_end` | DATE | NULL | Filter periods to this date (inclusive) |
| `created_at` | TIMESTAMP | — | Creation timestamp |
| `updated_at` | TIMESTAMP | — | Last update timestamp |

Migrations: `alembic/versions/0017_saved_charts_recipients_variants.py` (categories + recipients, safe defaults) · `alembic/versions/0063_saved_charts_tag_ids.py` (`tag_ids INTEGER[] NOT NULL DEFAULT '{}'`, additive).

### Valid (chart_type, chart_variant) Combinations

| chart_type | chart_variant | Valid |
|------------|---------------|-------|
| `line` | `default` | ✓ |
| `line` | `stacked` | ✗ — rejected 400 |
| `line` | `grouped` | ✗ — rejected 400 |
| `bar` | `default` | ✓ |
| `bar` | `stacked` | ✓ — StackedBarChart |
| `bar` | `grouped` | ✓ — BarChart multi-series |
| `area` | `default` | ✓ |
| `area` | `stacked` | ✓ — AreaChart stacked mode |
| `area` | `grouped` | ✗ — rejected 400 |

## API Endpoints

### GET /api/saved-charts
### POST /api/saved-charts
### PATCH /api/saved-charts/:id
### DELETE /api/saved-charts/:id

See [[docs/api/savedCharts]] for full contracts.

### GET /api/aggregations/recipient-pivot

Per-recipient spending keyed by period, used by `useRecipientPivot` to power recipient series in custom charts. Accepts `?bucket=monthly|yearly&start=YYYY-MM-DD&end=YYYY-MM-DD&excluded_recipient_ids=…`.

### GET /api/aggregations/tag-pivot

Per-tag spending keyed by period, used by `useTagPivot` to power tag series in custom charts. Requires `tag_ids` (repeatable int); an empty selection returns an empty pivot. Same spending lens as recipient-pivot: expenses only, `is_active = true`, internal transfers always excluded. Per-date historical FX conversion applied.

> [!warning] Multi-tag overlap
> A transaction that carries several of the selected tags contributes to **each** of those tags' totals independently (OR semantics, same as the transaction-list tag filter). Per-tag lines can therefore legitimately overlap and their sum may exceed total spending for the period.

See [[docs/api/aggregations|Aggregations API]] for the full `tag-pivot` contract.

## Frontend Hooks

| Hook | Purpose |
|------|---------|
| `useSavedCharts()` | Fetches all saved charts (query key `['saved-charts']`) |
| `useCreateSavedChart()` | Creates chart, invalidates cache |
| `useUpdateSavedChart()` | Updates chart by ID |
| `useDeleteSavedChart()` | Deletes chart by ID |
| `useRecipientPivot(chart)` | Per-chart hook; enabled only when `recipient_ids.length > 0`; keyed on `(currency, bucket, start, end)` |
| `useTagPivot(chart)` | Per-chart hook; enabled only when `tag_ids.length > 0`; mirrors `useRecipientPivot`; calls `GET /api/aggregations/tag-pivot` |

## Rendering

### CustomChart (read-only display)

`apps/frontend/src/components/statistics/CustomChart.tsx` — pure display component:

1. Calls `useRecipientPivot(savedChart)` for recipient data and `useTagPivot(savedChart)` for tag data.
2. Collects all periods from category pivot, recipient pivot, and tag pivot; applies `date_range_start`/`date_range_end` filter.
3. Builds unified `ChartDatum[]` where `values` is keyed as `cat:<id>`, `rec:<id>`, or `tag:<id>`. Tag series legend labels are rendered as `#<slug>`.
4. Renders the correct chart primitive:
   - `bar` + `stacked` → `StackedBarChart`
   - `bar` + `default`/`grouped` → `BarChart` (multi-series = grouped)
   - `area` + `stacked` → `AreaChart` with `stacked={true}`
   - `area` + `default` → `AreaChart`
   - `line` → `LineChart`
5. Period labels honor `time_bucket`: yearly → "2026", monthly → "Apr 26".
6. Shows edit/delete button row when `onEdit`/`onDelete` callbacks provided.

### Builder Modal

`apps/frontend/src/components/statistics/CustomChartBuilderModal.tsx` — Dialog with two-column layout:

- **Left column**: name field, chart-type combo select (6 flat options → `chart_type`+`chart_variant` pair), time-bucket toggle, date-range pickers, category multi-select (Popover+Command), recipient multi-select, tags multi-select picker.
- **Right column**: live `<CustomChart>` preview updated as state changes.
- **Modes**: create (default values) and edit (initial values from existing `SavedChart`).
- **Save**: calls `useCreateSavedChart` or `useUpdateSavedChart`; closes modal on success. A chart is saveable when at least one of categories, recipients, or tags is selected.

### SavedChartsSection (tab content)

`apps/frontend/src/components/statistics/SavedChartsSection.tsx` — full tab content:

- Header: section title + "New chart" button.
- Empty state: illustration + description + "Create your first chart" CTA when no charts.
- Chart grid: `grid-cols-1 lg:grid-cols-2` layout; each card is a `CustomChart` with edit/delete callbacks.
- Delete confirm: `AlertDialog` pattern (shadcn).
- Filters out `autochart:*` name-prefixed charts (tax-page internal records).

### Tax Page Compatibility

`CustomCategoryChart.tsx` (tax-page component with `persistSelection` mode) is unchanged. It creates hidden `autochart:<graphKey>` DB records. The new `CustomChart.tsx` is a separate component. `SavedChartsSection` filters out `autochart:*` entries so they never appear in the Custom Charts tab.

## Statistics Page Integration

The "Custom Charts" tab is the sixth tab in `StatisticsPage.tsx` (`value="custom"`). The `<Suspense>`-wrapped `<SavedChartsSection data={data} />` renders inside `TabsContent value="custom"`. The section previously rendered above the tabs strip has been removed.

## Query Configuration

- **saved-charts query key**: `['saved-charts']`
- **recipient-pivot query key**: `['aggregations', 'recipient-pivot', currency, bucket, start, end]`
- **tag-pivot query key**: `['aggregations', 'tag-pivot', currency, bucket, start, end, ...tagIds]`
- **Stale time**: 60 seconds for all three
- **Invalidation**: All CRUD mutations invalidate `['saved-charts']`

## Related Features

- [[docs/features/statistics|Statistics]] — Saved charts tab within the Statistics page
- [[docs/features/transactions|Categories]] — Category IDs referenced in charts
- [[docs/features/tags|Transaction Tags]] — Tags as a third series dimension in custom charts
- [[docs/api/aggregations|Aggregations API]] — `tag-pivot` and `recipient-pivot` endpoint contracts
- [[docs/adr/041-saved-charts-schema-extension|ADR-041]] — Schema extension decision record
- [[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052]] — Tags architecture rationale
