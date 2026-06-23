---
title: Migration Dependency Graph
type: reference
status: active
date: 2026-03-31
updated: 2026-06-18
tags: [reference, database, migrations, dependencies, alembic, migration-0035, migration-0037, migration-0038, aggregations, custom-parser-configs, mv-recipient-monthly-drop, adr-068, migration-0046, migration-0047, migration-0048, currency-integrity, recipient-bank-accounts, category-fk, adr-086, adr-087]
description: Migration dependency chain and grouping for the Vision database schema. Latest active chain is 0001–0058 (authored). 0046–0058 are AUTHORED but not yet applied — currency integrity, primary-bank-account, category FK, accounts entity (ADR-088/091), cash legs (ADR-090), balance reconciliation (ADR-094), portfolio import account_id (ADR-091/095 migration 0057), watchlist added_price (ADR-097 migration 0058).
aliases: [migration dependencies, migration chain, migration groups, alembic chain]
---

# Migration Dependency Graph

> [!abstract] Overview
> The Vision database uses a linear migration chain with logical groupings. This document shows the dependency chain and which migrations belong together.

> [!warning] Two migration trees
> The repository keeps two parallel Alembic trees:
> - **`alembic/versions/`** — the **active** chain (0001-0049, currently 49 revisions). Renumbered in early 2026 around the Phase-1 aggregation work.
> - **`alembic/legacy_versions/`** — the **archived** pre-renumbering chain (0001-0032 + 5 hash-named revisions, 38 files). Kept for history and for re-stamping older deployments; not applied on fresh installs.
>
> The chain summary below predates the renumbering — treat it as historical context for the legacy tree. For the active chain, `bun run db:history` is authoritative. Notable recent revisions in `alembic/versions/`:
> - **0030** — `add_user_settings_table` (settings persistence)
> - **0031** — `add_transaction_tags` (orthogonal-dimension tags, ADR-052)
> - **0035** — `add_recipient_aggregations` (Phase 1 aggregations consolidated)
> - **0036** — `add_transactions_tx_hash` (May 2026 monetary precision + deduplication audit, ADR-060)
> - **0037** — `add_custom_parser_configs` (saved named custom CSV parsers, ADR-066)
> - **0038** — `drop_mv_recipient_monthly` (drops the unread recipient monthly MV; downgrade recreates the 24-month version; ADR-068)
> - **0045** — `exclude_transfers_from_aggregations` (internal-transfer flag, ADR-083)
> - **0046** — `currency_integrity` (transactions + planned_transactions: backfill NULL → 'EUR', ISO CHECK NOT VALID, DEFAULT 'EUR', NOT NULL; ADR-086) **AUTHORED, NOT YET APPLIED**
> - **0047** — `one_primary_bank_account_per_recipient` (partial unique index on recipient_bank_accounts; ADR-087) **AUTHORED, NOT YET APPLIED**
> - **0048** — `category_fk_on_delete_set_null` (transactions/recipients/planned_transactions category FK changed from RESTRICT to ON DELETE SET NULL; ADR-087) **AUTHORED, NOT YET APPLIED**
> - **0049** — `validate_currency_checks` (normalise legacy currency codes, then VALIDATE the 0046 ISO checks retroactively; ADR-086) **AUTHORED, NOT YET APPLIED**
> - **0050** — `add_accounts_table` (accounts entity + account_id FKs on transactions/planned_transactions; ADR-088) **AUTHORED, NOT YET APPLIED**
> - **0051** — `account_dual_write_trigger` (BEFORE INSERT/UPDATE trigger keeping account_id ↔ bank_account in sync; ADR-088) **AUTHORED, NOT YET APPLIED**
> - **0052** — `portfolio_transactions_account_id` (nullable account_id FK on portfolio_transactions_base; ADR-091) **AUTHORED, NOT YET APPLIED**
> - **0053** — `trade_cash_legs` (portfolio_transaction_id FK on transactions for ADR-090 cash legs; ADR-090) **AUTHORED, NOT YET APPLIED**
> - **0054** — `account_statement_balance` (statement_balance + statement_balance_date on accounts; ADR-094) **AUTHORED, NOT YET APPLIED**
> - **0055** — `account_merge_table_support` (merge-related schema updates; ADR-088) **AUTHORED, NOT YET APPLIED**
> - **0056** — `account_funding_account_id` (funding_account_id FK on accounts for sleeve-less settlement; ADR-090) **AUTHORED, NOT YET APPLIED**
> - **0057** — `portfolio_import_batches_account_id` (account_id FK on portfolio_import_batches; ADR-091/ADR-095) **AUTHORED, NOT YET APPLIED**
> - **0058** — `watchlist_added_price` (added_price NUMERIC(18,6) NULLABLE on watchlist; ADR-097) **AUTHORED, NOT YET APPLIED**

## Migration Chain (legacy tree — historical reference)

```
0001 (initial schema)
  └── 0002 (planned_transactions.url)
        └── 0003 (transactions.recipient_id nullable)
              └── 0004 (portfolio tables)
                    └── 0005 (manual_raw_transactions)
                          └── 0006 (price_providers enum)
                                └── 0007 (recipient_merge)
                                      └── 0008 (drop_custom_raw_transactions)
                                            └── 0009 (transaction_splits)
                                                  └── 0010 (real_estate tax fields)
                                                        └── 0011 (planned_loans)
                                                              └── 0012 (add_indexes)
                                                                    └── 0013 (investment_inheritance)
                                                                          └── 0014 (investments_view_trigger)
                                                                                └── 0015 (gift txn type)
                                                                                      └── 0016 (fx_rate_to_eur)
                                                                                            └── 0017 (custom_provider_history)
                                                                                                  └── 0018 (metals_transactions_split)
                                                                                                        └── 0019 (asset_price_history)
                                                                                                              └── 0020 (drop_asset_price_history_fk)
                                                                                                                    └── 0021 (update_price_provider_enum)
                                                                                                                          └── 0022 (add_kinesis_enum)
                                                                                                                                └── 0023 (portfolio_performance_snapshots)
                                                                                                                                      └── 0024 (per_class_invested_columns)
                                                                                                                                            └── 0035 (add_recipient_aggregations)
```

## Migration Groups

### Group 1: Core Schema (0001-0012)
Foundation tables and basic features. Safe to run on any fresh install.

| # | Migration | Key Tables |
|---|-----------|-----------|
| 0001 | `initial_database_schema` | categories, recipients, transactions, planned_transactions, exchange_rates, raw transaction tables |
| 0002 | `add_url_to_planned_transactions` | planned_transactions.url |
| 0003 | `make_recipient_nullable` | transactions.recipient_id |
| 0004 | `portfolio_tables` | investments, portfolio_transactions |
| 0005 | `manual_raw_transactions` | manual_raw_transactions |
| 0006 | `price_providers` | price_provider enum type |
| 0007 | `recipient_merge` | recipients.primary_recipient_id |
| 0008 | `drop_custom_raw_transactions` | Drops custom_raw_transactions |
| 0009 | `transaction_splits` | transaction_splits, split_payments |
| 0010 | `investments_municipality_tax_fields` | real_estate_investments.municipality, cadastral_income |
| 0011 | `planned_loans` | planned_transaction_loan_schedule, loan fields on planned_transactions |
| 0012 | `add_indexes` | Performance indexes on all major tables |

### Group 2: Portfolio Inheritance (0013-0018)
Migrates portfolio from flat tables to PostgreSQL table inheritance. **Do not skip any migration in this group.**

| # | Migration | Key Changes |
|---|-----------|------------|
| 0013 | `investment_inheritance` | Creates investments_base + child tables, migrates data |
| 0014 | `investments_view_update_trigger` | Creates INSTEAD OF UPDATE trigger on investments view |
| 0015 | `add_gift_portfolio_txn_type` | Adds 'gift' to portfolio_txn_type enum |
| 0016 | `add_fx_rate_to_portfolio_transactions` | Adds fx_rate_to_eur column |
| 0017 | `investment_custom_provider_history` | Adds custom provider URL/path fields, updates metals view |
| 0018 | `metals_transactions_inheritance_split` | Splits metals_transactions into dedicated inheritance child |

### Group 3: Price Provider & Caching (0019-0022)
Adds price caching and updates provider enum values.

| # | Migration | Key Changes |
|---|-----------|------------|
| 0019 | `asset_price_history_cache` | Creates asset_price_history table |
| 0020 | `drop_asset_price_history_fk` | Drops FK on asset_price_history.investment_id |
| 0021 | `update_price_provider_enum` | Swaps coingecko/kraken → binance in enum |
| 0022 | `add_kinesis_price_provider_enum` | Adds 'kinesis' to price_provider enum |

### Group 4: Performance Snapshots (0023-0024)
Adds daily portfolio performance caching.

| # | Migration | Key Changes |
|---|-----------|------------|
| 0023 | `portfolio_performance_snapshots` | Creates portfolio_performance_snapshots table |
| 0024 | `per_class_invested_columns` | Adds per-class invested columns to snapshots |

### Group 5: Aggregation Consolidation (0035)
Restores recipient aggregation artifacts that were referenced by code but missing from baseline.

| # | Migration | Key Changes |
|---|-----------|------------|
| 0035 | `add_recipient_aggregations` | Creates `mv_recipient_monthly` (materialized view), `agg_recipient_totals` (trigger-maintained table), supporting functions and indexes. Backfills from existing transactions. |

### Group 7: DB Constraint Hardening (0046–0049) — AUTHORED, NOT YET APPLIED

> [!warning] These migrations are authored and pending user review/apply. Apply in order: 0046 → 0047 → 0048 → 0049.

| # | Migration | Key Changes |
|---|-----------|------------|
| 0046 | `currency_integrity` | `transactions` + `planned_transactions`: backfill NULL currency → 'EUR'; add `CHECK (currency ~ '^[A-Z]{3}$') NOT VALID`; `SET DEFAULT 'EUR'; SET NOT NULL`. Coupled app change: three INSERT paths write `'EUR'` instead of NULL. See [[docs/adr/086-currency-integrity\|ADR-086]]. |
| 0047 | `one_primary_bank_account_per_recipient` | Demote duplicate primaries (lowest id wins), then `CREATE UNIQUE INDEX uq_recipient_primary_account ON recipient_bank_accounts (recipient_id) WHERE is_primary`. No app change required. See [[docs/adr/087-db-constraint-hardening\|ADR-087]]. |
| 0048 | `category_fk_on_delete_set_null` | Drop + recreate `category_id` FKs on `transactions`, `recipients`, `planned_transactions` with `ON DELETE SET NULL` (was implicit RESTRICT, which surfaced as 500 on category delete). History-protecting FKs left as RESTRICT. See [[docs/adr/087-db-constraint-hardening\|ADR-087]]. |
| 0049 | `validate_currency_checks` | Normalise legacy currency codes (trim+upper where it yields a valid code), then `VALIDATE CONSTRAINT` the two 0046 ISO checks so they apply retroactively. Idempotent → trivially passes on fresh per-user DBs. See [[docs/adr/086-currency-integrity\|ADR-086]]. |

### Infrastructure
| Migration | Purpose |
|-----------|---------|
| `fix_alembic_version_col` | Expands alembic_version.version_num column size (run manually if needed) |

## Safe Migration Operations

| Operation | Safe? | Notes |
|-----------|-------|-------|
| Run all from scratch | ✅ | Linear chain, no branching |
| Skip a migration | ❌ | Each migration depends on the previous |
| Run subset (e.g., 0001-0012) | ✅ | Core schema is self-contained |
| Run subset (e.g., 0013-0024) | ⚠️ | Requires core schema (0001-0012) first |
| Downgrade from head | ✅ | All migrations have downgrade functions |
| Downgrade mid-group | ⚠️ | May leave inheritance schema in inconsistent state |

## Related

- [[docs/guides/migrations\|Migration Guide]] - How to run migrations
- [[docs/adr/002-database-schema\|Database Schema ADR]] - Table definitions
- [[docs/reference/database-triggers\|Database Triggers]] - Trigger documentation
