---
title: "ADR-200: Belgian tax is computed for a household of one or two partners with income activities"
type: adr
status: accepted
date: 2026-10-11
tags: [adr, belgian-tax, household, joint-assessment, marital-quotient, settings, migration, adr-058, adr-059, adr-199]
description: "Replaces the single-person BelgianTaxProfile with a version-2 household (one or two partners, each with several income activities, dated relationship events) stored under new setting keys belgian_tax_household_v2 and belgian_tax_household_snapshots_v2. The assessment mode is derived per income year from WIB 92 art. 126; tax is computed per partner. The frontend upgrades v1 data automatically on first load with pure, idempotent functions; a one-partner household reproduces computeBelgianPIT exactly. Partner A/B is the contract for the phase C mapping to accounts.owner."
aliases: [adr-200, belgian tax household model, household taxation]
---

# ADR-200: Belgian tax is computed for a household of one or two partners with income activities

## Status

Accepted on 2026-10-11 (phase B1: library, settings schema and documentation). Phase B2 wires the
store, context, UI and native Demo seed; phase C links partners to account owners. Builds on
[[docs/adr/199-belgian-tax-source-verification|ADR-199]] (every rule cites a row of the
[[docs/reference/belgian-tax-rule-matrix|rule matrix]]) and keeps the snapshot model of
[[docs/adr/058-belgian-tax-historical-year-snapshots|ADR-058]] and
[[docs/adr/059-belgian-tax-historical-year-extensions|ADR-059]].

## Date

2026-10-11

## Context

`BelgianTaxProfile` describes one person with one `employmentType`, a `filingStatus` the user
chooses and a single `spouseProfessionalIncome` figure. That cannot represent a couple in which
each partner has several jobs or a job plus self-employment, cannot tell from the dates whether a
year is assessed jointly (WIB 92 art. 126: the year of marriage is separate, the year after
factual separation is separate, and so on), and taxes the spouse with the basic exemption only.
The TODO item "Revalidate all Belgian tax logic and implement household taxation" asks for both
partners, several activities per person and the legally applicable individual or joint treatment,
while preserving single-person results.

## Decision

1. **Model.** `BelgianTaxHouseholdV2` (`apps/frontend/src/lib/belgianTax/householdTypes.ts`)
   holds `version: 2`, the income year, region, communal surcharge, one or two partners (`A`
   always present, `B` optional), relationship events, shared dependants, the home (cadastral and
   mortgage fields, with the partner who claims the own-home credit) and migration notes. Each
   partner has income activities (`employee`, `civil_servant`, `director`,
   `self_employed_profits`, `self_employed_fees`, `helping_spouse`, `pension`,
   `other_professional`, `net_professional_amount`), an expense choice per art. 51 forfait
   category, personal deductions, reductions (same field names as the v1 profile), birth year and
   treaty-exempt income.
2. **Assessment.** `deriveAssessment` derives single / separate / joint for each income year from
   dated events (marriage, legal cohabitation and its end, factual cohabitation, factual
   separation, divorce, death) following art. 126 §§1-3. A migrated `married_joint` profile
   without dates is assumed joint and raises `relationship_dates_missing`.
3. **Engine.** `computeHouseholdTax` computes per partner (art. 126 §1 al. 2, art. 130): social
   security per activity, one forfait per category, the marital quotient on professional income
   only, the tax-free sum with the joint balance transfer, reductions, regional factor, surcharge,
   and the CSSS on the household income. Every rule cites a matrix row; behaviour without a
   verified source uses a stated default and returns a `needs_source` issue. `engineVersion: 2`
   is stored with each result.
4. **Settings keys.** The household is stored under `belgian_tax_household_v2`; year snapshots
   under `belgian_tax_household_snapshots_v2` (`Record<"YYYY", household>`, each key equal to its
   household's `taxYear`). Both are validated by
   zod schemas in `apps/node-backend/src/routes/belgianTaxSettingsSchemas.ts`, mirrored in
   `householdSchema.ts`. The existing `belgian_tax_profile_snapshot_meta_v1` sidecar keeps its key
   and gains `frozenHouseholdResult` next to `frozenCalculation`; audit entries gain
   `householdChanges`.
5. **Upgrade on load.** The upgrade is a frontend load-time step, not an Alembic migration: the
   values are settings blobs owned by the frontend. On first load the frontend upgrades the v1
   profile and snapshots with `upgradeProfileV1ToHousehold` / `upgradeSnapshotsV1ToV2` and writes
   the v2 keys. There is no confirmation step and no rollback path. The functions are pure,
   deterministic and idempotent (a v2 value passes through unchanged), so two devices loading the
   same v1 data produce the same household. This decision does not delete the v1 keys.
6. **Compatibility.** `toBelgianTaxCalculation` projects a household result onto the v1
   `BelgianTaxCalculation` shape with the same breakdown rows, and
   `projectHouseholdToProfileV1` / `applyProfileV1PatchToHousehold` let v1-shaped editors keep
   working during phase B2. A one-partner household with one activity reproduces
   `computeBelgianPIT` exactly; a golden parity harness runs every `pit.test.ts` case and a
   property test through both paths.
7. **Partner identity contract (phase C).** Partner ids are the fixed strings `A` and `B`. Phase C
   maps them to `accounts.owner` values so transactions can be attributed to a partner; that
   mapping is stored separately and never changes the partner ids in saved households or
   snapshots.

## Consequences

- Joint households are taxed per spouse: the second partner's exemption, disability supplement,
  reductions and the art. 134 balance transfer are now applied, so a `married_joint` v1 profile
  can show a different (legally closer) result after the upgrade. The documented differences are
  listed in `apps/frontend/src/lib/belgianTax/__tests__/householdParity.ts`.
- Open rules are visible as `needs_source` issues and in the matrix's open items instead of being
  silently assumed.
- The backend rejects malformed household values; unknown setting keys stay rejected.
- `computeBelgianPIT` is unchanged and remains the v1 engine until B2 switches the UI.

## Alternatives considered

- **Extend `BelgianTaxProfile` with a `spouse` sub-object.** Rejected: it keeps one employment type
  per person and keeps the filing status a user choice instead of a date-derived fact.
- **Alembic data migration of the settings rows.** Rejected: the values are frontend-owned JSON and
  the mapping lives in the frontend library; a backend migration would duplicate it.
- **Explicit confirmation before upgrading.** Rejected by the owner on 2026-10-11: the upgrade runs
  automatically.

## Related

- [[docs/features/belgian-tax#Household taxation|Feature - Belgian Tax, Household taxation]]
- [[docs/reference/belgian-tax-rule-matrix|Belgian Tax Rule Coverage Matrix]]
- [[docs/api/settings|Settings API]]
- [[docs/adr/index|ADR index]]
