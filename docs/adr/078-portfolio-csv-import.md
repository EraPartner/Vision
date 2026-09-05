---
title: "ADR-078: Portfolio CSV Import Architecture"
type: adr
status: Accepted
date: 2026-06-15
tags:
  [
    adr,
    portfolio,
    import,
    csv,
    instrument-matching,
    type-normalizer,
    saved-parsers,
    kind-discriminator,
    review-step,
    auto-commit,
    deduplication,
    migration-0040,
    migration-0041,
    adr-078,
  ]
description: Records three key decisions for the Portfolio CSV Import feature — (a) a parallel pipeline over generalizing the recipient-centric budgeting import, (b) symbol→name exact matching with a mandatory review step for unresolved rows and conservative auto-commit, (c) reusing custom_parser_configs with a kind discriminator to separate transaction and portfolio parsers.
related:
  [
    docs/features/portfolio-import,
    docs/api/portfolio-imports,
    docs/adr/066-saved-named-custom-csv-parsers,
    docs/adr/007-streaming-imports,
    docs/adr/046-import-review-category-assignment,
    docs/adr/074-fx-attribution-historical-rates,
    docs/reference/data-model,
  ]
---

# ADR-078: Portfolio CSV Import Architecture

## Status

**Accepted** — Implemented 2026-06-15.

## Date

2026-06-15

## Context

Vision's budgeting import pipeline (ADR-007, ADR-046, ADR-066) targets bank-statement CSV files: recipient-centric, deduplicates by tx_hash, resolves fuzzy/pattern matches at review. Portfolio transactions (buy/sell/dividend/fee/tax/interest) have a fundamentally different shape — instrument-centric rather than recipient-centric, with numeric precision requirements (2-of-3 unit math), oversell prevention, FX conversion, and a richer type taxonomy.

Three design questions arose:

1. **Pipeline separation**: Should we generalize the existing `importPipeline/` to cover portfolio trades, or build a parallel pipeline?
2. **Instrument matching**: How should CSV rows be matched to existing `investments` records? What happens when no match is found?
3. **Parser config storage**: Where should saved portfolio column-mapping configurations live — a dedicated table or a shared one?

## Decision

### A. Parallel pipeline over generalization

A new `portfolioImportPipeline/` directory (`index.js`, `stage.js`, `validate.js`, `matchInvestments.js`, `commit.js`, `portfolioGenericAdapter.js`, `portfolioTypeNormalizer.js`) runs alongside the existing `importPipeline/`. New shared extraction points (`lib/csvUpload.js`, `services/portfolio/fxResolve.js`, `services/portfolioImportBatchService.js`) are extracted without modifying the budgeting pipeline.

**Rationale:**

- The matching phase differs fundamentally: budgeting matches recipients (fuzzy, pattern, alias), portfolio matches investment instruments (symbol/name, exact only).
- The commit phase differs: budgeting inserts into `transactions`; portfolio calls `portfolioTransactionRepository.create` with 2-of-3 unit math, oversell prevention, and asset-class routing.
- Generalization would require heavy parameterization of both phases, adding complexity for zero reuse benefit. The SSE mechanics, batch lifecycle, and CSV parsing are already shared via the extracted utility modules.
- The parallel structure means each pipeline can evolve independently. Future portfolio-specific features (ISIN lookup, lot accounting, corporate actions) do not pollute the budgeting path.

**Two new DB tables** (migration 0040): `portfolio_import_batches` and `portfolio_import_staging_rows`, mirroring `import_batches`/`import_staging_rows` but with portfolio-shaped columns (type, symbol, name, units, price, amount, fees, taxes, currency, fx_rate, resolved_investment_id, user_override_investment_id, match_source, default_asset_class, default_type on the batch). Both added to `BACKUP_COVERED_TABLES`.

### B. Symbol→name exact matching; review step for unresolved; conservative auto-commit

**Matching algorithm:**

1. Symbol lookup (case-insensitive) against `investments.symbol`.
2. Name lookup (case-insensitive, exact) against `investments.name` if symbol lookup fails.
3. If neither match → row is `unresolved`.

No ISIN lookup, no fuzzy/Levenshtein matching in this iteration. The review step (mandatory for `awaiting_review` batches) covers the long tail.

**No silent auto-create**: An unresolved row never silently creates a new investment. The user must explicitly choose: link to an existing investment (`investment_id`) or request creation (`create_new: true`). This prevents phantom holdings from CSV typos or broker-specific symbol formats.

**Auto-commit policy (conservative)**: The pipeline commits immediately (201/`complete`) only when:

- All rows were matched (`unresolved == 0`), AND
- There are zero row errors.

Any single mismatch or error puts the entire batch into `awaiting_review` (202/`review_required`). The rationale is that a partial auto-commit on a portfolio import could produce incorrect unit balances and mislead performance calculations — failing conservative is safer than failing optimistic.

**Unknown type → row error**: A present-but-unrecognized type string (after `typeMapping` and built-in alias resolution) is a row error, not a silent default. The default type (`buy`) is used only when no `type_column` is mapped at all.

### C. Reuse custom_parser_configs with a kind discriminator (migration 0041)

Rather than creating a separate `portfolio_parser_configs` table, the existing `custom_parser_configs` table gains a `kind` column (`'transaction'` | `'portfolio'`, DEFAULT `'transaction'`).

```sql
ALTER TABLE custom_parser_configs ADD COLUMN kind TEXT NOT NULL DEFAULT 'transaction';
DROP INDEX uq_custom_parser_configs_name;
CREATE UNIQUE INDEX uq_custom_parser_configs_name_kind
  ON custom_parser_configs (name, kind);
```

The old unique constraint `uq_custom_parser_configs_name` on `(name)` is replaced by `uq_custom_parser_configs_name_kind` on `(name, kind)`. This allows a user to have both a transaction parser and a portfolio parser with the same display name (e.g. "My Broker" could be both).

**Rationale:**

- All CRUD logic, backup coverage, and trigger wiring for `custom_parser_configs` already exists. Adding a discriminator column is a schema-minimal extension.
- The `kind` column is additive: existing transaction parsers (kind = NULL before migration, DEFAULT 'transaction' after) are unaffected.
- The conflict detection in `portfolioImportRoutes.js` checks for `uq_custom_parser_configs_name_kind` (not the old `uq_custom_parser_configs_name`) so each pipeline's parser namespace is independent.

## Consequences

### Positive

1. **Pipeline isolation**: Budgeting and portfolio imports cannot interfere with each other. Changes to one pipeline's phase logic are scoped to one directory.
2. **Correct unit math enforced**: Reusing `portfolioTransactionRepository.create` in the commit phase means every imported trade is subject to the same 2-of-3 math and oversell checks as manually entered trades — no path to bypass them.
3. **Explicit instrument resolution**: The review step and the `no-silent-auto-create` rule mean every committed trade is linked to a known, user-verified investment. No phantom holdings.
4. **Parser storage minimal change**: No new table for portfolio parsers; existing backup, trigger, and CRUD infrastructure is inherited.
5. **Conservative auto-commit**: Prioritizes correctness over convenience. A batch that should have gone to review never silently corrupts portfolio state.

### Negative / Tradeoffs

1. **Two staging tables**: `portfolio_import_batches` and `portfolio_import_staging_rows` duplicate schema structure from `import_batches`/`import_staging_rows`. Future schema evolution may require parallel migrations.
2. **No fuzzy matching**: Users importing from brokers with non-standard symbol formats must use the review step for every previously-unseen instrument. This is intentional but creates friction on first import.
3. **Kind migration requires care**: The ALTER TABLE / DROP INDEX / CREATE INDEX in migration 0041 acquires an ACCESS EXCLUSIVE lock on `custom_parser_configs`. For production instances with many saved parsers and concurrent import activity, this should be run during low-traffic windows.
4. **Conservative auto-commit increases review-step load**: A single unmatched row forces the entire batch to review, even if 999 of 1000 rows matched perfectly. This is a known trade-off; a future ADR may relax the policy to partial auto-commit.

## Implementation Files

- **Pipeline**: [[apps/node-backend/src/services/portfolioImportPipeline/]]
- **Batch service**: [[apps/node-backend/src/services/portfolioImportBatchService.js]]
- **Routes**: [[apps/node-backend/src/routes/portfolioImportRoutes.js]] (mounted at `/api/portfolio/import` in `main.js`)
- **Shared CSV upload**: [[apps/node-backend/src/lib/csvUpload.js]]
- **FX resolution**: [[apps/node-backend/src/services/portfolio/fxResolve.js]]
- **Migration 0040**: [[alembic/versions/0040_add_portfolio_import_staging.py]]
- **Migration 0041**: [[alembic/versions/0041_add_parser_config_kind.py]]
- **Frontend pages**: [[apps/frontend/src/pages/portfolio/PortfolioImportPage.tsx]], [[apps/frontend/src/pages/portfolio/PortfolioImportReviewPage.tsx]]
- **Frontend components**: [[apps/frontend/src/features/imports/PortfolioCsvColumnMapper.tsx]], [[apps/frontend/src/components/portfolio/InvestmentCombobox.tsx]]
- **Frontend API/hooks**: [[apps/frontend/src/lib/api/portfolioImports.ts]], [[apps/frontend/src/hooks/usePortfolioParserConfigs.ts]]
- **i18n**: `i18n/source/en.json`, `i18n/source/nl.json` — new `portfolioImport.*` keys

## Implementation update (2026-09-04)

The repository method names above record the accepted implementation at the time of this decision. The current implementation preserves the decision's shared-policy requirement through `portfolioTransactionService.create`: manual entry and portfolio import both use that service, while parameterized reads and writes remain in `portfolioTxRepo.*` ([[apps/node-backend/src/services/portfolio/portfolioTransactionService.js]], [[apps/node-backend/src/services/portfolio/portfolioTransactionRules.js]]).

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/features/portfolio-import|Portfolio Import Feature]]
- [[docs/api/portfolio-imports|Portfolio Imports API]]
- [[docs/adr/066-saved-named-custom-csv-parsers|ADR-066]] — original parser-config design; kind discriminator extends this
- [[docs/adr/007-streaming-imports|ADR-007]] — SSE streaming; same mechanism reused
- [[docs/adr/046-import-review-category-assignment|ADR-046]] — budgeting review step; portfolio review step mirrors this pattern
- [[docs/adr/074-fx-attribution-historical-rates|ADR-074]] — FX semantics used by commit phase fxResolve
- [[docs/reference/data-model|Data Model Reference]] — new tables and kind column
