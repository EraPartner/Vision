"""Initial baseline revision — full schema port from schemaInit.js

Revision ID: 0001_initial
Revises:
Create Date: 2026-02-28 13:00:00.000000

Consolidated baseline revision that creates the entire Vision database schema
from scratch. This replaces the legacy runtime-only ``schemaInit.js`` bootstrap
with an idempotent, Alembic-authoritative DDL script (ADR-027).

Scope:
  * Extensions: pg_trgm, pgcrypto
  * Helper functions: update_updated_at_column, touch_ai_conversation_updated_at
  * Enum types: asset_class, portfolio_txn_type, recurrence_interval,
    price_provider, revolut_state
  * Core transaction tables: categories, recipients, recipient_bank_accounts,
    transactions, planned_transactions, planned_transaction_executions,
    planned_transaction_loan_schedule, transaction_raw_references
  * Raw bank tables: belfius, revolut, kbc, sabb, wise, vision, custom, manual
  * Supporting tables: exchange_rates, belgian_inflation_rates, investments,
    asset_price_history, portfolio_transactions, watchlist, user_settings,
    saved_charts, ai_conversations, ai_messages
  * All associated indexes, triggers, and unique constraints

Explicitly excluded:
  * ``schema_version`` table — ADR-027 makes Alembic the sole schema authority.
  * Materialized views — managed at runtime by
    ``apps/node-backend/src/services/materializedViewService.js``.
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0001_initial'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ---------------------------------------------------------------------------
# Extensions + helper functions
# ---------------------------------------------------------------------------

EXTENSIONS_SQL = [
    "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
    "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
]

UPDATE_UPDATED_AT_FN = """
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""

TOUCH_AI_CONV_FN = """
CREATE OR REPLACE FUNCTION touch_ai_conversation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE ai_conversations SET updated_at = NOW() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""


# ---------------------------------------------------------------------------
# Enum types — idempotent creation via DO $$ ... EXCEPTION pattern
# ---------------------------------------------------------------------------

ENUMS_SQL = [
    # asset_class
    """
    DO $$ BEGIN
      CREATE TYPE asset_class AS ENUM (
        'stock','etf','crypto','metals','real_estate','savings','bond'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    """,
    # portfolio_txn_type
    """
    DO $$ BEGIN
      CREATE TYPE portfolio_txn_type AS ENUM (
        'buy','sell','dividend','fee','tax','interest','rent_income','appreciation','gift'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    """,
    # recurrence_interval
    """
    DO $$ BEGIN
      CREATE TYPE recurrence_interval AS ENUM (
        'daily','weekly','bi-weekly','monthly','quarterly','yearly'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    """,
    # price_provider
    """
    DO $$ BEGIN
      CREATE TYPE price_provider AS ENUM (
        'manual','binance','yahoo','custom','kinesis'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    """,
    # revolut_state
    """
    DO $$ BEGIN
      CREATE TYPE revolut_state AS ENUM (
        'COMPLETED','PENDING','REVERTED','DECLINED'
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    """,
    # Ensure 'metals' value exists on asset_class even when the type predates it
    """
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_class')
         AND NOT EXISTS (
           SELECT 1
           FROM pg_enum pe
           JOIN pg_type pt ON pt.oid = pe.enumtypid
           WHERE pt.typname = 'asset_class'
             AND pe.enumlabel = 'metals'
         ) THEN
        ALTER TYPE asset_class ADD VALUE 'metals';
      END IF;
    END $$;
    """,
]


# ---------------------------------------------------------------------------
# Core tables (dependency-ordered)
# ---------------------------------------------------------------------------

CATEGORIES_SQL = """
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  general TEXT NOT NULL,
  detail TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  CONSTRAINT uq_general_detail UNIQUE (general, detail)
);
"""

RECIPIENTS_SQL = """
CREATE TABLE IF NOT EXISTS recipients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  default_category_id INTEGER REFERENCES categories(id),
  primary_recipient_id INTEGER REFERENCES recipients(id) ON DELETE SET NULL,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
"""

RECIPIENT_BANK_ACCOUNTS_SQL = """
CREATE TABLE IF NOT EXISTS recipient_bank_accounts (
  id SERIAL PRIMARY KEY,
  recipient_id INTEGER REFERENCES recipients(id),
  account_number VARCHAR(34) NOT NULL UNIQUE,
  bank_name TEXT,
  account_label TEXT,
  address TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
"""

TRANSACTIONS_SQL = """
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  currency VARCHAR(3),
  balance NUMERIC(15,2),
  memo TEXT,
  comment TEXT,
  bank_account TEXT,
  recipient_id INTEGER NOT NULL REFERENCES recipients(id),
  recipient_bank_account_id INTEGER REFERENCES recipient_bank_accounts(id),
  category_id INTEGER REFERENCES categories(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
"""

PLANNED_TRANSACTIONS_SQL = """
CREATE TABLE IF NOT EXISTS planned_transactions (
  id SERIAL PRIMARY KEY,
  planned_date DATE NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  currency VARCHAR(3),
  memo TEXT,
  comment TEXT,
  url TEXT,
  bank_account TEXT,
  recipient_id INTEGER REFERENCES recipients(id),
  category_id INTEGER REFERENCES categories(id),
  is_recurring BOOLEAN NOT NULL DEFAULT false,
  recurrence_pattern TEXT,
  is_loan BOOLEAN NOT NULL DEFAULT false,
  loan_type TEXT,
  loan_principal NUMERIC(15,2),
  loan_annual_interest_rate NUMERIC(8,4),
  loan_term_months INTEGER,
  loan_start_date DATE,
  loan_payment_day INTEGER,
  loan_regular_payment_amount NUMERIC(15,2),
  loan_first_payment_date DATE,
  is_executed BOOLEAN NOT NULL DEFAULT false,
  last_executed_date DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
"""

PLANNED_TRANSACTION_EXECUTIONS_SQL = """
CREATE TABLE IF NOT EXISTS planned_transaction_executions (
  id SERIAL PRIMARY KEY,
  planned_transaction_id INTEGER NOT NULL REFERENCES planned_transactions(id) ON DELETE CASCADE,
  executed_transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  execution_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
"""

PLANNED_TRANSACTION_LOAN_SCHEDULE_SQL = """
CREATE TABLE IF NOT EXISTS planned_transaction_loan_schedule (
  id SERIAL PRIMARY KEY,
  planned_transaction_id INTEGER NOT NULL REFERENCES planned_transactions(id) ON DELETE CASCADE,
  installment_number INTEGER NOT NULL,
  due_date DATE NOT NULL,
  payment_amount NUMERIC(15,2) NOT NULL,
  principal_amount NUMERIC(15,2) NOT NULL,
  interest_amount NUMERIC(15,2) NOT NULL,
  remaining_principal NUMERIC(15,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  CONSTRAINT uq_ptls_planned_installment UNIQUE (planned_transaction_id, installment_number)
);
"""

TRANSACTION_RAW_REFERENCES_SQL = """
CREATE TABLE IF NOT EXISTS transaction_raw_references (
  id SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  raw_source_type VARCHAR(20) NOT NULL,
  raw_source_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
"""


# ---------------------------------------------------------------------------
# Raw bank tables
# ---------------------------------------------------------------------------

BELFIUS_RAW_SQL = """
CREATE TABLE IF NOT EXISTS belfius_raw_transactions (
  id SERIAL PRIMARY KEY,
  deduplication_hash VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  account_number VARCHAR(34) NOT NULL,
  transaction_date DATE NOT NULL,
  statement_number VARCHAR(50),
  transaction_number VARCHAR(50),
  recipient_account VARCHAR(34),
  recipient_name TEXT,
  recipient_street TEXT,
  recipient_location TEXT,
  recipient_bic VARCHAR(11),
  recipient_country VARCHAR(2),
  transaction_description TEXT,
  value_date DATE,
  amount NUMERIC(15,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  balance NUMERIC(15,2),
  additional_message TEXT,
  raw_csv_line TEXT NOT NULL
);
"""

REVOLUT_RAW_SQL = """
CREATE TABLE IF NOT EXISTS revolut_raw_transactions (
  id SERIAL PRIMARY KEY,
  deduplication_hash VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  transaction_type VARCHAR(50) NOT NULL,
  product VARCHAR(50) NOT NULL,
  started_date TIMESTAMPTZ,
  completed_date TIMESTAMPTZ NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  fee NUMERIC(15,2) DEFAULT 0,
  currency VARCHAR(3) NOT NULL,
  state revolut_state NOT NULL,
  balance NUMERIC(15,2),
  raw_csv_line TEXT NOT NULL
);
"""

KBC_RAW_SQL = """
CREATE TABLE IF NOT EXISTS kbc_raw_transactions (
  id SERIAL PRIMARY KEY,
  deduplication_hash VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  account_number VARCHAR(34) NOT NULL,
  category_name TEXT,
  account_holder_name TEXT,
  currency VARCHAR(3) NOT NULL,
  statement_number VARCHAR(50),
  transaction_date DATE NOT NULL,
  value_date DATE,
  description TEXT,
  amount NUMERIC(15,2) NOT NULL,
  balance NUMERIC(15,2),
  credit_amount NUMERIC(15,2),
  debit_amount NUMERIC(15,2),
  counterparty_account VARCHAR(34),
  counterparty_bic VARCHAR(11),
  counterparty_name TEXT,
  counterparty_address TEXT,
  structured_communication TEXT,
  free_communication TEXT,
  raw_csv_line TEXT NOT NULL
);
"""

SABB_RAW_SQL = """
CREATE TABLE IF NOT EXISTS sabb_raw_transactions (
  id SERIAL PRIMARY KEY,
  deduplication_hash VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  transaction_date DATE NOT NULL,
  posting_date DATE,
  description TEXT,
  amount NUMERIC(15,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(50),
  amount_other_currency TEXT,
  raw_csv_line TEXT NOT NULL
);
"""

WISE_RAW_SQL = """
CREATE TABLE IF NOT EXISTS wise_raw_transactions (
  id SERIAL PRIMARY KEY,
  deduplication_hash VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  transfer_id TEXT,
  direction VARCHAR(20),
  status VARCHAR(50) NOT NULL,
  finished_on TIMESTAMPTZ,
  source_name TEXT,
  source_amount NUMERIC(15,2),
  source_currency VARCHAR(3),
  target_name TEXT,
  target_amount NUMERIC(15,2),
  target_currency VARCHAR(3),
  exchange_rate NUMERIC(20,10),
  source_fee_amount NUMERIC(15,2),
  source_fee_currency VARCHAR(3),
  reference TEXT,
  batch TEXT,
  raw_csv_line TEXT NOT NULL
);
"""

VISION_RAW_SQL = """
CREATE TABLE IF NOT EXISTS vision_raw_transactions (
  id SERIAL PRIMARY KEY,
  deduplication_hash VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  transaction_date DATE NOT NULL,
  bank_account VARCHAR(100),
  recipient TEXT,
  memo TEXT,
  amount NUMERIC(15,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  balance NUMERIC(15,2),
  category TEXT,
  comment TEXT,
  raw_csv_line TEXT NOT NULL
);
"""

CUSTOM_RAW_SQL = """
CREATE TABLE IF NOT EXISTS custom_raw_transactions (
  id SERIAL PRIMARY KEY,
  deduplication_hash VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  date TIMESTAMPTZ NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  counterparty_name TEXT NOT NULL,
  counterparty_account VARCHAR(34) NOT NULL,
  balance NUMERIC(15,2),
  category_name TEXT,
  comments TEXT,
  raw_csv_line TEXT,
  raw_metadata JSONB
);
"""

MANUAL_RAW_SQL = """
CREATE TABLE IF NOT EXISTS manual_raw_transactions (
  id SERIAL PRIMARY KEY,
  deduplication_hash VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  transaction_id INTEGER,
  date DATE NOT NULL,
  bank_account VARCHAR(100),
  recipient_id INTEGER,
  amount NUMERIC(15,2) NOT NULL,
  memo TEXT,
  currency VARCHAR(3),
  category_id INTEGER,
  comment TEXT
);
"""


# ---------------------------------------------------------------------------
# Supporting tables
# ---------------------------------------------------------------------------

EXCHANGE_RATES_SQL = """
CREATE TABLE IF NOT EXISTS exchange_rates (
  id SERIAL PRIMARY KEY,
  currency_code VARCHAR(3) NOT NULL,
  rate_to_eur NUMERIC(20,10) NOT NULL,
  rate_date DATE NOT NULL,
  is_latest BOOLEAN DEFAULT false,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  CONSTRAINT uq_currency_date UNIQUE (currency_code, rate_date)
);
"""

BELGIAN_INFLATION_RATES_SQL = """
CREATE TABLE IF NOT EXISTS belgian_inflation_rates (
  id SERIAL PRIMARY KEY,
  month_date DATE NOT NULL UNIQUE,
  monthly_rate NUMERIC(10,8) NOT NULL,
  source VARCHAR(50) NOT NULL DEFAULT 'statbel',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
"""

INVESTMENTS_SQL = """
CREATE TABLE IF NOT EXISTS investments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  symbol VARCHAR(20),
  asset_class asset_class NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
  current_price NUMERIC(18,6),
  interest_rate NUMERIC(8,4),
  maturity_date DATE,
  location VARCHAR(300),
  municipality VARCHAR(200),
  cadastral_income NUMERIC(12,2),
  municipality_tax_rate NUMERIC(8,4),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  price_provider price_provider NOT NULL DEFAULT 'manual',
  price_provider_id VARCHAR(200),
  price_provider_url VARCHAR(500),
  price_provider_latest_url VARCHAR(500),
  price_provider_latest_path VARCHAR(300),
  price_provider_history_url VARCHAR(500),
  price_provider_history_path VARCHAR(300),
  price_provider_history_ts_path VARCHAR(300),
  price_provider_history_price_path VARCHAR(300),
  price_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

ASSET_PRICE_HISTORY_SQL = """
CREATE TABLE IF NOT EXISTS asset_price_history (
  id SERIAL PRIMARY KEY,
  investment_id INTEGER NOT NULL,
  price_date DATE NOT NULL,
  close_price NUMERIC(18,6) NOT NULL,
  source VARCHAR(50) NOT NULL DEFAULT 'provider',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  CONSTRAINT uq_asset_price_history_investment_date UNIQUE (investment_id, price_date)
);
"""

PORTFOLIO_TRANSACTIONS_SQL = """
CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id SERIAL PRIMARY KEY,
  investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  type portfolio_txn_type NOT NULL,
  date DATE NOT NULL,
  amount NUMERIC(18,4) NOT NULL,
  units NUMERIC(18,8),
  price_per_unit NUMERIC(18,6),
  fees NUMERIC(18,4) DEFAULT 0,
  taxes NUMERIC(18,4) DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
  fx_rate_to_eur NUMERIC(20,10),
  note TEXT,
  is_recurring BOOLEAN NOT NULL DEFAULT false,
  recurrence_interval recurrence_interval,
  recurrence_end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

WATCHLIST_SQL = """
CREATE TABLE IF NOT EXISTS watchlist (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  symbol VARCHAR(20),
  asset_class asset_class NOT NULL,
  target_price NUMERIC(18,6) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
  notes TEXT,
  price_provider_id VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

USER_SETTINGS_SQL = """
CREATE TABLE IF NOT EXISTS user_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

SAVED_CHARTS_SQL = """
CREATE TABLE IF NOT EXISTS saved_charts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  chart_type TEXT NOT NULL DEFAULT 'line',
  category_ids INTEGER[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

AI_CONVERSATIONS_SQL = """
CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

AI_MESSAGES_SQL = """
CREATE TABLE IF NOT EXISTS ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content TEXT,
  tool_name TEXT,
  tool_args JSONB,
  tool_result JSONB,
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','streaming','aborted','error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

# Ordered list of (label, sql) table DDLs. Dependency order honored.
TABLE_DDL: list[tuple[str, str]] = [
    ('categories', CATEGORIES_SQL),
    ('recipients', RECIPIENTS_SQL),
    ('recipient_bank_accounts', RECIPIENT_BANK_ACCOUNTS_SQL),
    ('transactions', TRANSACTIONS_SQL),
    ('planned_transactions', PLANNED_TRANSACTIONS_SQL),
    ('planned_transaction_executions', PLANNED_TRANSACTION_EXECUTIONS_SQL),
    ('planned_transaction_loan_schedule', PLANNED_TRANSACTION_LOAN_SCHEDULE_SQL),
    ('transaction_raw_references', TRANSACTION_RAW_REFERENCES_SQL),
    ('belfius_raw_transactions', BELFIUS_RAW_SQL),
    ('revolut_raw_transactions', REVOLUT_RAW_SQL),
    ('kbc_raw_transactions', KBC_RAW_SQL),
    ('sabb_raw_transactions', SABB_RAW_SQL),
    ('wise_raw_transactions', WISE_RAW_SQL),
    ('vision_raw_transactions', VISION_RAW_SQL),
    ('custom_raw_transactions', CUSTOM_RAW_SQL),
    ('manual_raw_transactions', MANUAL_RAW_SQL),
    ('exchange_rates', EXCHANGE_RATES_SQL),
    ('belgian_inflation_rates', BELGIAN_INFLATION_RATES_SQL),
    ('investments', INVESTMENTS_SQL),
    ('asset_price_history', ASSET_PRICE_HISTORY_SQL),
    ('portfolio_transactions', PORTFOLIO_TRANSACTIONS_SQL),
    ('watchlist', WATCHLIST_SQL),
    ('user_settings', USER_SETTINGS_SQL),
    ('saved_charts', SAVED_CHARTS_SQL),
    ('ai_conversations', AI_CONVERSATIONS_SQL),
    ('ai_messages', AI_MESSAGES_SQL),
]


# ---------------------------------------------------------------------------
# Indexes
# ---------------------------------------------------------------------------

INDEX_SQL: list[str] = [
    # categories
    "CREATE INDEX IF NOT EXISTS idx_categories_general ON categories (general);",
    "CREATE INDEX IF NOT EXISTS idx_categories_detail ON categories (detail);",

    # recipients
    "CREATE INDEX IF NOT EXISTS idx_recipients_name ON recipients (name);",
    "CREATE INDEX IF NOT EXISTS idx_recipients_primary_recipient_id ON recipients (primary_recipient_id);",
    "CREATE INDEX IF NOT EXISTS idx_recipients_default_category_id ON recipients (default_category_id);",
    "CREATE INDEX IF NOT EXISTS idx_recipients_name_trgm ON recipients USING GIN (name gin_trgm_ops);",

    # recipient_bank_accounts
    "CREATE INDEX IF NOT EXISTS idx_rba_recipient_id ON recipient_bank_accounts (recipient_id);",

    # transactions
    "CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);",
    "CREATE INDEX IF NOT EXISTS idx_transactions_recipient_id ON transactions (recipient_id);",
    "CREATE INDEX IF NOT EXISTS idx_transactions_category_id ON transactions (category_id);",
    "CREATE INDEX IF NOT EXISTS idx_transactions_bank_account ON transactions (bank_account);",
    "CREATE INDEX IF NOT EXISTS idx_transactions_recipient_bank_account_id ON transactions (recipient_bank_account_id);",
    "CREATE INDEX IF NOT EXISTS idx_transaction_date_recipient ON transactions (date, recipient_id);",
    "CREATE INDEX IF NOT EXISTS idx_transactions_active ON transactions (date DESC, id DESC) WHERE is_active = true;",
    "CREATE INDEX IF NOT EXISTS idx_transactions_recipient_date ON transactions (recipient_id, date DESC);",
    "CREATE INDEX IF NOT EXISTS idx_transactions_category_date ON transactions (category_id, date DESC);",
    "CREATE INDEX IF NOT EXISTS idx_transactions_bank_date ON transactions (bank_account, date DESC);",
    "CREATE INDEX IF NOT EXISTS idx_transactions_recipient_date_active ON transactions (recipient_id, date DESC) WHERE is_active = true;",
    "CREATE INDEX IF NOT EXISTS idx_transactions_category_date_active ON transactions (category_id, date DESC) WHERE is_active = true;",
    "CREATE INDEX IF NOT EXISTS idx_transactions_bank_date_active ON transactions (bank_account, date DESC) WHERE is_active = true;",
    "CREATE INDEX IF NOT EXISTS idx_transactions_category_recipient_active ON transactions (category_id, recipient_id) WHERE is_active = true;",
    "CREATE INDEX IF NOT EXISTS idx_transactions_memo_trgm ON transactions USING GIN (memo gin_trgm_ops);",
    "CREATE INDEX IF NOT EXISTS idx_transactions_comment_trgm ON transactions USING GIN (comment gin_trgm_ops);",

    # planned_transactions
    "CREATE INDEX IF NOT EXISTS idx_pt_planned_date ON planned_transactions (planned_date);",
    "CREATE INDEX IF NOT EXISTS idx_pt_bank_account ON planned_transactions (bank_account);",
    "CREATE INDEX IF NOT EXISTS idx_pt_recipient_id ON planned_transactions (recipient_id);",
    "CREATE INDEX IF NOT EXISTS idx_pt_category_id ON planned_transactions (category_id);",
    "CREATE INDEX IF NOT EXISTS idx_pt_is_active ON planned_transactions (is_active);",
    "CREATE INDEX IF NOT EXISTS idx_pt_is_executed ON planned_transactions (is_executed);",
    "CREATE INDEX IF NOT EXISTS idx_pt_is_recurring ON planned_transactions (is_recurring);",
    "CREATE INDEX IF NOT EXISTS idx_pt_is_loan ON planned_transactions (is_loan);",

    # planned_transaction_executions
    "CREATE INDEX IF NOT EXISTS idx_pte_planned_id ON planned_transaction_executions (planned_transaction_id);",
    "CREATE INDEX IF NOT EXISTS idx_pte_executed_tx_id ON planned_transaction_executions (executed_transaction_id);",
    "CREATE UNIQUE INDEX IF NOT EXISTS uniq_pte_planned_executed ON planned_transaction_executions (planned_transaction_id, executed_transaction_id);",

    # planned_transaction_loan_schedule
    "CREATE INDEX IF NOT EXISTS idx_ptls_planned_transaction_id ON planned_transaction_loan_schedule (planned_transaction_id);",
    "CREATE INDEX IF NOT EXISTS idx_ptls_due_date ON planned_transaction_loan_schedule (due_date);",

    # transaction_raw_references
    "CREATE INDEX IF NOT EXISTS idx_raw_ref_transaction_id ON transaction_raw_references (transaction_id);",
    "CREATE INDEX IF NOT EXISTS idx_raw_ref_source ON transaction_raw_references (raw_source_type, raw_source_id);",

    # belfius
    "CREATE INDEX IF NOT EXISTS idx_belfius_hash ON belfius_raw_transactions (deduplication_hash);",
    "CREATE INDEX IF NOT EXISTS idx_belfius_account_date ON belfius_raw_transactions (account_number, transaction_date);",

    # revolut
    "CREATE INDEX IF NOT EXISTS idx_revolut_hash ON revolut_raw_transactions (deduplication_hash);",
    "CREATE INDEX IF NOT EXISTS idx_revolut_product_date ON revolut_raw_transactions (product, completed_date);",
    "CREATE INDEX IF NOT EXISTS idx_revolut_state ON revolut_raw_transactions (state);",

    # kbc
    "CREATE INDEX IF NOT EXISTS idx_kbc_hash ON kbc_raw_transactions (deduplication_hash);",
    "CREATE INDEX IF NOT EXISTS idx_kbc_account_date ON kbc_raw_transactions (account_number, transaction_date);",
    "CREATE INDEX IF NOT EXISTS idx_kbc_statement ON kbc_raw_transactions (statement_number);",

    # sabb
    "CREATE INDEX IF NOT EXISTS idx_sabb_hash ON sabb_raw_transactions (deduplication_hash);",
    "CREATE INDEX IF NOT EXISTS idx_sabb_date ON sabb_raw_transactions (transaction_date);",

    # wise
    "CREATE INDEX IF NOT EXISTS idx_wise_hash ON wise_raw_transactions (deduplication_hash);",
    "CREATE INDEX IF NOT EXISTS idx_wise_finished_on ON wise_raw_transactions (finished_on);",
    "CREATE INDEX IF NOT EXISTS idx_wise_transfer_id ON wise_raw_transactions (transfer_id);",

    # vision
    "CREATE INDEX IF NOT EXISTS idx_vision_hash ON vision_raw_transactions (deduplication_hash);",
    "CREATE INDEX IF NOT EXISTS idx_vision_date ON vision_raw_transactions (transaction_date);",
    "CREATE INDEX IF NOT EXISTS idx_vision_bank_account ON vision_raw_transactions (bank_account);",

    # custom
    "CREATE INDEX IF NOT EXISTS idx_custom_hash ON custom_raw_transactions (deduplication_hash);",
    "CREATE INDEX IF NOT EXISTS idx_custom_date ON custom_raw_transactions (date);",

    # manual
    "CREATE INDEX IF NOT EXISTS idx_manual_hash ON manual_raw_transactions (deduplication_hash);",
    "CREATE INDEX IF NOT EXISTS idx_manual_date_amount ON manual_raw_transactions (date, amount);",
    "CREATE INDEX IF NOT EXISTS idx_manual_transaction_id ON manual_raw_transactions (transaction_id);",

    # exchange_rates
    "CREATE INDEX IF NOT EXISTS idx_exchange_rates_currency ON exchange_rates (currency_code);",
    "CREATE INDEX IF NOT EXISTS idx_exchange_rates_date ON exchange_rates (rate_date);",
    "CREATE INDEX IF NOT EXISTS idx_exchange_rates_latest ON exchange_rates (is_latest);",

    # belgian_inflation_rates
    "CREATE INDEX IF NOT EXISTS idx_belgian_inflation_month_date ON belgian_inflation_rates (month_date);",

    # investments
    "CREATE INDEX IF NOT EXISTS idx_investments_asset_class ON investments (asset_class);",
    "CREATE INDEX IF NOT EXISTS idx_investments_is_active ON investments (is_active);",

    # asset_price_history
    "CREATE INDEX IF NOT EXISTS idx_asset_price_history_investment_date ON asset_price_history (investment_id, price_date);",
    "CREATE INDEX IF NOT EXISTS idx_asset_price_history_date ON asset_price_history (price_date);",

    # portfolio_transactions
    "CREATE INDEX IF NOT EXISTS idx_portfolio_txn_investment_id ON portfolio_transactions (investment_id);",
    "CREATE INDEX IF NOT EXISTS idx_portfolio_txn_date ON portfolio_transactions (date);",
    "CREATE INDEX IF NOT EXISTS idx_portfolio_txn_type ON portfolio_transactions (type);",

    # watchlist
    "CREATE INDEX IF NOT EXISTS idx_watchlist_asset_class ON watchlist (asset_class);",

    # ai_conversations
    "CREATE INDEX IF NOT EXISTS idx_ai_conversations_updated_at ON ai_conversations (updated_at DESC);",

    # ai_messages
    "CREATE INDEX IF NOT EXISTS idx_ai_messages_conv_created ON ai_messages (conversation_id, created_at);",
]


# ---------------------------------------------------------------------------
# Triggers — updated_at auto-bump for any table carrying an ``updated_at`` col
# ---------------------------------------------------------------------------

UPDATED_AT_TRIGGER_TABLES: list[tuple[str, str]] = [
    ('update_categories_updated_at', 'categories'),
    ('update_recipients_updated_at', 'recipients'),
    ('update_rba_updated_at', 'recipient_bank_accounts'),
    ('update_transactions_updated_at', 'transactions'),
    ('update_pt_updated_at', 'planned_transactions'),
    ('update_ptls_updated_at', 'planned_transaction_loan_schedule'),
    ('update_belgian_inflation_updated_at', 'belgian_inflation_rates'),
    ('update_investments_updated_at', 'investments'),
    ('update_asset_price_history_updated_at', 'asset_price_history'),
    ('update_portfolio_txn_updated_at', 'portfolio_transactions'),
    ('update_watchlist_updated_at', 'watchlist'),
    ('update_saved_charts_updated_at', 'saved_charts'),
]


AI_MESSAGES_TOUCH_TRIGGER_SQL = """
DO $$ BEGIN
  CREATE TRIGGER trg_ai_messages_touch_conversation
    AFTER INSERT ON ai_messages
    FOR EACH ROW EXECUTE FUNCTION touch_ai_conversation_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
"""


def _updated_at_trigger_ddl(trigger_name: str, table_name: str) -> str:
    """Return idempotent DDL that attaches an ``updated_at`` touch trigger."""
    return f"""
DO $$ BEGIN
  CREATE TRIGGER {trigger_name}
    BEFORE UPDATE ON {table_name}
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
"""


# ---------------------------------------------------------------------------
# upgrade / downgrade
# ---------------------------------------------------------------------------


def upgrade() -> None:
    """Create the full Vision baseline schema."""

    # Extensions
    for sql in EXTENSIONS_SQL:
        op.execute(sql)

    # Helper functions
    op.execute(UPDATE_UPDATED_AT_FN)

    # Enum types
    for sql in ENUMS_SQL:
        op.execute(sql)

    # Tables (in dependency order)
    for _label, ddl in TABLE_DDL:
        op.execute(ddl)

    # Touch-conversation function must exist before its trigger; it references
    # ``ai_conversations`` so create after the table to match the original JS ordering.
    op.execute(TOUCH_AI_CONV_FN)

    # Indexes
    for sql in INDEX_SQL:
        op.execute(sql)

    # Triggers
    for trigger_name, table_name in UPDATED_AT_TRIGGER_TABLES:
        op.execute(_updated_at_trigger_ddl(trigger_name, table_name))

    op.execute(AI_MESSAGES_TOUCH_TRIGGER_SQL)


def downgrade() -> None:
    """Drop every object created in ``upgrade`` (reverse dependency order)."""

    # Triggers — tables hold triggers, dropped implicitly with CASCADE below,
    # but explicit DROP keeps the downgrade readable.
    op.execute("DROP TRIGGER IF EXISTS trg_ai_messages_touch_conversation ON ai_messages;")
    for trigger_name, table_name in UPDATED_AT_TRIGGER_TABLES:
        op.execute(f"DROP TRIGGER IF EXISTS {trigger_name} ON {table_name};")

    # Tables (reverse order; CASCADE removes dependent FKs/indexes)
    for label, _ddl in reversed(TABLE_DDL):
        op.execute(f"DROP TABLE IF EXISTS {label} CASCADE;")

    # Helper functions
    op.execute("DROP FUNCTION IF EXISTS touch_ai_conversation_updated_at() CASCADE;")
    op.execute("DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;")

    # Enum types
    for enum_name in (
        'revolut_state',
        'price_provider',
        'recurrence_interval',
        'portfolio_txn_type',
        'asset_class',
    ):
        op.execute(f"DROP TYPE IF EXISTS {enum_name} CASCADE;")

    # Extensions are left installed — they may be shared with other schemas
    # and dropping them is almost never the right call during a downgrade.
