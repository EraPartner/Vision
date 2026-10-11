---
title: "ADR-202: The household region decides the own-home regime, and each borrower has an own-home basket"
type: adr
status: accepted
date: 2026-10-11
tags: [adr, belgian-tax, household, own-home-credits, woonbonus, cheque-habitat, regional-competence, adr-054, adr-200]
description: "Supersedes ADR-054 for the mortgage region only: the regional own-home regime follows the household's region (the fiscal domicile on 1 January of the assessment year, special finance law art. 5/1 §2), and `mortgageRegion` is deprecated but kept in stored data. Adds `home.mortgageSharePartnerB`, which gives each of two borrowers their own woonbonus or chèque habitat basket."
aliases: [adr-202, belgian tax region competence, own-home baskets]
---

# ADR-202: The household region decides the own-home regime, and each borrower has an own-home basket

## Status

Accepted on 2026-10-11. Supersedes [[docs/adr/054-belgian-regional-own-home-credits|ADR-054]]
only where it introduced `mortgageRegion` as an override of the region. The rest of ADR-054 and
all of [[docs/adr/200-belgian-tax-household-model|ADR-200]] stand.

## Date

2026-10-11

## Context

ADR-054 let the user record the region "where the mortgage was signed" (`mortgageRegion`), and
the engines chose the Flemish woonbonus or the Walloon chèque habitat from that field before the
taxpayer's region. The special finance law of 16 January 1989 does not support that choice:

- Art. 5/1 §2: the personal income tax is "geacht te zijn gelokaliseerd op de plaats waar de
  belastingplichtige zijn fiscale woonplaats heeft gevestigd op 1 januari van het aanslagjaar".
- Art. 5/5 §4, 1°: the regions are exclusively competent for the own-home reductions, and the
  definition of the own home does not require the home to lie in that region.

A resident of Flanders who owns a home in Wallonia therefore gets the Flemish regime, if any.

ADR-200 gave the whole own-home credit to one partner (`mortgageCreditPartnerId`). The regional
texts give a basket to each taxpayer: the Flemish caps apply "per belastingplichtige", and spouses
under a joint assessment "kunnen ... deze uitgaven vrij verdelen binnen de begrenzingen" (Flemish
arts 145/37 §3 and 145/38/2 §3; FPS circular 2026/C/63). The Walloon chèque habitat is "une
réduction d'impôt forfaitaire et individuelle", capped "par contribuable", with the payments split
"au prorata de la part de propriété" (art. 145/46ter; FPS circular 2026/C/18). The sources are
listed in [[docs/reference/belgian-tax-rule-matrix|the rule matrix]] (LSF, W1, C63, C51, C18).

## Decision

1. **Region.** `resolveMortgageRegime` reads `region` only. In the household it is
   `household.region`; in the v1 profile it is `profile.region`. `mortgageRegion` is deprecated:
   the field stays in the v1 and v2 types and schemas, the v1 upgrade still copies it unchanged
   (the upgrade stays deterministic and idempotent), and the upgrade rewrites no stored value.
   When a stored `home.mortgageRegion` differs from the household region, the household engine
   raises `mortgage_region_not_used` (info). The home step no longer shows the mortgage-region
   select, and the next edit of a home field (in the home step, or a v1 patch with a home field
   through `applyProfileV1PatchToHousehold`) drops the stored value, so the note clears after
   one edit. A v1 patch never writes `mortgageRegion`.
2. **Two borrowers.** The optional `home.mortgageSharePartnerB` (0-100) is partner B's share of
   the payments; in Wallonia, B's ownership share. Strictly between 0 and 100, with both partners
   assessed, each partner has an own-home basket (`householdOwnHome.ts`):
   - Flemish woonbonus: each borrower's cap and rate. Under a joint assessment the payments go
     first to the part of each basket whose credit the spouse's tax can absorb (the tax after the
     tax-free sum and the other reductions), the higher rate first; at equal rates each borrower
     keeps their own payments and only what they cannot use moves to the other. Payments left
     over then fill the caps, and credit that still exceeds a spouse's tax raises
     `joint_reduction_allocation_unverified`. Otherwise each borrower claims their own share.
   - Walloon chèque habitat: each borrower's amount on their own taxable income, capped at
     their share of the payments. Under a joint assessment the €125 per child goes first to the
     borrower with the most room under that cap; otherwise only the borrower who claims the
     children gets it.
3. **One borrower stays the default.** Without the share, or with 0 or 100, the one-borrower path
   of ADR-200 applies (100 names B, 0 names A). Removing partner B drops the share.

## Consequences

- A household whose `mortgageRegion` differed from its region may see its own-home credit change
  or disappear; the info issue explains why. Nothing is migrated, so a later decision can still
  read the stored field.
- The v1 engine follows the same region rule; the v1 profile has no two-borrower input.
- A couple that shares a loan can now claim up to two baskets. The two-borrower path does not
  model a second home or the per-period history of each borrower: one
  `home.firstQualifyingYear` serves both chèque-habitat borrowers.
- Because the joint woonbonus split reads each spouse's tax, the own-home credit is recomputed
  for every marital-quotient step that the art. 88 comparison evaluates.

## Related

- [[docs/adr/054-belgian-regional-own-home-credits|ADR-054]]
- [[docs/adr/200-belgian-tax-household-model|ADR-200]]
- [[docs/reference/belgian-tax-rule-matrix|Belgian Tax Rule Coverage Matrix]]
- [[docs/features/belgian-tax]]
- [[docs/adr/index|All ADRs]]
