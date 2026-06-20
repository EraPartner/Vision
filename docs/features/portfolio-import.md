---
title: Feature - Portfolio CSV Import
type: feature
status: active
date: 2026-06-20
updated: 2026-06-20
last_modified: 2026-06-20
tags: [feature, portfolio, import, csv, brokerage, trades, portfolio-import, instrument-matching, review, type-normalizer, deduplication, fx, adr-078, adr-074, adr-066, migration-0040, migration-0041, migration-0057, account-id, adr-091]
aliases: [portfolio-import, portfolio-csv-import, brokerage-import]
description: CSV import of brokerage and exchange trades into portfolio_transactions. Parallel pipeline (stage → validate → matchInvestments → review/autoCommit → commit) with symbol→name exact matching, conservative auto-commit policy, type normalization, FX auto-resolution, field-based+intra-batch deduplication, and saved portfolio parser configs (kind=portfolio on custom_parser_configs).
related_code:
  - "apps/node-backend/src/services/portfolioImportPipeline/index.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/stage.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/validate.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/matchInvestments.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/commit.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/portfolioGenericAdapter.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/portfolioTypeNormalizer.js"
  - "apps/node-backend/src/services/portfolioImportBatchService.js"
  - "apps/node-backend/src/routes/portfolioImportRoutes.js"
  - "apps/node-backend/src/lib/csvUpload.js"
  - "apps/node-backend/src/services/portfolio/fxResolve.js"
  - "apps/frontend/src/pages/portfolio/PortfolioImportPage.tsx"
  - "apps/frontend/src/pages/portfolio/PortfolioImportReviewPage.tsx"
  - "apps/frontend/src/features/imports/PortfolioCsvColumnMapper.tsx"
  - "apps/frontend/src/components/portfolio/InvestmentCombobox.tsx"
  - "apps/frontend/src/lib/api/portfolioImports.ts"
  - "apps/frontend/src/hooks/usePortfolioParserConfigs.ts"
  - "alembic/versions/0040_add_portfolio_import_staging.py"
  - "alembic/versions/0041_add_parser_config_kind.py"
---

# Feature: Portfolio CSV Import

## Overview

Portfolio CSV Import lets users bulk-load brokerage and exchange trade history from CSV files directly into `portfolio_transactions`. It is a parallel pipeline to the budgeting import (`/api/import`) — same phase structure (stage → validate → matchInvestments → commit), same SSE streaming endpoint, same saved-parser pattern — but targeting portfolio data rather than bank statements.

Key design points:

- **Always custom-config driven**: no pre-built adapter for specific brokers; the column mapper covers all CSV shapes.
- **Instrument matching by symbol then name** (exact, case-insensitive). No ISIN lookup, no fuzzy match.
- **Conservative auto-commit**: only when every row matched exactly and there are zero errors/unresolved.
- **Review step for mismatches**: unresolved rows go to `awaiting_review`; the user links each symbol/name to an existing investment or creates a new one.
- **Reuses existing `portfolioTransactionRepository.create`**: 2-of-3 unit math, oversell prevention, asset-class routing.
- **Saved parser configs**: reuses `custom_parser_configs` table with `kind = 'portfolio'` discriminator (ADR-041 migration 0041).

---

## Pipeline Phases

### 1. Stage

**Module:** [[apps/node-backend/src/services/portfolioImportPipeline/stage.js]]

Parses the uploaded CSV using the `portfolioGenericAdapter` (the only adapter; no pre-configured bank adapters exist for portfolio CSVs). Raw rows are stored in `portfolio_import_staging_rows`. The adapter reads columns according to the `column_mapping` in the config.

Progress event: `{ phase: 'staging', current, total, percent }`

### 2. Validate

**Module:** [[apps/node-backend/src/services/portfolioImportPipeline/validate.js]]

For each staged row:
- Parses the date using `date_format`.
- Resolves the transaction type via `portfolioTypeNormalizer` (see §Type Normalization below).
- Validates numeric fields (units, price, amount, fees, taxes, fx_rate).
- Applies field-based deduplication: a row is a duplicate if an identical `(date, symbol, units, amount, currency)` combination already exists in `portfolio_transactions`.
- Marks invalid rows with `error_detail` without aborting the batch.

Progress event: `{ phase: 'validating', current, total, errors, percent }`

### 3. Match Investments

**Module:** [[apps/node-backend/src/services/portfolioImportPipeline/matchInvestments.js]]

For each valid staged row, attempts to find an existing `investments` record:

1. **Symbol match** (case-insensitive): look up `investments.symbol`.
2. **Name match** (case-insensitive, exact): look up `investments.name` if symbol lookup failed or produced no result.
3. **Unresolved**: if neither match succeeds, the row is marked `unresolved` and goes to the review step.

`match_source` values: `symbol_exact` | `name_exact` | `unresolved`.

> [!info] No ISIN, no fuzzy
> ISIN lookup and fuzzy/Levenshtein matching are explicitly out of scope for this iteration. The review step covers the long tail of unrecognized symbols.

Auto-commit condition (checked after this phase):
- All rows matched (`unresolved == 0`)
- No errors (`errors == 0`)

If both are true → pipeline continues directly to commit (201 response or `complete` SSE event).  
Otherwise → batch is set to `awaiting_review` (202 response or `review_required` SSE event).

Progress event: `{ phase: 'matching', current, total, percent }`

### 4. Review (if needed)

When a batch enters `awaiting_review`, the frontend navigates to `PortfolioImportReviewPage`. For each unresolved group (distinct raw symbol+name), the user chooses one of:

- **Pick an existing investment** via `InvestmentCombobox` → `POST /api/portfolio/import/batches/:id/rows/:rowId/investment-override` with `{ investment_id }`.
- **Create a new investment** → same endpoint with `{ create_new: true }`. Creates an investment from the row's symbol/name/default_asset_class and links all rows with the same raw symbol+name.

When all rows are resolved, the user clicks **Commit** → `POST /api/portfolio/import/batches/:id/commit`.

### 5. Commit

**Module:** [[apps/node-backend/src/services/portfolioImportPipeline/commit.js]]

For each valid, resolved staged row:
- Calls `portfolioTransactionRepository.create` (shared with the manual transaction entry path), which enforces 2-of-3 unit math (units × price ≈ amount), oversell prevention, and asset-class routing.
- **Account assignment:** if the batch has `account_id` set (migration 0057), each committed `portfolio_transaction` inherits that `account_id` so all lots from this import belong to the specified brokerage account.
- **FX auto-resolution**: if the trade currency is not EUR and no `fx_rate` was mapped or present in the row, calls `fxResolve` ([[apps/node-backend/src/services/portfolio/fxResolve.js]]) to look up the historical EUR rate for the trade date (ADR-074 semantics).
- **Intra-batch deduplication**: a Set tracks `(date,symbol,units,amount,currency)` hashes committed so far in the batch; a duplicate row within the same upload is counted as `duplicate` and not inserted.
- Per-row errors (oversell, missing investment after override, FX failure) are recorded as `rows_error` without aborting the batch.

Progress event: `{ phase: 'committing', current, total, imported, duplicates, errors, percent }`

---

## Type Normalization

**Module:** [[apps/node-backend/src/services/portfolioImportPipeline/portfolioTypeNormalizer.js]]

Converts raw CSV type strings → canonical `portfolio_txn_type` values:

**Resolution order:**
1. User-provided `type_mapping` (e.g. `{"Koop":"buy","Verkoop":"sell"}`).
2. Built-in alias table (covers common English and NL/DE variations):

| Canonical | Aliases recognized |
|-----------|-------------------|
| `buy` | buy, purchase, koop, kauf, aankoop |
| `sell` | sell, sale, verkoop, verkauf |
| `dividend` | dividend, div, dividende |
| `fee` | fee, commission, kosten, gebühr |
| `tax` | tax, withholding, belasting |
| `interest` | interest, rente, zinsen |

3. If the type string is non-empty but unknown after both steps → **row error** (not a silent default). The error detail names the unrecognized value.
4. If no `type_column` is mapped at all → `default_type` from the config is used (default `buy`).

> [!warning] Unknown type = row error
> A row with a present but unrecognized type string is rejected, not silently cast to the default. This prevents misclassified trades from polluting the portfolio.

---

## Deduplication

Two layers prevent duplicate portfolio_transactions:

1. **Field-based** (validate phase): checks `portfolio_transactions` for an existing row with identical `(date, investment_id, units, amount, currency)`. Marks the staging row as `duplicate` before commit.
2. **Intra-batch** (commit phase): a Set tracks hashes of committed rows within the current upload run. A second row with the same `(date, symbol, units, amount, currency)` in the same CSV file is counted as `duplicate`.

There is no SHA-256 hash column on `portfolio_transactions` (unlike `transactions.tx_hash`). The field-based check is sufficient because brokerage trade records have stable numeric identities.

---

## Saved Portfolio Parser Configs

Reuses the `custom_parser_configs` table with a `kind` column (migration 0041):

```sql
ALTER TABLE custom_parser_configs ADD COLUMN kind TEXT NOT NULL DEFAULT 'transaction';
DROP INDEX uq_custom_parser_configs_name;
CREATE UNIQUE INDEX uq_custom_parser_configs_name_kind
  ON custom_parser_configs (name, kind);
```

The `kind` discriminator (`'transaction'` | `'portfolio'`) means:
- Transaction parsers and portfolio parsers are stored in the same table but kept separate.
- Uniqueness is per-kind: a parser named "My Bank" can exist as both a transaction parser and a portfolio parser simultaneously.
- `GET /api/portfolio/import/parsers` filters `WHERE kind = 'portfolio'`.
- `GET /api/import/parsers` filters `WHERE kind = 'transaction'` (or `kind` IS NULL for rows predating migration 0041, handled by the DEFAULT).

**Frontend:** `usePortfolioParserConfigs` hook, `PortfolioCsvColumnMapper` component, `portfolioImports` API client module.

---

## Frontend

### Navigation

Portfolio CSV Import is accessible under **Portfolio → Tools → Import portfolio CSV** at route `/portfolio/import`.

### Pages

| Page | Route | Purpose |
|------|-------|---------|
| `PortfolioImportPage` | `/portfolio/import` | Column mapper, file upload, parser picker, brokerage account picker |
| `PortfolioImportReviewPage` | `/portfolio/import/review/:batchId` | Investment resolution for unmatched rows |

> [!warning] Brokerage routing UI flag-gated — default OFF (ADR-103, 2026-06-20)
> The **brokerage toggle** (marks a batch as `is_brokerage=true`) and the **sleeve-account picker**
> on `PortfolioImportPage` are hidden when `VITE_ENABLE_PER_ACCOUNT_HOLDINGS` is `false` (the
> default). Similarly, the per-row cash/trade routing display and the account picker on
> `PortfolioImportReviewPage` are hidden. Standard portfolio CSV import (without brokerage routing)
> continues to work regardless of the flag — it is only the per-account brokerage fan-out path that
> is gated. Set `VITE_ENABLE_PER_ACCOUNT_HOLDINGS=true` to restore the full brokerage import UI.
> See [[docs/adr/103-per-account-holdings-ui-flag|ADR-103]] and
> [[docs/adr/095-brokerage-account-import|ADR-095]].

### Components

| Component | Purpose |
|-----------|---------|
| `PortfolioCsvColumnMapper` | Maps CSV columns to portfolio fields; shows `FileHeadersPanel` preview |
| `InvestmentCombobox` | Searchable combobox for picking or creating an investment during review |

### i18n

New `portfolioImport.*` keys in `i18n/source/en.json` and `i18n/source/nl.json`.

---

## FileHeadersPanel Integration

`PortfolioCsvColumnMapper` uses the shared `FileHeadersPanel` component (added alongside this feature) to show CSV column names and sample rows as soon as a file is selected, before any mapping is attempted. This is the same panel now shown in `TransactionImportCard` for budgeting imports. See [[docs/features/import#file-headers-preview-panel|Import Feature — FileHeadersPanel]].

---

## Database

Two new tables, authored in migration 0040 (not yet applied — user must run `bun run db:revision`):

**`portfolio_import_batches`** — mirrors `import_batches` with portfolio-specific defaults:
- Standard status lifecycle (`pending → staging → … → complete | failed | aborted | awaiting_review`)
- `default_asset_class` and `default_type` columns store batch-level config defaults
- `account_id` FK → `accounts` (nullable) — destination brokerage account; committed lots inherit this value (**migration 0057, authored, not applied**)
- Included in `BACKUP_COVERED_TABLES`

**`portfolio_import_staging_rows`** — mirrors `import_staging_rows` with portfolio-shaped columns:
- `type`, `symbol`, `name`, `units`, `price`, `amount`, `fees`, `taxes`, `currency`, `fx_rate`
- `resolved_investment_id` FK → investments (set by matchInvestments phase)
- `user_override_investment_id` FK → investments (set by investment-override endpoint)
- `match_source` TEXT (symbol_exact | name_exact | unresolved)
- Included in `BACKUP_COVERED_TABLES`

See [[docs/reference/data-model|Data Model Reference]] for field-level schema.

---

## Related

- [[docs/api/portfolio-imports|Portfolio Imports API]] — full endpoint reference
- [[docs/adr/078-portfolio-csv-import|ADR-078: Portfolio CSV Import Architecture]]
- [[docs/features/import|Import Feature]] — budgeting import pipeline (parallel)
- [[docs/features/portfolio|Portfolio Feature]]
- [[docs/adr/103-per-account-holdings-ui-flag|ADR-103: Per-account holdings UI flag]] — gates the brokerage toggle + account picker (default off)
- [[docs/adr/095-brokerage-account-import|ADR-095: Brokerage Account Import]] — fan-out core; brokerage routing UI gated by ADR-103
- [[docs/adr/066-saved-named-custom-csv-parsers|ADR-066: Saved Named Custom CSV Parsers]] — original parser-config design
- [[docs/adr/074-fx-attribution-historical-rates|ADR-074: FX Attribution]] — fxResolve semantics used by commit phase
- [[docs/reference/data-model|Data Model Reference]] — `portfolio_import_batches`, `portfolio_import_staging_rows`, `custom_parser_configs`
