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
refresh of the same year keeps the prior snapshot and exposes the error. Native Tax UI and
filing/editing actions remain pending.

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

The native computation adapter is implemented; native Tax UI, profile editing, and filing actions
remain pending in [[docs/reference/native-parity/tax|the parity inventory]]. The web app still
calculates through the same shared engine locally.
