---
title: Portfolio Summary API
type: endpoint
status: active
date: 2026-10-19
updated: 2026-10-19
tags:
  [
    endpoint,
    api,
    portfolio,
    realtime,
    summary,
    totals,
    dashboard,
    performance,
    net-worth,
    live-overlay,
    fx-attribution,
    asset-gain,
    fx-gain,
    purchase-date-rates,
    per-account,
    byAccount,
    adr-091,
    adr-100,
  ]
description: "Realtime portfolio totals endpoint serving as single source of truth for dashboard, performance, and (from 2026-05-31) net-worth current-point metrics. Single computation path, consistent FX timing, 60s cache TTL. 2026-06-11 (ADR-074): flows convert at transaction-date FX; gainLoss = assetGain + fxGain. 2026-06-18 (ADR-091/ADR-100): additive byAccount array. 2026-08-10 (ADR-108): byAccount carries full per-broker P&L from the partitioned lot engine, summaries carry fullyAssigned, Σ byAccount ≡ totals parity-tested under all cost-basis methods."
aliases: [portfolio-totals, portfolio-metrics, summary-api]
related_code:
  [
    "apps/node-backend/src/services/portfolio/portfolioSummaryService.ts",
    "apps/node-backend/src/routes/info/portfolioSummary.ts",
    "apps/node-backend/src/routes/info/_cache.js",
    "apps/node-backend/src/routes/info/_liveSummary.js",
    "apps/frontend/src/hooks/portfolio/usePortfolioSummary.ts",
    "apps/node-backend/src/services/portfolio/portfolioAssetClassTotals.ts",
    "apps/node-backend/src/services/currency/latestRateConversion.ts",
    "apps/frontend/src/hooks/portfolio/holdingPnl.ts",
    "apps/frontend/src/hooks/portfolio/assetGroupTotals.ts",
    "apps/frontend/src/lib/api/info.ts",
  ]
---

# Portfolio Summary API

For mixed-currency bookings, native asset gain converts the transaction's principal, fees, taxes
and income to the investment's quote currency using dated on-or-before rates. Target-currency
totals retain the original booked amounts and their dated conversion. This daily-rate attribution
does not isolate broker intraday conversion markup; a missing quote rate sets `usedFallbackRate`.
Since 2026-10-19 the web frontend has no local fallback calculation: active and archived holdings
both come from this endpoint ([[docs/adr/216-server-owned-domain-calculations|ADR-216]]).

> [!abstract] Overview
> Realtime endpoint computing portfolio totals (value, invested, gain/loss, returns) with FX conversion applied server-side. Single source of truth for dashboard overview cards, performance page headline metrics, and (from 2026-05-31) the Net Worth endpoint's _current_ investments value. Eliminates divergence from dual compute paths and ensures consistent FX timing across all three UI surfaces.
>
> **2026-06-11 (ADR-074) — FX attribution semantics change.** `totalInvested` / `totalBuyCost` / `gainLoss` / `realizedGain` / `unrealizedGain` / `avgCostBasis` / fees / taxes / income are now converted at **transaction-date** FX rates (invested is locked at purchase-date rates; it no longer drifts with today's FX). `gainLoss` **includes** the FX component and equals `assetGain + fxGain`. New additive fields carry the decomposition.

## In-kind income subtotal

`totals.totalInKindIncome` and each investment summary's `totalInKindIncome` retain proved literal
income already represented by acquired units. They use the response reporting currency and normal
transaction-date conversion. The amount stays separate from ordinary `totalIncome`, `totalDividends`
and gain/return formulas; units, cost basis, sale proceeds and valuation are unchanged. Absence on
older responses means zero. This additive subtotal does not infer tax treatment. Active canonical summaries supply it directly to the frontend.
The additive `archivedInKindIncome` array contains `{ id, totalInKindIncome }` for archived holdings,
converted from the literal income currency on its transaction date to the response currency. It is
always present on current responses (empty when none); absent older metadata means unknown. Until
2026-10-19 the frontend overrode only the archived income subtotal with it; it now reads archived
holdings, including `totalInKindIncome`, from the `active=false` canonical summaries.
Foreign income without canonical dated metadata is disclosed as unavailable rather than converted
using the investment currency or current rate. See [[docs/adr/188-proved-in-kind-income-recognition|ADR-188]] and
[[docs/features/portfolio]].

## Imported account fees

The optional additive `brokerageCashFees` object contains `total`, `gainAfterFees`,
`usedFallbackRate` and `byAccount: [{ account_id, total }]`, all amounts in the response currency.
`gainAfterFees = totals.totalGainLoss - brokerageCashFees.total`. Current responses always return
this object; absent older metadata means unavailable. This is a non-breaking response addition.

Only active, negative, non-transfer cash fees with committed brokerage source ownership qualify.
Ownership must still match account, date, currency, amount, source hash and fingerprint. The
Kinesis own-account funding receipt can own a separate fee component. Canonical IDs are deduplicated;
aborted owners, balance anchors, future records and source-overlapping portfolio fees are excluded.
Category and memo edits do not remove proved costs. A batch need not be complete if the relevant
row is committed. The subtotal uses transaction-date, on-or-before foreign exchange rates and
flags a missing historical rate that requires today's conversion.

These fees stay in the cash ledger. Investment `totals`, `summaries`, `byAccount`, cost basis,
asset/FX decomposition and performance series retain their existing scope. The overview labels
those returns as investment returns and separately shows broker account fees and gain after
account fees. It does not allocate account fees to individual securities or reconstruct cash FX
principal. See [[docs/features/portfolio]] and [[docs/adr/095-brokerage-account-import|ADR-095]].

## Scope and archived presentation

The optional `active` query is additive and defaults to `true`: existing active-only totals,
canonical summaries, dated FX, cache-warmer entries, and invalidation behavior are unchanged.
`active=false` requests canonical summaries/totals for all active and inactive investments.
Only single literal `true` / `false` values are accepted; malformed or repeated scope values
return `400 VALIDATION_ERROR`. The global API limit and this endpoint's existing 60/min limit
still apply. No write or migration is added.

The all-investment response also supplies `archivedPresentation`, containing inactive holdings
only. It reproduces the archive behavior that `usePortfolioSummaries` had before 2026-10-19: ordinary CRUD history is limited
to the newest 1000 rows per investment and replayed by the shared TypeScript portfolio helper,
then converted at the latest stored quote-currency rate. Since 2026-10-19 there is no static-rate
fallback: a holding whose currency has no stored rate keeps its original values and is flagged with
`usedFallbackRate: true`. Custody and adjustment events remain in the canonical summaries, rather
than being introduced into the retained ordinary archive display. `totalInKindIncome` alone
continues to use the canonical transaction-date bridge. `transactionCount` records the archive
history count; `summarySource` is `local`. Converted ordinary values retain web precision.

> [!note] Web portfolio changed on 2026-10-19
> The web portfolio (`usePortfolio` → `useAllHoldingsSummaryQuery`) now shows archived holdings
> from the canonical `summaries` of the `active=false` response, with dated FX and the configured
> cost-basis method, and keeps the default response for current totals
> ([[docs/adr/216-server-owned-domain-calculations|ADR-216]]). The paragraph below describes the
> earlier policy. The Belgian tax portfolio dashboard reads the same canonical summaries
> ([[docs/adr/217-belgian-tax-figures-on-the-server|ADR-217]]); no Vision screen reads
> `archivedPresentation` any more, but the response still carries it.

Archive views must use `archivedPresentation` for those ordinary figures, keeping the
active response for current totals. They must not replace these display values with canonical
all-investment P&L: a historical purchase rate and today's quote rate can produce different
costs, and this frontend migration preserves that distinction. Canonical `byAccount` remains a
separate broker snapshot, matching existing detail API reads. Archive presentation omits
canonical-only `assetGain`, `fxGain` and `nativeCurrentValue`; clients show these as unavailable
rather than borrowing the canonical decomposition. `usedFallbackRate` is omitted too, except
`true` when the holding's currency has no stored rate (2026-10-19).

The active cache retains its currency key; all-investment requests use `all:<currency>`. Both
are cleared by existing investment/transaction mutation invalidation. Synthetic tests verify
scope isolation/invalidation and historical-versus-current FX divergence. See
[[docs/api/investments|investment metadata and write fields]], [[docs/features/portfolio|Portfolio]],
and [[docs/api/index|API index]].

## Endpoint Details

| Property           | Value                                  |
| ------------------ | -------------------------------------- |
| **Path**           | `/api/info/portfolio-summary`          |
| **Method**         | GET                                    |
| **Authentication** | Session (required)                     |
| **Rate Limit**     | 60 req/min                             |
| **Cache TTL**      | 60 seconds (in-memory)                 |
| **Invalidation**   | On any investment or transaction write |

## Request

### Query Parameters

| Parameter  | Type   | Required | Default | Description                                                                 |
| ---------- | ------ | -------- | ------- | --------------------------------------------------------------------------- |
| `currency` | string | No       | EUR     | Target 3-letter currency code for FX conversion (e.g., `USD`, `GBP`, `CHF`) |

`target_currency` is an alias. A malformed code falls back to EUR. A repeated `currency` or
`target_currency` key returns `400 VALIDATION_ERROR` with `currency must be a single value`.

**Examples:**

- `/api/info/portfolio-summary` — Totals in EUR (default)
- `/api/info/portfolio-summary?currency=USD` — Totals in USD
- `/api/info/portfolio-summary?currency=GBP` — Totals in GBP
- `/api/info/portfolio-summary?currency=EUR&active=false` — All canonical holdings plus the retained archive presentation

### Headers

```
Content-Type: application/json
```

## Response

### Success (200 OK)

```json
{
  "currency": "EUR",
  "computed_at": "2026-10-13T12:00:00Z",
  "totals": {
    "totalPortfolioValue": 1250,
    "totalInvested": 1000,
    "totalGainLoss": 250,
    "totalRealizedGain": 0,
    "totalUnrealizedGain": 250,
    "totalGain": 250,
    "totalIncome": 0,
    "totalDividends": 0,
    "totalInKindIncome": 0,
    "totalFees": 0,
    "totalTaxes": 0,
    "totalAssetGain": 250,
    "totalFxGain": 0,
    "totalReturnPct": 25,
    "usedFallbackRate": false
  },
  "summaries": [
    {
      "id": 1,
      "name": "Synthetic holding",
      "asset_class": "stock",
      "assetClass": "stock",
      "currency": "EUR",
      "originalCurrency": "EUR",
      "is_active": true,
      "currentValue": 1250,
      "totalBuyCost": 1000,
      "totalUnits": 10,
      "currentPrice": 125,
      "avgCostBasis": 100,
      "realizedGain": 0,
      "unrealizedGain": 250,
      "gainLoss": 250,
      "gainLossPercent": 25,
      "totalIncome": 0,
      "totalDividends": 0,
      "totalInKindIncome": 0,
      "assetGain": 250,
      "fxGain": 0,
      "nativeCurrentValue": 1250,
      "usedFallbackRate": false,
      "fullyAssigned": true,
      "oversold": false,
      "byAccount": [
        {
          "account_id": 1,
          "assignment": "account",
          "contribution_kind": "position",
          "oversold": false,
          "currentValue": 1250,
          "totalInvested": 1000,
          "realizedGain": 0,
          "unrealizedGain": 250,
          "gainLoss": 250
        }
      ]
    }
  ],
  "byAccount": [
    {
      "account_id": 1,
      "assignment": "account",
      "contribution_kind": "position",
      "oversold": false,
      "currentValue": 1250,
      "totalInvested": 1000,
      "realizedGain": 0,
      "unrealizedGain": 250,
      "gainLoss": 250
    }
  ]
}
```

### Response Fields

Per-investment `totalUnits` preserves eight decimal places. Monetary fields retain their existing
reporting-currency rounding. Active portfolio holdings use these canonical quantities and gains,
including dated custody and unit adjustments; ordinary transaction lists remain editing data.

**Top-level:**

| Field          | Type              | Description                                                                                                                                                                                                                                                                            |
| -------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currency`     | string            | Echo of requested currency (default EUR)                                                                                                                                                                                                                                               |
| `computed_at`  | string (ISO-8601) | Timestamp when this snapshot was computed; refreshes on cache invalidation                                                                                                                                                                                                             |
| `totals`       | object            | Aggregate portfolio metrics across all assets                                                                                                                                                                                                                                          |
| `summaries`    | array             | Per-investment metrics. Each entry also carries its exact `byAccount` partition rows for current-point client filtering.                                                                                                                                                               |
| `byAssetClass` | array             | **2026-10-19 (ADR-216).** One `PortfolioHoldingTotals` entry per asset class present (plus `assetClass`). See [[docs/api/portfolio-summary#Asset-class and asset-group totals                                                                                                          | Asset-class and asset-group totals]]. |
| `byAssetGroup` | array             | **2026-10-19 (ADR-216).** One `PortfolioHoldingTotals` entry per page group (`stocks_etfs`, `crypto`, `metals`, `real_estate`, `savings_bonds`) plus its `assetClasses`.                                                                                                               |
| `byAccount`    | array             | **ADR-108 (2026-08-10): full per-broker P&L.** Per-account partition breakdown from the partitioned lot engine (sells consume same-account lots under the user's configured cost-basis method; corporate actions apply investment-wide). Additive — pre-existing fields are unchanged. |
| `accountTotals` | array            | **2026-10-19 (ADR-216), additive.** Portfolio-wide figures per broker account (`account_id` `null` = unassigned): every `byAccount` contribution kind of that account summed with Decimal and rounded once, sorted by `currentValue` descending. The Portfolio broker filter's holdings and P/L subtotals. Fields as `byAccount[]` without `contribution_kind`. |

**byAccount[] object (identified by `account_id` plus `contribution_kind`):**

`contribution_kind: "position"` contains lot-bearing position results. A partition with standalone
income or adjustments but no buy/gift/sell history is emitted separately as `"non_position"`.
This keeps `fullyAssigned` defined as lot assignment completeness: an unassigned dividend does not
make assigned holdings appear unassigned, but it remains visible as its own null-account row.

| Field               | Type                           | Description                                                                                                    |
| ------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `account_id`        | `number \| null`               | Account identifier; `null` = unassigned                                                                        |
| `assignment`        | `"account" \| "unassigned"`    | Stable machine-readable identity; clients localize the Unassigned label                                        |
| `contribution_kind` | `"position" \| "non_position"` | Distinguishes lot-bearing position results from standalone income or adjustment partitions                     |
| `oversold`          | boolean                        | True when any contributing investment sold more units in this account partition than its assigned lots provide |
| `currentValue`      | number                         | Holdings market value for this account in target currency                                                      |
| `totalInvested`     | number                         | Gross buy cost for this account at transaction-date FX rates (same grain as `totals.totalInvested`)            |
| `realizedGain`      | number                         | **New (ADR-108).** Realized P&L from this account's own lots                                                   |
| `unrealizedGain`    | number                         | **New (ADR-108).** Open-position P&L for this account                                                          |
| `gainLoss`          | number                         | Total gain for this account (incl. income minus fee/tax rows)                                                  |

Each `summaries[]` entry additionally carries `fullyAssigned: boolean`, `oversold: boolean`, and
`byAccount: PortfolioSummaryByAccountItem[]`. The nested rows are the exact contributions for that
investment; the top-level array is their round-once portfolio aggregate. This additive shape lets
the Portfolio Overview filter existing server-computed partitions without replaying cost basis in
the browser. While an instrument has broker-unassigned lots, its **entire** figures sit on the
Unassigned row and its global math stays the flat replay. A legacy partition deficit remains
readable with `oversold: true`; writes reject a new or worsened deficit but allow unchanged or
improving repair edits.

**Broker-filter totals (2026-10-19, ADR-216, additive).** Each `summaries[]` entry also carries
`accountTotals: PortfolioSummaryAccountTotals[]`, one row per broker account of that investment with
its contribution kinds summed on the server (Decimal, rounded once), and the response carries the
portfolio-wide `accountTotals` above. The Portfolio Overview broker filter reads the selected
account's row of each investment and the top-level subtotal; it no longer adds `byAccount` rows in
the browser and derives only the return percentage. Not a breaking change: existing fields are
unchanged. Covered on real PostgreSQL by
[[apps/node-backend/tests/portfolioSummaryTotals.db.test.ts]].

**Current-rate conversion (2026-10-19).** Current values (and the archived presentation of
`active=false`) convert at the latest **stored** exchange rate. A holding whose currency has no
stored rate keeps its unconverted figures and sets `usedFallbackRate: true` (and so
`totals.usedFallbackRate`); it is never converted at the hard-coded `FALLBACK_RATES` constants.

**Parity invariant (locked by `tests/portfolioSummaryPartitionParity.db.test.ts` under weighted_avg/fifo/lifo, per ADR-061 discipline):**

```
Σ byAccount[].currentValue    === totals.totalPortfolioValue
Σ byAccount[].totalInvested   === totals.totalInvested
Σ byAccount[].realizedGain    === totals.totalRealizedGain
Σ byAccount[].unrealizedGain  === totals.totalUnrealizedGain
Σ byAccount[].gainLoss        === totals.totalGainLoss
```

> [!note] ADR-108 headline semantics on fully-assigned multi-broker instruments
> Because the investment core **is** the partition aggregate, the global headline is not purely re-attributed in two edge data states: a **weighted_avg** `return_of_capital` exceeding one partition's basis share floors per partition (the flat replay floored one pooled basis; the partitioned figure matches FIFO/LIFO for the same rows), and a legacy sell tagged to a broker holding fewer units than sold clamps to that partition's lots. The latter is emitted as `oversold` and shown as a repair warning.

**totals object:**

| Field                 | Type    | Description                                                                                                                            |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `totalPortfolioValue` | number  | Sum of all investments' current market value in target currency (today's FX)                                                           |
| `totalInvested`       | number  | Sum of all cost basis at **transaction-date** FX rates (does not drift with today's FX)                                                |
| `totalGainLoss`       | number  | Net gain including ordinary income and recorded costs; includes asset and FX components (`= totalAssetGain + totalFxGain`)             |
| `totalAssetGain`      | number  | **New (ADR-074).** Pure asset-performance component: native-currency gain × today's rate                                               |
| `totalFxGain`         | number  | **New (ADR-074).** Currency-movement component: `totalGainLoss − totalAssetGain`                                                       |
| `totalRealizedGain`   | number  | Realized gains/losses from closed positions (converted at transaction-date rates)                                                      |
| `totalUnrealizedGain` | number  | Unrealized gains/losses from open positions (current − cost basis at purchase-date rates)                                              |
| `totalFees`           | number  | Cumulative fees paid (converted at transaction-date rates)                                                                             |
| `totalTaxes`          | number  | Cumulative taxes paid (converted at transaction-date rates)                                                                            |
| `totalIncome`         | number  | Cumulative dividends/interest/yield received (converted at transaction-date rates)                                                     |
| `totalDividends`      | number  | Dividend share of ordinary income, summed across holdings (converted at transaction-date rates); excludes in-kind income               |
| `totalReturnPct`      | number  | Total return percentage: `(totalGainLoss / totalInvested) × 100`                                                                       |
| `usedFallbackRate`    | boolean | **New (ADR-074).** `true` if any investment lacked a transaction-date rate and fell back to today's rate; a disclosure flag for the UI |

**summaries[] object (one per investment; selected fields):**

| Field                   | Type           | Description                                                                                                                                                                       |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asset_class`           | string         | Asset class: `stock`, `etf`, `crypto`, `metals`, `real_estate`, `savings`, or `bonds`                                                                                             |
| `currentValue`          | number         | Current market value in target currency (today's FX)                                                                                                                              |
| `totalBuyCost`          | number         | Cost basis at transaction-date FX rates                                                                                                                                           |
| `gainLoss`              | number         | Net gain including ordinary income and costs (= `assetGain + fxGain`)                                                                                                             |
| `assetGain`             | number         | **New (ADR-074).** Pure asset-performance component for this class                                                                                                                |
| `fxGain`                | number         | **New (ADR-074).** Currency-movement component for this class                                                                                                                     |
| `nativeCurrentValue`    | number         | **New (ADR-074).** Current market value in the investment's native currency (before FX conversion)                                                                                |
| `realized`              | number         | Realized gains for this class                                                                                                                                                     |
| `unrealized`            | number         | Unrealized gains for this class                                                                                                                                                   |
| `fees`                  | number         | Fees for this class                                                                                                                                                               |
| `taxes`                 | number         | Taxes for this class                                                                                                                                                              |
| `income`                | number         | Income for this class                                                                                                                                                             |
| `returnPct`             | number         | Return % for this class                                                                                                                                                           |
| `count`                 | integer        | Number of investments in this class                                                                                                                                               |
| `usedFallbackRate`      | boolean        | **New (ADR-074).** `true` if any transaction in this class used a fallback (non-historical) rate                                                                                  |
| `feesAndTaxes`          | number         | **2026-10-19.** `totalFees + totalTaxes`, from the rounded fields                                                                                                                 |
| `propertyReturn`        | number         | **2026-10-19.** Real Estate return: `totalAppreciation + totalIncome − totalFees − totalTaxes`                                                                                    |
| `monthlyRent`           | number \| null | **2026-10-19.** Latest `rent_income` amount (by date, then id) converted from its booking currency at the latest **stored** rate; `0` without rent, `null` when no rate is stored |
| `unrealizedGainPercent` | number         | Unrealized gain against the held basis (`avgCostBasis × totalUnits`); `0` without a basis                                                                                         |

**Reconciliation invariants (verified by test):**

```
sum(summaries[].currentValue) === totals.totalPortfolioValue
sum(summaries[].totalBuyCost)     === totals.totalInvested
sum(summaries[].gainLoss)     === totals.totalGainLoss
sum(summaries[].assetGain)    === totals.totalAssetGain
sum(summaries[].fxGain)       === totals.totalFxGain
gainLoss === assetGain + fxGain   (per-investment AND in totals)
(totalGainLoss / totalInvested) × 100 = totalReturnPct
```

### Error Responses

| Status | Description               | Example                                                                |
| ------ | ------------------------- | ---------------------------------------------------------------------- |
| 400    | Malformed/repeated scalar | ``VALIDATION_ERROR`; malformed currency codes retain the EUR fallback` |
| 401    | Not authenticated         | User session expired                                                   |
| 429    | Rate limited              | User exceeded 60 req/min quota                                         |
| 500    | Server error              | Database or conversion service unavailable                             |

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Error message" } }
```

### Additional typed display fields

Optional top-level `firstInvestmentDate` is the earliest ordinary transaction date on active
investments, independent of selected performance periods and record creation timestamps. It
excludes inactive holdings and custody/adjustment event dates; absence means no qualifying
transaction is known. All-time annualized hints can use this date without relabeling a
period-scoped chart start as the investment start.

Summary items expose `nativeCurrentPrice` and `nativeAvgCostBasis` in the investment quote
currency, plus server-computed `unrealizedGainPercent` against the held basis. Per-item
`estimatedMonthlyRent` is still the latest ordinary rent amount in its booking currency without FX
conversion; since 2026-10-19 the Real Estate page reads the converted `monthlyRent` instead, and the
browser rent conversion (`hooks/portfolio/monthlyRent.ts`) was removed. Fields, totals and nullability are declared in `openapi.yaml`; generated readers
can decode money and unit/rate quantities directly as Decimal. Metadata that is null in storage
remains nullable. `totals.usedFallbackRate` is boolean, rather than a numeric dynamic-map entry.

### Asset-class and asset-group totals

Added 2026-10-19 ([[docs/adr/216-server-owned-domain-calculations|ADR-216]]), built by
[[apps/node-backend/src/services/portfolio/portfolioAssetClassTotals.ts]]. Every total is the
Decimal sum of the rounded per-investment figures in the same response, so a page total equals the
sum of the rows it shows. `byAssetClass[]` adds `assetClass`; `byAssetGroup[]` adds `group` and
`assetClasses` (`stocks_etfs` = stock + etf, `crypto`, `metals`, `real_estate`,
`savings_bonds` = savings + bond).

Each entry (OpenAPI `PortfolioHoldingTotals`) carries `holdingCount`, `totalPortfolioValue`,
`totalInvested`, `totalGainLoss`, `totalRealizedGain`, `totalUnrealizedGain`, `totalIncome`,
`totalDividends`, `totalInKindIncome`, `totalFees`, `totalTaxes`, `totalFeesAndTaxes`,
`netReturnExcludingIncome`, `netReturnWithDividends`, `totalAppreciation`, `totalPropertyReturn`,
`totalAccruedInterest`, `totalProjectedAnnualInterest`, `valueWeightedInterestRate`,
`estimatedMonthlyRent` (Σ `monthlyRent` of holdings that have a rate), `monthlyRentRateMissing`
(some holding's `monthlyRent` is `null`), and `usedFallbackRate`.

The Stocks, Crypto, Metals, Real Estate and Savings pages and the Portfolio allocation chart read
these through `findHoldingTotals(summary, assetClasses)` in
`apps/frontend/src/hooks/portfolio/assetGroupTotals.ts` instead of summing or converting holdings
in the browser. Covered on real PostgreSQL by
[[apps/node-backend/tests/portfolioSummaryTotals.db.test.ts]].

## Caching Strategy

**TTL:** 60 seconds

- Balances freshness (price refreshes run on 5-min intervals) with low latency
- Most dashboard renders hit cache; cold-start time is ~200-400ms

**Invalidation:** Atomic on write

- `POST /api/investments` → clears cache
- `PATCH /api/investments/:id` → clears cache
- `DELETE /api/investments/:id` → clears cache
- `POST /api/investments/:id/transactions` → clears cache
- `PATCH /api/investments/transactions/:txnId` → clears cache
- `DELETE /api/investments/transactions/:txnId` → clears cache
- `POST /api/transactions` → clears cache
- `PATCH /api/transactions/:id` → clears cache
- `DELETE /api/transactions/:id` → clears cache

**Inflight dedup:** If two requests arrive during cache miss, the second waits for the first's result instead of re-computing.

## FX Conversion

All monetary values in the response are pre-converted to the target currency on the server. The conversion applies:

1. Fetch all investments with their current prices and cost basis
2. For each investment, load the `fx_rate_to_eur` stamped on every portfolio transaction (or look up the stored on-or-before rate from `exchange_rates`)
3. Flows (buys, sells, fees, taxes, income) are converted at their **transaction-date** rate; holdings values are converted at today's rate
4. `assetGain` = native-currency gain × today's rate; `fxGain` = `gainLoss − assetGain`
5. Group by asset class and sum totals

**Rate source (ADR-074):** `portfolio_transactions.fx_rate_to_eur` per row (preferred) → stored on-or-before rate from `exchange_rates` (≤7-day lookback) → today's rate with `usedFallbackRate: true`

> [!warning] Semantics change from pre-ADR-074
> Before 2026-06-11, `totalInvested` was restated at today's FX rate on every call, so "invested" drifted with the market. After ADR-074 it is locked at purchase-date rates. Multi-currency portfolios will see different `totalInvested` and `gainLoss` figures compared to pre-ADR-074 readings — this is the intentional fix, not a regression.

## Use Cases

### Dashboard Overview Cards

Frontend dashboard renders four headline cards using this endpoint:

```typescript
const { data } = usePortfolioSummaryQuery(displayCurrency);

// Total Portfolio Value
<Card>Total: {data?.totals.currentValue.toFixed(2)}</Card>

// Total Invested
<Card>Invested: {data?.totals.totalInvested.toFixed(2)}</Card>

// Total Gain/Loss
<Card>Gain/Loss: {data?.totals.totalGainLoss.toFixed(2)}</Card>

// Return %
<Card>Return: {data?.totals.totalReturnPct.toFixed(2)}%</Card>
```

### Performance Page Headline Metrics

Performance page headline metrics (updated 2026-04-29):

```typescript
const { data: performance } = usePortfolioPerformanceQuery(
  displayCurrency,
  period,
);

// Override snapshot-era totals with realtime values
const metricsBlock = {
  ...performance.metrics,
  currentValue: portfolioSummary.totals.currentValue,
  totalInvested: portfolioSummary.totals.totalInvested,
  totalGainLoss: portfolioSummary.totals.totalGainLoss,
  totalReturnPct: portfolioSummary.totals.totalReturnPct,
};
```

### Net Worth Current-Point Overlay (2026-05-31)

The `GET /api/info/net-worth` endpoint now overlays its _current_ investments value with the live summary from this endpoint, via the shared `portfolioSummaryCache`. The new shared helper `resolveLivePortfolioValue(targetCurrency)` in `apps/node-backend/src/routes/info/_liveSummary.js` reads `totals.totalPortfolioValue` from the cache and passes it to `infoRepositoryNetWorth.getNetWorthFromSnapshots`. This means Dashboard, Performance, and Net Worth all derive their "current portfolio value" from the same source — a true single source of truth across all three surfaces. Historical Net Worth snapshot days are unaffected. See [[docs/adr/064-net-worth-current-value-live-overlay|ADR-064]].

### Per-Asset-Group Breakdown

The Portfolio allocation chart reads the server group totals (2026-10-19); only the shares are
derived in the browser:

```typescript
const slices = Object.entries(assetClassGroups).map(([name, classes]) => ({
  name,
  value: findHoldingTotals(portfolioSummary, classes).totalPortfolioValue,
}));
```

## Examples

### cURL

```bash
# Get portfolio totals in EUR (default)
curl -X GET "http://localhost:3002/api/info/portfolio-summary" \
  -H "Content-Type: application/json"

# Get portfolio totals in USD
curl -X GET "http://localhost:3002/api/info/portfolio-summary?currency=USD" \
  -H "Content-Type: application/json"
```

### JavaScript (Fetch)

```javascript
const response = await fetch("/api/info/portfolio-summary?currency=EUR", {
  method: "GET",
  credentials: "include", // Include session cookie
});
const data = await response.json();
console.log(`Total: ${data.totals.currentValue}`);
```

### React Query (Frontend)

```typescript
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

function usePortfolioSummaryQuery(currency = 'EUR') {
  return useQuery({
    queryKey: ['portfolio-summary', currency],
    queryFn: () => apiClient.getPortfolioSummary({ currency }),
    staleTime: 60_000, // 60 seconds
    retry: 1,
  });
}

// Usage in component
const { data, isLoading } = usePortfolioSummaryQuery(displayCurrency);
if (isLoading) return <Loading />;
return <div>Total: {data.totals.currentValue}</div>;
```

## Related

- [[docs/api/info|Info & Analytics API]] — Other portfolio/statistics endpoints
- [[docs/api/investments|Investments API]] — Per-investment data and price updates
- [[docs/features/portfolio|Portfolio Feature]] — Feature overview and asset classes; per-account breakdown
- [[docs/features/net-worth|Net Worth Feature]] — Per-account breakdown table consuming byAccount
- [[docs/adr/100-net-worth-account-native-holdings|ADR-100]] — Per-account byAccount parity decision
- [[docs/adr/091-per-account-positioning|ADR-091]] — account_id on lots; prerequisite for byAccount
- [[docs/adr/074-fx-attribution-historical-rates|ADR-074]] — FX attribution decision and rationale
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044]] — Single source of truth architecture decision
- [[docs/adr/073-shared-portfolio-math-package|ADR-073]] — Shared portfolio math (fxMultiplier converted track)
- [[docs/adr/216-server-owned-domain-calculations|ADR-216]] — Domain calculations run on the server; archived holdings read from this endpoint
- [[docs/integrations/currency-conversion|Currency Conversion]] — ECB full-history tier, on-or-before convention
- [[docs/reference/code-patterns#portfolio-totals-pattern|Portfolio Totals Pattern]] — Implementation guidelines

## Changelog

### 2026-06-18 — Per-account holdings breakdown (ADR-091 / ADR-100)

- **New additive top-level field `byAccount[]`:** `{ account_id: number | null, currentValue, totalInvested, gainLoss }` per account. Existing `totals` and `summaries` fields are completely unchanged.
- Lots grouped by `account_id`; `null` entry covers unassigned lots. Both sides run through the same cost-basis math and FX multipliers as the per-investment path, so parity holds by construction.
- Parity invariant (`Σ byAccount == totals`) locked by test (ADR-061 approach).
- Frontend hook: `apps/frontend/src/hooks/portfolio/useAccountPositions.ts`. `InvestmentDetailDialog` now shows "Holdings by Account" card.
- Net Worth page uses this via `useAccountNetWorth` to compose the per-account breakdown table. See [[docs/adr/100-net-worth-account-native-holdings|ADR-100]].

### 2026-06-11 — FX attribution fields + purchase-date rate semantics (ADR-074)

- **Semantics change:** `totalInvested`, `totalBuyCost`, `gainLoss`, `realizedGain`, `unrealizedGain`, `avgCostBasis`, fees, taxes, and income are now converted at **transaction-date** FX rates instead of today's rate. Invested capital no longer drifts with FX.
- **New totals fields:** `totalAssetGain` (pure asset performance), `totalFxGain` (currency effect), `usedFallbackRate` (disclosure flag).
- **New per-investment fields:** `assetGain`, `fxGain`, `nativeCurrentValue`, `usedFallbackRate`.
- **Identity guaranteed:** `gainLoss = assetGain + fxGain` holds per-investment and in totals.
- `fx_rate_to_eur` is now auto-resolved from stored `exchange_rates` (on-or-before ≤7 days) on transaction create/edit when not explicitly provided and currency ≠ EUR.
- Source: [[apps/node-backend/src/services/portfolio/portfolioSummaryService.ts]], [[apps/node-backend/src/services/investmentService.ts]]

### 2026-05-31 — Net Worth overlay extended single source of truth

- The Net Worth endpoint (`GET /api/info/net-worth`) now reads `totals.totalPortfolioValue` from `portfolioSummaryCache` (this endpoint's cache) and overlays it onto the latest snapshot before computing the headline `current` value, last chart point, and latest table row.
- New shared helper `apps/node-backend/src/routes/info/_liveSummary.js` exposes `resolveLiveSummary` and `resolveLivePortfolioValue` for use by both `netWorth.ts` and the startup warmup path.
- API response shape of `/api/info/net-worth` is UNCHANGED. No frontend changes.
- This extends the "single source of truth" guarantee from Dashboard + Performance to all three portfolio pages. See [[docs/adr/064-net-worth-current-value-live-overlay|ADR-064]].

### 2026-04-29 — Initial Release

- New realtime endpoint `/api/info/portfolio-summary`
- Single source of truth for dashboard + performance page totals
- 60s cache TTL with atomic invalidation
- Reconciliation invariant verified by tests (sum of summaries = totals)
