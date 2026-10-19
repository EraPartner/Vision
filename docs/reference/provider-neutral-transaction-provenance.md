---
title: Provider-Neutral Transaction Provenance
type: reference
status: active
date: 2026-10-19
tags: [reference, imports, provenance, migration]
description: Durable provider-neutral source archives, provenance links, and atomic manual-transaction identity claims.
aliases: [transaction provenance, neutral import provenance]
related_code:
  - db/migrations/0001_baseline.sql
  - apps/node-backend/src/services/deduplication.ts
---

# Provider-Neutral Transaction Provenance

`transaction_source_records` is the durable source archive. `native_payload` is the complete JSONB
representation of the source row; `raw_csv_line` separately preserves the exact CSV text where it
exists. `migration_status` is `linked`, `unlinked`, or `dangling-reference`.

`transaction_source_links` owns provenance relationships. `transaction_id` is nullable and follows a
deleted canonical row to null. `legacy_transaction_id` remains immutable so a dangling historical link
is still explainable.

`manual_transaction_dedup_claims` is operational identity, not raw bank data. Its hash points only to
the current live transaction; deleting and re-adding may reclaim the same hash. Manual creation holds
a transaction-scoped PostgreSQL advisory lock derived from that versioned hash across duplicate
checking, transaction insertion, and claim insertion, so concurrent identical requests cannot both
pass the check. Unexpected claim failures roll back the transaction. A missing claim table is the
only tolerated rolling-deployment fallback.

Manual identity now uses `manual-v3`: a JSON tuple of version, calendar date, canonical decimal
amount rounded to the ledger's four decimal places (ties away from zero), nullable recipient ID,
trimmed uppercase memo, canonical account identity and normalized
currency. The same recipe controls the advisory lock and new claims. A claim hit must still match
the current active transaction fields, so editing a transaction does not reserve its old identity.
Legacy claims remain readable metadata; live-field fallback detects their current transactions
without rewriting historical hashes. The fallback includes currency and matches absent recipients.
Its memo trimming uses the same whitespace set as JavaScript, including tabs, line breaks and
Unicode spaces on historical rows.
Import fingerprints and their compatibility contract are unchanged.

Historical migration 0108 performed only expand and backfill; the per-bank raw tables were later
dropped by the out-of-band `contract_drop_provider_raw` operation. The `0001` baseline
([[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]) has the contracted shape: it
contains `transaction_source_records`, `transaction_source_links` and
`manual_transaction_dedup_claims`, and no per-bank `*_raw_transactions` tables. The manual
contract scripts were deleted with the Alembic tree.

## Related

- [[docs/adr/141-provider-neutral-transaction-provenance|ADR-141: Provider-Neutral Transaction Provenance]]
- [[docs/features/import|Transaction Import]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/guides/migrations|Database Migrations]]
