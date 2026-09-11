---
title: ADR-135 Compatibility Cutoff for September Retirements
type: adr
status: accepted
date: 2026-09-11
tags:
  [
    adr,
    compatibility,
    breaking-change,
    migrations,
    settings,
    recurrence,
    belgian-tax,
    insights,
  ]
description: Ends five legacy client, recurrence, tax-result, and browser-profile compatibility paths, with a guarded JSONB rewrite for frozen Belgian-tax calculations.
aliases: [September compatibility cutoff, legacy retirement cutoff]
---

# ADR-135: Compatibility Cutoff for September Retirements

## Status

Accepted

## Date

2026-09-11

## Context

Vision still carried five bounded compatibility groups after their canonical replacements existed:

- transaction responses duplicated `transaction_date` as `date`, and the frontend accepted either;
- portfolio and planned recurrence paths normalized `bi-weekly` to `biweekly`;
- Belgian-tax calculations emitted `federalPITTotal` beside `federalPITBeforeExemption`;
- settings hydration imported `enhancedEffects`, browser dashboard settings, and Chart Builder v1 storage;
- app startup copied browser-only insight dismissals to the server before releasing the application.

The browser-only populations cannot be measured centrally. Migration 0099 has not appeared in a
tagged release, so its planned one-release recurrence window did not elapse. The explicit delivery
request therefore acts as an early breaking cutoff rather than evidence that those earlier gates
passed.

Frozen Belgian-tax calculations are different because they can be stored in
`user_settings['belgian_tax_profile_snapshot_meta_v1']`. Static ownership tracing found no other
persisted consumer and no pre-existing persisted fixture containing the alias. New migration tests
intentionally exercise the legacy field. The whole `user_settings` table
is already included in database backups.

## Decision

- Transaction API responses and frontend fixtures use only `transaction_date`. A list response
  without a non-empty canonical field is rejected as malformed. Request-side `date` compatibility
  is a separate surface and remains unchanged.
- Runtime recurrence input and output accept only `biweekly`. Migration 0099 remains responsible
  for rewriting and constraining stored portfolio values.
- Migration 0106 checks that every persisted `federalPITTotal` is numeric and equal to a numeric
  `federalPITBeforeExemption`, then removes the alias atomically. It refuses alias-only, malformed,
  or divergent data. Downgrade reconstructs the alias from the canonical value. New settings
  writes containing the alias are rejected.
- App and dashboard settings hydrate from canonical server fields only. Chart Builder reads only
  the bounded v2 library. App startup no longer imports browser-only insight dismissals.
- The compatibility horizon for unopened browser profiles ends on this date. Legacy browser keys
  are neither read nor deleted by current code.

## Consequences

- Older servers that return only transaction `date`, older clients that send `bi-weekly`, and
  unopened browser profiles that skipped all intermediate migration builds are no longer supported.
- Existing v2 Chart Builder layouts, server-backed settings, server-backed insight dismissals, and
  current tax snapshots remain supported.
- Database startup fails closed if tax snapshot aliases cannot be proven equivalent. Operators must
  inspect and repair or restore the one settings row before retrying; the migration never guesses.
- Database upgrade and downgrade execution still require an environment with `TEST_DATABASE_URL`.
  Static review and skipped database tests are not substitutes for that run.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/130-canonical-biweekly-recurrence|ADR-130: Canonical biweekly recurrence]]
- [[docs/features/belgian-tax|Belgian Tax]]
- [[docs/features/settings|Settings Feature]]
- [[docs/features/statistics|Statistics]]
- [[docs/features/research|Research]]
- [[docs/api/transactions|Transactions API]]
