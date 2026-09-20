---
title: ADR-160 - Explicit Audit Enrollment Baseline
type: adr
status: Accepted
date: 2026-09-20
tags: [adr, audit, security, electron, keychain]
description: Let an existing native installation deliberately establish a forward-looking audit checkpoint while labeling earlier history as an accepted baseline.
aliases: [audit enrollment baseline]
---

# ADR-160: Explicit Audit Enrollment Baseline

## Context

[[docs/adr/158-macos-keychain-audit-witness|ADR-158]] creates a protected checkpoint automatically only for a new native cluster. An existing installation can have an internally consistent chain but no independent receipt. A new receipt cannot prove whether a privileged actor changed that history before enrollment.

## Decision

- The native Admin audit view offers an explicit **Start audit protection** action only when no trusted local anchor exists. Electron main checks that state again and shows a default-Cancel warning. The action never runs on application startup or restore.
- The backend verifies the full chain, linked post-cutover domain rows, schema migration heads, and legacy cutover before Electron creates a receipt and separate Keychain witness at the observed head. Any existing, broken, or mismatched anchor blocks enrollment. A partial write fails closed and is never silently replaced.
- The signed receipt records an immutable enrollment sequence. Older version 3 receipts keep their original message authentication code encoding. Later checkpoint updates carry the enrollment sequence forward.
- The private backend checkpoint call receives only the five established receipt fields; the enrollment sequence stays in the independently authenticated local receipt. Repeating an exact checkpoint is idempotent. On the next trusted startup Electron can restore missing database metadata after a crash between the Keychain write and backend acknowledgement, without replacing or re-signing the external checkpoint.
- Entries at or before that sequence are labeled **Accepted at enrollment** in the native Admin view. Exports carry the same limitation. Later entries are checked against the enrollment checkpoint and subsequent closures. Pre-cutover legacy rows remain separately unverified.

## Consequences and limits

This starts forward-looking detection for an existing installation while preserving an honest boundary for older history. It does not retroactively prove old entries, replace a lost Keychain witness, resolve a mismatched receipt, or enroll a restored backup on a new device. Key rotation, device migration, retention, and adversarial live acceptance remain open.

## Related

- [[docs/adr/index|Architecture Decision Records]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/security/data-protection|Data Protection]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
