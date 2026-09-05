---
title: ADR-119 Trigger-Owned Updated-At Policy
type: adr
status: Accepted
date: 2026-09-04
updated: 2026-09-04
tags: [adr, database, postgresql, timestamps, migrations, observability]
description: Every mutable table with an updated_at column uses the shared PostgreSQL trigger; mutable staging and preference tables gain updated_at when change timing matters.
aliases: [adr-119, updated-at-policy]
---

# ADR-119: Trigger-Owned `updated_at` Policy

## Status

Accepted

## Context

Vision mixed database triggers with application-written `updated_at` values. Four tables exposed the
column without a trigger, while two staging tables and `investment_ticker_prefs` could change without
recording when the change occurred. This made timestamps depend on which write path happened to run.

## Decision

Every ordinary mutable table that has an `updated_at` column uses the shared PostgreSQL
`update_updated_at_column()` `BEFORE UPDATE` trigger. Application code may still supply a timestamp,
but the trigger is the final authority.

`agg_split_outstanding` is the deliberate exception. It is not edited as an ordinary entity. Its
`fn_agg_split_outstanding_sync` function rewrites the aggregate values and `updated_at` together, so
adding a second timestamp trigger would duplicate ownership without covering another write path.

Migration 0092 attaches the trigger to `exchange_rates`, `user_settings`, `ai_conversations`, and
`provider_health`. It adds `updated_at` and the same trigger to `investment_ticker_prefs`,
`import_staging_rows`, and `portfolio_import_staging_rows`.
Existing staging rows inherit `created_at`; existing ticker-preference rows use migration time because
that table has no creation timestamp.

## Consequences

- All write paths produce the same modification-time behavior.
- The trigger-maintained split aggregate keeps function-owned timestamp maintenance as an explicit,
  tested exception.
- Import diagnostics can distinguish staging creation from later matching, repair, or commit changes.
- Existing application-side timestamp assignments remain compatible but are redundant.
- Downgrade removes the seven triggers and only the three columns introduced by migration 0092.
- The migration must be executed and rolled back against disposable PostgreSQL before release; this
  desktop session did not apply it to user data.

## Related

- [[alembic/versions/0092_updated_at_policy.py|Migration 0092]]
- [[docs/reference/data-model|Data Model]]
- [[docs/reference/code-patterns|Code Patterns]]
