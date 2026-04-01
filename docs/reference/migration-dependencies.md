---
title: Migration Dependency Graph
type: reference
status: active
date: 2026-03-31
tags: [reference, database, migrations, dependencies, alembic]
description: Migration dependency chain and grouping for the Vision database schema
aliases: [migration dependencies, migration chain, migration groups, alembic chain]
---

# Migration Dependency Graph

> [!abstract] Overview
> The Vision database uses a linear migration chain with logical groupings. This document shows the dependency chain and which migrations belong together.

## Migration Chain

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
