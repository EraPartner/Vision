---
title: Legacy and Compatibility Surface Inventory
type: audit
date: 2026-09-09
tags: [audit, legacy, compatibility, database, api, frontend, electron]
description: Repository-wide classification of legacy and compatibility surfaces, their consumers, retirement gates, and bounded TODO ownership.
aliases: [legacy inventory, compatibility inventory]
related_code: [[TODO.md]], [[package.json]], [[scripts/check-legacy-inventory.js]], [[docs/audits/legacy-surface-inventory.json]]
---

# Legacy and Compatibility Surface Inventory

## Outcome

The repository-wide discovery found **53 candidate surfaces**:

| Classification         | Count | Meaning                                                                                                                    |
| ---------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------- |
| Remove now             |     9 | Static reachability or schema evidence shows no supported runtime consumer.                                                |
| Migrate, then remove   |    27 | The surface is redundant or deprecated, but an active client, stored-data, rollback, or support-window dependency remains. |
| Retain with reason     |    15 | The surface is current architecture, recovery support, or intentionally named compatibility.                               |
| Historical record only |     2 | Keep as migration or decision history; it is not runtime code.                                                             |
| Unknown                |     0 | No candidate remains without a disposition.                                                                                |

The exact evidence, readers, writers, persisted-data status, replacement, deletion dependencies,
support window, and TODO owner for every item are in
[[docs/audits/legacy-surface-inventory.json|the machine-readable inventory]].
`bun run check-legacy-inventory` verifies the record schema, evidence paths, totals, required seed
coverage, and the existence of every actionable TODO.

This is a static repository audit. The repository does not provide maintained-install database
counts, external API-client telemetry, old browser-profile population, or an Electron install
census. Those live facts remain explicit retirement gates; absence of static callers is not proof
that persisted data or skipped-version installs are safe to discard.

## Confirmed removal candidates

| ID                              | Surface                                        | Why it is irrelevant now                                                                              | Required boundary                                                                                      |
| ------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `LEG-DB-RESOLVED-BANK-ACCOUNT`  | `import_staging_rows.resolved_bank_account_id` | No production reader or writer exists.                                                                | Guard non-null values and active batches; prove Alembic upgrade/downgrade on disposable PostgreSQL 18. |
| `LEG-DB-EXCHANGE-RATE-CACHE`    | `exchange_rate_cache`                          | Current runtime uses `exchange_rates`; the old table is not in the fresh baseline or backup registry. | Guard relation shape and data; keep a fresh-install no-op and restore boundary.                        |
| `LEG-BE-BANK-ADAPTER-SHIM`      | `services/bankAdapters.js`                     | Only tests and the test-only allowlist import it.                                                     | Repoint tests and remove stale docs/allowlist entries.                                                 |
| `LEG-BE-INFO-HELPER-REEXPORTS`  | Repository helper re-exports                   | All callers import the seven helpers from their canonical modules.                                    | Run an exact import scan and repository tests.                                                         |
| `LEG-PKG-ASSET-CLASS-SHIM`      | Shared-utils asset-class subpath               | It has zero repository importers; `@vision/types` owns the constants.                                 | Remove package exports and run typecheck/build.                                                        |
| `LEG-FE-DEFAULT-SETTINGS-ALIAS` | `defaultAppSettings`                           | Zero callers; `DEFAULT_APP_SETTINGS` is canonical.                                                    | Preserve hydration tests.                                                                              |
| `LEG-FE-ASSET-CLASS-GROUPS`     | `ASSET_CLASS_GROUPS`                           | Zero callers; translated `getAssetClassGroups` is canonical.                                          | Run exact symbol scan and portfolio tests.                                                             |
| `LEG-FE-INSIGHT-DEAD-EXPORTS`   | Old insight dismissal helpers                  | Only their legacy unit tests use them; the migration gate needs a smaller storage surface.            | Preserve load/replace/types and rewrite focused tests.                                                 |
| `LEG-ELEC-ARCHIVER7`            | Archiver v7 callable/tar/json branches         | Lockfiles resolve Archiver 8 and bundle creation only requests zip.                                   | Prove backup creation and restore round trips.                                                         |

The two database candidates are irrelevant to current code, but deleting a database object is still
destructive. Their TODOs require guarded migrations and disposable-database proof. This audit does
not authorize applying either migration to a maintained database.

## Staged retirements

These items are not safe immediate deletions. Each now has an owner-sized TODO with its first
required migration or decision.

### Database and stored contracts

| ID                         | Surface                                  | Current gate                                                                               |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `LEG-DB-RAW-PROVENANCE`    | Provider raw transaction relations       | Preserve unique provenance, backfill links, stop writers, and prove backup/restore parity. |
| `LEG-DB-TX-HASH`           | Legacy `tx_hash` identity                | ADR-134 acceptance plus a fallback-free soak.                                              |
| `LEG-DB-ADR109-ROLLBACK`   | `legacy_inh_*` relations                 | Zero-loss disposition, 30-day soak, stopped writers, and restore-tested backup.            |
| `LEG-DB-RECURRENCE-ENUM`   | Old recurrence enum                      | ADR-109 retirement, zero `pg_depend` consumers, and downgrade-policy decision.             |
| `LEG-DB-BANK-ACCOUNT`      | Transaction `bank_account` compatibility | Client identifier migration, parity proof, stopped writers, and guarded contract.          |
| `LEG-DB-STATEMENT-SCALARS` | Statement scalar projections             | Multi-currency client migration and count/digest parity.                                   |

### API contracts

| ID                               | Surface                              | Current gate                                                           |
| -------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `LEG-API-AI-DONE`                | AI `done` event                      | Staged client/server migration and supported skew window.              |
| `LEG-API-CATEGORY-ASSIGN`        | Category name-assignment endpoint    | External-client decision and synchronized route/OpenAPI removal.       |
| `LEG-API-AGGREGATION-ALIASES`    | `start`/`end` and `all_tags` aliases | External-client decision and contract tests.                           |
| `LEG-API-IMPORT-QUERY-FALLBACKS` | Import query options                 | Shipped frontend must first send multipart fields across all variants. |
| `LEG-API-ADMIN-FORCE`            | Admin reset `force` query            | External-client boundary and destructive-route tests.                  |
| `LEG-API-AI-UNPAGED`             | Unbounded conversation listing       | Client window and bounded load contract.                               |
| `LEG-API-ERROR-SHAPES`           | Historical HTTP error envelopes      | Route-wide unified-envelope proof and packaged skew decision.          |
| `LEG-API-TX-DATE`                | Transaction `date` fallback          | Response fixture proof and server/client skew decision.                |

### Frontend compatibility

| ID                          | Surface                          | Current gate                                                |
| --------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `LEG-FE-ASSET-CLASS-LABELS` | English label constant           | Migrate active UI to translated helpers.                    |
| `LEG-FE-INSIGHT-GATE`       | Browser dismissal migration gate | Browser-profile horizon plus offline/retry proof.           |
| `LEG-FE-MONEY-SHIM`         | Local money re-export            | Move six production imports to shared-utils.                |
| `LEG-FE-TYPE-ALIASES`       | Market/import type aliases       | Migrate active type imports.                                |
| `LEG-FE-CURRENCY-FORMATTER` | Positional decimal argument      | Move runtime callers to the canonical options shape.        |
| `LEG-FE-TAX-PIT-ALIAS`      | `federalPITTotal`                | Census persisted keys and migrate consumers/data.           |
| `LEG-FE-RECURRENCE-INPUT`   | `bi-weekly` spelling             | Live migration proof, old-value query, and client window.   |
| `LEG-FE-ENHANCED-EFFECTS`   | Old app-settings field           | Persisted-settings support horizon and population evidence. |
| `LEG-FE-DASHBOARD-STORAGE`  | Dashboard local storage          | Browser-profile horizon and migration smoke.                |
| `LEG-FE-CHART-V1-STORAGE`   | Chart Builder v1 layouts         | Browser-profile horizon and saved-layout round trip.        |
| `LEG-FE-DEEP-LINKS`         | Old settings/account/routes      | Published link window plus browser/Electron route tests.    |

### Electron installation compatibility

| ID                        | Surface                              | Current gate                                                           |
| ------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `LEG-ELEC-USERDATA-NAME`  | `vision-desktop` user-data migration | Install census or cutoff, recovery rule, and packaged migration smoke. |
| `LEG-ELEC-NATIVE-CUTOVER` | Retired Docker cutover guards        | Zero maintained legacy installs or cutoff plus recovery proof.         |

## Explicitly retained surfaces

The audit rejected these common false positives:

- `portfolio_txn_type`, the archived revision stamp bridge, and root `alembic.ini` still support
  valid schema, upgrades, or the human migration workflow.
- App-local money/CSV/slugify modules, `priceProviderService`, the aggregation materialized-view
  service, frontend `apiClient`, and handwritten API type barrels have active architectural owners.
- The camel-case exchange-rate query key, `gainLoss`, upcoming-payment dismissal validation,
  `Skeleton`, and `PageLoader` are current behavior, not legacy remnants.
- Raw SQL/`.enc` restore, the `VISIONBAK1` AES-CBC reader, and the Vision 1.0.2 fixture are required
  recovery compatibility until a backup support policy says otherwise.
- Archived Alembic revisions, superseded ADRs, and manual rollback contracts are historical or
  recovery evidence. They must not be deleted merely because their text describes retired designs.

## Discovery method and coverage

The pass combined name-based search with reachability and schema-use checks across backend and
frontend runtime code, packages, Alembic revisions and manual migrations, OpenAPI routes, Electron
startup and backup code, generated or hand-written types, tests, package exports, configuration,
and documentation. Known candidates from the original TODO were mandatory seed IDs, so the checker
fails if a later edit silently drops one.

The inventory is a dated snapshot. Re-run it when a migration, compatibility policy, supported
client window, backup format, or install population changes. A rerun should update evidence and
classifications, not create a second broad cleanup item.

## Related

- [[TODO|Implementation queue]]
- [[docs/reference/scripts|Scripts Reference]]
- [[docs/guides/migrations|Database Migrations]]
- [[docs/adr/134-versioned-import-identity-and-exact-provenance|ADR-134]]
- [[docs/adr/109-flat-investments-schema-canonical|ADR-109]]
