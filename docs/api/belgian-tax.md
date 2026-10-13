---
title: Belgian Tax Computation API
type: endpoint
status: active
date: 2026-10-13
updated: 2026-10-13
method: GET, POST
path: /api/belgian-tax
tags: [api, tax, belgian, native, adr-204]
description: Stateless access to the shared TypeScript household tax engine for native clients.
related_code:
  - apps/node-backend/src/routes/belgianTax.ts
  - apps/node-backend/src/routes/belgianPortfolioTax.ts
  - apps/node-backend/src/services/tax/portfolioDashboardService.ts
  - packages/shared-utils/src/belgianTax/portfolioDashboard.ts
  - apps/node-backend/src/routes/belgianTaxDashboard.ts
  - apps/node-backend/src/services/tax/dashboardService.ts
  - packages/shared-utils/src/belgianTax/household.ts
  - apps/native/Sources/VisionNativeCore/Screens/Tax/TaxComputationService.swift
---

# Belgian Tax Computation API

## Read a live or historical overview

`GET /api/belgian-tax/overview?year=2025` reads the tax settings and CAS baselines in one
database snapshot. Omit `year` to select the live household year. An explicit year must be
a single four-digit integer in 1900–2200; malformed, repeated, or out-of-range values return
`400 VALIDATION_ERROR`. Storage or computation failures return an error, never empty success.

The response uses the standard envelope. It includes the selected and live households, normalized
household snapshots, snapshot metadata, the selected year and live year, profile/snapshot flags,
and both the PIT calculation and household result. Valid v2 settings take precedence; v1 settings
are upgraded using the same shared routines as the web provider. Invalid v2 storage yields the
existing fallback and `storedValueInvalid` plus warning key/kind/issues, without logging or
returning a copy of the invalid value in the warning. Original settings remain in `records`.

The live year uses the live household even if a snapshot exists for that year. A historical year
uses its snapshot, or a year-pinned live estimate when no snapshot exists. Neither read creates
a snapshot or writes an upgrade. `householdMigrationNeeded` and `snapshotsMigrationNeeded`
identify the normalizations the caller may later persist through the existing settings API.

`calculationSource` and `householdResultSource` distinguish `frozen` from `computed`. Frozen
values are returned verbatim. A fully frozen record does not invoke the current engine. A legacy
frozen PIT calculation without a frozen household result retains that calculation while obtaining
the missing household breakdown from the current engine, matching the web store. Old frozen
calculations may omit newer fields; consumers must display those as unavailable, not zero or
recomputed amounts. The OpenAPI historical calculation requires `totalPIT` and leaves other
fields optional for this compatibility case.

`records` contains the original values and `expected` baselines for the three v2/metadata setting
keys. Baselines preserve absent rows versus JSON null and legacy JSON-string storage. They must
be sent unchanged on a later save. This operation performs no writes or filing actions and does
not overwrite malformed records. It uses the global and aggregation rate limits.

`TaxOverviewModel` guards the requested year, coalesces requests, refreshes on invalidation,
and rejects late responses from another year. A failed year change clears old amounts; a failed
refresh of the same year keeps the prior snapshot and exposes the error. The native `/tax` view now renders those results; profile edits and snapshot/freeze/filing
changes use existing atomic settings CAS writes. CSV is native, while PDF remains the shared
web report dialog. macOS build and Demo parity review remain pending. See
[[docs/reference/native-parity/tax|the action mapping]].

## Read Portfolio Tax widget data

`GET /api/belgian-tax/portfolio-dashboard` (`getBelgianPortfolioTaxDashboard`) is an additive,
read-only operation for `/portfolio/tax`. It accepts the same optional `year` (1900–2200)
and three-letter `currency` (default EUR, normalized uppercase). Invalid or repeated scalar
values return `400`; source read failures and malformed frozen PIT calculations return `500`,
never an empty dashboard. It shares the existing global and aggregation rate limits.

The typed response contains recorded/manual tax and fee totals, effective tax rate, frozen-first
selected-year PIT and combined budget, tax/fee localization-key breakdowns, asset-class costs,
per-investment costs and target-converted realized gains, monthly costs, Belgian TOB/TACR/Reynders/
CGT estimates, dividend withholding/reclaim details, fraction-valued tax rates and precomputed
percent badges. `isEmpty` reflects holdings; `hasProfile` reflects the live profile. The
`hasInKindIncomeUnclassified` flag identifies selected-year included-in-units income. Unknown
ordinary dividend conventions leave gross dividend base, reclaim, and net cost null; included-in-
units dividends do not enter dividend income/WHT estimates.

Source scope preserves `usePortfolioTaxData` rather than introducing fiscal changes during the
native migration: first 500 name-ordered investment metadata rows, newest 1000 ordinary transactions
per investment, active canonical summaries, and inactive `archivedPresentation` summaries from
[[docs/api/portfolio-summary|Portfolio Summary]]. Ordinary recorded costs use latest stored rates
over fallbacks and retain the existing original-amount display fallback when a currency rate is
unavailable, even when a transaction stores dated FX. Archived ordinary gains/current values keep
the web current-FX presentation; active canonical gains retain their dated attribution. A historical
selection changes recorded cost/dividend/buy-leg years, manual adjustment keys and annual tax tables;
realized/unrealized gains and current-value estimates remain the current all-time holdings figures.
PIT retains the selected overview's frozen-first number and existing currency behavior. Monthly
series include transaction months with zero costs and exclude manual adjustments. Explicit tax/fee
transactions retain existing breakdown bucket precedence, which can differ from aggregate recorded
costs when their own `taxes`/`fees` fields are also populated.

`records` returns both complete `portfolio_tax_adjustments_v1` and
`portfolio_tax_classifications_v1` settings plus untouched CAS `expected` baselines. Missing values
are null with `exists: false`; unknown fields, other-year adjustments, JSON null, and legacy raw
JSON-string baselines remain intact. Edits use the existing atomic [[docs/api/settings|Settings API]];
this endpoint never writes settings. `summaries` supplies the investment identity/currency/asset
class rows needed by those editors. Fiscal formulas and cost bucket logic stay in shared TypeScript,
including the frontend compatibility exports. Native clients decode money and rates directly as
`Decimal`; no fiscal or FX formula moves to Swift. See [[docs/features/portfolio-tax|Portfolio Tax]]
and [[docs/reference/native-parity/portfolio-wealth-tools|the wealth-tool action inventory]].

## Read Tax charts and widget data

`GET /api/belgian-tax/dashboard` is an additive, read-only operation. It accepts the same
optional four-digit `year`, a three-letter `currency` (default EUR), `start_date` and
`end_date` calendar dates, and repeatable `excluded_category_ids` / `excluded_recipient_ids`.
Malformed dates (including impossible days), IDs, repeated scalar inputs, and retired
`start`/`end` aliases return `400`. If bounds are omitted, the operation uses the first day
23 calendar months before today through today in the application timezone. Native callers
send their explicit calendar window and resolve the Statistics settings/hidden-category
exclusions before requesting the data. The server does not invent exclusion defaults.

The response supplies monthly income/reserve and yearly income/PIT/net series, selected-category
and recorded-data empty-state flags, recorded income per partner, recorded portfolio tax totals,
per-year display calculations/status, the four static tax-rule localization-key groups, live-profile
deduction suggestions, the viewed profile projection, and household breakdown display rows.
`exportProfile` includes the complete v1 projection used by the existing CSV format; the editable
source remains the v2 household. Fiscal amounts remain server-owned TypeScript results.

Chart estimates preserve the web hook's behavior: selected category ancestors include descendants;
positive income is split with account owner `partner` and half of `joint`; a frozen PIT scales by
the bar's gross relative to the frozen gross. Monthly reserves prorate one annual PIT over income
shares, limited to the viewed historical year or the live trailing twelve observed months. Trend
and comparison entries prefer frozen calculations verbatim. Legacy missing calculation fields stay
unavailable, including a null property-inclusive total when no property estimate was frozen.
Household rows are omitted for single-person households and legacy frozen filings without a frozen
household result.

Recorded portfolio taxes include active and inactive investments, explicit tax transactions and
per-transaction tax fields. They use the web's latest stored FX table with static fallback rates and
its original-amount fallback for an unavailable rate, rather than portfolio flow-date FX. Manual
adjustments are excluded from this recorded-only figure. Partner attribution and portfolio tax
helpers now live in the shared TypeScript package with frontend compatibility exports.

The operation uses the existing global and aggregation rate limits. Settings, aggregation,
portfolio, or rate-read failures return an error, never an empty setup prompt. It performs no
settings, migration, or filing writes. Targeted synthetic route tests cover category ancestry,
frozen scaling, partner attribution, recorded FX, exclusions, and read failures; macOS rendering
remains a separate native parity gate.

## Compute an unsaved household

`POST /api/belgian-tax/compute` exposes the same PIT and household engine used by the web
Tax screen. This is an additive, nonbreaking API; existing settings and report operations retain
their contracts. The shared implementation lives in `packages/shared-utils/src/belgianTax/`;
frontend paths remain compatibility exports with the existing lazy loading.

Send `{ "household": <complete v2 household> }` with JSON content type. The household has the
same fields and bounds as the `belgian_tax_household_v2` setting. Partner A is required; partner
and activity IDs must be unique; dependent, event, and mortgage references must name existing
partners; a death event names the deceased partner. `pensionKind` applies only to a pension,
and `netProfessionalIncome` only to `net_professional_amount`. Extra household fields are
accepted, as in settings; extra top-level request fields are rejected. See `openapi.yaml` for
the full field definitions and [[docs/api/settings|Settings API]] for storage.

Success uses the standard `{ ok: true, data: { result, calculation } }` envelope;
`result` and `calculation` are structured objects, not serialized JSON strings.

`result` includes the engine version, income year, assessment decision, partner and activity
breakdowns, marital quotient, special social security contribution (CSSS), property estimate,
household totals, and issue codes. `calculation` is the existing legacy-compatible PIT
presentation, including breakdown rows and monthly reserve. Monetary values use EUR and retain
the engine's precision. Rates keep their existing engine units. Generated Swift models use
`Decimal`, including rates; clients must not recalculate taxes.

Unsupported years retain the engine's table approximation and issue behavior. Engine limitations
and `needs_source` issues remain visible; this endpoint does not make estimates authoritative.
See [[docs/reference/belgian-tax-rule-matrix|the rule matrix]] and
[[docs/reference/belgian-tax-scenario-matrix|the verified scenarios]].

The operation is stateless: it does not read a profile, transactions, settings, snapshots, or
filing records and does not persist the submitted household. It supports unsaved previews and
historical inputs. Clients select the correct household first and continue to prefer a frozen
calculation for filed years. Filing and settings edits keep their existing compare-and-swap flow.

Invalid input returns `400 VALIDATION_ERROR` in the standard error envelope. The API CSRF guard
returns `403` for cross-site requests, and the global and aggregation rate limiters return `429`
when exceeded. Request bodies use the API's existing 1 MB JSON limit.

Native Tax UI, write-through profile editing, snapshot/freeze/filing actions and CSV export
are implemented in phase 3h. The PDF dialog remains web; the full macOS build and the owner's
Demo visual/keyboard pass are pending in [[docs/reference/native-parity/tax|the parity inventory]].
The web app still calculates through the same shared engine locally.
