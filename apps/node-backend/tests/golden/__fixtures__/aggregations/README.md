# Aggregation Golden Fixtures

Fixture slot per aggregate that feeds Dashboard / Statistics. Each `<aggregate>/<variant>.input.json` pair lands as the matching `services/calculations/aggregation/<aggregate>.js` module is built in Phases 2–6.

> Phase 1 lands the infrastructure (migration 0026 + orchestrator + harness). Inputs/expected for these fixtures are authored alongside the calc module that consumes them — authoring them before the module exists would hard-code today's `infoRepository` behaviour and defeat the point.

## Aggregates

| Slug | Source module (Phase) | Feeds |
|------|-----------------------|-------|
| `monthly-summary` | `services/calculations/aggregation/monthly.js` (Phase 2) | Dashboard monthly chart, Statistics yearly totals |
| `category-breakdown` | `services/calculations/aggregation/category.js` (Phase 2) | Dashboard category donut, Statistics category panel |
| `recipient-insights` | `services/calculations/aggregation/recipient.js` (Phase 2) | Recipients page, top-recipient widgets |
| `cashflow-comparison` | `services/calculations/aggregation/cashflow.js` (Phase 2) | Dashboard cashflow strip |
| `average-vs-current` | `services/calculations/aggregation/averageVsCurrent.js` (Phase 2) | Dashboard trend widget |
| `owed-summary` | `services/calculations/aggregation/splits.js` (Phase 4) | OwesPage, dashboard balance |

## Variant matrix (per aggregate)

Each aggregate fixture must cover the full matrix to satisfy the Phase 8 correctness pass:

- `empty` — no transactions / splits in range
- `single-currency` — one currency throughout
- `multi-currency` — at least two currencies, exercises conversion boundary
- `with-exclusions` — excluded categories / recipients filtered out
- `without-exclusions` — same dataset, no filters (round-trip check)
- `month-boundary` — transactions on the first and last day of a month
- `year-boundary` — Dec/Jan spanning the fiscal boundary
- `leap-day` — Feb 29 handling
- `dst-transition` — spring-forward and fall-back timestamps in `APP_TIMEZONE`

## Authoring

1. Create `<aggregate>/<variant>.input.json` with the curated input set.
2. Write the vitest spec invoking `runGolden('aggregations/<aggregate>/<variant>', fn)`.
3. Run with `UPDATE_GOLDENS=1` to materialise the first `expected.json`.
4. Commit both files together; never update `expected.json` by hand after the initial capture — every subsequent change must go through an ADR note explaining the re-baseline.

## DB-backed fixtures

When a fixture needs a real Postgres instance (trigger-maintained aggregates), gate the spec on `hasTestDatabase()` from `tests/setup/db.js` and load a per-test transaction that rolls back in `afterEach`. See `tests/services/aggregationRefresh.test.js` for the skip-if pattern.
