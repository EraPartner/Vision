---
title: ADR-040 - Backup Format v2 AEAD Encryption with Per-Backup Salt
type: adr
status: Accepted
date: 2026-04-28
tags: [adr, backup, encryption, security, electron, phase-2, aead, aes-256-gcm, scrypt]
description: Upgrade from AES-256-CBC with static salt to AES-256-GCM AEAD with per-backup random salt for defense-in-depth encryption of Vision backup bundles.
related_code: ["packaging/electron/main.js", "packaging/electron/backup/bundle.js", "packaging/electron/backup/backup-v2-scheme.txt"]
---

# ADR-040: Backup Format v2 AEAD Encryption with Per-Backup Salt

## Status

Accepted

## Date

2026-04-28

## Context

### Prior Backup Architecture (v1)

Vision's `.visionbak` backup bundle previously used **AES-256-CBC** with:
- **Static salt**: Same salt across all backups (12 bytes, hardcoded)
- **Key derivation**: Scrypt with default parameters (N=2^14, r=8, p=1) from user passphrase
- **Confidentiality**: CBC provides confidentiality only; no authentication
- **Risk**: Static salt reduces entropy; no AEAD means tampering undetectable; CBC requires careful padding
- **Format header**: `VISIONENC1` magic

### Attack Surface

1. **Replay risk**: Attacker can swap encrypted backups without detection
2. **Modification risk**: Corrupted or tampered ciphertext decrypts to garbage with no authentication failure
3. **Salt reuse**: Static salt allows offline dictionary attacks over multiple backups if one passphrase leaks
4. **Padding oracle**: CBC mode theoretically vulnerable if timing side-channels leak padding information

## Decision

Introduce **backup format v2** using **AES-256-GCM (Galois/Counter Mode)** with:

- **Per-backup random salt**: 16 random bytes generated per backup
- **Stronger KDF parameters**: Scrypt with N=2^15, r=8, p=1 (doubled iteration count)
- **AEAD (Authenticated Encryption with Associated Data)**: GCM provides both confidentiality and authenticity; tampering detected automatically
- **Per-backup random IV**: 12 random bytes (GCM standard)
- **Authentication tag**: 16 bytes appended by GCM for tamper-proof validation
- **Format header**: `VISIONENC2` magic for detection and routing
- **Backward compatibility**: v1 format (`VISIONENC1`) remains readable indefinitely; v2 is write-only for new backups
- **Schema metadata**: Optional associated data (currently unused; reserved for future schema versioning)

### Format Structure (v2)

```
[VISIONENC2 magic: 9 bytes]
[Random salt: 16 bytes]
[Random IV: 12 bytes]
[Encrypted bundle: variable]
[GCM authentication tag: 16 bytes]
Total overhead: 9 + 16 + 12 + 16 = 53 bytes (40 bytes for v1)
```

## Consequences

### Positive

1. **Authenticated Encryption**: Tampering detected immediately; failed decryption throws during authentication tag verification, not at parsing
2. **Higher KDF iteration**: N=2^15 vs N=2^14 doubles brute-force cost for offline dictionary attacks
3. **Per-backup entropy**: Each backup has unique salt + IV, eliminating salt-reuse collisions across multiple backups
4. **Defense-in-depth**: Combined with per-backup random IV and GCM authentication, backup encryption reaches modern standard (NIST recommendation)
5. **Zero impact on UX**: Auto-detection via magic header; user sees no format difference
6. **Forward/backward compatibility**: v2 reads only v2; v1 decoder still works for existing v1 backups; new code can upgrade on restore if desired

### Negative

1. **Extra 13 bytes per backup**: v2 adds 13 bytes overhead vs v1 (40 bytes total structure vs 53); negligible for typical backups (50 MB+ databases)
2. **Scrypt computation cost**: Slightly slower (2^15 vs 2^14), but on passphrase entry (one-time, human-perceptible delay acceptable)
3. **No transparent migration**: v1 backups stay v1 until user explicitly restores → re-exports; transparent upgrade not implemented (deferred to future phase if needed)

## Implementation

### Backend Changes

**File:** `packaging/electron/backup/bundle.js`

- New `encryptBundle(bundlePath, passphrase)` function (signature change from `key`)
  - Generates random 16-byte salt
  - Derives key via Scrypt(passphrase, salt, N=2^15, r=8, p=1)
  - Generates random 12-byte IV
  - Encrypts bundle with AES-256-GCM
  - Prepends `VISIONENC2` + salt + IV + ciphertext + auth tag

- New `decryptToTemp(encPath, passphrase, tmpPath)` function
  - Auto-detects v1 vs v2 via magic header read
  - Dispatches to appropriate decoder (v1: `VISIONENC1` → CBC, v2: `VISIONENC2` → GCM)
  - Returns plaintext bundle path for extraction

- Legacy `decryptBundle(encPath, key, tmpPath)` signature deprecated but retained for backward compatibility (internal use only)

**File:** `packaging/electron/main.js`

- IPC handler `backup:restore` now validates:
  - `filePath` is a string
  - `filePath` was returned by prior `backup:select-file` dialog (stored in `ALLOWED_RESTORE_PATHS` set, cleared after restore)
  - `filePath` ends in `.visionbak` / `.visionbak.enc` / `.sql` / `.enc`
  - `filePath` exists on disk before decryption attempt
  - Prevents XSS-in-renderer from passing arbitrary paths to decryption
  - Rejects paths escaping attachments directory via `path.resolve()` + `fs.realpath()`

- `decryptBackupFileToTemp(filePath, passphrase)` signature change from `key` parameter
  - Takes plaintext `passphrase`, not pre-derived key
  - Dispatches to appropriate decoder based on magic header
  - Handles both v1 and v2 formats transparently

### Tests

**File:** `apps/node-backend/tests/backup-roundtrip.test.js`

- Updated signatures: `encryptBundle(bundlePath, passphrase)` and `decryptToTemp(encPath, passphrase, tmpPath)`
- Added v2-specific test: encrypt with passphrase → verify magic is `VISIONENC2` → decrypt and validate content matches
- Added v1-compat test: attempt to decrypt v1 backup → verify magic detection + correct decoder invoked
- Added auth-failure test: tamper with ciphertext → expect decryption to fail with tag mismatch (not at parse time)

## Related

- [[docs/features/backup-coverage-audit|Feature: Backup Coverage Audit]] (v2 format added)
- [[docs/security/data-protection|Security: Data Protection]] (encryption & authentication docs)
- [[docs/integrations/currency-conversion|Integration: Currency Conversion]] (no change; referenced for KDF best practices)
- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022]] (Electron security posture)
- Cryptographic details: Node.js native `crypto` module; `scrypt` KDF (already available), `createCipheriv` / `createDecipheriv` with `aes-256-gcm`
