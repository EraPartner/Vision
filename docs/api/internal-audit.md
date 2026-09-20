---
title: Private Electron Audit Bridge API
type: endpoint
status: active
date: 2026-09-20
tags: [api, audit, electron, security, internal]
description: Private loopback verification and checkpoint metadata routes used by the native Electron main process.
aliases: [internal audit bridge, audit verification API]
related_code:
  - apps/node-backend/src/routes/internalAudit.js
  - apps/node-backend/src/services/auditVerificationService.js
  - apps/node-backend/src/services/auditReadService.js
  - apps/node-backend/src/services/auditBridgeService.js
  - apps/node-backend/src/services/auditRetentionService.js
  - packaging/electron/runtime/native.js
  - packaging/electron/audit-anchor.js
---

# Private Electron Audit Bridge API

`/api/internal/audit` is a native Electron main-process bridge. The renderer does not receive its token. Each app launch generates a fresh token and passes it to the backend child as `VISION_AUDIT_BRIDGE_TOKEN`. All six routes require an actual loopback socket peer and `Authorization: Bearer <per-launch token>`. The router checks the socket address rather than a proxy-derived client address. `ADMIN_AUTH_TOKEN` does not grant access. Normal API clients should not call these routes.

These operations are additive and private; they do not change the contract of existing public routes.

## Operations

| Method | Path                                  | Request JSON                                                                                                                        | Result                                                                                               |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| POST   | `/api/internal/audit/verify`          | `{}` or `{ "trustedCheckpoint": { "sequence": 0, "hash": "<64 lowercase hex>" } }`                                                  | ADR-026 envelope whose `data.status` is `verified`, `partially_verified`, `unavailable`, or `failed` |
| POST   | `/api/internal/audit/read`            | `{ "trustedCheckpoint": { "sequence": 0, "hash": "<64 lowercase hex>" }, "afterSequence": 0, "limit": 100 }`                        | Verification status and at most 500 entries; no entries if verification fails or is unavailable      |
| POST   | `/api/internal/audit/retention-plan`  | `{ "trustedCheckpoint": { "sequence": 3, "hash": "<64 lowercase hex>" } }`                                                          | Eligible one-year prefix boundary or a reason no prefix is due                                       |
| POST   | `/api/internal/audit/retention-prune` | `{ "trustedCheckpoint": { "sequence": 3, "hash": "<64 lowercase hex>", "retention": { ... } } }`                                    | Number of entries removed; exact retry returns zero                                                  |
| POST   | `/api/internal/audit/checkpoint`      | `{ "sequence": 0, "headHash": "<64 lowercase hex>", "anchorKind": "...", "receiptId": "...", "receiptHash": "<64 lowercase hex>" }` | Inserted or exact repeated checkpoint metadata `{ id, createdAt }`                                   |
| POST   | `/api/internal/audit/update-decision` | `{ "decision": "checksum_verified", "mode": "native", "version": "v1.2.3" }`                                                        | Appended `release_update` entry `{ sequence, hash }`                                                 |

The request body must be a plain JSON object of at most 4096 serialized bytes and contain only the listed keys. Verify accepts no checkpoint or one with a nonnegative safe-integer sequence and lowercase SHA-256 hash. Checkpoint requires all five fields; `anchorKind` is 1–100 characters and `receiptId` is 1–300 characters. Update decisions are limited to `checksum_verified`, `checksum_failed`, `install_requested`, and `install_failed`; `mode` is `native` or `dev`, and the bounded version starts with an optional `v` followed by a digit. The decision route accepts no path or URL. Malformed input returns 400, a missing or wrong token returns 401, and a non-loopback peer returns 403. A checkpoint ahead of the chain or with a mismatched hash returns 409.

The verify route returns HTTP 200 even when `data.status` is `failed` or `unavailable`. Clients must inspect `data.status`. The backend scans the full versioned chain, its head, the supplied trusted checkpoint, linked post-cutover domain rows, and the migration's legacy cutover IDs. For editor and split entries, it recomputes the domain digest from PostgreSQL-persisted row values. For broker retag entries, it compares the chain payload with the persisted receipt fields, including normalized UUIDs. All three checks include the exact UTC microsecond `created_at`, which the writers obtain from PostgreSQL. A mismatch in those authenticated values fails verification. The verifier also compares the latest chained Alembic migration heads with `alembic_version`. Pre-cutover rows are counted in `legacyUnverified`; they are not represented as verified history. A checkpoint behind the current head yields `partially_verified`: the prefix matches, while the newer tail has no independent receipt. The backend trusts a checkpoint only because the main process authenticated it outside PostgreSQL; a row in `audit_chain_checkpoints` is not proof by itself.

The read route repeats full verification and reads one ordered page inside a single read-only repeatable-read transaction with a nine-second database statement timeout. It accepts an optional nonnegative `afterSequence` cursor and a `limit` of 1–500 (default 100). Entries are returned only when the chain matches an externally authenticated checkpoint. Each entry is labeled `anchored` through the checkpoint or `pending_anchor` in the newer tail. The `hasMore` flag indicates another page. The native bridge limits the response to 4 MiB. A failed or unavailable verification returns no entries. A valid page is a snapshot, not proof that a later mutation could not occur; a version 3 receipt also requires a separate macOS Keychain checkpoint.

The checkpoint route stores metadata after the Electron main process has persisted its local receipt. The route verifies the named sequence and hash against the stored chain under a database lock. It cannot create or authenticate an external receipt on its own.

The update decision route records native updater checksum and install decisions in the chain. A native runtime closes the new checkpoint synchronously, including when the update mode is `dev`. If an external receipt exists or this launch established a trusted session, install blocks if closure fails. An existing installation with no receipt and no trusted session may still install after the event is recorded, with audit protection reported unavailable. These events record a local decision with mode and version; they do not prove a signed release or publisher provenance. Source development updates without a native runtime can lack the bridge, so decision recording there is not guaranteed.

## One-year retention

A version 3 trusted checkpoint may contain a signed `retention` object: `through` (last deleted sequence), `hash` (its chain hash), `domainMax` (`dbEditor`, `split`, `retag` linked row IDs), and sorted `migrationHeads`. Its `through` must be below the checkpoint sequence. Verification accepts a retained suffix only when its first entry is exactly `through + 1` and its `previousHash` matches that signed hash. If the old prefix still exists, verification checks it and the signed boundary before pruning. A successful verification reports `retentionThrough`; reads start after that sequence.

`retention-plan` verifies the complete chain under a read-only repeatable-read transaction, then proposes only a contiguous prefix older than one year and behind an independently authenticated checkpoint. The Electron main process signs this plan into its receipt and Keychain witness, records checkpoint metadata, and then calls `retention-prune`. The prune route verifies the signed boundary and calls migration 0118's guarded database function. The function rechecks the prefix under the chain-head lock; a complete prior deletion is an idempotent zero result. If receipt signing succeeds but pruning fails, the next native retention attempt retries the same signed boundary. A database-local checkpoint alone cannot authorize the main process to sign a boundary. See [[docs/adr/162-one-year-audit-retention|ADR-162]].

## Lifecycle and limits

The main process checks on native startup before first navigation and after backend recovery. It creates a first receipt only for a native cluster created in the current launch after the verifier checks its post-migration head and reports zero legacy-unverified audit rows; migration 0117 can already have written the first chain entry. A transient initial bridge failure can be retried up to five times at 30-second intervals while healthy. A saved receipt binds the chain sequence, hash, and legacy cutover IDs with a local HMAC key protected by Electron `safeStorage`. Version 3 additionally requires a matching macOS Keychain checkpoint; an older version 2 receipt remains unverified. An exact verified head starts a trusted live session. Every 30 seconds while that session and the backend remain healthy, Electron re-verifies and can persist a newly valid tail to the local receipt before mirroring checkpoint metadata. A tail already present at startup is not automatically promoted. Backend loss ends the live session. A failed or unavailable check produces a system notification; startup remains accessible. Restore pauses closure and first requires an exact `verified` match. A mismatch rolls back the candidate. Only after that rollback succeeds may the user deliberately accept a second warning with Cancel as default; Electron then retries that selected backup once, requires a full internally valid chain without claiming the receipt matches, keeps the external receipt unchanged, and leaves audit continuity unverified; a later check against the preserved receipt may report rollback. Existing installations are not automatically enrolled. Changes within the 30-second interval can be incorporated into the next receipt, and a coordinated rollback of the application-data tree and PostgreSQL is detected when the separate Keychain checkpoint survives. Loss or mismatch of that checkpoint fails closed.

## Related

- [[docs/api/index|API Documentation]]
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]
- [[docs/architecture/electron|Electron Architecture]]
- [[docs/security/data-protection|Data Protection]]
- [[docs/adr/157-electron-local-audit-receipt|ADR-157]]
- [[docs/adr/158-macos-keychain-audit-witness|ADR-158]]
- [[docs/adr/162-one-year-audit-retention|ADR-162]]
