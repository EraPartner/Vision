---
title: ADR-162 - One-Year Audit Chain Retention
type: adr
status: Accepted
date: 2026-09-20
tags: [adr, audit, security, retention, postgres]
description: Delete only complete year-old audit chain prefixes after their boundary is bound to an external Keychain-backed receipt.
aliases: [audit chain retention]
---

# ADR-162: One-Year Audit Chain Retention

## Context

The append-only chain in [[docs/adr/156-forward-only-audit-chain-foundation|ADR-156]] grows indefinitely. The user chose one year of protected audit history. Deleting an old prefix without retaining its authenticated boundary would make a truncated or replaced chain appear valid.

This decision resolves the one-year-retention limitation recorded in [[docs/adr/161-password-protected-audit-device-transfer|ADR-161]].

## Decision

- The native runtime verifies the entire chain and plans a contiguous prefix whose entries are all older than one year. It keeps at least one entry behind the current external checkpoint. An unanchored tail is never eligible.
- The plan records the last deleted sequence and hash, linked domain high-water IDs, and latest migration heads. Electron signs this boundary into its receipt and macOS Keychain witness before requesting deletion. Checkpoint metadata is mirrored to PostgreSQL but is not itself the trust root.
- Migration 0118 adds a `SECURITY DEFINER` PostgreSQL function. It locks the chain head and checks age, continuity, the boundary hash, a previously recorded version 3 checkpoint, and the retained successor. It removes the complete prefix atomically and refuses partial or ineligible pruning. An exact retry returns zero. The application role receives only EXECUTE on this function, not ownership of the audit tables.
- Verification starts at the signed predecessor when the prefix is absent. If it is still present after signing, verification checks the full chain against the signed boundary. Coverage checks continue from the signed domain high-water IDs; legacy cutover counts remain separate. Audit display and export state that older entries were removed.
- The runtime retries an interrupted signed-but-not-pruned operation before planning another cut. Failed verification blocks pruning. A failed or missing external witness makes history unavailable and does not trigger a replacement checkpoint.

## Consequences

Old chain entries and their exact payloads are intentionally unrecoverable from the live database after pruning. Backups may still contain older entries under their own backup retention policy. Audit domain tables remain in the backup and are not pruned by this operation. Downgrade of migration 0118 is refused after the first prune because older code cannot verify a retained suffix. Database owners can still bypass database protections; the external witness is the independent local evidence boundary.

## Related

- [[docs/adr/index|Architecture Decision Records]]
- [[docs/api/internal-audit|Private Audit Bridge]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/security/data-protection|Data Protection]]
