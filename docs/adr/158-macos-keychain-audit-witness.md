---
title: ADR-158 - macOS Keychain Audit Checkpoint Witness
type: adr
status: Accepted
date: 2026-09-20
tags: [adr, audit, security, electron, keychain]
description: Keep the latest native audit checkpoint in the macOS Keychain so rolling back the application-data tree cannot silently roll back the receipt.
aliases: [Keychain audit witness]
---

# ADR-158: macOS Keychain Audit Checkpoint Witness

## Context

[[docs/adr/157-electron-local-audit-receipt|ADR-157]] stores both its signed receipt and encrypted key under the application-data tree. A coordinated rollback of that tree and PostgreSQL could restore an older matching pair. The user accepts macOS Keychain prompts on unsigned builds but does not plan to sign the application for stable Keychain access.

## Decision

- A packaged macOS native helper uses Apple's Security framework generic-password API to create, read, and replace a separate latest-checkpoint record. The record contains the receipt version, key ID, sequence, chain hash, and digest of the signed receipt. Its service name separates Vision from Vision Demo. Checkpoint data is sent to the helper through standard input, not command arguments.
- Receipt version 3 requires an exact match with this Keychain record before a database checkpoint is trusted. If either side is absent, corrupted, or behind the other, verification fails closed. The first checkpoint is created only under ADR-157's new-cluster rule. A version 2 receipt does not silently gain a Keychain witness; it remains unverified until an explicit migration policy exists.
- The helper is compiled for the macOS package and ad-hoc signed with the app. Source development without the packaged helper reports audit verification unavailable. The only live operating-system probe so far used a disposable synthetic Keychain file; no real Vision Keychain item was created by the probe.

## Consequences and limits

Rolling back PostgreSQL and application data alone no longer restores a matching trusted checkpoint when the Keychain record survives. A crash between a receipt write and Keychain update can leave a mismatch that needs deliberate recovery; it is never auto-repaired. Loss of the Keychain item, moving to a new machine, or an unsigned app identity change can also make verification unavailable or prompt the user. This is local evidence, not a hardware monotonic counter, remote witness, or proof against an attacker who can change the Keychain item or application code. Existing-install enrollment, key rotation, device migration, retention, and full adversarial acceptance remain open in the audit TODO.

## Related

- [[docs/adr/index|Architecture Decision Records]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/security/data-protection|Data Protection]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
