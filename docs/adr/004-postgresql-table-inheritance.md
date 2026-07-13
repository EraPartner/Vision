---
title: ADR 004 - PostgreSQL Table Inheritance for Investments
type: adr
status: Superseded
date: 2026-04-02
tags: [architecture, database, postgresql, inheritance, investments]
description: Decision to use PostgreSQL table inheritance for the investments domain, separating shared fields from asset-class-specific fields
aliases: [table inheritance, investment schema, postgresql inheritance]
related_code: ["alembic/versions/0013_investment_inheritance.py", "alembic/versions/0014_investments_view_update_trigger.py", "apps/node-backend/src/repositories/investmentRepository.js"]
---

# ADR-004: PostgreSQL Table Inheritance for Investments

## Status
Superseded by [[docs/adr/109-flat-investments-schema-canonical|ADR-109]] (2026-07-10) — the flat
shape is canonical; legacy inheritance installs convert via a one-time guarded migration.

## Date
2026-03-22

## Context

The investments domain supports multiple asset classes (stocks, ETFs, crypto, real estate, savings, bonds, metals) with different field requirements:
- **Real estate** needs `municipality`, `cadastral_income`, `municipality_tax_rate`
- **Savings/Bonds** need `interest_rate`, `maturity_date`
- **Stocks/ETFs/Crypto** need `symbol`, `price_provider`
- **All** share `name`, `currency`, `current_price`, `is_active`

The original flat `investments` table accumulated all columns, with most being NULL for most rows. This created:
1. **Schema rigidity** — adding a new asset class required ALTER TABLE on the main table
2. **Wasted storage** — most columns NULL for most rows
3. **Validation gaps** — no way to enforce "real estate MUST have municipality"

## Decision

Use **PostgreSQL table inheritance** to model the investment hierarchy:

### Structure

```
investments_base (parent table)
├── stock_investments
├── etf_investments
├── crypto_investments
├── real_estate_investments
├── savings_investments
├── bond_investments
└── metals_investments
```

### Backward Compatibility

A **compatibility view** `investments` is created that UNION ALLs all child tables. Existing repository code queries this view unchanged.

An **INSTEAD OF trigger** on the view routes INSERT/UPDATE/DELETE operations to the correct child table based on `asset_class`.

### Same Pattern for Transactions

```
portfolio_transactions_base (parent table)
├── stock_transactions
├── etf_transactions
├── crypto_transactions
├── real_estate_transactions
├── savings_transactions
├── bond_transactions
└── metals_transactions
```

## Consequences

### Positive
- **Extensibility** — new asset classes added by creating new child tables
- **Data integrity** — asset-class-specific constraints enforced at table level
- **Storage efficiency** — NULL columns eliminated from child tables
- **Query performance** — queries on specific asset classes scan only relevant child tables
- **Backward compatibility** — existing code works unchanged through the view

### Negative
- **Complexity** — schema initialization must handle both view and table cases
- **Migration complexity** — data migration from flat table to inheritance structure
- **Startup overhead** — schema init must detect whether tables or views exist and act accordingly
- **Index management** — indexes must be created on each child table separately

## Implementation Details

### Migration Chain

1. `0013_investment_inheritance.py` — Creates parent/child tables, migrates data
2. `0014_investments_view_update_trigger.py` — Creates view and INSTEAD OF trigger
3. `0017_investment_custom_provider_history.py` — Adds custom provider fields to inheritance tables
4. `0018_metals_transactions_inheritance_split.py` — Splits metals transactions from stock_transactions

### Repository Adaptation

The repository detects the schema version and:
- Routes writes to child tables directly (bypassing the view)
- Reads from the compatibility view for backward compatibility
- Validates asset-class-specific fields before insert

## Related

- [[docs/adr/002-database-schema|ADR-002: Database Schema]]
- [[docs/features/portfolio]] — Portfolio feature
- [[docs/adr/003-bugfixes-ui-state-category-names|ADR-003]] — Related bugfixes
