---
title: ADR-157 - Electron Local Audit Receipt and Private Bridge
type: adr
status: Accepted
date: 2026-09-20
tags: [adr, audit, security, electron, backup, restore]
description: Bind the forward-only database audit chain to a local main-process receipt and verify it at native startup and before restore activation.
aliases: [Electron audit receipt, audit bridge decision]
---

# ADR-157: Electron Local Audit Receipt and Private Bridge

## Context

[[docs/adr/156-forward-only-audit-chain-foundation|ADR-156]] records a forward-only hash chain and its migration cutover. PostgreSQL stores the head, entries, and checkpoint metadata. An internally valid database can still be rolled back or rewritten by someone with sufficient database access. The native desktop needs a checkpoint outside that database and a way to compare it before accepting a restored database.

## Decision

- Electron's main process stores a versioned HMAC-signed receipt and its `safeStorage`-encrypted key under the local application-data `audit-anchor/` directory, outside PostgreSQL and the Vision backup bundle. The receipt binds the sequence, chain hash, and the three legacy high-water IDs captured by migration 0117. Missing, partial, corrupt, or inconsistent files do not silently create a replacement anchor.
- A new native backend child receives a random per-launch token through the allowlisted `VISION_AUDIT_BRIDGE_TOKEN` environment variable. Three private `/api/internal/audit` POST routes require both this Bearer token and a loopback socket peer. The renderer and ordinary admin token do not receive this authority. The main process sends an authenticated checkpoint to the verify route, then records receipt metadata through the checkpoint route after persisting the local receipt.
- Verification scans the complete versioned chain, its database head, the supplied checkpoint, and linked post-cutover domain audit rows. It checks the migration cutover IDs against the signed local receipt. Older audit rows remain explicitly unverified. A checkpoint behind the database head verifies only its prefix and returns `partially_verified`.
- PostgreSQL Alembic revision application and stamps append `schema_migration` entries after migration 0117 creates the chain, in the same revision transaction. Entries record direction, revision, and resulting heads. Verification compares the latest chained heads with `alembic_version`. Pre-0117, SQLite, and offline migrations have no such entry.
- The 0117 downgrade recognizes only its sole deterministic upgrade entry with a matching head, unchanged legacy high-water IDs, and no checkpoint. Any later or domain event or any checkpoint blocks downgrade. This narrows the empty-history rollback wording in ADR-156 after migration auditing was added.
- The native main process verifies at startup before first navigation and after backend recovery. An exact verified head starts a trusted live session. Every 30 seconds while the backend remains healthy, the main process verifies the full chain and signed cutover again, then advances the local receipt to a valid new tail and mirrors checkpoint metadata. A failed or unavailable result ends that session and produces a visible operating-system notification while leaving the application accessible. A tail already present at startup is never promoted by this timer. Backend loss and update restarts end the session. Restore pauses live closure and initially rolls back unless the candidate matches the receipt exactly. A second warning defaults to Cancel. If the user explicitly continues, Electron retries the selected authenticated backup once, requires a full internally valid chain, leaves the original receipt unchanged, and leaves audit continuity unverified; a later check against the preserved receipt may report rollback.
- The native updater sends bounded `checksum_verified`, `checksum_failed`, `install_requested`, and `install_failed` decisions through the private bridge. When a receipt exists or a trusted session was established this launch, each decision must be synchronously checkpointed and install blocks if closure fails. An existing installation without either can continue after recording the decision, with audit protection reported unavailable. These chained events record local updater decisions, not signed release or publisher provenance. Source development updates without the native bridge may have no such entry.
- First-checkpoint enrollment occurs only when this launch created a new native PostgreSQL cluster, the verifier has checked its current head and every legacy-unverified audit count is zero, and no local anchor files exist. Migration 0117 itself can write the first chained `schema_migration` entry, so the initial receipt may anchor sequence 1 or later rather than genesis. An existing cluster never auto-enrolls.

## Consequences and limits

The local receipt detects a database rollback, fork, changed legacy cutover, or broken domain link when the installation's receipt and key remain intact. The checkpoint metadata table does not prove the external file exists. This is an installation-local witness, not an independent remote or hardware monotonic counter. A privileged attacker who rolls back the entire application-data tree together with PostgreSQL can restore a mutually consistent older state. Changes made during a trusted live session's 30-second interval can become part of the next receipt. A new machine or an existing installation without a prior receipt cannot silently enroll. A valid unanchored tail seen at startup remains `partially_verified`. The exact-head restore rule can also reject a legitimate older backup or a backup taken between live receipt updates; explicit recovery accepts an internally valid chain but does not re-establish audit continuity or lower the receipt. The broader audit TODO remains open until existing-install enrollment, recovery, and the remaining coverage limits are resolved.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/156-forward-only-audit-chain-foundation|ADR-156]]
- [[docs/api/internal-audit|Private Electron Audit Bridge API]]
- [[docs/security/data-protection|Data Protection]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
