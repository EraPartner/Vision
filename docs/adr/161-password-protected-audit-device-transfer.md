---
title: ADR-161 - Password-Protected Audit Device Transfer
type: adr
status: Accepted
date: 2026-09-20
tags: [adr, audit, security, electron, backup]
description: Move a trusted audit checkpoint to a fresh Mac in a small password-protected file before restoring its matching backup.
aliases: [audit device transfer]
---

# ADR-161: Password-Protected Audit Device Transfer

## Context

[[docs/adr/158-macos-keychain-audit-witness|ADR-158]] keeps the audit receipt, device-encrypted key, and Keychain witness outside database backups. A new Mac therefore cannot authenticate a restored database. The user chose a password-protected transfer instead of treating every device move as a new enrollment.

## Decision

- Admin exports the current independently verified receipt and 32-byte audit key in a small versioned file. The export first closes a pending chain tail. The file contains no transactions.
- The file uses a fresh 16-byte salt, `scrypt` with N=32768, r=8, p=1, and AES-256-GCM with a versioned associated-data label. The password has at least 16 characters and is never saved by Vision. The file must be kept separately from the password. A copied file and password together grant the audit key; the password should be discarded after a successful move.
- Import is available only during the first launch that created a new native cluster, while its original receipt still matches the pristine database. Electron shows a default-Cancel replacement warning. It checks the transfer authentication tag, key ID, receipt message authentication code, and receipt shape before encrypting the key with the new Mac's secure storage and replacing that fresh cluster's Keychain witness.
- Import does not authenticate or alter database rows. The new Mac then restores the matching encrypted database backup. The existing restore gate must compare the complete restored chain with the imported checkpoint before switching databases. A backup older or newer than the transferred receipt can fail the exact-head check; export and backup should be made without intervening audited changes.
- A failed or interrupted import cannot silently fall back to a fresh checkpoint. Once an established checkpoint has advanced, import is refused. A device move should be done with the old Mac available until the new Mac verifies the restore.
- Admin also offers explicit key rotation after full verification. It generates a new random key and receipt for the same trusted head, replaces the Keychain witness, and records new checkpoint metadata. An interrupted rotation fails closed; Vision does not auto-accept an old key or re-sign the database. Keep a matching protected transfer and backup until the new receipt verifies.

## Limits

This copies the audit key and trust state; it does not revoke the old Mac's copy. The operator should stop using the old installation after confirming the new restore. A lost password cannot be recovered. A partial write remains a hard integrity failure. One-year retention and interrupted-transfer recovery still need separate implementation and validation.

## Related

- [[docs/adr/index|Architecture Decision Records]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/security/data-protection|Data Protection]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
