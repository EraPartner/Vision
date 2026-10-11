---
title: "ADR-201: Tax partners map to account owners by a fixed rule"
type: adr
status: accepted
date: 2026-10-11
tags: [adr, belgian-tax, household, accounts, account-owner, attribution, adr-200]
description: "Supersedes ADR-200 §7 for the mapping only: partner A is the account owner `me`, partner B is `partner`, and `joint` accounts are split 50/50. The mapping is fixed in code, not stored. Transactions without an account count as `me`. The backend reports amounts per owner; the frontend maps them to partners. A one-partner household attributes everything to partner A."
aliases: [adr-201, tax partner account mapping]
---

# ADR-201: Tax partners map to account owners by a fixed rule

## Status

Accepted on 2026-10-11 (phase C2 of the household workstream). Supersedes
[[docs/adr/200-belgian-tax-household-model|ADR-200]] §7 only where it says the partner-to-owner
mapping "is stored separately". The rest of §7 stands: partner ids stay the fixed strings `A` and
`B`, and the mapping never changes them in saved households or snapshots.

## Date

2026-10-11

## Context

Phase C attributes figures derived from transactions (recorded income per income category,
deductible spending such as pension savings, donations or childcare) to the partners of the
household. Accounts already carry `owner` (`me` | `partner` | `joint`, migration 0050). A stored,
user-editable mapping would need a new setting, an editor and a migration path, while the three
owner values already name the two people and their shared accounts.

## Decision

1. **Fixed mapping.** `me` → partner A, `partner` → partner B, `joint` → half to A and half to B.
   The mapping lives in `apps/frontend/src/lib/belgianTax/partnerAttribution.ts` and is not
   stored.
2. **Unowned transactions.** A transaction without an account counts as `me` (the column
   default), so it goes to partner A.
3. **Backend reports owners, not partners.** `GET /api/info/deduction-candidates` returns each
   total split as `byOwner: { me, partner, joint }`, and `GET /api/aggregations/category-pivot`
   cells carry `incomeByOwner: { partner?, joint? }` when non-zero. Both fields are additive.
   The frontend applies the mapping, so the backend has no tax-partner concept.
4. **One partner.** Without partner B every amount goes to partner A, so a single-person
   household gets exactly the figures, actions and exports it had before.
5. **Rounding.** Partner B's share is rounded to cents; partner A receives the total minus that
   share, so the two shares always add up to the total.

## Consequences

- A couple whose accounts are owned differently from how they file (for example a `me` account
  that holds the partner's salary) must change the account owner; there is no per-household
  override.
- Changing an account owner clears the statistics response cache so the split follows at once.
- A stored mapping can still be added later with a new ADR; the owner-level API fields would stay.

## Alternatives considered

- **Stored mapping setting (ADR-200 §7 as written).** Rejected by the owner on 2026-10-11 as
  unnecessary for the three fixed owner values.
- **Backend returns partner shares.** Rejected: it would move a tax rule into the statistics
  layer and duplicate the frontend household model.

## Related

- [[docs/adr/200-belgian-tax-household-model|ADR-200]]
- [[docs/features/belgian-tax#Partner attribution|Feature - Belgian Tax, Partner attribution]]
- [[docs/api/info|Info API]]
- [[docs/api/aggregations|Aggregations API]]
