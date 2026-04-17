# Calculation Inventory Lock

Phase 8 correctness gate. Every non-trivial calc in `src/services/calculations/` is
enumerated here with its golden-fixture coverage + property-test coverage. Any new
calc must append a row before merge.

Legend:
- G = golden-fixture count (`tests/golden/__fixtures__/<module>/*.input.json`)
- P = covered by a property test in `tests/property/*.property.test.js`
- S = covered by aggregation shadow middleware

## Pure calculation modules

| Module | Function | G | P | S | Notes |
|---|---|---|---|---|---|
| `loanSchedule.js` | `generateLoanRepaymentSchedule` | 7 | yes | — | amortizing (standard, zero-APR, month-end clamp, long-term, single-month), fixed_principal, interest_only |
| `loanSchedule.js` | `validateLoanConfig` | indirect | — | — | exercised through `generateLoanRepaymentSchedule` golden inputs |
| `recurrence.js` | `calculateNextDate` | 10 | yes | — | daily/weekly/biweekly/monthly/quarterly/yearly, custom `every N days`, Jan-31 clamp (leap + non-leap), invalid |
| `recurrence.js` | `isValidPattern` | indirect | — | — | covered via invalid-pattern golden |
| `recurrence.js` | `getSupportedPatterns` | — | — | — | trivial constant accessor |
| `splits.js` | `validateSplitAllocation` | 4 | — | — | ok, over, non-positive, tolerance-boundary |
| `splits.js` | `validateBatchSplitAllocation` | 4 | — | — | ok, over, empty, negative-member |
| `splits.js` | `validatePaymentAmount` | 4 | — | — | ok, over, non-positive, exact-settle |
| `splits.js` | `computeSplitRemaining` | indirect | yes | — | invariant: split.amount == paid + remaining |
| `splits.js` | `computeOwedSummary` | 5 | yes | — | empty, single, multi, fully-settled-filtered, stringified-numbers |
| `splits.js` | `roundToCents` | indirect | — | — | used everywhere; covered by every split fixture |
| `normalization.js` | `normalizeForMatching` (re-export) | 10 | — | — | see `textNormalization.js` goldens |
| `normalization.js` | `findBestRecipientMatches` | — | — | — | DB-bound (pg_trgm); tested in `rawTransactionImportService.test.js` |
| `currency.js` | `convertToEur` (re-export) | — | yes | — | round-trip within rounding |
| `currency.js` | `convertToCurrency` (re-export) | — | yes | — | round-trip within rounding |
| `dedup` (`services/deduplication.js`) | `createTransactionHash` | 8 | — | — | backward-compat hash lock (Phase 7) |
| `dedup` (`services/deduplication.js`) | `createManualTransactionHash` | 8 | — | — | backward-compat hash lock (Phase 7) |

## Aggregation modules

| Module | Function | G | P | S | Notes |
|---|---|---|---|---|---|
| `aggregation/monthly.js` | `computeMonthlySummary` | — | yes | yes | `sum(monthly) == yearly` invariant |
| `aggregation/category.js` | `computeCategoryBreakdown` | — | yes | yes | `sum(category) + excluded == total` invariant |
| `aggregation/recipient.js` | `computeRecipientInsights` | — | — | yes | shadow compares vs legacy `/api/info/*` |
| `aggregation/cashflow.js` | `computeCashflowComparison` | — | — | yes | shadow compares vs legacy |
| `aggregation/averageVsCurrent.js` | `computeAverageVsCurrent` | — | — | yes | shadow compares vs legacy |
| `aggregation/bankBalances.js` | `computeBankBalances` | — | — | yes | shadow compares vs legacy |
| `aggregation/_envelope.js` | `buildEnvelope` | indirect | — | — | trivial wrapper; exercised by every aggregation test |

## Regeneration policy

- Fixture drift is **intentional** only. Rebaseline with `UPDATE_GOLDENS=1 bun vitest run <path>` and document the ADR in the same PR.
- A new calc **must** land with at least one golden input/expected pair. A new aggregation **must** land registered with the shadow middleware.
- Property tests guard invariants that fixtures can't enumerate exhaustively (cross-scale sums, round-trip, bijective iteration).
