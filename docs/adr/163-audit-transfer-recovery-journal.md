---
title: ADR-163 - Audit Transfer Recovery Journal
type: adr
status: Accepted
date: 2026-09-20
tags: [adr, audit, security, electron, backup]
description: Recover an interrupted audit transfer only by comparing both local checkpoints with the independent Keychain witness.
aliases: [audit transfer recovery]
---

# ADR-163: Audit Transfer Recovery Journal

## Context

[[docs/adr/161-password-protected-audit-device-transfer|ADR-161]] imports a protected receipt by writing the locally encrypted key and receipt, then advancing the macOS Keychain witness. A process crash between those writes can leave the fresh target's local pair incomplete. Accepting either local pair without the witness would permit a rollback.

## Decision

- Before replacing a fresh target's key and receipt, Electron durably copies both original files into a private transfer journal. The journal stays outside PostgreSQL and is never included in a database backup.
- On startup, Electron compares the current pair and the complete journal pair with the independent Keychain witness. If the current pair matches, the witness already advanced; it keeps the imported checkpoint and removes the journal. Otherwise, if the original pair matches, it restores both original files and removes the journal. An incomplete, invalid, or unmatched pair fails closed.
- The normal import gate still requires the newly created cluster's original checkpoint and pristine database in the same launch. Journal recovery cannot authorize replacement of an established checkpoint. After a crash that restored the original fresh checkpoint, the operator must start with a fresh empty target again before retrying the transfer; the old Mac and its matching backup remain the recovery source.
- The journal does not authenticate database rows. A matching backup must still pass the post-restore audit check.

## Consequences

This recovers the local checkpoint state from process interruption without re-signing history or trusting a database copy. A lost or mismatched Keychain witness remains an integrity failure. This supersedes ADR-161's open interrupted-transfer recovery limit; it does not change the limits of key rotation or require the old Mac's key to be revoked.

## Related

- [[docs/adr/index|Architecture Decision Records]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/security/data-protection|Data Protection]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
