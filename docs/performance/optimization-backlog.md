---
title: Optimization Backlog
type: performance
status: active
date: 2026-05-14
last_modified: 2026-05-14
tags: [performance, optimization, backlog, refactor, tech-debt]
description: Behaviour-neutral performance and code-design findings from the May 2026 codebase audit that have NOT yet been turned into PRs — recorded for later review to confirm they are still worth doing.
aliases: [optimization backlog, perf backlog, audit findings, deferred optimizations]
---

# Optimization Backlog

Findings from the May 2026 codebase audit (frontend charts/hooks, backend
calculations/repositories, backend routes/middleware) that **did not** become
PRs. Each entry notes why it was not shipped and what to verify before picking
it up. All entries are intended to be **behaviour-neutral** — confirm that
still holds before implementing.

> Shipped from the same audit: PRs #58–#63 (N+1 batching, chart memoization,
> backend helper dedup, redundant-work removal, portfolio-summary cache
> sharing, aiChat per-turn fetch dedup).

## Skipped — behaviour-change risk

Re-evaluate only if the semantics below can be confirmed safe; otherwise leave
as-is.

- **`recipientRepository.createOrGet` extra `getById` round-trip**
  (`apps/node-backend/src/repositories/recipientRepository.js`). After the
  upsert it always runs a third round-trip (`getById`, a 4-join query). Looks
  like dead weight, **but** `POST /api/recipients` (`routes/recipients.js`)
  returns that full object to the client — dropping it changes the response
  shape. Only viable if the route is changed to re-fetch explicitly or the
  upsert `RETURNING` is widened to the full client shape.

- **`recurringDetectionService.detectAmountChanges` redundant date re-sort**
  (`apps/node-backend/src/services/recurringDetectionService.js`). The
  per-recipient `txns` array already arrives `ORDER BY t.recipient_id, t.date`
  from SQL, so the `[...transactions].sort(...)` looks redundant — **but** the
  JS comparator handles invalid/`NaN`/`null` dates differently from Postgres
  `ORDER BY ... NULLS LAST`. Removing it risks a subtle ordering change in the
  "last few transactions" logic. Only safe if `transactions.date` is proven
  non-null and tie-handling is confirmed equivalent.

## Deferred — larger / maintainability refactor

- **Extract a shared `useTableState` hook from `DataTable` / `VirtualDataTable`**
  (`apps/frontend/src/components/shared/`). The two components are ~90%
  duplicated (sort, filter, resize, search, `getSortValue`, `IndexedRow`,
  header JSX — ~400 lines). Deferred because the stateful parts genuinely
  diverge: `DataTable` has pagination and no server-sort; `VirtualDataTable`
  has virtualization, server-sort, infinite scroll, and a different debounce
  interval (200 ms vs 350 ms) and search-sync effect. A shared hook is real
  regression risk for a pure-maintainability gain — do it as its own focused
  PR with careful before/after behaviour comparison, or not at all.

## Frontend — not yet addressed (behaviour-neutral memoization)

Viable follow-up PRs in the same spirit as #59.

- **`CustomChart.tsx`** — `data.categoryPivot.filter(...)` is recomputed 3×
  (inside `allPeriods`, `seriesMeta`, `chartData`); `.includes` for category-id
  lookup is O(n); `legendItems` and the per-chart `series` arrays are rebuilt
  with new identity each render. Also `seriesMeta`'s dep array omits
  `recipientData` though it's used. Fix: compute the filtered set once in a
  `useMemo`, use a `Set` for id lookup, memoize `legendItems`/`series`.
- **`CategoryPivotTable.tsx`** — `getPeriodValue` is redefined each render and
  used inside three `useMemo`s behind `eslint-disable exhaustive-deps` (fragile);
  `columnTotals` is an O(periods × categories) second scan that could be derived
  from the `hierarchicalCategories` memo in one pass. Hoist `getPeriodValue` to
  a pure module function.
- **`forecastMerge.ts`** — `mergeForView` re-implements ~140 lines of
  `mergeForViewRolling`'s band-map + series-building logic inline instead of
  reusing the already-extracted `buildBandMaps` / `buildSeries` helpers. Also
  declares an unused `bandsCumByMethod` in the `view === 'daily'` branch.
- **`usePortfolioSummaries.ts`** — `byAssetClass` returns a fresh filtered array
  on every call, so pages calling it in render (Stocks/Crypto/Metals) get a new
  identity each render. Consider returning a memoized
  `Map<AssetClass, InvestmentSummary[]>` grouped once.
- **`RecipientInsightsTab.tsx`** — `formatCurrency` rebuilds an
  `Intl.NumberFormat` on every call (same pattern fixed in #59 for the chart
  formatters); memoize the formatter instance.
- **`useStatistics.ts`** — `mapToStatisticsData` runs `monthlyData.reduce`
  twice where a single pass would compute both totals. Low impact.
- **`computeRollingAverage` (`rollingAverage.ts`)** — O(n × window) nested loop;
  a running-sum sliding window is O(n). Window is currently 3 so impact is
  negligible — cleanup only.
- **`SankeyChart.tsx`** — `graph` and `nodeColorMap` could share one pass over
  `data`. Minor.

## Backend — not yet addressed

- **`recurringDetectionService.detectRecurringPatterns` full-table scan**
  (`apps/node-backend/src/services/recurringDetectionService.js`). Selects the
  entire `transactions` table (joined to recipients/categories, ordered) with
  no date bound on every call — including via the `getRecurringDetected` aiChat
  tool. Fix options: bound the query to the last ~3 years (older rows can't
  form a current pattern given the `predictedNext` logic), or add a short-lived
  module cache keyed on `MAX(updated_at)` / row count. **Medium impact.**
- **`streamingImportService.getOrCreateRecipient` per-row work**
  (`apps/node-backend/src/services/streamingImportService.js`). Re-normalizes
  the name and runs the recipient upsert for every CSV row, though a merchant
  typically repeats many times within one file. Add a per-import
  `Map<normalizedName, recipientId>` cache; the address/account
  UPDATE/INSERT also fires on every occurrence of an already-known recipient.
- **`recipientPatternService.previewPatternMatches` unbounded load**
  (`apps/node-backend/src/services/recipientPatternService.js`). The regex path
  does `SELECT id, name FROM recipients WHERE is_active = true` with no LIMIT,
  then filters in JS. Acceptable since regex can't push to Postgres, but add a
  count cap / LIMIT guard for large recipient tables.
- **`quoteBackfillService` duplicated query + row mapping**
  (`apps/node-backend/src/services/quoteBackfillService.js`).
  `getInvestmentsWithHoldingWindows` and `getInvestmentWithHoldingWindows`
  repeat the same 13-column SELECT and 12-field investment-object construction;
  only the WHERE differs (`i.id = $1`). Extract a shared query builder +
  `mapInvestmentRow(row)` helper.
- **`routes/aggregations.js` `cashflow-forecast-accuracy` per-method re-sort**.
  `[...history].sort(...)` copies+sorts each method group; the rows could be
  fetched `ORDER BY method_id, as_of_month DESC` so the route just groups.
  Touches the repo query. Low impact.
- **`middleware/validation.js` possibly-dead exports**. `sanitizeUpdateFields`,
  `sanitizeString`, `validateNumber`, `validateDateString`, `validatePagination`
  appear unreferenced (routes do their own inline clamping). **Grep the whole
  repo to confirm before removing.**
- **Multiple `YahooFinance` instances**. `routes/marketLookup.js`,
  `services/prices/priceProviderRegistry.js`, and
  `services/providerHealthService.js` each construct their own
  `new YahooFinance(...)` with identical config. Could share one instance.
  Low impact.
- **`routes/plannedTransactions.js` raw `dbQuery` from the route layer**.
  `resolveRecipientIdFromName` / `resolveCategoryIdFromName` run raw SQL point
  lookups directly in the route (already `Promise.all`-parallelized). Move the
  lookups into the recipient/category repositories for layering consistency.
- **`portfolioPerformanceSnapshotService.getLatestSnapshot` uses `SELECT *`**
  where the rest of the file uses explicit column lists. Cosmetic consistency.

## How to use this list

When picking an item up:
1. Re-confirm it is still behaviour-neutral (code may have moved since the audit).
2. For the "skipped" items, the listed risk must be resolved first.
3. Verify with `bun run lint` / `bun run lint:backend` and the full test suites.
4. Keep PRs small and single-themed, as in #58–#63.
