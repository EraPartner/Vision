---
title: Saved Charts Feature
type: feature
status: active
date: 2026-06-26
tags: [feature, saved-charts, charts, customization, statistics, recipients, tags, ranked-chart, all-sources]
description: User-defined custom charts that persist across sessions, supporting mixed category, recipient, and tag series, multiple chart variants (including ranked bar), dynamic all-source flags with top-N capping, yearly buckets, and date-range filters
aliases: [custom charts, chart presets, saved chart configurations]
related_code:
  - apps/frontend/src/hooks/useSavedCharts.ts
  - apps/frontend/src/hooks/useRecipientPivot.ts
  - apps/frontend/src/hooks/useTagPivot.ts
  - apps/frontend/src/lib/api/aggregations.ts
  - apps/frontend/src/lib/api/types.ts
  - apps/frontend/src/features/statistics/CustomChart.tsx
  - apps/frontend/src/features/statistics/CustomChartBuilderModal.tsx
  - apps/frontend/src/features/statistics/SavedChartsSection.tsx
  - apps/node-backend/src/routes/savedCharts.js
  - apps/node-backend/src/repositories/savedChartsRepository.js
  - apps/node-backend/src/repositories/infoRepositoryTags.js
  - apps/node-backend/src/services/calculations/aggregation/tagPivot.js
  - alembic/versions/0017_saved_charts_recipients_variants.py
  - alembic/versions/0063_saved_charts_tag_ids.py
  - alembic/versions/0064_saved_charts_all_source_flags.py
updated: 2026-08-26
---

# Saved Charts Feature

## Overview

The Saved Charts feature lets users build, save, and reuse custom charts that can mix category, recipient, and tag series on a single chart. Charts support multiple rendering variants, monthly or yearly time buckets, and optional date-range filters. Saved charts appear in a dedicated "Custom Charts" tab on the Statistics page.

Tags (see [[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052]]) are the third, orthogonal series dimension: selecting one or more tags renders per-tag spending lines sourced from the `GET /api/aggregations/tag-pivot` endpoint. A chart is saveable when it contains any combination of categories, recipients, and/or tags — all three sets may coexist on one chart.

## Data Model

### TypeScript Types

```typescript
type ChartType = 'line' | 'bar' | 'area';
type ChartVariant = 'default' | 'stacked' | 'grouped' | 'ranked';
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
  all_categories: boolean;
  all_recipients: boolean;
  all_tags: boolean;
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
  allCategories?: boolean;
  allRecipients?: boolean;
  allTags?: boolean;
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
| `chart_variant` | VARCHAR | `'default'` | `'default'`, `'stacked'`, `'grouped'`, or `'ranked'` |
| `time_bucket` | VARCHAR | `'monthly'` | `'monthly'` or `'yearly'` (ignored when `chart_variant = 'ranked'`) |
| `category_ids` | INTEGER[] | `'{}'` | Category IDs to include as series (ignored when `all_categories = true`) |
| `recipient_ids` | INTEGER[] | `'{}'` | Recipient IDs to include as series (ignored when `all_recipients = true`) |
| `tag_ids` | INTEGER[] | `'{}'` | Tag IDs to include as series (ignored when `all_tags = true`) |
| `all_categories` | BOOLEAN | `false` | When `true`, chart all categories dynamically (ignores `category_ids`) |
| `all_recipients` | BOOLEAN | `false` | When `true`, chart all recipients dynamically (ignores `recipient_ids`) |
| `all_tags` | BOOLEAN | `false` | When `true`, chart all tags dynamically (ignores `tag_ids`) |
| `date_range_start` | DATE | NULL | Filter periods from this date (inclusive) |
| `date_range_end` | DATE | NULL | Filter periods to this date (inclusive) |
| `created_at` | TIMESTAMP | — | Creation timestamp |
| `updated_at` | TIMESTAMP | — | Last update timestamp |

Migrations: `alembic/versions/0017_saved_charts_recipients_variants.py` (categories + recipients, safe defaults) · `alembic/versions/0063_saved_charts_tag_ids.py` (`tag_ids INTEGER[] NOT NULL DEFAULT '{}'`, additive) · `alembic/versions/0064_saved_charts_all_source_flags.py` (`all_categories`, `all_recipients`, `all_tags BOOLEAN NOT NULL DEFAULT false`, additive).

### Valid (chart_type, chart_variant) Combinations

| chart_type | chart_variant | Valid |
|------------|---------------|-------|
| `line` | `default` | ✓ |
| `line` | `stacked` | ✗ — rejected 400 |
| `line` | `grouped` | ✗ — rejected 400 |
| `line` | `ranked` | ✗ — rejected 400 |
| `bar` | `default` | ✓ |
| `bar` | `stacked` | ✓ — StackedBarChart |
| `bar` | `grouped` | ✓ — BarChart multi-series |
| `bar` | `ranked` | ✓ — horizontal bar per entity, sorted high→low by total spend |
| `area` | `default` | ✓ |
| `area` | `stacked` | ✓ — AreaChart stacked mode |
| `area` | `grouped` | ✗ — rejected 400 |
| `area` | `ranked` | ✗ — rejected 400 |

## API Endpoints

### GET /api/saved-charts
### POST /api/saved-charts
### PATCH /api/saved-charts/:id
### DELETE /api/saved-charts/:id

See [[docs/api/savedCharts]] for full contracts.

### GET /api/aggregations/recipient-pivot

Per-recipient spending keyed by period, used by `useRecipientPivot` to power recipient series in custom charts. Accepts `?bucket=monthly|yearly&start=YYYY-MM-DD&end=YYYY-MM-DD&excluded_recipient_ids=…`.

### GET /api/aggregations/tag-pivot

Per-tag spending keyed by period, used by `useTagPivot` to power tag series in custom charts. Requires explicit `tag_ids` (repeatable int) **unless** the `all=true` (alias `all_tags=true`) parameter is passed, in which case every active tag in the workspace is returned. Same spending lens as recipient-pivot: expenses only, `is_active = true`, internal transfers always excluded. Per-date historical FX conversion applied.

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
| `useRecipientPivot(chart)` | Per-chart hook; enabled when `recipient_ids.length > 0` **or** `all_recipients = true`; when all-flag is set, calls API with no recipient filter and skips client-side id filtering; cache key includes `'all'` token when all-flag is active |
| `useTagPivot(chart)` | Per-chart hook; enabled when `tag_ids.length > 0` **or** `all_tags = true`; when all-flag is set, calls `GET /api/aggregations/tag-pivot?all=true` and skips client-side id filtering; cache key includes `'all'` token |

## Rendering

### CustomChart (read-only display)

`apps/frontend/src/features/statistics/CustomChart.tsx` — pure display component:

1. Calls `useRecipientPivot(savedChart)` for recipient data and `useTagPivot(savedChart)` for tag data.
2. Runs a unified entity pipeline:
   - When any `all_*` source flag is set, collects all returned entities of that dimension.
   - When `all_categories`, `all_recipients`, or `all_tags` is true and the total entity count exceeds `TOP_N = 8`, the long tail is capped: the top 8 entities by total spend are kept as individual series; the remaining entities are summed into a single **"Other"** series/bar. This cap is applied client-side after API data is received.
3. Collects all periods from category pivot, recipient pivot, and tag pivot; applies `date_range_start`/`date_range_end` filter.
4. Builds unified `ChartDatum[]` where `values` is keyed as `cat:<id>`, `rec:<id>`, or `tag:<id>`. Tag series legend labels are rendered as `#<slug>`.
5. Renders the correct chart primitive:
   - `bar` + `stacked` → `StackedBarChart`
   - `bar` + `default`/`grouped` → `BarChart` (multi-series = grouped)
   - `bar` + `ranked` → horizontal bar chart, one bar per entity, sorted descending by total spend over the chart's date range; `time_bucket` is ignored (whole range aggregated)
   - `area` + `stacked` → `AreaChart` with `stacked={true}`
   - `area` + `default` → `AreaChart`
   - `line` → `LineChart`
6. Period labels honor `time_bucket`: yearly → "2026", monthly → "Apr 26". (Not shown for ranked charts.)
7. Shows edit/delete button row when `onEdit`/`onDelete` callbacks provided.

> [!info] Ranked variant behaviour
> `chart_variant: 'ranked'` aggregates the **entire** date range into a single total per entity. It ignores `time_bucket` and does not render a time axis. Invalid combinations `line:ranked` and `area:ranked` are rejected by the backend with 400.

### Builder Modal

`apps/frontend/src/features/statistics/CustomChartBuilderModal.tsx` — Dialog with two-column layout:

- **Left column**: name field, chart-type combo select (now includes a **"Bar (Ranked)"** option in addition to the original 6, mapping to `chart_type='bar'` + `chart_variant='ranked'`); time-bucket toggle (hidden when ranked is selected); date-range pickers; per-dimension pickers with an **"All …"** toggle (Switch) per dimension:
  - When the "All" toggle is on for a dimension, the matching `*_ids` manual picker is disabled and the `all_*` flag is sent to the backend.
  - The manual picker remains fully functional when the toggle is off.
- **Right column**: live `<CustomChart>` preview updated as state changes.
- **Modes**: create (default values) and edit (initial values from existing `SavedChart`).
- **Save**: calls `useCreateSavedChart` or `useUpdateSavedChart`; closes modal on success. A chart is saveable when at least one dimension has either a non-empty id list or its all-flag set to `true`.

### SavedChartsSection (tab content)

`apps/frontend/src/features/statistics/SavedChartsSection.tsx` — full tab content:

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
- **recipient-pivot query key**: `['aggregations', 'recipient-pivot', currency, bucket, start, end]` — when `all_recipients = true`, the key includes the token `'all'` in place of individual ids
- **tag-pivot query key**: `['aggregations', 'tag-pivot', currency, bucket, start, end, ...tagIds]` — when `all_tags = true`, the key includes the token `'all'` instead of individual tag ids
- **Stale time**: 60 seconds for all three
- **Invalidation**: All CRUD mutations invalidate `['saved-charts']`

## Related Features

- [[docs/features/statistics|Statistics]] — Saved charts tab within the Statistics page
- [[docs/features/transactions|Categories]] — Category IDs referenced in charts
- [[docs/features/tags|Transaction Tags]] — Tags as a third series dimension in custom charts
- [[docs/api/aggregations|Aggregations API]] — `tag-pivot` and `recipient-pivot` endpoint contracts
- [[docs/api/savedCharts|Saved Charts API]] — Full REST contract for saved chart CRUD
- [[docs/adr/041-saved-charts-schema-extension|ADR-041]] — Schema extension decision record
- [[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052]] — Tags architecture rationale
- [[docs/adr/106-saved-charts-ranked-variant-and-all-source-flags|ADR-106]] — Ranked variant and dynamic all-source flags decision record
