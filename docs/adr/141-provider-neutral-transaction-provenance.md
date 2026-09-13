---
title: ADR-141 - Provider-Neutral Transaction Provenance
type: adr
status: Accepted
date: 2026-09-12
tags: [adr, imports, provenance, migration, deduplication]
description: Replace provider-specific raw tables with an exact neutral archive, preserved links, and a separate manual duplicate-claim boundary.
---

# ADR-141: Provider-Neutral Transaction Provenance

## Context

The active import pipelines use batch staging, but eight older raw tables still hold durable history.
Seven have no runtime consumer. `manual_raw_transactions` still supported duplicate detection, and
`transaction_raw_references` may be the only record of historical many-to-many provenance. Terminal
staging is deleted after 30 days, so it cannot replace this history.

## Decision

Migration 0108 adds `transaction_source_records`. One row stores the source type, original identifier,
creation time, duplicate hash, exact CSV line, and the complete old row as JSONB. The unique
`(source_type, legacy_source_id)` key makes the backfill restart-safe. Explicit linked, unlinked, and
dangling-reference status prevents silent loss. `transaction_source_links` preserves the old link and
its original transaction identifier even when the transaction no longer exists.

The durable archive accepts historical duplicate-hash text exactly as stored. Only valid 64-character
hexadecimal hashes enter the operational manual-claim table. Invalid historical values remain in the
archive and make the later active-claim parity gate fail closed instead of blocking lossless expansion.

Manual duplicate identity moves to `manual_transaction_dedup_claims`. The service now takes a
transaction-scoped advisory lock on the versioned identity, then reads and writes
that neutral table; field matching remains the rolling-deployment fallback. Deleted transactions clear
the claim link, and re-adding the same manual transaction reclaims it.

The migration is additive. The old tables remain a rollback copy until a later maintenance window.
The out-of-band contract supports both known fresh-install shapes, locks all stores, and requires exact
source/archive counts, complete JSONB equality, link parity, active manual-claim parity, stopped writers,
and a restore-tested backup before any drop.

## Consequences

- Backup and restore now cover provider-neutral provenance and manual claims.
- New code no longer depends on provider-specific tables.
- Historical native fields remain available without freezing eight table contracts.
- Destructive removal is still installation-specific and cannot be inferred from Alembic revision.

The maintained-installation operator waived an elapsed-time soak on 2026-09-13. This does not waive
the stopped-writer locks, exact source/archive/link parity, or restore-tested backup required by the
manual contract.

The maintained installation then passed the concrete retirement gate: 4,445 legacy source rows and
4,445 links were preserved with zero parity mismatches, the old relations were removed, and the
combined post-cleanup dump and isolated PostgreSQL 18 restore acceptance passed. The guarded
contract remains available for other installations.

## Related

- [[docs/reference/provider-neutral-transaction-provenance|Provider-Neutral Transaction Provenance]]
- [[docs/adr/134-versioned-import-identity-and-exact-provenance|ADR-134]]
- [[docs/adr/002-database-schema|Database Schema]]
