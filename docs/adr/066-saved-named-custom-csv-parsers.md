---
title: ADR-066 - Saved Named Custom CSV Parsers
type: adr
status: Accepted
date: 2026-06-01
tags: [adr, import, csv, custom-parser, persistence, database, named-parsers, bank-label, generic-adapter, stage-fallback]
description: Persist named custom CSV parser configurations in a new `custom_parser_configs` table so users can save, reuse, edit, and delete their column-mapping setups across import sessions. The parser name doubles as the bank/account label written onto imported transactions. Includes a generic-adapter fallback fix in stageBatch that eliminates "Unknown adapter" errors for any free-form named import.
related: [docs/features/import, docs/api/imports, docs/reference/data-model, docs/adr/046-import-review-category-assignment, docs/adr/007-streaming-imports]
---

# ADR-066: Saved Named Custom CSV Parsers

## Status

**Accepted** — Implemented 2026-06-01 on `feat/saved-custom-parsers`.

## Date

2026-06-01

## Context

### Problem

Users importing from unsupported banks had to re-enter their full custom CSV column mapping (date column, date format, recipient column, amount column, memo column, separator, encoding, skip-rows) on every single import session. The configuration was held only in transient frontend React state and was lost when the page was left or refreshed.

This friction made the custom import path viable only as a one-off workaround rather than a repeatable workflow for users whose bank is not among the nine pre-configured adapters.

A secondary latent bug was present in the import pipeline staging phase (`stageBatch` in `apps/node-backend/src/services/importPipeline/stage.js`): when a `customConfig` was supplied along with an `adapterName` that was not in the static adapter registry (e.g. a free-form bank label the user had typed), `getAdapter(adapterName)` returned `null` and the code threw `Unknown adapter` instead of using the generic adapter. This meant named custom imports (even before this feature) could fail at the stage boundary.

### Goals

1. Let users save a custom parser config under a unique name they choose.
2. Surface saved parsers in the bank-source dropdown so they are as easy to select as a pre-configured bank.
3. Let users edit and delete saved parsers from the import UI without going to a separate settings page.
4. Have the parser name serve as the bank/account label on imported transactions — consistent with how a standard bank adapter provides an identity to the pipeline.
5. Fix the latent `Unknown adapter` bug so any future named custom import is robust.

## Decision

### 1. New `custom_parser_configs` table (migration `0037`)

A new table stores parser configurations persistently in PostgreSQL.

```sql
CREATE TABLE custom_parser_configs (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  config_json JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_custom_parser_configs_name
  ON custom_parser_configs (name);
```

The `updated_at` column is maintained by the shared `update_updated_at_column()` trigger that is already used by other tables in the schema. The `config_json` JSONB field mirrors the frontend `CustomConfig` shape:

```json
{
  "dateColumn": "Date",
  "dateFormat": "DD/MM/YYYY",
  "recipientColumn": "Description",
  "amountColumn": "Amount",
  "memoColumn": "Memo",
  "separator": ";",
  "encoding": "utf-8",
  "skipRows": 0
}
```

### 2. Repository layer — `customParserConfigRepository.js`

A new repository at `apps/node-backend/src/repositories/customParserConfigRepository.js` exposes `getAll`, `getById`, `getByName`, `create`, `update`, and `delete`. All methods map the DB column `config_json` to the application key `config` so callers never need to know about the JSONB column naming.

### 3. Four new REST endpoints on `/api/import/parsers`

CRUD operations are mounted on `importRoutes.js` under the existing `/api/import` prefix:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/import/parsers` | List all saved parsers |
| POST | `/api/import/parsers` | Create a new saved parser |
| PATCH | `/api/import/parsers/:id` | Update name and/or config |
| DELETE | `/api/import/parsers/:id` | Delete a saved parser |

Duplicate-name conflicts return HTTP 409 (ConflictError). Missing required config fields (`dateColumn`, `recipientColumn`, `amountColumn`) return HTTP 400 (ValidationError). Missing record on PATCH/DELETE returns HTTP 404.

### 4. Parser name doubles as bank/account label

When a saved parser is selected for import, `adapterName` is set to the parser's name (e.g. `"My Savings Bank"`). The import pipeline's `stageBatch` (see §5 below) uses the `generic` adapter to parse the file and the `adapterName` string is stored as `bank_account` on the resulting transactions — exactly the same role the static adapter key fills for standard banks.

This is intentional: a parser name like `"My Savings Bank"` or `"Old Broker CSV"` becomes a persistent, human-readable bank-account label that groups transactions in the Analytics view, just as `"belfius"` or `"revolut"` does.

### 5. `stageBatch` generic-adapter fallback (latent bug fix)

`apps/node-backend/src/services/importPipeline/stage.js` previously called `getAdapter(adapterName)` and threw if the result was `null`. This was only safe when the caller guaranteed `adapterName` was always a registered key. With named custom parsers (and even with pre-existing typed bank-name imports), passing an unrecognised name was possible.

The fix mirrors the same logic already in `adapters/index.js`'s `createAdapter()`: if `getAdapter(adapterName)` returns `null` **and** a `customConfig` is present, fall back to the `generic` adapter. This makes `stageBatch` robust to any `adapterName` that is not in the static registry, provided a `customConfig` supplies the column mapping.

```javascript
// Before (throws on unrecognised name):
const adapter = getAdapter(adapterName);
if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);

// After (falls back to generic when customConfig present):
let adapter = getAdapter(adapterName);
if (!adapter && customConfig) {
  adapter = getAdapter('generic');
}
if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);
```

### 6. Frontend integration

- `apps/frontend/src/lib/api/imports.ts` gains four API methods (`listCustomParserConfigs`, `createCustomParserConfig`, `updateCustomParserConfig`, `deleteCustomParserConfig`) and two types (`SavedParserConfig`, `CustomParserConfigPayload`), re-exported from `apps/frontend/src/lib/api.ts`.
- `apps/frontend/src/hooks/useCustomParserConfigs.ts` wraps these with React Query under cache key `['custom-parser-configs']`, providing a list query and three mutations with toast feedback and cache invalidation.
- `TransactionImportCard.tsx` renders saved parsers in the bank dropdown with a Bookmark icon (value prefix `saved:<id>`). Selecting a saved parser loads its config. A read-only summary shows Edit and "Delete this parser" (confirm dialog) buttons. In custom-config mode a name field and "Save parser" button create a new saved parser; editing a saved parser shows "Save changes" / "Cancel".

### 7. Backup coverage

`apps/node-backend/src/backup/coverage.js` registers `custom_parser_configs` as a backed-up table so saved parsers are included in `.visionbak` exports.

### 8. i18n

New `importPage.customParser.*` keys are added to `i18n/source/en.json` and `i18n/source/nl.json`. `validate-locales` passes.

## Consequences

### Positive

1. **Repeatable custom imports**: Users configure column mapping once and select it from the dropdown on every subsequent import — same friction as a pre-configured bank.
2. **Bank-label persistence**: Importing the same CSV format always assigns the same `bank_account` label, enabling consistent grouping across Analytics, filters, and exports.
3. **Latent bug eliminated**: The `Unknown adapter` throw in `stageBatch` is fixed for all callers, not only the saved-parser path. Any future code path that supplies a `customConfig` with an unrecognised `adapterName` is now handled gracefully.
4. **Backup-safe**: Saved parsers travel with the backup bundle; restoring from a backup restores the parser library too.

### Negative / Tradeoffs

1. **Name immutability has data consequences**: The parser name is stored in `bank_account` on every imported transaction. Renaming a parser via PATCH does not retroactively update `bank_account` on existing transactions. Users who rename a parser will see a split in their bank-account filter/grouping between old and new imports.
2. **No per-user scoping**: The `custom_parser_configs` table has no `user_id` column. Vision is a single-user self-hosted app; multi-tenancy is not a design goal, so this is consistent with the rest of the schema.
3. **Generic adapter fallback is opt-in to `customConfig`**: The fallback only activates when `customConfig` is present. An `adapterName` that is neither a registered adapter nor accompanied by a `customConfig` still throws `Unknown adapter`. This is intentional — passing an unrecognised name without a mapping config is a programming error.

## Implementation Files

- **Migration**: [[alembic/versions/0037_add_custom_parser_configs.py]]
- **Repository**: [[apps/node-backend/src/repositories/customParserConfigRepository.js]]
- **Routes**: [[apps/node-backend/src/routes/importRoutes.js]]
- **Stage fallback**: [[apps/node-backend/src/services/importPipeline/stage.js]]
- **Backup coverage**: [[apps/node-backend/src/backup/coverage.js]]
- **API client**: [[apps/frontend/src/lib/api/imports.ts]]
- **Hook**: [[apps/frontend/src/hooks/useCustomParserConfigs.ts]]
- **UI**: [[apps/frontend/src/features/imports/TransactionImportCard.tsx]]
- **i18n**: `i18n/source/en.json`, `i18n/source/nl.json`

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/features/import|Import Feature]] — Updated with saved-parser UX and stage fallback docs
- [[docs/api/imports|Imports API]] — Updated with 4 new `/api/import/parsers` endpoint contracts
- [[docs/reference/data-model|Data Model Reference]] — `custom_parser_configs` table
- [[docs/adr/046-import-review-category-assignment|ADR-046]] — Import review; saved parsers feed into the same pipeline
- [[docs/adr/007-streaming-imports|ADR-007]] — Streaming imports; saved parsers work with the SSE stream path
