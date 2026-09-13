---
title: Provider-Neutral Transaction Provenance
type: reference
status: active
date: 2026-09-12
tags: [reference, imports, provenance, migration]
description: Durable provider-neutral source archives, provenance links, and atomic manual-transaction identity claims.
aliases: [transaction provenance, neutral import provenance]
related_code:
  - alembic/versions/0108_provider_neutral_provenance.py
  - apps/node-backend/src/services/deduplication.js
  - alembic/manual/contract_drop_provider_raw/up.sql
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

Migration 0108 performs only expand and backfill. The contract at
`alembic/manual/contract_drop_provider_raw/` is deliberately out of band. The operator waived an
elapsed-time soak on 2026-09-13. Do not run it against a maintained database until the
stopped-writer check, count/payload/link parity, and logical backup restore test are complete.

## Related

- [[docs/adr/141-provider-neutral-transaction-provenance|ADR-141: Provider-Neutral Transaction Provenance]]
- [[docs/features/import|Transaction Import]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/guides/migrations|Database Migrations]]
