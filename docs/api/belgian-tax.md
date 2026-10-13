---
title: Belgian Tax Computation API
type: endpoint
status: active
date: 2026-10-13
updated: 2026-10-13
method: POST
path: /api/belgian-tax/compute
tags: [api, tax, belgian, native, adr-204]
description: Stateless access to the shared TypeScript household tax engine for native clients.
related_code:
  - apps/node-backend/src/routes/belgianTax.ts
  - packages/shared-utils/src/belgianTax/household.ts
  - apps/native/Sources/VisionNativeCore/Screens/Tax/TaxComputationService.swift
---

# Belgian Tax Computation API

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

The native computation adapter is implemented; native Tax UI and profile/frozen-filing workflows
remain pending in [[docs/reference/native-parity/tax|the parity inventory]]. The web app still
calculates through the same shared engine locally.
