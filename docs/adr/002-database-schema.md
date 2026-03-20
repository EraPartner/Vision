---
title: ADR 002 - Database Schema
type: adr
status: Accepted
date: 2026-03-18
tags: [architecture, database, schema, postgresql]
---

# ADR-002: Database Schema Design

## Status
Accepted

## Date
2026-03-18

## Context
Vision requires a comprehensive PostgreSQL database schema to store financial transactions, investments, categories, recipients, and supporting data. The schema must support:
- Core transaction tracking with categories and recipients
- Planned/scheduled transactions with recurrence
- Investment portfolio management (stocks, crypto, real estate, savings)
- Multi-bank raw transaction storage
- Belgian tax-specific fields
- Performance through proper indexing and materialized views

## Decision

### Core Tables

#### Categories (`categories`)
Organizational labels for transactions using "GENERAL:DETAIL" format (e.g., "FOOD:GROCERIES").

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| general | TEXT | NOT NULL | General category (e.g., FOOD, TRANSPORT) |
| detail | TEXT | NOT NULL | Detail category (e.g., GROCERIES, GAS) |
| description | TEXT | NULLABLE | Optional description |
| is_active | BOOLEAN | DEFAULT true | Soft delete flag |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NULLABLE | Last update timestamp |

**Constraints**: UNIQUE(general, detail)

**Indexes**:
- `idx_categories_general` on general
- `idx_categories_detail` on detail
- `update_categories_updated_at` trigger

#### Recipients (`recipients`)
Payees/payers associated with transactions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| name | TEXT | NOT NULL | Display name |
| normalized_name | TEXT | NOT NULL UNIQUE | Normalized for matching |
| default_category_id | INTEGER | REFERENCES categories(id) | Default category |
| primary_recipient_id | INTEGER | REFERENCES recipients(id) | For merged recipients |
| notes | TEXT | NULLABLE | Optional notes |
| is_active | BOOLEAN | DEFAULT true | Soft delete flag |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NULLABLE | Last update timestamp |

**Indexes**:
- `idx_recipients_name` on name
- `idx_recipients_primary_recipient_id` on primary_recipient_id
- `idx_recipients_default_category_id` on default_category_id
- `idx_recipients_name_trgm` GIN trigram index for ILIKE search

#### Recipient Bank Accounts (`recipient_bank_accounts`)
Bank accounts associated with recipients.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| recipient_id | INTEGER | REFERENCES recipients(id) | Associated recipient |
| account_number | VARCHAR(34) | NOT NULL UNIQUE | IBAN/account number |
| bank_name | TEXT | NULLABLE | Bank name |
| account_label | TEXT | NULLABLE | Account label |
| address | TEXT | NULLABLE | Account address |
| is_primary | BOOLEAN | DEFAULT false | Primary account flag |
| is_active | BOOLEAN | DEFAULT true | Soft delete flag |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NULLABLE | Last update timestamp |

#### Transactions (`transactions`)
Core financial transactions (income/expense records).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| date | DATE | NOT NULL | Transaction date |
| amount | NUMERIC(15,2) | NOT NULL | Transaction amount |
| currency | VARCHAR(3) | NULLABLE | Currency code (ISO 4217) |
| balance | NUMERIC(15,2) | NULLABLE | Account balance after |
| memo | TEXT | NULLABLE | Transaction description |
| comment | TEXT | NULLABLE | User comment |
| bank_account | TEXT | NULLABLE | Source bank account |
| recipient_id | INTEGER | NOT NULL REFERENCES recipients(id) | Associated recipient |
| recipient_bank_account_id | INTEGER | REFERENCES recipient_bank_accounts(id) | Target account |
| category_id | INTEGER | REFERENCES categories(id) | Category |
| is_active | BOOLEAN | DEFAULT true | Soft delete flag |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NULLABLE | Last update timestamp |

**Indexes**:
- `idx_transactions_date` on date
- `idx_transactions_recipient_id` on recipient_id
- `idx_transactions_category_id` on category_id
- `idx_transactions_bank_account` on bank_account
- `idx_transactions_recipient_bank_account_id` on recipient_bank_account_id
- `idx_transaction_date_recipient` on (date, recipient_id)
- `idx_transactions_active` partial on (date DESC, id DESC) WHERE is_active = true
- `idx_transactions_recipient_date` on (recipient_id, date DESC)
- `idx_transactions_category_date` on (category_id, date DESC)
- `idx_transactions_bank_date` on (bank_account, date DESC)
- `idx_transactions_memo_trgm` GIN trigram on memo
- `idx_transactions_comment_trgm` GIN trigram on comment

#### Planned Transactions (`planned_transactions`)
Scheduled and recurring future transactions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| planned_date | DATE | NOT NULL | Scheduled date |
| amount | NUMERIC(15,2) | NOT NULL | Planned amount |
| currency | VARCHAR(3) | NULLABLE | Currency code |
| memo | TEXT | NULLABLE | Description |
| comment | TEXT | NULLABLE | User comment |
| url | TEXT | NULLABLE | Payment URL |
| bank_account | TEXT | NULLABLE | Source account |
| recipient_id | INTEGER | REFERENCES recipients(id) | Associated recipient |
| category_id | INTEGER | REFERENCES categories(id) | Category |
| is_recurring | BOOLEAN | DEFAULT false | Recurring flag |
| recurrence_pattern | TEXT | NULLABLE | Recurrence pattern |
| is_loan | BOOLEAN | DEFAULT false | Loan flag |
| loan_type | TEXT | NULLABLE | Loan type |
| loan_principal | NUMERIC(15,2) | NULLABLE | Principal amount |
| loan_annual_interest_rate | NUMERIC(8,4) | NULLABLE | Annual interest rate |
| loan_term_months | INTEGER | NULLABLE | Term in months |
| loan_start_date | DATE | NULLABLE | Start date |
| loan_payment_day | INTEGER | NULLABLE | Day of month for payment |
| loan_regular_payment_amount | NUMERIC(15,2) | NULLABLE | Regular payment |
| loan_first_payment_date | DATE | NULLABLE | First payment date |
| is_executed | BOOLEAN | DEFAULT false | Executed flag |
| last_executed_date | DATE | NULLABLE | Last execution date |
| is_active | BOOLEAN | DEFAULT true | Soft delete flag |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NULLABLE | Last update timestamp |

**Indexes**:
- `idx_pt_planned_date` on planned_date
- `idx_pt_bank_account` on bank_account
- `idx_pt_recipient_id` on recipient_id
- `idx_pt_category_id` on category_id
- `idx_pt_is_active` on is_active
- `idx_pt_is_executed` on is_executed
- `idx_pt_is_recurring` on is_recurring
- `idx_pt_is_loan` on is_loan

#### Planned Transaction Executions (`planned_transaction_executions`)
Links planned transactions to executed transactions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| planned_transaction_id | INTEGER | NOT NULL REFERENCES planned_transactions(id) | Planned transaction |
| executed_transaction_id | INTEGER | NOT NULL REFERENCES transactions(id) | Executed transaction |
| execution_date | DATE | NOT NULL | Execution date |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |

**Indexes**:
- `idx_pte_planned_id` on planned_transaction_id
- `idx_pte_executed_tx_id` on executed_transaction_id

#### Planned Transaction Loan Schedule (`planned_transaction_loan_schedule`)
Amortization schedule for loans.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| planned_transaction_id | INTEGER | NOT NULL REFERENCES planned_transactions(id) | Loan planned transaction |
| installment_number | INTEGER | NOT NULL | Installment number |
| due_date | DATE | NOT NULL | Due date |
| payment_amount | NUMERIC(15,2) | NOT NULL | Payment amount |
| principal_amount | NUMERIC(15,2) | NOT NULL | Principal portion |
| interest_amount | NUMERIC(15,2) | NOT NULL | Interest portion |
| remaining_principal | NUMERIC(15,2) | NOT NULL | Remaining principal |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NULLABLE | Last update timestamp |

**Constraints**: UNIQUE(planned_transaction_id, installment_number)

### Raw Transaction Tables
Bank-specific raw transaction storage for deduplication:

#### Supported Banks
| Table | Purpose | Description |
|-------|---------|-------------|
| `belfius_raw_transactions` | Belfius Bank | Parses Belfius CSV format |
| `revolut_raw_transactions` | Revolut | Parses Revolut CSV export |
| `kbc_raw_transactions` | KBC Bank | Parses KBC CSV statements |
| `sabb_raw_transactions` | SABB | Saudi Arabian British Bank |
| `wise_raw_transactions` | Wise | Parses Wise transaction exports |
| `vision_raw_transactions` | Vision | Parses Vision bank format |
| `custom_raw_transactions` | Custom CSV Import | User-defined column mapping for generic CSVs |
| `manual_raw_transactions` | Manual Entry | Deduplication for manually entered transactions |

#### Custom CSV Import (`custom_raw_transactions`)
The `custom_raw_transactions` table stores transactions imported via the **Custom** bank adapter. This adapter allows users to define their own column mappings (date, description, amount, etc.) for CSV files that don't match any supported bank format. The mapping is stored per-import in `raw_metadata`.

#### Manual Entry Deduplication (`manual_raw_transactions`)
The `manual_raw_transactions` table stores manually entered transaction data **before** creating the actual transaction. This enables hash-based deduplication to prevent duplicate entries when users manually add transactions that may already exist in imported data.

All raw tables include:
- `deduplication_hash` - Unique hash for deduplication (UNIQUE)
- `created_at` - Import timestamp
- `raw_csv_line` - Original CSV line for audit

### Investment Tables

#### Investments (`investments`)
Investment holdings (stocks, ETFs, crypto, real estate, savings, bonds).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| name | VARCHAR(200) | NOT NULL | Investment name |
| symbol | VARCHAR(20) | NULLABLE | Ticker symbol |
| asset_class | asset_class | NOT NULL | Asset type |
| currency | VARCHAR(10) | DEFAULT 'EUR' | Currency |
| current_price | NUMERIC(18,6) | NULLABLE | Current price |
| interest_rate | NUMERIC(8,4) | NULLABLE | For savings/bonds |
| maturity_date | DATE | NULLABLE | For bonds |
| location | VARCHAR(300) | NULLABLE | For real estate |
| municipality | VARCHAR(200) | NULLABLE | Belgian municipality |
| cadastral_income | NUMERIC(12,2) | NULLABLE | Belgian cadastral income |
| municipality_tax_rate | NUMERIC(8,4) | NULLABLE | Municipal tax rate |
| notes | TEXT | NULLABLE | Notes |
| is_active | BOOLEAN | DEFAULT true | Soft delete |
| price_provider | price_provider | DEFAULT 'manual' | Price source |
| price_provider_id | VARCHAR(200) | NULLABLE | Provider identifier |
| price_provider_url | VARCHAR(500) | NULLABLE | Provider URL |
| price_updated_at | TIMESTAMPTZ | NULLABLE | Last price update |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() | Last update |

**Asset Class Enum**: stock, etf, crypto, real_estate, savings, bond

**Price Provider Enum**: manual, coingecko, yahoo, kraken, custom

**Indexes**:
- `idx_investments_asset_class` on asset_class
- `idx_investments_is_active` on is_active
- `update_investments_updated_at` trigger

#### Portfolio Transactions (`portfolio_transactions`)
Buy/sell/dividend transactions for investments.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| investment_id | INTEGER | NOT NULL REFERENCES investments(id) | Investment |
| type | portfolio_txn_type | NOT NULL | Transaction type |
| date | DATE | NOT NULL | Transaction date |
| amount | NUMERIC(18,4) | NOT NULL | Total amount |
| units | NUMERIC(18,8) | NULLABLE | Number of units |
| price_per_unit | NUMERIC(18,6) | NULLABLE | Price per unit |
| fees | NUMERIC(18,4) | DEFAULT 0 | Transaction fees |
| taxes | NUMERIC(18,4) | DEFAULT 0 | Taxes paid |
| currency | VARCHAR(10) | DEFAULT 'EUR' | Currency |
| note | TEXT | NULLABLE | Notes |
| is_recurring | BOOLEAN | DEFAULT false | Recurring flag |
| recurrence_interval | recurrence_interval | NULLABLE | Recurrence interval |
| recurrence_end_date | DATE | NULLABLE | End date for recurrence |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() | Last update |

**Transaction Type Enum**: buy, sell, dividend, fee, tax, interest, rent_income, appreciation

**Recurrence Interval Enum**: daily, weekly, bi-weekly, monthly, quarterly, yearly

**Indexes**:
- `idx_portfolio_txn_investment_id` on investment_id
- `idx_portfolio_txn_date` on date
- `idx_portfolio_txn_type` on type

#### Watchlist (`watchlist`)
Investment watchlist for tracking.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| name | VARCHAR(200) | NOT NULL | Watchlist name |
| symbol | VARCHAR(20) | NULLABLE | Ticker symbol |
| asset_class | asset_class | NOT NULL | Asset type |
| target_price | NUMERIC(18,6) | NOT NULL | Target price |
| currency | VARCHAR(10) | DEFAULT 'EUR' | Currency |
| notes | TEXT | NULLABLE | Notes |
| price_provider_id | VARCHAR(200) | NULLABLE | Provider ID |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() | Last update |

### Supporting Tables

#### Exchange Rates (`exchange_rates`)
Currency exchange rates to EUR.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| currency_code | VARCHAR(3) | NOT NULL | ISO currency code |
| rate_to_eur | NUMERIC(20,10) | NOT NULL | Rate to EUR |
| rate_date | DATE | NOT NULL | Rate date |
| is_latest | BOOLEAN | DEFAULT false | Latest flag |
| fetched_at | TIMESTAMPTZ | DEFAULT NOW() | Fetch timestamp |
| updated_at | TIMESTAMPTZ | NULLABLE | Last update |

**Constraints**: UNIQUE(currency_code, rate_date)

#### User Settings (`user_settings`)
Key-value user preferences.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| key | TEXT | PRIMARY KEY | Setting key |
| value | JSONB | DEFAULT '{}' | Setting value |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() | Last update |

#### Saved Charts (`saved_charts`)
Saved chart configurations.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| name | TEXT | NOT NULL | Chart name |
| chart_type | TEXT | DEFAULT 'line' | Chart type |
| category_ids | INTEGER[] | DEFAULT '{}' | Category filter |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() | Last update |

#### Transaction Raw References (`transaction_raw_references`)
Links transactions to their raw source.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Unique identifier |
| transaction_id | INTEGER | NOT NULL UNIQUE REFERENCES transactions(id) | Transaction |
| raw_source_type | VARCHAR(20) | NOT NULL | Source bank type |
| raw_source_id | INTEGER | NOT NULL | Source record ID |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | Creation timestamp |

### Enum Types

| Enum Name | Values |
|-----------|--------|
| asset_class | stock, etf, crypto, real_estate, savings, bond |
| portfolio_txn_type | buy, sell, dividend, fee, tax, interest, rent_income, appreciation |
| recurrence_interval | daily, weekly, bi-weekly, monthly, quarterly, yearly |
| price_provider | manual, coingecko, yahoo, kraken, custom |
| revolut_state | COMPLETED, PENDING, REVERTED, DECLINED |

### Materialized Views
The schema includes materialized views for performance optimization (see [[apps/node-backend/src/services/materializedViewService.js]]):
- Transaction summaries by category/recipient
- Portfolio valuations
- Spending trends

Views are refreshed on startup and after data modifications.

## Consequences

### Positive
- Comprehensive data model supports all required features
- Proper foreign key constraints maintain data integrity
- Indexing strategy optimizes common query patterns
- GIN trigram indexes enable fast text search
- Materialized views speed up aggregations
- Soft delete pattern preserves historical data

### Negative
- Complex schema benefits from automated migrations in Docker (docker-entrypoint.sh waits for DB, fixes alembic_version column, runs Alembic on startup)
- Multiple raw transaction tables require maintenance
- Materialized view refresh adds startup overhead

## Related
- [[docs/adr/001-technology-stack|ADR-001: Technology Stack]]
- [[docs/api/transactions|API: Transactions]]
- [[docs/api/investments|API: Investments]]
- [[docs/performance/index|Performance Documentation]]
