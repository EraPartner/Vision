---
title: "ADR-267: Classify holdings by hand"
type: adr
status: Accepted
date: 2026-11-05
tags: [adr, portfolio, exposure, classification, sqlite, migration, adr-150]
description: "Holdings get their sector, issuer country and issuer in the app, one at a time or in bulk. Values set by hand are marked manual and later source imports skip them. A whole ETF without a holdings document can be classified and then counts as classified instead of uncovered. Amends ADR-150."
aliases: [adr-267, manual holding classification, classify holdings]
related_code:
  [
    "db/migrations/0003_exposure_classification_origin.sql",
    "apps/node-backend/src/services/portfolio/portfolioExposureService.ts",
    "apps/node-backend/src/repositories/portfolioExposureRepository.ts",
    "apps/frontend/src/features/portfolio/ClassifyHoldingsDialog.tsx",
  ]
---

# ADR-267: Classify holdings by hand

## Status

Accepted on 2026-11-05 (Tor). Amends [[docs/adr/150-explicit-portfolio-look-through-exposure|ADR-150]]:
its source bundle, fund look-through and coverage rules stay.

## Context

[[docs/adr/150-explicit-portfolio-look-through-exposure|ADR-150]] made sector, issuer country and
issuer exposure depend on explicit classifications, but the only way to supply one was a typed
JSON source bundle. Tor asked for a way to assign sectors and similar fields to holdings in the
UI, without an import. Two questions followed: what a later import does to a value set by hand,
and whether an ETF without a holdings document can carry one classification for the whole fund.

## Decision

- **Where**: a Classify holdings sheet, opened from the Portfolio exposure card (all active
  holdings, with search, multi-select and "apply sector or country to selected") and from each
  holding's ••• menu (that holding only). It edits sector (free text with suggestions from the
  sectors in use and the eleven GICS sector names), issuer country (ISO 3166-1 alpha-2, picked
  by name) and issuer (defaults to the holding name).
- **Storage**: the same `portfolio_exposure_classifications` rows, targeted by investment ID.
  Migration `0003_exposure_classification_origin` adds `origin` (`import` | `manual`, default
  `import`), so every existing row stays an import. Rows saved from the sheet are `manual` with
  source label `Set in Vision`. The issuer ID is reused from the holding's own row or any row with
  the same issuer name (case and spacing ignored), so a direct holding and a fund constituent of
  one issuer still group together; otherwise it is `name:<normalized name>`.
- **Manual wins** (Tor: "good"): `PUT /api/investments/exposure/sources` skips rows whose origin
  is `manual` and returns their IDs as `keptManualInvestmentIds`; the card says how many were
  kept. Clearing a holding in the sheet deletes its row, so the next import may set it again.
- **Whole-ETF classification** (Tor: "yes"): an ETF or fund without a holdings document and with
  a direct classification counts as a direct, classified position instead of uncovered. A fund
  with a holdings document keeps look-through; its direct classification is ignored and the sheet
  marks it "Look-through".
- **API**: `GET` and `PUT /api/investments/exposure/classifications` (additive).

## Consequences

- Users can classify holdings without writing JSON; bundles keep working for fund constituents
  and bulk sources.
- A re-import never silently overwrites a value the user typed; to hand a holding back to
  imports the user clears it.
- A direct classification on an ETF that an earlier bundle supplied, and that ADR-150 ignored,
  now counts when the ETF has no holdings document.
- Rolling back the migration drops `origin`; manual rows remain as ordinary rows that a later
  import may overwrite.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/150-explicit-portfolio-look-through-exposure|ADR-150]]
- [[docs/features/portfolio|Portfolio]]
- [[docs/api/investments|Investments API]]
