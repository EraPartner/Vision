---
title: "ADR-217: Compute Belgian tax figures on the server"
type: adr
status: accepted
date: 2026-10-19
tags: [adr, architecture, tax, belgian, frontend, api, adr-200]
description: "Accepted on 2026-10-19 by the owner. The web app no longer runs the Belgian PIT/household engine. The store hydrates from GET /api/belgian-tax/overview, the editor's live figures come from a debounced POST /api/belgian-tax/compute, and freezing, filing, CSV and PDF exports use server figures. The engine, including the assessment and the year tables, leaves the browser bundle. Amends the lazily loaded engine of ADR-200 phase B2."
aliases: [adr-217, server tax figures, belgian tax on the server]
---

# ADR-217: Compute Belgian tax figures on the server

## Status

Accepted on 2026-10-19 by the owner. It amends the lazily loaded browser engine of
[[docs/adr/200-belgian-tax-household-model|ADR-200]] (phase B2); the household model itself is
unchanged.

## Date

2026-10-19

## Context

The PIT and household engine moved to `packages/shared-utils/src/belgianTax/` and is served by
`POST /api/belgian-tax/compute`, `GET /api/belgian-tax/overview` and the tax dashboards. The web
store still ran the same engine in the browser for the live household, every snapshot year,
freezing, filing and both exports. The owner chose to defer calculations to the server and to
take the engine out of the browser bundle, with the editor's live preview computed by the server
after a short debounce.

## Decision

- `BelgianTaxProfileProvider` hydrates the store from `GET /api/belgian-tax/overview`: the
  upgraded live household, its snapshots and metadata, and the CAS baselines of the three stored
  keys from the same read. The store adopts those baselines for later saves; the provider still
  writes the v2 keys once when the overview reports a pending upgrade.
- The store keeps household edits as local state; it no longer holds a calculation or household
  result. `useTaxYearFigures(year)` returns the frozen figures of a frozen year, else the result of
  `POST /api/belgian-tax/compute` on the year's household, debounced by 300 ms. Each household is
  its own React Query entry, so an older response never replaces a newer one, a superseded request
  is aborted, and the previous figures of the same year stay on screen while an edit computes.
  The overview's figures seed the hydrated household, so the first render needs no compute call.
- Freezing, filing (`persistTaxFiling`), the year CSV and the PDF report's precomputed PIT and
  household blocks use the server's figures for the year's household (`computeTaxYearResults`,
  `resolveTaxYearFigures`). The stored frozen metadata keeps its shape: `frozenCalculation` and
  `frozenHouseholdResult` are the compute response verbatim.
- The browser keeps only shape helpers: the v1 projection and patch, the zod household schema and
  the Art. 51 category map (`forfaitCategory.ts`, split out of `household.ts`).
- The v1 projection and patch (`householdMigration.ts`) take the joint-filing decision as an
  argument. The server passes `filesJointly` (`assessment.ts`: a migrated joint profile without
  relationship events stays joint, otherwise the art. 126 assessment decides), so its projections
  are unchanged. The browser passes none: with partner B its projection leaves `filingStatus` out,
  and the year CSV takes the filing status from the server's `assessment` of the year (empty for a
  year frozen before household results were stored). No browser editor patches the spouse fields
  without a filing status, so the browser's patches are unchanged.
- The supported income years and the latest default communal surcharges move to `taxYears.ts`, so
  the profile defaults and the region step no longer load the year tables. `constants.ts`
  re-exports them and refuses to load when they disagree with its tables.
- The engine wrappers and their re-exports leave `apps/frontend/src/lib/belgianTax/`. The engine's
  unit, property and scenario tests move to `packages/shared-utils/tests/belgianTax/` with their
  expected values unchanged and run with `bun run test:packages` in CI.

## Consequences

- No Belgian tax engine module reaches the browser bundle: no PIT, person, quotient, exemption,
  own-home, property, social-security, assessment or year-table code (boot 461.15 → 456.52 →
  454.44 KB gz, all assets 1379.95 → 1369.83 → 1367.28 KB gz; the bundle budgets are lowered to
  456 / 1369 KB).
- Edited figures, including the household step's assessment badge, appear about 300 ms after the
  last keystroke plus a round trip. A failed computation replaces the figures with an error until
  the next edit.
- The tax screen needs the backend for any figure, as the dashboards already did.
- The browser's v1 profile of a two-partner household has no `filingStatus`; consumers that need
  it read the server's `assessment`.
- `taxYears.ts` repeats facts of the year tables; adding a year means updating both, which the
  load-time check and `taxYears.test.ts` enforce.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/features/belgian-tax|Belgian Tax feature]]
- [[docs/api/belgian-tax|Belgian Tax API]]
