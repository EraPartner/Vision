---
title: "ADR-231: Remove audit history"
type: adr
status: accepted
date: 2026-10-20
tags:
  [
    adr,
    audit,
    security,
    electron,
    keychain,
    backup,
    restore,
    migration,
    retirement,
    splits,
    portfolio,
    adr-013,
    adr-101,
    adr-156,
    adr-157,
    adr-158,
    adr-160,
    adr-161,
    adr-162,
    adr-163,
    adr-207,
    adr-222,
  ]
description: "Accepted on 2026-10-20 by Tor. Vision removes the audit-history feature: the PostgreSQL hash chain, the Electron signed receipt and macOS Keychain witness, the private audit bridge, enrollment, device transfer, key rotation, one-year retention, the Admin audit view and the plain change tables db_editor_audit, split_audit and portfolio_retag_audit. Migration 0004 drops the tables. The broker re-tag recognises a repeat from current assignments. A one-time Electron cleanup removes the leftover receipt folder and Keychain item. Supersedes ADR-156, 157, 158, 160, 161, 162 and 163, and the audit parts of ADR-013, ADR-101, ADR-207 and ADR-222."
aliases:
  [
    adr-231,
    remove audit history,
    remove audit chain,
    remove audit trail,
    legacy audit cleanup,
  ]
related_code:
  [
    "db/migrations/0004_remove_audit_history.sql",
    "db/migrations/0004_remove_audit_history.down.sql",
    "packaging/electron/legacy-audit-cleanup.ts",
    "packaging/electron/main.ts",
    "packaging/electron/runtime/native.ts",
    "packaging/electron/backup/restore.ts",
    "packaging/electron/updater.ts",
    "apps/node-backend/src/services/portfolio/portfolioBrokerRetagService.ts",
    "apps/node-backend/src/services/dbEditor.ts",
    "apps/node-backend/src/services/splitService.ts",
    "apps/node-backend/src/database/migrate.ts",
    "apps/node-backend/src/backup/coverage.ts",
    "config/postgres/app-role-grants.sql.tpl",
  ]
---

# ADR-231: Remove audit history

## Status

Accepted on 2026-10-20 (decision by Tor). It supersedes
[[docs/adr/156-forward-only-audit-chain-foundation|ADR-156]],
[[docs/adr/157-electron-local-audit-receipt|ADR-157]],
[[docs/adr/158-macos-keychain-audit-witness|ADR-158]],
[[docs/adr/160-explicit-audit-enrollment-baseline|ADR-160]],
[[docs/adr/161-password-protected-audit-device-transfer|ADR-161]],
[[docs/adr/162-one-year-audit-retention|ADR-162]] and
[[docs/adr/163-audit-transfer-recovery-journal|ADR-163]]. It supersedes the `split_audit` trail
in [[docs/adr/013-split-hard-delete-with-audit-trail|ADR-013]] (hard delete stays), the
`db_editor_audit` table in [[docs/adr/101-db-data-editor|ADR-101]] (the editor stays) and the
`schema_migration` audit events in
[[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]] (the Kysely migrator stays) and the
audit-closure pause in [[docs/adr/207-coordinated-native-recovery|ADR-207]] (writer quiescence
stays).

## Date

2026-10-20

## Context

From September 2026 Vision gained local tamper evidence for its change history. Migration
`0117_audit_chain` started a forward-only hash chain in PostgreSQL (`audit_chain_head`,
`audit_chain_entries`, `audit_chain_checkpoints`, append-only triggers). Database-editor writes,
split lifecycle events, broker re-tags, schema migrations and updater decisions appended entries.
The Electron main process kept an HMAC-signed receipt under `<userData>/audit-anchor/` and a
latest-checkpoint record in the macOS Keychain through a compiled Swift helper. A private
loopback bridge (`/api/internal/audit/*`, per-launch `VISION_AUDIT_BRIDGE_TOKEN`) verified the chain
before the first page load, every 30 seconds, before restore activation and around updates. Later
ADRs added enrollment, a password-protected device transfer, key rotation, a transfer recovery
journal and one-year retention pruning. Older plain change tables (`db_editor_audit`,
`split_audit`, `portfolio_retag_audit`) fed the chain.

Vision runs on one person's Mac. ADR-158 already recorded the limit: someone who can rewrite the
database and application data on that Mac can usually also change the Keychain item or the
application code. The owner judged the protection unrealistic for that setting. Its cost was
real: a startup wait before navigation, Keychain prompts on unsigned builds, restore and update
gates, a private bridge in the backend, a native helper in the package and more than ten thousand
lines of code and tests.

## Decision

Tor decided to remove the feature entirely.

- **Schema.** `db/migrations/0004_remove_audit_history.sql` drops `audit_chain_checkpoints`,
  `audit_chain_entries`, `audit_chain_head`, the functions `audit_chain_prune_prefix` and
  `audit_chain_reject_mutation` (and with them the append-only triggers), and the tables
  `db_editor_audit`, `split_audit` and `portfolio_retag_audit`. The baseline is unchanged; the
  number 0003 is left for another change. The down migration recreates only the empty schema,
  with an empty genesis chain head. The runtime role grant template no longer grants `EXECUTE` on
  `audit_chain_prune_prefix`.
- **Backend.** The audit chain repository and core, the audit bridge, read, retention and
  verification services, the six `POST /api/internal/audit/*` routes and
  `VISION_AUDIT_BRIDGE_TOKEN` are removed. `migrate.ts` no longer appends `schema_migration`
  events. The database editor logs each committed change (`db-editor mutation committed`) but no
  longer writes a table row, and it no longer refuses the former audit tables with `403`. Split
  routes no longer read the `x-actor` header and split services take no `actor` parameter. The
  backup coverage list no longer names the six tables.
- **Broker re-tag.** `PUT /api/investments/transactions/broker` keeps no stored state. When
  `from_account_id` and `to_account_id` differ and every selected row already sits on
  `to_account_id`, it writes nothing and returns `replayed: true` with `changed_count: 0`.
  `idempotency_key` is still required as a UUID and is echoed but never stored, so reusing a key
  with another body is no longer a `409`. `receipt_id` and `created_at` are removed from the
  receipt, a breaking change to its schema. `previous_assignments` reports each row's broker before
  this call. The web dialogs show `selected_count` for a replay and no longer show a receipt ID.
- **API.** Six operations are removed (299 → 293). `openapi.yaml` loses the internal audit paths,
  the `AuditBridgeToken` security scheme and the `Audit*` schemas.
- **Electron.** `audit-anchor.ts`, `audit-keychain.ts`, `audit-keychain.swift` and its packaged
  `audit-keychain` resource, `audit-viewer.ts`, the six `audit:*` IPC channels and
  `window.electronAudit` are removed. Startup no longer waits on a chain check (the `audit_verify`
  boot mark is gone) and the 30-second re-check is gone. Restore no longer compares checkpoints or
  shows the audit-continuity warning. Updates are no longer recorded or gated by the bridge; the
  checksum check stays. A healthy backend left running by a previous launch is reused again
  instead of being restarted for a fresh bridge token.
- **Leftover cleanup.** `packaging/electron/legacy-audit-cleanup.ts` runs once, fire-and-forget,
  after launch. It removes `<userData>/audit-anchor` (receipt, encrypted key and any transfer
  journal); a symbolic link is unlinked without touching its target. On macOS it deletes the
  Keychain generic password with account `latest-checkpoint` and service
  `com.vaultvoyager.vision.audit-witness` or `com.vaultvoyager.vision-demo.audit-witness` through
  `/usr/bin/security delete-generic-password`. After the folder step succeeds it writes
  `<userData>/.legacy-audit-cleanup-done`, so later launches skip both steps. If the folder step
  fails, the marker is not written and the next launch retries. The Keychain delete is otherwise
  tried once only: the item's access list trusted the removed helper, so macOS may show a prompt,
  and a refused prompt must not return on every launch. Tor chose this on 2026-10-20.
- **Frontend.** The Admin > Audit card is removed with 52 locale keys per language
  (`admin.audit.*`, `app.audit*`, `settings.restore.auditContinuity*` and
  `portfolio.brokerTransfer.receiptId`).

## Consequences

- Vision no longer detects local tampering with its change history, and no longer claims to.
  Backups, encryption, restore rollback and the update checksum check are unaffected.
- Migrations apply at backend startup, so migration 0004 runs at the next launch after the update.
  All chain entries and checkpoints and every database-editor, split and broker re-tag change
  record are deleted. They can be read only from a backup taken before the update, with an older
  Vision. The down migration does not bring them back.
- Older backups that contain the six tables still restore without an audit warning. The restore
  path activates the dump at its own migration head, then backend startup runs
  `runMigrations()`, which applies 0004 and drops the tables again. This follows from the code
  path; no test restores a pre-0004 dump end to end.
- The leftover cleanup may show one macOS Keychain prompt. If the user refuses it, or the delete
  fails for another reason after the folder was removed, the item stays in the login keychain.
  It is harmless and can be removed in Keychain Access. A `.vat` transfer file or audit snapshot
  that the user saved elsewhere is not touched; it no longer has a use and can be deleted.
- A broker re-tag repeat is recognised from the current assignments, not from the key. A request
  whose rows are already on the destination returns a replay receipt even if it was never sent
  before. The destination eligibility check runs first, so a replay against a destination that
  was closed since then returns `400`. A selection that is partly on the source and partly on the
  destination remains a stale `409`.
- Clients that call `/api/internal/audit/*` get an error response instead of the old operation.
  Clients that read `receipt_id` or `created_at` from a re-tag receipt must stop. A client that
  sends `x-actor` to the split routes is not rejected; the header is ignored.
- `docs/api/internal-audit.md` and `docs/diagrams/electron-audit-verification-flow.puml` are
  deleted. The flow visualizer drops the native audit receipt journey.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/229-remove-cloud-ai-codex-and-agentcloak|ADR-229]] (previous feature removal)
- [[docs/api/investments|Investments API]]
- [[docs/api/splits|Splits API]]
- [[docs/api/admin|Admin API]]
- [[docs/architecture/electron|Electron Architecture]]
- [[docs/security/data-protection|Data Protection]]
- [[docs/features/backup-coverage-audit|Backup Coverage]]
- [[docs/reference/data-model|Data Model]]
