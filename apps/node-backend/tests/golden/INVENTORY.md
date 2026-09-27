# Calculation Coverage Inventory

Selected calculation coverage, reviewed on 2026-09-26. This is not an exhaustive
inventory of all production calculations. Add coverage for new calculations and
update the relevant row before merge.

Legend:

- G = golden cases in `tests/golden/__fixtures__/<module>/`; multiple cases may share one input file.
- P = covered by a production-connected property test in `tests/property/*.property.test.js`.

## Pure calculation modules

| Module                                | Function                           | G        | P   | Notes                                                                                                          |
| ------------------------------------- | ---------------------------------- | -------- | --- | -------------------------------------------------------------------------------------------------------------- |
| `loanSchedule.js`                     | `generateLoanRepaymentSchedule`    | 7        | yes | amortizing (standard, zero-APR, month-end clamp, long-term, single-month), fixed_principal, interest_only      |
| `loanSchedule.js`                     | `validateLoanConfig`               | indirect | —   | exercised through `generateLoanRepaymentSchedule` golden inputs                                                |
| `recurrence.js`                       | `calculateNextDate`                | 10       | yes | daily/weekly/biweekly/monthly/quarterly/yearly, custom `every N days`, Jan-31 clamp (leap + non-leap), invalid |
| `recurrence.js`                       | `isValidPattern`                   | indirect | —   | covered via invalid-pattern golden                                                                             |
| `recurrence.js`                       | `getSupportedPatterns`             | —        | —   | trivial constant accessor                                                                                      |
| `splits.js`                           | `validateSplitAllocation`          | 4        | —   | ok, over, non-positive, tolerance-boundary                                                                     |
| `splits.js`                           | `validateBatchSplitAllocation`     | 4        | —   | ok, over, empty, negative-member                                                                               |
| `splits.js`                           | `validatePaymentAmount`            | 4        | —   | ok, over, non-positive, exact-settle                                                                           |
| `splits.js`                           | `computeSplitRemaining`            | indirect | yes | invariant: split.amount == paid + remaining                                                                    |
| `splits.js`                           | `computeOwedSummary`               | 5        | yes | empty, single, multi, fully-settled-filtered, stringified-numbers                                              |
| `splits.js`                           | `roundToCents`                     | indirect | —   | used everywhere; covered by every split fixture                                                                |
| `normalization.js`                    | `normalizeForMatching` (re-export) | 10       | —   | see `textNormalization.js` goldens                                                                             |
| `normalization.js`                    | `findBestRecipientMatches`         | —        | —   | DB-bound (pg_trgm); tested in `rawTransactionImportService.test.js`                                            |
| `currencyConversionService.js`        | `convertToCurrency`                | —        | yes | round-trip within rounding                                                                                     |
| `dedup` (`services/deduplication.js`) | `createTransactionHash`            | 9        | —   | backward-compat hash lock (Phase 7)                                                                            |
| `dedup` (`services/deduplication.js`) | `createManualTransactionHash`      | 7        | —   | backward-compat hash lock (Phase 7)                                                                            |

## Aggregation coverage

Aggregation shadow middleware was removed after the Phase 9 cutover, as recorded
in [ADR-016](../../../../docs/adr/016-aggregation-shadow-mode.md). It provides no
current coverage and is not a requirement for new aggregations. The
`__fixtures__/aggregations/` directory contains a historical plan only; there are
no aggregation input/expected golden pairs there.

| Production surface                                                                                                               | Current check                                                                  | What it establishes                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`infoRepositoryHelpers.js`](../../src/repositories/infoRepositoryHelpers.js): `buildMonthlySummary`                             | [`monthlyYearly.property.test.js`](../property/monthlyYearly.property.test.js) | Summing an already aggregated window preserves signed cents, transaction counts and period bounds, including duplicate and empty rows. Despite the historical filename, this does not compare monthly SQL with yearly SQL. |
| [`infoRepositoryHelpers.js`](../../src/repositories/infoRepositoryHelpers.js): `buildCategoryFromConvertedRows`                  | [`categoryTotal.property.test.js`](../property/categoryTotal.property.test.js) | Already converted rows preserve signed totals and counts across category grouping, duplicate rows, ordinary numeric/string IDs and the numeric uncategorized sentinel.                                                     |
| `infoRepositoryMonthly.js`: `getMonthlyFinancialSummary`                                                                         | [`infoRepoMonthly.db.test.js`](../infoRepoMonthly.db.test.js)                  | Real database rows exercise window filling, exclusions, transfers, stored historical FX, live/materialized-view agreement on one corpus, and application timezone boundaries.                                              |
| `infoRepositoryStatistics.js`: `getCategoryBreakdown`, `getCategoryPivot`                                                        | [`infoRepoStatistics.db.test.js`](../infoRepoStatistics.db.test.js)            | Real database rows exercise currency conversion, transfers, inactive rows, hierarchy/alias resolution, mixed-sign pivots and exclusions.                                                                                   |
| `aggregation/monthly.js`, `category.js`, `recipient.js`, `cashflow.js`, `averageVsCurrent.js`, `bankBalances.js`, `_envelope.js` | [`services/aggregationCalcs.test.js`](../services/aggregationCalcs.test.js)    | Mocked repository responses verify wrapper forwarding, envelopes and metadata. They do not establish database result correctness.                                                                                          |

The helper property tests use integer-cent oracles. They do not exercise SQL
selection/grouping, exclusion filters, FX lookup, or yearly-query parity. The
separate database suites require `TEST_DATABASE_URL`; a skipped database suite
must not be reported as passed coverage.

## Regeneration policy

- Fixture drift is **intentional** only. Rebaseline with `UPDATE_GOLDENS=1 bun vitest run <path>` and document the ADR in the same PR.
- A new pure calc **must** land with at least one golden input/expected pair. Aggregation changes need checks of the affected production helper or database path; mocked wrapper contracts alone do not prove numeric correctness.
- Property tests guard invariants that fixtures can't enumerate exhaustively (cross-scale sums, round-trip, bijective iteration).
