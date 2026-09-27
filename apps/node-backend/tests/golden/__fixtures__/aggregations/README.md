# Historical Aggregation Golden Fixture Plan

Reviewed on 2026-09-26. This directory contains this plan only: no aggregation
`.input.json` or `.expected.json` fixtures were implemented here. The six
aggregates and nine variants below describe the former Phase 1 plan, not 54
existing tests or a current acceptance gate.

Current coverage is listed in [the calculation inventory](../../INVENTORY.md).
The production-connected properties exercise `buildMonthlySummary` and
`buildCategoryFromConvertedRows` in `infoRepositoryHelpers.js` with integer-cent
oracles. They cover already aggregated/converted row totals, not SQL grouping,
exclusions, FX lookup, or monthly/yearly SQL parity.

[Monthly repository database tests](../../../infoRepoMonthly.db.test.js) and
[statistics repository database tests](../../../infoRepoStatistics.db.test.js)
exercise real rows, including stored historical rates and applicable filters.
They require `TEST_DATABASE_URL`; their skip state must remain visible. Retired
shadow middleware is not a current test layer or registration requirement.

## Original planned aggregates

| Slug                  | Source module (Phase)                                             | Feeds                                               |
| --------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `monthly-summary`     | `services/calculations/aggregation/monthly.js` (Phase 2)          | Dashboard monthly chart, Statistics yearly totals   |
| `category-breakdown`  | `services/calculations/aggregation/category.js` (Phase 2)         | Dashboard category donut, Statistics category panel |
| `recipient-insights`  | `services/calculations/aggregation/recipient.js` (Phase 2)        | Recipients page, top-recipient widgets              |
| `cashflow-comparison` | `services/calculations/aggregation/cashflow.js` (Phase 2)         | Dashboard cashflow strip                            |
| `average-vs-current`  | `services/calculations/aggregation/averageVsCurrent.js` (Phase 2) | Dashboard trend widget                              |
| `owed-summary`        | `services/calculations/aggregation/splits.js` (Phase 4)           | OwesPage, dashboard balance                         |

## Original planned variant matrix (per aggregate)

The original plan proposed the following matrix. No entries below imply
implemented fixture coverage:

- `empty` — no transactions / splits in range
- `single-currency` — one currency throughout
- `multi-currency` — at least two currencies, exercises conversion boundary
- `with-exclusions` — excluded categories / recipients filtered out
- `without-exclusions` — same dataset, no filters (round-trip check)
- `month-boundary` — transactions on the first and last day of a month
- `year-boundary` — Dec/Jan spanning the fiscal boundary
- `leap-day` — Feb 29 handling
- `dst-transition` — spring-forward and fall-back timestamps in `APP_TIMEZONE`

## Authoring a future golden fixture

1. Create `<aggregate>/<variant>.input.json` with the curated input set.
2. Write the vitest spec invoking `runGolden('aggregations/<aggregate>/<variant>', fn)`.
3. Run with `UPDATE_GOLDENS=1` to materialise the first `expected.json`.
4. Commit both files together; never update `expected.json` by hand after the initial capture — every subsequent change must go through an ADR note explaining the re-baseline.

## Database-backed checks

Use `hasTestDatabase()` from `tests/setup/db.js` when a check needs PostgreSQL,
and follow the setup and teardown of the existing repository database suites.
Pure helper properties and mocked wrapper tests do not replace those checks.
