---
title: "ADR-041: Saved Charts Schema Extension — Recipients, Variants, Time Config"
type: adr
status: accepted
date: 2026-04-28
tags: [adr, saved-charts, schema, charts, recipients, statistics]
description: Extends the saved_charts table with recipient_ids, chart_variant, time_bucket, and date range columns to support mixed-series charts with multiple rendering variants
---

# ADR-041: Saved Charts Schema Extension — Recipients, Variants, Time Config

## Status

Accepted

## Date

2026-04-28

## Context

The original `saved_charts` table (introduced April 2026) only supported category-based series and a single `chart_type` field. Users requested:

1. Mixing category and recipient series on one chart.
2. Stacked-bar, grouped-bar, and area-stacked rendering variants beyond the three base types.
3. Yearly as well as monthly time buckets.
4. Optional date-range filters per chart.

## Decision

**Schema extension (additive migration `0017`):** Add five columns to `saved_charts` with safe defaults so all existing rows continue working unchanged:

| Column | Type | Default |
|--------|------|---------|
| `recipient_ids` | INTEGER[] | `'{}'` |
| `chart_variant` | TEXT | `'default'` |
| `time_bucket` | TEXT | `'monthly'` |
| `date_range_start` | DATE | NULL |
| `date_range_end` | DATE | NULL |

**Two-field chart type decomposition:** `chart_type` captures the primitive (`line`, `bar`, `area`) and `chart_variant` captures the rendering mode (`default`, `stacked`, `grouped`). The backend rejects three invalid combinations at the route layer with 400: `(line, stacked)`, `(line, grouped)`, `(area, grouped)`.

**Per-chart recipient-pivot hook:** A new `useRecipientPivot(chart)` hook fetches `/api/aggregations/recipient-pivot` only when a chart has `recipient_ids`. It is keyed per `(currency, bucket, start, end)` tuple so different charts that share settings share one cached response. This keeps the global statistics query lean.

**New `/api/aggregations/recipient-pivot` endpoint:** Returns per-recipient spending grouped by period (monthly/yearly), with optional date-range and exclusion filtering. Mirrors the existing `category-pivot` endpoint shape.

**Separate display and builder components:** `CustomChart.tsx` is a read-only display component; `CustomChartBuilderModal.tsx` is the create/edit modal with a live preview column. The existing `CustomCategoryChart.tsx` (used by the tax page) is untouched for backward compatibility.

**Dedicated Statistics tab:** Saved charts move from the above-tabs position into a "Custom Charts" tab. `SavedChartsSection.tsx` is rewritten to own the full tab content including empty state, chart grid, create/edit modal wiring, and delete confirm dialog.

## Consequences

**Positive:**
- Existing `autochart:*` records used by the tax page continue working — `recipient_ids` defaults to empty, `chart_variant` defaults to `'default'`, `time_bucket` defaults to `'monthly'`, no date range = all-time.
- Migration is additive with defaults — safe to roll forward; down-migration drops new columns without data loss for existing rows.
- Six flat chart-variant options presented as one select in the builder prevent invalid combinations from ever reaching the API.
- Recipient pivot query is cached at React Query layer; multiple charts with identical settings share one network request.

**Negative:**
- Chart count per page doubled in complexity (mixed series require unified period merging).
- The `(chart_type, chart_variant)` constraint lives in application code, not the DB; a raw INSERT can bypass it.

**Neutral:**
- `CustomCategoryChart.tsx` remains alongside `CustomChart.tsx` until the tax page is migrated to the new component (logged as follow-up).

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/features/saved-charts|Saved Charts Feature]]
- [[docs/api/savedCharts|Saved Charts API]]

## Addendum (2026-06-11, recipient-pivot query-key narrowing)

**Original decision (above):** `useRecipientPivot` keyed the React Query cache on `(currency, bucket, start, end)` only, so different charts that share those four parameters would share one cached network response containing the full all-recipients pivot. The frontend then filtered the response client-side to the chart's `recipient_ids`.

**Amendment:** The query key now includes `recipient_ids`:

```typescript
queryKey: [
  'aggregations', 'recipient-pivot',
  targetCurrency,
  chart?.time_bucket ?? 'monthly',
  chart?.date_range_start ?? null,
  chart?.date_range_end ?? null,
  chart?.recipient_ids ?? [],   // ← added 2026-06-11
],
```

The API call also passes `recipient_ids` to the backend:

```typescript
queryFn: () => getAggregationRecipientPivot({
  currency: targetCurrency,
  bucket: chart!.time_bucket,
  start: chart!.date_range_start ?? undefined,
  end: chart!.date_range_end ?? undefined,
  recipient_ids: chart!.recipient_ids,   // ← added
}),
```

**Motivation (performance):** The original approach fetched the pivot for *all* recipients and discarded most of the payload. For workspaces with many recipients this was wasteful. With the narrowed request the backend executes:

```sql
SELECT id FROM recipients WHERE id = ANY($1) OR primary_recipient_id = ANY($1)
```

to resolve alias members of the requested recipient IDs, then filters transactions to that resolved set before aggregating. The response payload is proportionally smaller.

**Cache-sharing trade-off:** Two charts that happen to request the same `recipient_ids` set (same elements, same order preserved by `JSON.stringify`) still share one cached response. Charts with different recipient selections get independent cache entries, which is correct — a narrowed payload for chart A must not be served to chart B with different recipients.

**Code:** [[apps/frontend/src/hooks/useRecipientPivot.ts]], [[apps/node-backend/src/routes/aggregations.js]]

## Addendum (2026-06-16, follow-up closed: CustomCategoryChart removed)

The Neutral consequence above noted `CustomCategoryChart.tsx` would remain alongside
`CustomChart.tsx` "until the tax page is migrated." That follow-up is **done**:
`CustomCategoryChart.tsx` no longer exists in the tree (only `CustomChart.tsx` and
`CustomChartBuilderModal.tsx` remain, with zero references to the old component). No coexistence
remains.
