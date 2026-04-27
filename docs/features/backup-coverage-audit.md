---
title: Backup Coverage Audit
type: feature
status: active
date: 2026-04-27
updated: 2026-04-27
tags: [feature, backup, restore, database, filesystem, localStorage, bundle, encryption, schema-migration, phase-1, phase-2, passphrase-modal, ux]
description: Authoritative audit of every persistence surface in Vision and its backup/restore coverage status. Phase 1+2 implements .visionbak bundle format with optional AES-256-CBC encryption, schema-safe restore, and localStorage hydration.
aliases: [backup audit, coverage audit, backup coverage, visionbak, bundle format]
related_code: ["packaging/electron/backup/bundle.js", "packaging/electron/main.js", "apps/node-backend/src/backup/coverage.js", "apps/frontend/src/lib/api/electron.ts", "apps/frontend/src/lib/localStorage-keys.ts", "apps/frontend/src/components/settings/tabs/BackupTab.tsx"]
---

# Backup Coverage Audit

> [!abstract] Overview
> Authoritative inventory of every persistence surface in Vision — Postgres tables, filesystem files, and browser localStorage — with coverage status in the `.visionbak` bundle format.

## Feature Overview

### User Story

> As a Vision user, I want a backup that captures my entire application state so that I can restore a byte-for-byte equivalent instance on a new machine or after data loss.

### Key Capabilities

- Every Postgres table included in `pg_dump` SQL artifact inside bundle
- Attachment files (receipts, PDFs) bundled alongside the SQL dump
- Browser localStorage state (theme, dismissed notifications) captured and restored
- CI test enforces coverage whenever a new migration or localStorage key is added

---

## Persistence Surfaces

### 1. Postgres Database Tables

All 31 user-data tables are included in the `pg_dump` SQL artifact inside every `.visionbak` bundle.

**Source of truth:** `apps/node-backend/src/backup/coverage.js` → `BACKUP_COVERED_TABLES`

**Enforced by:** `apps/node-backend/tests/backup-coverage.test.js`

#### Core Transactional Data

| Table | Domain | Backup | Notes |
|-------|--------|--------|-------|
| `transactions` | Transactions | ✅ Included | Primary ledger |
| `categories` | Categorisation | ✅ Included | |
| `recipients` | Recipients | ✅ Included | |
| `recipient_bank_accounts` | Recipients | ✅ Included | |
| `recipient_match_patterns` | Recipients | ✅ Included | Auto-match rules |
| `transaction_raw_references` | Import | ✅ Included | Raw↔canonical links |

#### Planning & Recurring

| Table | Domain | Backup | Notes |
|-------|--------|--------|-------|
| `planned_transactions` | Planning | ✅ Included | Recurring rules |
| `planned_transaction_executions` | Planning | ✅ Included | Execution history |
| `planned_transaction_loan_schedule` | Planning | ✅ Included | Loan amortisation |

#### Raw Bank Import Tables

| Table | Domain | Backup | Notes |
|-------|--------|--------|-------|
| `belfius_raw_transactions` | Import | ✅ Included | |
| `revolut_raw_transactions` | Import | ✅ Included | |
| `kbc_raw_transactions` | Import | ✅ Included | |
| `sabb_raw_transactions` | Import | ✅ Included | |
| `wise_raw_transactions` | Import | ✅ Included | |
| `vision_raw_transactions` | Import | ✅ Included | |
| `custom_raw_transactions` | Import | ✅ Included | |
| `manual_raw_transactions` | Import | ✅ Included | |

#### Portfolio & Investments

| Table | Domain | Backup | Notes |
|-------|--------|--------|-------|
| `investments` | Portfolio | ✅ Included | Holdings |
| `portfolio_transactions` | Portfolio | ✅ Included | Buy/sell history |
| `asset_price_history` | Portfolio | ✅ Included | Price cache |
| `watchlist` | Portfolio | ✅ Included | |

#### Settings & Personalisation

| Table | Domain | Backup | Notes |
|-------|--------|--------|-------|
| `user_settings` | Settings | ✅ Included | All app settings |
| `saved_charts` | Charts | ✅ Included | Chart configurations |

#### AI & Conversations

| Table | Domain | Backup | Notes |
|-------|--------|--------|-------|
| `ai_conversations` | AI Chat | ✅ Included | |
| `ai_messages` | AI Chat | ✅ Included | |

#### Attachments

| Table | Domain | Backup | Notes |
|-------|--------|--------|-------|
| `attachments` | Attachments | ✅ Included | Metadata rows |

#### Reference / Cache Data

| Table | Domain | Backup | Notes |
|-------|--------|--------|-------|
| `exchange_rates` | FX | ✅ Included | Rate cache |
| `belgian_inflation_rates` | Tax | ✅ Included | |
| `cashflow_forecast_accuracy` | Forecasting | ✅ Included | |
| `cashflow_forecast_mc` | Forecasting | ✅ Included | Monte Carlo cache |

#### Operational

| Table | Domain | Backup | Notes |
|-------|--------|--------|-------|
| `provider_health` | Observability | ✅ Included | Provider status history |

#### Excluded Tables

| Table | Reason |
|-------|--------|
| `alembic_version` | Alembic internal — re-derived on restore via `alembic upgrade head` |
| `agg_shadow_divergences` | Dropped in migration 0009 — no longer in schema |
| `feature_flags` | Dropped in migration 0011 — no longer in schema |
| `bank_statements` | Dropped in migration 0014 — bank reconciliation feature was removed |
| `reconciliation_entries` | Dropped in migration 0014 — bank reconciliation feature was removed |

---

### 2. Filesystem — Attachment Files

| Surface | Path | Backup | Restore |
|---------|------|--------|---------|
| Receipt files | `$ATTACHMENTS_DIR/{transaction_id}/{uuid}.{ext}` | ✅ Bundled as `attachments/` tree | Extracted to `$ATTACHMENTS_DIR` after DB load |

**Default `ATTACHMENTS_DIR`:** `./data/attachments` (env-configurable via `ATTACHMENTS_DIR`).

**Restore safety:** Files extracted to a staging directory (`$ATTACHMENTS_DIR.staging/`) and atomically swapped on success. Rolled back on failure — original files preserved until swap completes.

**Supported types:** Images (PNG, JPEG, GIF, WEBP) and PDF (enforced by `attachmentService.js` magic-byte sniff).

---

### 3. Browser localStorage

Captured as `frontend-state.json` in the bundle. Restored after DB load triggers a full app reload so theme/layout take effect immediately.

**Source of truth:** `apps/frontend/src/lib/localStorage-keys.ts` → `LOCAL_STORAGE_KEYS`

| Key | Purpose | Backup |
|-----|---------|--------|
| `vision_theme` | Active theme mode (`light`/`dark`/`system`) | ✅ Included |
| `vision_theme_variant` | Color variant | ✅ Included |
| `vision.backup.passphrase.reminder.dismissed` | Passphrase reminder dismissed flag | ✅ Included |
| `dismissed_upcoming_planned_payments` | Dismissed upcoming-payment IDs | ✅ Included |
| `dismissed_recurring_patterns` | Dismissed recurring-pattern keys | ✅ Included |
| `vision_dashboardSettings` | Legacy dashboard layout | ❌ Excluded — SettingsContext migrates to DB and removes on read; no live value to back up |

---

### 4. In-Memory / Derived State

| Surface | Backup | Notes |
|---------|--------|-------|
| Materialised views | ❌ Excluded | Re-built at runtime by `materializedViewService.js` |
| Price provider caches (HTTP) | ❌ Excluded | Re-fetched on demand |
| Electron `safeStorage` passphrase | ❌ Excluded | User re-enters passphrase post-restore |
| `settings.json` (Electron-local) | ❌ Excluded | Contains backup dir config + deviceId; meaningless on new machine |

---

## Bundle Format

**Phase 1+2 Bundle (April 2026):**

```
vision_backup_{deviceId}_{timestamp}.visionbak   ← .zip archive (unencrypted)
├── metadata.json        # schema head, app version, deviceId, timestamps, sha256 checksums
├── db.sql               # pg_dump plain SQL
├── attachments/         # mirrors $ATTACHMENTS_DIR/
│   └── {txn_id}/{uuid}.{ext}
└── frontend-state.json  # { keys: { vision_theme: "dark", … } }

vision_backup_{deviceId}_{timestamp}.visionbak.enc ← AES-256-CBC encrypted archive
```

**Encryption:** Optional per-bundle. If passphrase set, entire `.visionbak` zip is encrypted to `.visionbak.enc` using AES-256-CBC with pbkdf2 key derivation. Default: unencrypted (changed from legacy `.sql` behaviour where encryption was always presented).

**Module:** `packaging/electron/backup/bundle.js` provides:
- `createBundle()` — Create zip from db.sql, attachments/, frontend-state.json, metadata.json
- `encryptBundle()` — Wrap bundle in AES-256-CBC encryption
- `openBundle()` — Extract and decrypt bundle; returns paths to sql, attachments, frontend state
- `isBundleEncrypted()` — Inspect bundle header without full extraction

---

## Restore Process (Phase 1+2)

**IPC Handlers** (in `packaging/electron/main.js`):

| Handler | Signature | Purpose |
|---------|-----------|---------|
| `backup:run` | `(destDir, frontendStateJson?)` | Create and optionally encrypt bundle |
| `backup:restore` | `(bundlePath, opts?)` | Restore from bundle with optional passphrase; `opts = { passphrase }` |
| `backup:is-encrypted` | `(filePath)` | Detect if backup file is encrypted (returns boolean) |
| `backup:select-file` | `()` | Dialog to select .visionbak file |
| `backup:select-dir` | `()` | Dialog to choose backup directory |

**New Helper Functions** (Phase 2 Encrypted Restore):

- `deriveBackupKeyFromPassphrase(passphrase)` — Scrypt KDF to derive AES key from user-entered passphrase (same algorithm as `getBackupEncryptionKey`)
- `decryptBackupFileToTemp(encryptedFilePath, key)` — Decrypt OpenSSL-format ciphertext using AES key; throws `Error('INVALID_PASSPHRASE')` on bad decrypt
- Error sentinels: `ERR_PASSPHRASE_REQUIRED = 'PASSPHRASE_REQUIRED'`, `ERR_INVALID_PASSPHRASE = 'INVALID_PASSPHRASE'`

**Restore Steps (Phase 2):**

1. **Encryption Detection** — Check file magic header via `isBundleEncrypted()` or `isEncryptedBackupFile()`. If encrypted:
   - Return `{ encrypted: true }` to frontend
   - Frontend opens passphrase modal via `useRestoreBackup` hook
   - User enters passphrase; frontend retries restore with `{ passphrase }` option
2. **Decryption** (if encrypted) — Derive AES key via `deriveBackupKeyFromPassphrase(passphrase)` scrypt KDF. Decrypt bundle to temporary path; throw `Error('INVALID_PASSPHRASE')` on bad decrypt. Frontend catches this and re-prompts modal.
3. **Schema Validation** — Extract metadata.json from bundle; compare `metadata.schemaHead` against current `getSchemaHead()`. If bundle schema > current, throw `BUNDLE_SCHEMA_NEWER` error (user must upgrade Vision first).
4. **Database Drop & Restore** — Drop existing DB via `docker exec` `dropdb`, then restore via `psql -f` with bind-mounted .sql file.
5. **Docker Restart** — Kill and restart backend container to pick up new DB.
6. **Health Poll** — Wait for `/health` to report ready (up to 10s).
7. **Attachment Swap** — Extract `attachments/` to temporary staging directory, then atomically swap with `$ATTACHMENTS_DIR` on success. Rolled back on failure.
8. **Frontend State Restore** — Return `{ frontendState.keys }` to renderer; component writes each key to localStorage via `localStorage.setItem(key, value)`.
9. **Page Reload** — Trigger full reload so theme and UI preferences take effect.

**Error Handling (Phase 2):**

- `PASSPHRASE_REQUIRED` → No passphrase provided for encrypted backup; retry prompt modal
- `INVALID_PASSPHRASE` → Wrong passphrase entered; modal shows error and allows retry (up to 3 attempts typical)
- `BUNDLE_SCHEMA_NEWER` → User-friendly toast: "Cannot restore — backup is from a newer Vision version"
- Other decrypt errors (corrupted file, incomplete extraction) → `openBundle()` fails; IPC returns error with details
- Attachment swap failure → Logged but does not block restore; user can manually sync later
- DB restore failure → Explicit error with Docker logs; attachment staging rolled back automatically
- Fallback source resolution: If user does not enter passphrase in modal, restore attempts `VISION_BACKUP_PASSPHRASE` env var and OS keychain (Electron safeStorage) before throwing `PASSPHRASE_REQUIRED`

**Related Code:**
- `runBundleRestore()` in `packaging/electron/main.js` — Main restore orchestrator
- `FrontendStateSnapshot` type in `apps/frontend/src/lib/api/electron.ts`
- Error handling in `BackupTab.tsx` — checks for BUNDLE_SCHEMA_NEWER prefix on error string

---

## Coverage Enforcement

`apps/node-backend/tests/backup-coverage.test.js` runs in CI and:

1. **Table coverage** — parses all `alembic/versions/*.py` files, computes net table set (created minus dropped), and asserts exact match against `BACKUP_COVERED_TABLES`.  Fails if a new migration adds a table not in the registry.
2. **localStorage coverage** — asserts all keys in `LOCAL_STORAGE_KEYS` are referenced in the bundle snapshot logic.

Adding a table or localStorage key without updating the registries causes a CI failure.

---

## Gaps / Known Limitations

- No cloud/off-device sync. Bundles are local-disk only.
- No incremental backup. Every backup is a full dump.
- Merge-restore not supported — restore always wipes and replaces.
- Restoring a bundle created on a **newer** schema version is blocked with a clear error. Upgrade Vision first.

---

## Related

- [[docs/architecture/electron|Electron Desktop Architecture]] — IPC handlers, bundle format integration
- [[docs/reference/api-endpoint-matrix#ipc-handlers--electron-desktop-phase-12|API Endpoint Matrix — IPC Section]] — All 8 backup/restore handlers
- [[docs/features/settings|Settings Feature]] — Backup tab UI integration
- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron Sandbox Hardening]] — Security model for backup/restore
- [[docs/adr/|Architecture Decision Records]]
