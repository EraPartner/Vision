---
title: "ADR-106: Saved Charts — Ranked Bar Variant and Dynamic All-Source Flags"
type: adr
status: Accepted
date: 2026-06-26
tags: [adr, saved-charts, charts, ranked, all-sources, top-n, statistics, frontend, backend]
description: Records the addition of a ranked horizontal-bar chart variant (chart_variant=ranked) and three dynamic all-source boolean flags (all_categories, all_recipients, all_tags) to the saved-charts schema, including the client-side top-N=8 + Other capping strategy.
aliases: [adr-106, ranked-chart-adr, all-source-flags-adr]
---

# ADR-106: Saved Charts — Ranked Bar Variant and Dynamic All-Source Flags

## Status

Accepted

## Date

2026-06-26

## Context

The saved-charts feature ([[docs/adr/041-saved-charts-schema-extension|ADR-041]]) supports multi-series time-bucketed charts over a user-selected list of categories, recipients, and tags ([[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052]]). Two usability gaps emerged:

1. **No ranking view.** Users wanted a "Most Spent Recipients" style view — a horizontal bar chart sorted by total spend over the date range — without having to pick individual entities up front. The existing `bar:default`/`bar:stacked`/`bar:grouped` variants all require a time axis and render per-period data. There was no way to express "show me all time, sorted by total" in a single chart.

2. **Stale explicit ID lists.** When a user selects a fixed list of tags, recipients, or categories and a new entity is created later (e.g., a new trip tag), that entity is silently absent from the chart. Users had to remember to edit each chart. The only alternatives were a dynamic sentinel in the id arrays (fragile, breaks empty-means-none semantics) or a global "all" scalar that conflates the three dimensions.

## Decision

### 1. Ranked bar variant (`chart_variant: 'ranked'`)

A new value `'ranked'` is added to the `chart_variant` enum (valid values are now `default`, `stacked`, `grouped`, `ranked`). Constraints:

- `ranked` is only valid with `chart_type = 'bar'`. The combinations `line:ranked` and `area:ranked` are rejected with HTTP 400.
- When `ranked` is active, `time_bucket` is ignored by the rendering layer. The endpoint is still called with the chart's date filters, but the frontend aggregates all periods into a single per-entity total and renders a horizontal bar chart sorted high→low by that total.
- No new DB column is required — `chart_variant` is an existing VARCHAR column (`alembic/versions/0017_saved_charts_recipients_variants.py`).

This reuses the existing `chart_variant` discriminator rather than introducing a separate `is_ranked` boolean, keeping the combination-validation table as the single source of truth.

### 2. Dynamic all-source flags (`all_categories`, `all_recipients`, `all_tags`)

Three boolean columns are added to `saved_charts` (migration `0064_saved_charts_all_source_flags.py`, `down_revision: 0063_saved_charts_tag_ids`):

```sql
all_categories  BOOLEAN NOT NULL DEFAULT false
all_recipients  BOOLEAN NOT NULL DEFAULT false
all_tags        BOOLEAN NOT NULL DEFAULT false
```

When a flag is `true`:
- The corresponding `*_ids` column is **ignored** at fetch time (not cleared in the DB — the prior manual selection is preserved so toggling the flag off restores the previous list).
- The backend returns every entity of that dimension. For tags, this required a new `all=true` query param on `GET /api/aggregations/tag-pivot` (alias `all_tags=true`); when set, `getTagPivot` drops the tag-id filter and skips the short-circuit that returned an empty result for an empty id list. Recipients already returned all recipients when no `recipient_ids` were provided — no backend change needed.

A per-dimension orthogonal boolean was chosen over alternatives:
- **Sentinel in id arrays** (e.g., `[-1]` = "all"): rejected — breaks the invariant that an empty array means "none selected"; would require callers to special-case the sentinel.
- **Single `all_sources` boolean**: rejected — the three dimensions are independently useful (e.g., all tags + specific recipients); a single flag cannot express partial "all".
- **Separate `source_mode` enum per dimension** (`ids | all`): considered but unnecessary complexity; a boolean is sufficient since `all` is the only alternative to explicit ids.

### 3. Client-side top-N=8 + "Other" capping

When any all-source flag is true, the entity count can be large (hundreds of recipients, dozens of tags). Rendering all of them produces an unreadable chart. The cap is applied in `CustomChart.tsx`:

- Constant `TOP_N = 8`.
- After receiving API data, entities are ranked by their total spend across the chart's date range. The top 8 are kept as individual series. The remaining entities' values are summed into a single synthetic **"Other"** series/bar.
- The cap is client-side only — the API always returns full data; the frontend chooses how much to display. This keeps the backend simple and allows future UI controls to adjust `TOP_N` without an API change.
- In ranked mode the "Other" bar appears as the last bar (lowest, since entities are sorted high→low and Others' combined total may not be smallest).

## Consequences

**Positive:**
- Ranked bar charts cover the "which recipient/tag/category costs most overall?" use case without per-period data.
- Dynamic all-source flags make charts self-updating as new entities are created — no manual chart maintenance required.
- Orthogonal per-dimension flags give precise control; a chart can say "all tags but only these 3 recipients."
- Additive migrations (both `0063` and `0064` use safe defaults) — no data loss, no backfill required.

**Negative / trade-offs:**
- The combination-validity table grows (2 more invalid combos: `line:ranked`, `area:ranked`). Developers adding new `chart_type` values must also enumerate valid/invalid combos for `ranked`.
- Top-N=8 is a hardcoded constant. Charts with many entities silently drop the tail into "Other"; users cannot currently control `TOP_N` per chart.
- `time_bucket` is stored in the DB even for ranked charts (it is simply ignored at render time). A stricter model would reject non-null `time_bucket` on ranked charts — deferred to avoid breaking existing rows if `ranked` charts are later changed to also support bucketed views.

## Related

- [[docs/adr/041-saved-charts-schema-extension|ADR-041]] — Original saved-charts schema (categories + recipients + variants)
- [[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052]] — Tags as orthogonal chart dimension (tag_ids added)
- [[docs/features/saved-charts|Saved Charts Feature]] — Full feature specification
- [[docs/api/savedCharts|Saved Charts API]] — REST contract
- [[docs/api/aggregations|Aggregations API]] — tag-pivot `all` param
- [[docs/adr/index|All ADRs]]
