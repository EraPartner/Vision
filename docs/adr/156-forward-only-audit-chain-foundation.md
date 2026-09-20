---
title: ADR-156 - Forward-Only Audit Chain Foundation
type: adr
status: Accepted
date: 2026-09-20
tags: [adr, audit, security, database, backup, migration-0117]
description: Start a versioned audit hash chain after the existing audit rows, preserve its database state in backups, and defer any tamper-evidence claim until an independent anchor and lifecycle verification exist.
aliases: [audit chain foundation, audit cutover]
---

# ADR-156: Forward-Only Audit Chain Foundation

## Context

Vision already has `db_editor_audit`, `split_audit`, and `portfolio_retag_audit` rows. Their historical payloads were not written under a shared hash contract. Rewriting them into a new chain would assert a provenance that the application cannot verify. A hash chain stored only in PostgreSQL can detect ordinary broken links, but a privileged writer can rewrite the whole chain or restore an older self-consistent database.

## Decision

- Migration `0117_audit_chain` creates `audit_chain_head`, `audit_chain_entries`, and `audit_chain_checkpoints`. The one head row records the highest legacy ID in each of the three existing audit tables at upgrade. This is a forward-only cutover marker, not a hash of earlier rows. The migration does not rewrite historical audit data.
- Migration 0117 removes `split_audit.split_id`'s `ON DELETE SET NULL` foreign key. Deleting a split can no longer erase the original split ID from an audit row. Dangling IDs are intentional provenance; consumers must not treat them as live references.
- Each future entry has a sequence, format version, previous hash, entry hash, JSON payload, and creation time. `appendAuditEvent` locks the head row and appends the entry while updating the head in the caller's database transaction. A caller must put the domain mutation in that same transaction.
- Database triggers reject updates, deletes, and truncation of entries and checkpoint metadata, and reject deletion or truncation of the head. These triggers protect normal application writes. They do not constrain a privileged database administrator.
- All three new tables are registered for normal backup coverage. Checkpoint rows can record metadata for a receipt that an independent anchor has already stored. A checkpoint row inside the same database is not itself an independent anchor.
- Downgrade is allowed only while both entries and checkpoints are empty. Once history exists, migration 0117 refuses ordinary downgrade; recovery needs a reviewed restore or a separate preservation contract. Re-adding the old split foreign key also fails if any retained non-null split ID has no matching split.

## Consequences and release boundary

The schema and repository supply a recoverable chain foundation and an exact legacy cutover. The audit TODO remains open. No independent anchor, startup or restore verification, or complete tamper-evidence guarantee is established by this migration. A restored backup can contain an internally valid but older chain until checked against an external receipt. Apply the migration to user data only through the separately approved database-migration workflow.

## Later implementation note (2026-09-20)

Online PostgreSQL Alembic now appends a deterministic `schema_migration` entry for 0117's own upgrade inside its migration transaction. Therefore the originally stated empty-entry downgrade case cannot occur after a normal online upgrade. The implemented downgrade permits only that sole matching 0117 upgrade entry, its matching head and unchanged legacy high-water IDs, and no checkpoint. Any later migration or domain entry, or any checkpoint, still refuses downgrade. [[docs/adr/157-electron-local-audit-receipt|ADR-157]] records the later verification and receipt boundary; the original foundation decision above remains historical.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/157-electron-local-audit-receipt|ADR-157: Later Electron receipt decision]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/security/data-protection|Data Protection]]
- [[docs/diagrams/backend-database-schema.puml|Database Schema]]
