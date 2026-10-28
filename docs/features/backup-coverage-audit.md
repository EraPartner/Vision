---
title: Backup Coverage Audit
type: feature
status: active
date: 2026-10-28
updated: 2026-10-28
last_modified: 2026-10-28
tags: [feature, backup, restore, database, filesystem, localStorage, bundle, encryption, schema-migration, phase-1, phase-2, phase-7, passphrase-modal, ux, aead, aes-256-gcm, rolling-cache, concurrent-backup-guard, pre-restore-confirmation, watchdog-pause, safe-storage, keychain, lazy-safeStorage, settings-dialog-fix, backup-path-revert-fix]
description: "Authoritative audit of every persistence surface in Vision and its backup/restore coverage status. Phase 1+2 implements .visionbak bundle format with optional AES-256-GCM encryption (v2, 2026-04-28; the AES-256-CBC v1 format was retired and is refused since 2026-10-19, ADR-219), schema-safe restore, and localStorage hydration. Phase 7 (May 2026) hardens restore with user confirmation, concurrent-backup guard, and health watchdog pause. safeStorage is now accessed lazily to avoid macOS Keychain prompts for users without a stored passphrase. 2026-06-11: fixes \"backup path keeps reverting to default\" — settings dialog now loads backup settings on open; Electron IPC handlers correctly unwrap the response envelope."
aliases: [backup audit, coverage audit, backup coverage, visionbak, bundle format]
related_code: ["packaging/electron/backup/bundle.ts", "packaging/electron/main.ts", "packaging/electron/runtime/native.ts", "apps/node-backend/tests/localStorage-keys-registry.test.ts", "apps/frontend/src/lib/api/electron.ts", "apps/frontend/src/lib/localStorage-keys.ts", "apps/frontend/src/features/settings/sections/BackupSection.tsx", "apps/frontend/src/features/settings/DashboardSettingsDialog.tsx"]
---

# Backup Coverage Audit

> [!tip] Backup coverage and restore rollback
> [Open the journey](../flow-visualizer.html#backup-create) or [the companion flow](../flow-visualizer.html#backup-restore). See [[docs/guides/visual-learning|Understand Vision Visually]] for the reading paths and conceptual diagrams.

> [!abstract] Overview
> Authoritative inventory of every persistence surface in Vision — Postgres tables, filesystem files, and browser localStorage — with coverage status in the `.visionbak` bundle format.

## Feature Overview

### User Story

> As a Vision user, I want a backup that captures my entire application state so that I can restore a byte-for-byte equivalent instance on a new machine or after data loss.

### Key Capabilities

- Every Postgres table included in `pg_dump` SQL artifact inside bundle
- Attachment files (receipts, PDFs) bundled alongside the SQL dump
- Browser localStorage state (theme, dismissed notifications) captured and restored
- Table coverage is automatic: the dump is the whole database, so new migrations need no registration
- CI test enforces registration whenever a new localStorage key is added

---

## Persistence Surfaces

### 1. Postgres Database Tables

All user-data tables are included in the `pg_dump` SQL artifact inside every `.visionbak` bundle.

**Source of truth:** the whole-database `pg_dump` in `packaging/electron/runtime/native.ts`. It
passes no `--table` or `--exclude-table` filter (only `--exclude-extension` for the bundled
extensions), so every table in the migrated schema is captured without a registry. The former
`BACKUP_COVERED_TABLES` list in `apps/node-backend/src/backup/coverage.ts` was read only by its own
test and was removed on 2026-10-20. The tables below document the current schema.

#### Aggregates

| Table                   | Domain     | Backup      | Notes |
| ----------------------- | ---------- | ----------- | ----- |
| `agg_recipient_totals`  | Aggregates | ✅ Included |       |
| `agg_split_outstanding` | Aggregates | ✅ Included |       |

#### Removed audit history

Migration `0004_remove_audit_history` dropped `audit_chain_head`, `audit_chain_entries`,
`audit_chain_checkpoints`, `db_editor_audit`, `split_audit` and `portfolio_retag_audit`, and
`BACKUP_COVERED_TABLES` no longer names them
([[docs/adr/231-remove-audit-history|ADR-231]]). An older backup that still contains them
restores without an audit check or continuity warning; restore activates the dump at its own
migration head, and the next backend start applies 0004 and drops the tables again. No test
restores a pre-0004 dump end to end.

Fresh installs start at migration `0001_baseline` (which still creates the audit chain with one
`baseline_installed` entry) and then apply the later migrations, so 0004 drops it again.
The schema revision of a database, and the `schemaHead` a bundle records, is the highest name in
`public.kysely_migration`. Restore refuses any backup taken before the switch to the Kysely
baseline: a dump that has no `kysely_migration` rows fails with `BACKUP_PRE_BASELINE`. See
[[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]] and
[[docs/guides/migrations|Database Migration Guide]].

#### AI & Conversations

Migration 0002 dropped `ai_disclosure_grants`, `ai_disclosure_records`, `ai_reference_scopes` and
`ai_reference_entries` ([[docs/adr/229-remove-cloud-ai-codex-and-agentcloak|ADR-229]]). An older
backup that still contains them restores, and the next backend start drops them again.

| Table                            | Domain      | Backup      | Notes                                                |
| -------------------------------- | ----------- | ----------- | ---------------------------------------------------- |
| `ai_conversations`               | AI Chat     | ✅ Included |                                                      |
| `ai_messages`                    | AI Chat     | ✅ Included |                                                      |
| `ai_research_documents`          | AI Research | ✅ Included | Local document metadata                              |
| `ai_research_passages`           | AI Research | ✅ Included | Local extracted text and embeddings                  |
| `ai_investigation_jobs`          | AI Research | ✅ Included | Inputs, answer checkpoints, and local results        |
| `ai_investigation_steps`         | AI Research | ✅ Included | Reusable step checkpoints                            |
| `research_dossiers`              | Research    | ✅ Included | Current local dossier content and version pointer    |
| `research_dossier_versions`      | Research    | ✅ Included | Immutable content snapshots                          |
| `research_dossier_links`         | Research    | ✅ Included | Live foreign keys and historical target labels       |
| `analysis_monitors`              | Monitoring  | ✅ Included | Rule conditions, next due time, and dedup state      |
| `analysis_monitor_observations`  | Monitoring  | ✅ Included | Complete local check history, including failures     |
| `analysis_monitor_notifications` | Monitoring  | ✅ Included | Deduplicated in-app inbox and read state             |

#### Portfolio import reconciliation and custody

| Table | Backup | Notes |
| ----- | ------ | ----- |
| `portfolio_import_reconciliation_journal` | Included | Immutable adoption/restore images and retained source references (0120) |
| `portfolio_import_duplicate_repair_journal` | Included | Full manual/imported images and original staging/batch counters for explicit repair restoration (0122) |
| `portfolio_asset_transfers` | Included | Dated source/destination units, source identity, and method-specific fee-basis allocations (0121) |
| `portfolio_asset_adjustments` | Included | Dated unit reversals/asset fees and per-method original-lot basis allocations (0123) |
| `portfolio_asset_adjustment_sources` | Included | Restrictive original yield-source links, including evidence in older batches (0123) |

These tables are included in the whole-database dump. They retain original-trade restoration and
custody replay state, including referenced batches/staging provenance. They are domain history. The import session's tab-scoped `sessionStorage`
metadata is not a backup surface; canonical staged batches and source records remain in PostgreSQL.
See [[docs/reference/data-model]] and
[[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger]] for guarded migration recovery.

#### Attachments & Reference

| Table                 | Domain      | Backup      | Notes         |
| --------------------- | ----------- | ----------- | ------------- |
| `asset_price_history` | Portfolio   | ✅ Included | Price cache   |
| `attachments`         | Attachments | ✅ Included | Metadata rows |
| `adr109_legacy_cleanup_marker` | Reference | ✅ Included | Reference row shipped by the `0001` baseline |

#### Raw Bank Import Tables

| Table                          | Domain         | Backup      | Notes                                        |
| ------------------------------ | -------------- | ----------- | -------------------------------------------- |
| `belgian_inflation_rates`      | Tax            | ✅ Included |                                              |
| `cashflow_forecast_accuracy`   | Forecasting    | ✅ Included | Backtest metrics                             |
| `cashflow_forecast_mc`         | Forecasting    | ✅ Included | Month-view Monte Carlo cache                 |
| `cashflow_forecast_mc_rolling` | Forecasting    | ✅ Included | Rolling-window Monte Carlo cache             |
| `categories`                   | Categorisation | ✅ Included |                                              |
| `category_merge_aliases`       | Categorisation | ✅ Included | Redirects merged legacy pairs                |
| `category_root_aliases`        | Categorisation | ✅ Included | Redirects former legacy root names           |
| `custom_parser_configs`        | Import         | ✅ Included | Custom bank parser configs                   |
| `exchange_rates`               | FX             | ✅ Included | Rate cache                                   |
| `import_batches`               | Import         | ✅ Included | Import batch records                         |
| `import_staging_rows`          | Import         | ✅ Included | Exact source records and import fingerprints |
| `insight_cash_projections`     | Insights       | ✅ Included | Significant-move baseline                    |
| `insight_digest_state`         | Insights       | ✅ Included | Versioned navigation badge count             |
| `insight_dismissals`           | Insights       | ✅ Included | Server-visible user preferences              |
| `investments`                  | Portfolio      | ✅ Included | Holdings                                     |

#### Planning & Recurring

| Table                               | Domain        | Backup      | Notes                                        |
| ----------------------------------- | ------------- | ----------- | -------------------------------------------- |
| `planned_transaction_executions`    | Planning      | ✅ Included | Execution history                            |
| `planned_transaction_loan_schedule` | Planning      | ✅ Included | Loan amortisation                            |
| `planned_transaction_tags`          | Planning      | ✅ Included |                                              |
| `planned_transactions`              | Planning      | ✅ Included | Recurring rules                              |
| `portfolio_performance_snapshots`   | Portfolio     | ✅ Included | Performance snapshots                        |
| `portfolio_import_batches`          | Import        | ✅ Included | Portfolio import history                     |
| `portfolio_import_staging_rows`     | Import        | ✅ Included | Exact source records and import fingerprints |
| `portfolio_transactions`            | Portfolio     | ✅ Included | Buy/sell history and import fingerprints     |
| `provider_health`                   | Observability | ✅ Included | Provider status history                      |

#### Core Transactional Data

| Table                        | Domain       | Backup      | Notes                                  |
| ---------------------------- | ------------ | ----------- | -------------------------------------- |
| `recipient_bank_accounts`    | Recipients   | ✅ Included |                                        |
| `recipient_match_patterns`   | Recipients   | ✅ Included | Auto-match rules                       |
| `recipients`                 | Recipients   | ✅ Included |                                        |
| `saved_chart_categories`     | Charts       | ✅ Included | Category memberships                   |
| `saved_chart_recipients`     | Charts       | ✅ Included | Recipient memberships                  |
| `saved_chart_tags`           | Charts       | ✅ Included | Tag memberships                        |
| `saved_charts`               | Charts       | ✅ Included | Chart configurations                   |
| `split_payments`             | Splits       | ✅ Included |                                        |
| `tags`                       | Tags         | ✅ Included |                                        |
| `transaction_splits`         | Splits       | ✅ Included |                                        |
| `transaction_tags`           | Tags         | ✅ Included |                                        |
| `transactions`               | Transactions | ✅ Included | Primary ledger and import fingerprints |
| `user_settings`              | Settings     | ✅ Included | All app settings                       |
| `watchlist`                  | Portfolio    | ✅ Included |                                        |

#### Excluded Tables

| Table                    | Reason                                                                         |
| ------------------------ | ------------------------------------------------------------------------------ |
| `kysely_migration`       | Migrator bookkeeping created by `database/migrate.ts`, not by a migration; the schema version it records travels with the dump |
| `kysely_migration_lock`  | Migrator lock row created by `database/migrate.ts`, not by a migration       |

---

### 2. Filesystem — Attachment Files

| Surface       | Path                                             | Backup                            | Restore                                       |
| ------------- | ------------------------------------------------ | --------------------------------- | --------------------------------------------- |
| Receipt files | `$ATTACHMENTS_DIR/{transaction_id}/{uuid}.{ext}` | ✅ Bundled as `attachments/` tree | Extracted to `$ATTACHMENTS_DIR` after DB load |

**Attachment root:** native mode uses the absolute
`~/Library/Application Support/Vision/native/vision/attachments/` directory and passes it to the
backend through `ATTACHMENTS_DIR`.

**Restore safety:** Files extracted to a staging directory (`$ATTACHMENTS_DIR.staging/`) and atomically swapped on success. Rolled back on failure — original files preserved until swap completes.

**Supported types:** Images (PNG, JPEG, GIF, WEBP) and PDF (enforced by `attachmentService.ts` magic-byte sniff).

---

### 3. Browser localStorage

Captured as `frontend-state.json` in the bundle. Restored after DB load triggers a full app reload so theme/layout take effect immediately.

**Source of truth:** `apps/frontend/src/lib/localStorage-keys.ts` → `LOCAL_STORAGE_KEYS`

| Key                                           | Purpose                                         | Backup                                                                                                      |
| --------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `vision_theme`                                | Active theme mode (`light`/`dark`/`system`)     | ✅ Included                                                                                                 |
| `vision_theme_variant`                        | Color variant                                   | ✅ Included                                                                                                 |
| `vision.backup.passphrase.reminder.dismissed` | Passphrase reminder dismissed flag              | ✅ Included                                                                                                 |
| `dismissed_upcoming_planned_payments`         | Dismissed upcoming-payment IDs                  | ✅ Included                                                                                                 |
| `vision.home.dismissedAccountInactivity` | Account IDs and dismissed last-transaction days | ✅ Included through the frontend key registry |
| `dismissed_recurring_patterns`                | Dismissed recurring-pattern keys                | ✅ Included                                                                                                 |
| `vision.onboarding.draft.v1`                  | Resumable onboarding draft (no file bytes)      | ✅ Included                                                                                                 |
| `vision.research.chartBuilder.layouts.v2`     | Chart Builder draft and named layouts           | ✅ Included                                                                                                 |
| `vision.analysis.sqlHistory`                  | Recent manual SQL editor statements             | ✅ Included                                                                                                 |
| `vision.sidebar.collapsed`                    | Sidebar shown as icons only (`1`; ADR-180)      | ✅ Included                                                                                                 |
| `vision.sidebar.hiddenSections`               | Sidebar sections the user hid (ADR-180)         | ✅ Included                                                                                                 |
| `vision.palette.recents`                      | Command palette recent routes (last ~5 visited) | ❌ Excluded — Ephemeral navigation state; registered in `LOCAL_STORAGE_EXCLUDED_KEYS` (Premium v3, ADR-071) |

---

### 4. In-Memory / Derived State

| Surface                                            | Backup      | Notes                                                                                                                                                                                                         |
| -------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Materialised views                                 | ❌ Excluded | Re-built at runtime by `materializedViewService.ts`                                                                                                                                                           |
| Price provider caches (HTTP)                       | ❌ Excluded | Re-fetched on demand                                                                                                                                                                                          |
| Electron `safeStorage` passphrase                  | ❌ Excluded | User re-enters passphrase post-restore. safeStorage is accessed lazily — only when a passphrase blob is already stored — to avoid macOS Keychain prompts for users who have not configured backup encryption. |
| `settings.json` (Electron-local)                   | ❌ Excluded | Contains backup dir config + deviceId; meaningless on new machine                                                                                                                                             |
| Legacy Electron `audit-anchor/` folder             | ❌ Excluded | Retired by ADR-231. `legacy-audit-cleanup.ts` deletes it once, with the macOS Keychain audit-witness item, after the database records migration 0004 (ADR-242).                                              |

The encrypted reference tables are backed up to preserve job and checkpoint consistency. On the
same installation, a restored in-flight job can restore its provider-form checkpoint while the
original key and 30-day claimed scope remain valid. A backup moved without that key still contains
only authenticated ciphertext; restoration fails visibly instead of returning token text or a
partly restored answer. A completed job already has its locally restored answer in `result_json`.
Deleting the job cascades to the scope and entries.

---

## Passphrase Storage & OS Keychain

When the user configures backup encryption, the passphrase is encrypted via Electron's `safeStorage` API and stored as `backupPassphraseEncrypted` in `settings.json`. On macOS, `safeStorage` delegates to the system Keychain under the entry **"Vision Safe Storage"**.

### Lazy Keychain Access

Because Vision ships ad-hoc unsigned (no Developer ID certificate), macOS treats the code identity as unstable. Accessing `safeStorage` at every launch would trigger a login-password prompt even for users who have never configured a passphrase. The Electron main process avoids this:

- **`getBackupPassphrase()`** reads `backupPassphraseEncrypted` from `settings.json` _before_ calling any `safeStorage` API. If no blob is present and the `VISION_BACKUP_PASSPHRASE` env var is absent, it returns `undefined` without touching the keychain. Backup-on-quit therefore never prompts for users who have not configured encryption.
- **`getBackupPassphraseStatus()`** (IPC: `backup:get-encryption-status`, used by the Backup settings tab) only calls `safeStorage.isEncryptionAvailable()` when a passphrase blob is already stored. With nothing stored, it reports availability from the API's mere presence (no actual keychain probe). The real check runs inside `setBackupPassphrase()` when the user actively opts in.

### Keychain Prompts on Unsigned Builds

Users who **do** store a passphrase will see macOS password prompts on an unsigned build because macOS re-challenges an unstable code identity on each access.

**Workarounds:**

| Option                             | Description                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Always Allow**                   | In the Keychain dialog, click "Always Allow" to suppress future challenges for Vision Safe Storage                                                                          |
| `VISION_BACKUP_PASSPHRASE` env var | Bypasses `safeStorage` entirely; the shell reads the passphrase from the environment variable instead. Useful for automation, CI, or users who want no Keychain involvement |
| No stored passphrase               | No backup-passphrase Keychain prompt occurs. The one-time legacy audit cleanup may still prompt once to delete its old Keychain item.                                       |

> [!note]
> `safeStorage` only stores and retrieves the _passphrase text_. The backup encryption key itself is always derived via scrypt from the passphrase; the Keychain never holds the raw key.

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

vision_backup_{deviceId}_{timestamp}.visionbak.enc ← Encrypted archive (v2 format)
```

### Encryption Formats

**v1 (Retired):** AES-256-CBC with static salt

- **Magic:** `VISIONENC1` for raw SQL backups or `VISIONBAK1` for bundles (10 bytes)
- **Salt:** Static `vision-backup-v1` value (hardcoded, same across all v1 backups)
- **KDF:** Scrypt(passphrase, salt, N=2^14, r=8, p=1)
- **Mode:** CBC (confidentiality only; no authentication)
- **Confidentiality:** ✅ Provided | **Authenticity:** ❌ Not provided | **Per-backup Entropy:** ❌ No
- **Status:** Not written since 2026-04-28 and no longer restored since 2026-10-19 ([[docs/adr/219-minimal-electron-shell-hardening|ADR-219]], superseding ADR-040's v1-readable clause). Restore refuses the file by its magic before any decryption with "This backup uses the retired v1 encryption format, which Vision no longer restores." Restore such a file with an older Vision release and create a new backup.

**v2 (AEAD, April 2026):** AES-256-GCM with per-backup random salt and IV

- **Magic:** `VISIONENC2` for raw SQL backups or `VISIONBAK2` for bundles (10 bytes)
- **Salt:** Random 16 bytes per backup (generated at encryption time)
- **IV:** Random 12 bytes per backup (GCM standard)
- **KDF:** Scrypt(passphrase, salt, N=2^15, r=8, p=1) — doubled iteration count vs v1
- **Mode:** GCM (Galois/Counter Mode — AEAD: Authenticated Encryption with Associated Data)
- **Auth Tag:** 16 bytes appended (detects tampering on decryption)
- **Confidentiality:** ✅ Provided | **Authenticity:** ✅ Provided | **Per-backup Entropy:** ✅ Yes
- **Overhead:** 53 bytes (magic + salt + IV + tag) vs v1's 40 bytes
- **Status:** Default for new backups as of 2026-04-28; see [[docs/adr/040-backup-format-v2-aead-encryption|ADR-040]]

**Compatibility:** Restore detects the format from the magic header. v2 backups decrypt with their passphrases unchanged. A v1 file is still recognised as encrypted, so the passphrase prompt appears, and is then refused; no plaintext is written.

**Modules:** `packaging/electron/backup/encrypted-file.ts` owns the v2 byte format, the
retired-v1 refusal, key derivation, stream cleanup, and authentication-error handling. The adapters preserve
their public interfaces and supply format-specific magic values and messages:

- `packaging/electron/backup/crypto.ts` — raw SQL backup adapter
- `packaging/electron/backup/bundle.ts` — `.visionbak` bundle adapter, which provides:

- `createBundle()` — Create zip from db.sql, attachments/, frontend-state.json, metadata.json
- `encryptBundle(bundlePath, passphrase)` — Wrap bundle in AES-256-GCM (v2); takes plaintext passphrase, not pre-derived key
- `decryptToTemp(encPath, passphrase, tmpPath)` — Decrypt a v2 bundle; refuse a retired `VISIONBAK1` bundle by name
- `openBundle()` — Extract and decrypt bundle; returns paths to sql, attachments, frontend state
- `isBundleEncrypted()` — Inspect bundle header without full extraction

---

## Consistent native capture and restart recovery

The native bundle writer captures SQL, attachments and schema head while the backend writer is
stopped. PostgreSQL remains available for `pg_dump`. `backup/quiescent-snapshot.ts` stops the
writer, invokes capture, and always attempts restart and detailed readiness in `finally`, even
when capture fails. Compression and encryption run
after the backend returns. The main process pauses its watchdog and holds a maintenance guard
against conflicting restore/update shutdown; quit waits for that guard. This introduces a brief
write interruption, signalled through `backend:lost` with the localized backup-maintenance reason.
It does not provide a distributed snapshot against external writers that bypass the native backend.

Before an attachment rename, native state records the intended destination and previous tree.
On the next launch, an unfinished database switch restores attachments and then the previous
database before normal startup. Recovery handles interruption before either rename, between
renames, and after activation. If database finalization is already durable, the remaining
attachment journal only authorizes cleanup. Corrupt state or unexpected paths stop recovery;
there is no empty replacement database fallback. See [[docs/adr/207-coordinated-native-recovery|ADR-207]]
and [[docs/architecture/electron|Electron architecture]].

## Restore Process (Phase 1+2)

**IPC Handlers** (in `packaging/electron/main.ts`):

| Handler               | Signature                       | Purpose                                                               |
| --------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `backup:run`          | `(destDir, frontendStateJson?)` | Create and optionally encrypt bundle                                  |
| `backup:restore`      | `(bundlePath, opts?)`           | Restore from bundle with optional passphrase; `opts = { passphrase }` |
| `backup:is-encrypted` | `(filePath)`                    | Detect if backup file is encrypted (returns boolean)                  |
| `backup:select-file`  | `()`                            | Dialog to select .visionbak file                                      |
| `backup:select-dir`   | `()`                            | Dialog to choose backup directory                                     |

**Helper Functions** (Phase 2 + v2 Upgrade):

- `decryptBackupFileToTemp(filePath, passphrase, tmpPath)` — Read the magic header; decrypt v2 (GCM) and refuse retired v1 (`VISIONENC1`) with the retired-format message; takes plaintext `passphrase`, not pre-derived key; throws `Error('INVALID_PASSPHRASE')` on bad decrypt or GCM auth failure
- Error sentinels: `ERR_PASSPHRASE_REQUIRED = 'PASSPHRASE_REQUIRED'`, `ERR_INVALID_PASSPHRASE = 'INVALID_PASSPHRASE'`
- Path validation (v2 security enhancement): `decryptBackupFileToTemp()` and `backup:restore` IPC handler validate:
  - `filePath` is a string
  - `filePath` was returned by prior `backup:select-file` dialog (stored in `ALLOWED_RESTORE_PATHS` set)
  - `filePath` ends in `.visionbak`, `.visionbak.enc`, `.sql`, or `.enc`
  - `filePath` exists on disk
  - `filePath` does not escape `attachments` directory via `path.resolve()` + `fs.realpath()`
  - Prevents XSS-in-renderer from passing arbitrary paths

**Restore Steps (Phase 2):**

1. **Path Validation** (v2) — Check `filePath` is in `ALLOWED_RESTORE_PATHS` and exists on disk. Reject if path escapes attachments root. Prevents renderer XSS from triggering arbitrary file operations.
2. **Encryption Detection** — Check file magic header via `isBundleEncrypted()`. If encrypted:
   - Return `{ encrypted: true }` to frontend
   - Frontend opens passphrase modal via `useRestoreBackup` hook
   - User enters passphrase; frontend retries restore with `{ passphrase }` option
3. **Decryption** (if encrypted) — Call `decryptBackupFileToTemp(filePath, passphrase, tmpPath)`. Read the magic header:
   - **v1 (retired):** Refuse with "This backup uses the retired v1 encryption format, which Vision no longer restores." before any decryption
   - **v2:** Extract salt + IV from header; derive key via Scrypt KDF with per-backup salt; decrypt GCM ciphertext; verify auth tag; throw `Error('INVALID_PASSPHRASE')` on tag failure (tampering detected)
   - Frontend catches invalid-passphrase error and re-prompts modal (up to 3 attempts typical)
4. **Schema Validation** — Read the dump's own `kysely_migration` rows. A dump without them is refused with `BACKUP_PRE_BASELINE`. The highest migration name must equal `metadata.schemaHead` when present (otherwise the bundle is reported corrupt), and is compared with the current `getSchemaHead()` (or the highest shipped `db/migrations/` file). If the bundle schema is newer, throw `BUNDLE_SCHEMA_NEWER` (user must upgrade Vision first).
5. **Native Database Stage** — The runtime restores into a fresh staged database created from
   `template0`, uses version-matched PostgreSQL 18 tools, stops on the
   first error, and restores in one transaction. A no-owner restore leaves schema tables with the
   owner/migration role, then hands only the runtime-managed materialized views to the application
   role so their create, index, refresh, and analyze lifecycle remains least-privilege. Runtime
   bootstrap grants restored ordinary tables and views individually and skips those app-owned
   materialized views.
6. **Database Validation** — Confirm the staged database's highest `kysely_migration` name equals
   the expected schema head and that it has public tables before
   the live database name can change.
7. **Attachment Stage** — Extract `attachments/` to a sibling staging directory, reject symbolic
   links, and compute the count and aggregate SHA-256 fingerprint.
8. **Atomic Activation** — Stop the active writer, switch the staged database and attachment tree,
   start the provider, and wait for database-backed `/health/detailed` readiness. Both switches
   keep rollback state until readiness succeeds. There is no audit-receipt check or
   audit-continuity warning ([[docs/adr/231-remove-audit-history|ADR-231]]).
9. **Frontend State Restore** — Return `{ frontendState.keys }` to renderer; component writes each key to localStorage via `localStorage.setItem(key, value)`.
10. **Page Reload** — Trigger full reload so theme and UI preferences take effect.

**Error Handling (Phase 2):**

- `PASSPHRASE_REQUIRED` → No passphrase provided for encrypted backup; retry prompt modal
- `INVALID_PASSPHRASE` → Wrong passphrase entered; modal shows error and allows retry (up to 3 attempts typical)
- `BUNDLE_SCHEMA_NEWER` → User-friendly toast: "Cannot restore — backup is from a newer Vision version"
- Other decrypt errors (corrupted file, incomplete extraction) → `openBundle()` fails; IPC returns error with details
- Attachment stage or activation failure → Restore fails; the previous attachment tree and database
  remain active or are rolled back together
- Database restore or detailed-readiness failure → Explicit provider error; staged database and
  attachment state are rolled back before the writer resumes
- Fallback source resolution: If user does not enter passphrase in modal, restore attempts `VISION_BACKUP_PASSPHRASE` env var and OS keychain (Electron safeStorage) before throwing `PASSPHRASE_REQUIRED`

**Related Code:**

- `runBundleRestore()` in `packaging/electron/backup/restore.ts`, called from `packaging/electron/main.ts` — Main restore orchestrator
- `FrontendStateSnapshot` and all backup bridge result types in `packaging/electron/electron-api.d.ts`, re-exported by `@vision/types/electron`
- Error handling in `BackupTab.tsx` — checks for BUNDLE_SCHEMA_NEWER prefix on error string

---

## Coverage Enforcement

Tables need no enforcement: the dump is whole-database, so a table added by a migration is in the
next backup automatically.

`apps/node-backend/tests/localStorage-keys-registry.test.ts` runs in CI and fails when frontend
source reads or writes a raw localStorage key that is not registered in `LOCAL_STORAGE_KEYS` or
`LOCAL_STORAGE_EXCLUDED_KEYS` (`apps/frontend/src/lib/localStorage-keys.ts`).

### Native macOS end-to-end journey

`bun run native:isolated-smoke` is the destructive backup/restore acceptance journey for the
supported native macOS application. It creates its own temporary application-data directory and
PostgreSQL 18 cluster, writes a synthetic account, recipient, transaction, setting, and attachment,
creates a current AES-256-GCM `.visionbak.enc` bundle with frontend state, mutates the temporary
database and attachment, and restores the bundle. It then verifies exact account, transaction,
setting, and attachment values plus the schema revision, database statistics, frontend-state
payload, API readiness, and packaged frontend assets. The entire temporary instance is removed
after success; it cannot address the user's real Vision data.

`apps/node-backend/tests/backup-release-compat.test.ts` also opens the immutable, sanitized
`packaging/electron/backup/fixtures/vision-1.0.2-sanitized.visionbak.enc` artifact through the
compiled build output of `packaging/electron/backup/bundle.ts` (`out/backup/bundle.js`); the backend Vitest global setup
(`apps/node-backend/tests/setup/electronBuild.ts`) rebuilds `out/` when an Electron source is newer
than the last build ([[docs/adr/196-electron-shell-typescript|ADR-196]]). The artifact was
written and encrypted by the bundle implementation from Git tag `v1.0.2` and includes synthetic
SQL, an attachment, metadata, and frontend state. This checks the current reader against encrypted
bytes from the older producer rather than a bundle created by the current writer. Vision 1.0.2
already wrote the authenticated `VISIONBAK2` envelope. The fixed encrypted-byte tests in
`packaging/electron/backup/encrypted-file.test.ts` decrypt the v2 vectors and check that the v1
vectors are refused without writing plaintext. Opening it does not make it restorable: its dump predates the Kysely baseline, so restore refuses
it with `BACKUP_PRE_BASELINE`. Newer-schema and pre-baseline rejection and restore rollback remain
covered by the focused Electron backup tests (`packaging/electron/backup/restore.test.ts`).

---

## Bug Fix: Backup Path Keeps Reverting to Default (2026-06-11)

**Symptom:** After setting a custom backup directory and closing then reopening the Settings dialog, the backup path would revert to the default. Scheduled backups therefore ran to the wrong location.

**Root cause (two independent defects):**

1. **Settings dialog clobber.** `DashboardSettingsDialog.tsx` persisted the Backup tab's values (path, schedule, enabled flag) on every Save click, even when the Backup tab had never been opened in that dialog session. The tab's default React state (empty string / false) overwrote the saved settings.

2. **Electron IPC envelope unwrap.** The `backup:load-settings` and `will-quit` IPC handlers in `packaging/electron/main.ts` read the backup settings from the API response as `data.value`, but the API returns the standard `{ ok: true, data: { key, value } }` envelope — so the handlers were reading `undefined` instead of the actual stored value. This meant the in-memory settings object was never populated from the DB, and the DB branch of the load path was effectively a no-op.

**Fix:**

- `DashboardSettingsDialog.tsx` now loads backup settings from the backend when the dialog opens, using a `trusted` flag to prevent a stale in-flight response from overwriting user edits made after open.
- `BackupTab.tsx` initialises from the loaded values rather than empty state.
- `packaging/electron/main.ts` IPC handlers unwrap `response.data.value` correctly (matching the `{ ok, data: { key, value } }` envelope shape).
- `settings.json` (Electron-local) mirrors the raw stored values rather than the unwrapped result, so the file accurately reflects what the backend returned.

**Sources:** [[apps/frontend/src/features/settings/DashboardSettingsDialog.tsx]], [[apps/frontend/src/features/settings/sections/BackupSection.tsx]], [[packaging/electron/main.ts]]

---

## Gaps / Known Limitations

- No cloud/off-device sync. Bundles are local-disk only.
- No incremental backup. Every backup is a full dump.
- Merge-restore is not supported. Restore stages and validates a complete replacement, then uses
  atomic activation with rollback instead of modifying the live attachment tree in place.
- Restoring a bundle created on a **newer** schema version is blocked with a clear error. Upgrade Vision first.

---

## Related

- [[docs/architecture/electron|Electron Desktop Architecture]] — IPC handlers, bundle format integration
- [[docs/reference/api-endpoint-matrix#ipc-handlers--electron-desktop-phase-12|API Endpoint Matrix — IPC Section]] — All 8 backup/restore handlers
- [[docs/features/settings|Settings Feature]] — Backup tab UI integration
- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron Sandbox Hardening]] — Security model for backup/restore
- [[docs/adr/index|Architecture Decision Records]]
