/**
 * Database Schema Initializer
 *
 * Ensures all required tables, indexes, enums, triggers, and
 * materialized views exist on startup.
 * Uses IF NOT EXISTS / DO $$ blocks so it's safe to run repeatedly (idempotent).
 *
 * Table creation order respects foreign key dependencies:
 *   1. categories (no FK deps)
 *   2. recipients (FK → categories, self-ref)
 *   3. recipient_bank_accounts (FK → recipients)
 *   4. transactions (FK → recipients, recipient_bank_accounts, categories)
 *   5. planned_transactions (FK → recipients, categories, transactions)
 *   6. planned_transaction_executions (FK → planned_transactions, transactions)
 *   7. transaction_raw_references (FK → transactions)
 *   8. belfius_raw_transactions, revolut_raw_transactions, kbc_raw_transactions
 *   9. custom_raw_transactions, manual_raw_transactions
 *  10. exchange_rates
 *  11. investments, portfolio_transactions
 *  12. user_settings
 */

import { query } from './connection.js';
import { logger } from '../config/logger.js';
import { createMaterializedViews, refreshMaterializedViews } from '../services/materializedViewService.js';

/**
 * Run the full schema initialisation. Safe to call on every startup.
 */
export async function initializeSchema() {
  const start = Date.now();
  logger.info('Running database schema initialisation (idempotent)…');

  try {
    // --- Enums ---
    await ensureEnums();

    // --- Extensions ---
    // pg_trgm enables GIN trigram indexes for fast ILIKE / full-text search
    await query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    // --- Helper function ---
    await query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // --- Tables (in dependency order) ---
    await createCategories();
    await createRecipients();
    await createRecipientBankAccounts();
    await createTransactions();
    await createPlannedTransactions();
    await createPlannedTransactionExecutions();
    await createTransactionRawReferences();
    await createBelfiusRaw();
    await createRevolutRaw();
    await createKbcRaw();
    await createCustomRaw();
    await createManualRaw();
    await createExchangeRates();
    await createInvestments();
    await createPortfolioTransactions();
    await createWatchlist();
    await createUserSettings();

    // --- Materialized views ---
    await createMaterializedViews();
    // Initial population
    await refreshMaterializedViews();

    const duration = Date.now() - start;
    logger.info(`Schema initialisation complete in ${duration}ms`);
  } catch (err) {
    logger.error('Schema initialisation failed', { error: err.message });
    throw err;
  }
}

// ─────────────────────────────────────────────
// Enum types
// ─────────────────────────────────────────────

async function ensureEnums() {
  const enums = [
    { name: 'asset_class', values: "'stock','etf','crypto','real_estate','savings','bond'" },
    { name: 'portfolio_txn_type', values: "'buy','sell','dividend','fee','tax','interest','rent_income','appreciation'" },
    { name: 'recurrence_interval', values: "'daily','weekly','bi-weekly','monthly','quarterly','yearly'" },
    { name: 'price_provider', values: "'manual','coingecko','yahoo','kraken','custom'" },
    { name: 'revolut_state', values: "'COMPLETED','PENDING','REVERTED','DECLINED'" },
  ];

  for (const e of enums) {
    await query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${e.name}') THEN
          CREATE TYPE ${e.name} AS ENUM (${e.values});
        END IF;
      END $$;
    `);
  }
}

// ─────────────────────────────────────────────
// Core tables
// ─────────────────────────────────────────────

async function createCategories() {
  await query(`
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
  `);
  await safeIndex('idx_categories_general', 'categories', 'general');
  await safeIndex('idx_categories_detail', 'categories', 'detail');
  await safeTrigger('update_categories_updated_at', 'categories');
}

async function createRecipients() {
  await query(`
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
  `);
  await safeIndex('idx_recipients_name', 'recipients', 'name');
  await safeIndex('idx_recipients_normalized_name', 'recipients', 'normalized_name');
  await safeIndex('idx_recipients_primary_recipient_id', 'recipients', 'primary_recipient_id');
  await safeTrigger('update_recipients_updated_at', 'recipients');
}

async function createRecipientBankAccounts() {
  await query(`
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
  `);
  await safeIndex('idx_rba_recipient_id', 'recipient_bank_accounts', 'recipient_id');
  await safeTrigger('update_rba_updated_at', 'recipient_bank_accounts');
}

async function createTransactions() {
  await query(`
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
  `);
  await safeIndex('idx_transactions_date', 'transactions', 'date');
  await safeIndex('idx_transactions_recipient_id', 'transactions', 'recipient_id');
  await safeIndex('idx_transactions_category_id', 'transactions', 'category_id');
  await safeIndex('idx_transactions_bank_account', 'transactions', 'bank_account');
  await safeIndex('idx_transaction_date_recipient', 'transactions', 'date, recipient_id');
  // GIN trigram indexes for fast ILIKE search on free-text columns
  await safeGinIndex('idx_transactions_memo_trgm', 'transactions', 'memo gin_trgm_ops');
  await safeGinIndex('idx_transactions_comment_trgm', 'transactions', 'comment gin_trgm_ops');
  await safeTrigger('update_transactions_updated_at', 'transactions');
}

async function createPlannedTransactions() {
  await query(`
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
      is_executed BOOLEAN NOT NULL DEFAULT false,
      last_executed_date DATE,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );
  `);
  await safeIndex('idx_pt_planned_date', 'planned_transactions', 'planned_date');
  await safeIndex('idx_pt_bank_account', 'planned_transactions', 'bank_account');
  await safeIndex('idx_pt_recipient_id', 'planned_transactions', 'recipient_id');
  await safeIndex('idx_pt_category_id', 'planned_transactions', 'category_id');
  await safeIndex('idx_pt_is_active', 'planned_transactions', 'is_active');
  await safeIndex('idx_pt_is_executed', 'planned_transactions', 'is_executed');
  await safeIndex('idx_pt_is_recurring', 'planned_transactions', 'is_recurring');
  await safeTrigger('update_pt_updated_at', 'planned_transactions');
}

async function createPlannedTransactionExecutions() {
  await query(`
    CREATE TABLE IF NOT EXISTS planned_transaction_executions (
      id SERIAL PRIMARY KEY,
      planned_transaction_id INTEGER NOT NULL REFERENCES planned_transactions(id) ON DELETE CASCADE,
      executed_transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      execution_date DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await safeIndex('idx_pte_planned_id', 'planned_transaction_executions', 'planned_transaction_id');
}

async function createTransactionRawReferences() {
  await query(`
    CREATE TABLE IF NOT EXISTS transaction_raw_references (
      id SERIAL PRIMARY KEY,
      transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
      raw_source_type VARCHAR(20) NOT NULL,
      raw_source_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await safeIndex('idx_raw_ref_transaction_id', 'transaction_raw_references', 'transaction_id');
  await safeIndex('idx_raw_ref_source', 'transaction_raw_references', 'raw_source_type, raw_source_id');
}

// ─────────────────────────────────────────────
// Raw bank tables
// ─────────────────────────────────────────────

async function createBelfiusRaw() {
  await query(`
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
  `);
  await safeIndex('idx_belfius_hash', 'belfius_raw_transactions', 'deduplication_hash');
  await safeIndex('idx_belfius_account_date', 'belfius_raw_transactions', 'account_number, transaction_date');
}

async function createRevolutRaw() {
  await query(`
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
  `);
  await safeIndex('idx_revolut_hash', 'revolut_raw_transactions', 'deduplication_hash');
  await safeIndex('idx_revolut_product_date', 'revolut_raw_transactions', 'product, completed_date');
  await safeIndex('idx_revolut_state', 'revolut_raw_transactions', 'state');
}

async function createKbcRaw() {
  await query(`
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
  `);
  await safeIndex('idx_kbc_hash', 'kbc_raw_transactions', 'deduplication_hash');
  await safeIndex('idx_kbc_account_date', 'kbc_raw_transactions', 'account_number, transaction_date');
  await safeIndex('idx_kbc_statement', 'kbc_raw_transactions', 'statement_number');
}

async function createCustomRaw() {
  await query(`
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
  `);
  await safeIndex('idx_custom_hash', 'custom_raw_transactions', 'deduplication_hash');
  await safeIndex('idx_custom_date', 'custom_raw_transactions', 'date');
}

async function createManualRaw() {
  await query(`
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
  `);
  await safeIndex('idx_manual_hash', 'manual_raw_transactions', 'deduplication_hash');
  await safeIndex('idx_manual_date_amount', 'manual_raw_transactions', 'date, amount');
}

// ─────────────────────────────────────────────
// Supporting tables
// ─────────────────────────────────────────────

async function createExchangeRates() {
  await query(`
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
  `);
  await safeIndex('idx_exchange_rates_currency', 'exchange_rates', 'currency_code');
  await safeIndex('idx_exchange_rates_date', 'exchange_rates', 'rate_date');
  await safeIndex('idx_exchange_rates_latest', 'exchange_rates', 'is_latest');
}

async function createInvestments() {
  await query(`
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
      notes TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      price_provider price_provider NOT NULL DEFAULT 'manual',
      price_provider_id VARCHAR(200),
      price_provider_url VARCHAR(500),
      price_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await safeIndex('idx_investments_asset_class', 'investments', 'asset_class');
  await safeIndex('idx_investments_is_active', 'investments', 'is_active');
  await safeTrigger('update_investments_updated_at', 'investments');
}

async function createPortfolioTransactions() {
  await query(`
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
      note TEXT,
      is_recurring BOOLEAN NOT NULL DEFAULT false,
      recurrence_interval recurrence_interval,
      recurrence_end_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await safeIndex('idx_portfolio_txn_investment_id', 'portfolio_transactions', 'investment_id');
  await safeIndex('idx_portfolio_txn_date', 'portfolio_transactions', 'date');
  await safeIndex('idx_portfolio_txn_type', 'portfolio_transactions', 'type');
  await safeTrigger('update_portfolio_txn_updated_at', 'portfolio_transactions');
}

async function createWatchlist() {
  await query(`
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
  `);
  await safeIndex('idx_watchlist_asset_class', 'watchlist', 'asset_class');
  await safeTrigger('update_watchlist_updated_at', 'watchlist');
}

async function createUserSettings() {
  await query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Create a B-tree index if it doesn't already exist.
 */
async function safeIndex(name, table, columns) {
  await query(`
    CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${columns});
  `);
}

/**
 * Create a GIN index if it doesn't already exist (used for trigram/full-text search).
 */
async function safeGinIndex(name, table, expression) {
  await query(`
    CREATE INDEX IF NOT EXISTS ${name} ON ${table} USING GIN (${expression});
  `);
}

/**
 * Create an updated_at trigger if it doesn't already exist.
 */
async function safeTrigger(name, table) {
  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = '${name}'
      ) THEN
        CREATE TRIGGER ${name}
          BEFORE UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      END IF;
    END $$;
  `);
}

export default initializeSchema;
