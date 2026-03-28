/**
 * Database Schema Initializer
 *
 * Ensures all required tables, indexes, enums, triggers, and
 * materialized views exist on startup.
 * Uses IF NOT EXISTS / DO $$ blocks so it's safe to run repeatedly (idempotent).
 *
 * SCHEMA VERSION GUARD
 * On a warm start (database already fully initialised), running 50+ sequential
 * CREATE IF NOT EXISTS / DROP + RECREATE queries is unnecessary overhead.
 * We store a schema version in a `schema_version` table.  If the stored version
 * matches CURRENT_SCHEMA_VERSION we skip the full DDL suite and only refresh
 * materialized views (which need fresh data on every start).
 *
 * Bump CURRENT_SCHEMA_VERSION whenever you make a schema change that needs DDL
 * to be re-applied (new table, altered column, new index, etc.).
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
 *      sabb_raw_transactions, wise_raw_transactions, vision_raw_transactions
 *   9. custom_raw_transactions, manual_raw_transactions
 *  10. exchange_rates
 *  11. investments, portfolio_transactions
 *  12. user_settings
 */

import { query } from './connection.js';
import { logger } from '../config/logger.js';
import { createMaterializedViews, ensureMaterializedViewIndexes, refreshMaterializedViews } from '../services/materializedViewService.js';

/**
 * Increment this whenever schema changes require DDL to be re-applied on existing DBs.
 * Format: YYYYMMDD_N (N = change number on that date, starting at 1).
 */
const CURRENT_SCHEMA_VERSION = '20260327_2';

/**
 * Check the stored schema version.  Returns null if the table doesn't exist yet.
 */
async function getStoredSchemaVersion() {
  try {
    const result = await query(
      `SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1`
    );
    return result.rows[0]?.version ?? null;
  } catch {
    // Table doesn't exist — first ever run
    return null;
  }
}

/**
 * Persist the current schema version.
 */
async function setSchemaVersion(version) {
  // Create the tracking table if it doesn't exist yet
  await query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id          SERIAL PRIMARY KEY,
      version     TEXT NOT NULL,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(
    `INSERT INTO schema_version (version) VALUES ($1)`,
    [version]
  );
}

/**
 * Run the full schema initialisation. Safe to call on every startup.
 *
 * On warm starts where the schema version already matches, only the
 * materialized view refresh is performed (skipping all CREATE TABLE/INDEX DDL).
 */
export async function initializeSchema() {
  const start = Date.now();

  const storedVersion = await getStoredSchemaVersion();
  const isWarmStart = storedVersion === CURRENT_SCHEMA_VERSION;

  if (isWarmStart) {
    logger.info(`Schema version ${CURRENT_SCHEMA_VERSION} already applied — skipping DDL.`);
    // NOTE: Materialized view refresh is intentionally omitted from startup.
    // Mat-views are refreshed on-demand via the /api/info endpoint or can be
    // refreshed manually. This avoids blocking startup with expensive aggregation
    // queries on every restart.
    return;
  }

  logger.info(`Running full schema initialisation (version ${CURRENT_SCHEMA_VERSION})…`);

  try {
    // --- Enums + extension + helper function ---
    // All three are fully independent — run in parallel.
    await Promise.all([
      ensureEnums(),
      // pg_trgm enables GIN trigram indexes for fast ILIKE / full-text search
      query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`),
      query(`
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `),
    ]);

    // --- Tables (in dependency order, with parallelism where safe) ---

    // Level 1: no FK deps
    await createCategories();

    // Level 2: depends on categories
    await createRecipients();

    // Level 3: depends on recipients
    await createRecipientBankAccounts();

    // Level 4: depends on recipients + recipient_bank_accounts + categories
    await createTransactions();

    // Level 5: depends on transactions (+ recipients, categories)
    await createPlannedTransactions();

    // Level 6: planned_transaction_executions and transaction_raw_references
    // both depend on transactions/planned_transactions but not on each other
    await Promise.all([
      createPlannedTransactionExecutions(),
      createTransactionRawReferences(),
      createPlannedTransactionLoanSchedule(),
    ]);

    // Level 7: raw bank tables — all independent of each other and of the
    // core transaction chain above (no FK references into it)
    await Promise.all([
      createBelfiusRaw(),
      createRevolutRaw(),
      createKbcRaw(),
      createSABBRaw(),
      createWiseRaw(),
      createVisionRaw(),
      createCustomRaw(),
      createManualRaw(),
    ]);

    // Level 8: supporting tables — all independent of each other
    // Note: createPortfolioTransactions depends on createInvestments, so
    // investments must finish first; the others are fully independent.
    await Promise.all([
      createExchangeRates(),
      createBelgianInflationRates(),
      createInvestments(),
      createAssetPriceHistory(),
      createWatchlist(),
      createUserSettings(),
      createSavedCharts(),
    ]);

    // Level 9: depends on investments (FK investment_id)
    await createPortfolioTransactions();

    // --- Materialized views ---
    await createMaterializedViews();
    // Ensure unique indexes exist even on DBs that pre-date their addition
    await ensureMaterializedViewIndexes();
    // Initial population
    await refreshMaterializedViews();

    // --- Stamp the schema version so warm starts are fast ---
    await setSchemaVersion(CURRENT_SCHEMA_VERSION);

    const duration = Date.now() - start;
    logger.info(`Schema initialisation complete in ${duration}ms (version ${CURRENT_SCHEMA_VERSION})`);
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
    { name: 'asset_class', values: "'stock','etf','crypto','metals','real_estate','savings','bond'" },
    { name: 'portfolio_txn_type', values: "'buy','sell','dividend','fee','tax','interest','rent_income','appreciation','gift'" },
    { name: 'recurrence_interval', values: "'daily','weekly','bi-weekly','monthly','quarterly','yearly'" },
    { name: 'price_provider', values: "'manual','binance','yahoo','custom','kinesis'" },
    { name: 'revolut_state', values: "'COMPLETED','PENDING','REVERTED','DECLINED'" },
  ];

  // All enum checks are independent — run in parallel
  await Promise.all(enums.map(e => query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${e.name}') THEN
        CREATE TYPE ${e.name} AS ENUM (${e.values});
      END IF;
    END $$;
  `)));

  await query(`
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
  `);
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
  // `normalized_name` is declared UNIQUE which creates an index; avoid a redundant duplicate index
  await safeIndex('idx_recipients_primary_recipient_id', 'recipients', 'primary_recipient_id');
  // default_category_id is used in uncategorized-recipient queries
  await safeIndex('idx_recipients_default_category_id', 'recipients', 'default_category_id');
  // GIN trigram index for fast ILIKE search on recipient name
  await safeGinIndex('idx_recipients_name_trgm', 'recipients', 'name gin_trgm_ops');
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
  // Index FK for joins on recipient bank account
  await safeIndex('idx_transactions_recipient_bank_account_id', 'transactions', 'recipient_bank_account_id');
  await safeIndex('idx_transaction_date_recipient', 'transactions', 'date, recipient_id');
  // Partial index on active transactions — most queries filter is_active = true
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_active ON transactions (date DESC, id DESC) WHERE is_active = true;`);
  // Composite indexes for common per-recipient and per-category ordered queries
  await safeIndex('idx_transactions_recipient_date', 'transactions', 'recipient_id, date DESC');
  await safeIndex('idx_transactions_category_date', 'transactions', 'category_id, date DESC');
  await safeIndex('idx_transactions_bank_date', 'transactions', 'bank_account, date DESC');
  // Partial variants optimized for the common case: active rows per-entity ordered by date
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_recipient_date_active ON transactions (recipient_id, date DESC) WHERE is_active = true;`);
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_category_date_active ON transactions (category_id, date DESC) WHERE is_active = true;`);
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_bank_date_active ON transactions (bank_account, date DESC) WHERE is_active = true;`);
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
  `);
  await query(`ALTER TABLE planned_transactions ADD COLUMN IF NOT EXISTS is_loan BOOLEAN NOT NULL DEFAULT false;`);
  await query(`ALTER TABLE planned_transactions ADD COLUMN IF NOT EXISTS loan_type TEXT;`);
  await query(`ALTER TABLE planned_transactions ADD COLUMN IF NOT EXISTS loan_principal NUMERIC(15,2);`);
  await query(`ALTER TABLE planned_transactions ADD COLUMN IF NOT EXISTS loan_annual_interest_rate NUMERIC(8,4);`);
  await query(`ALTER TABLE planned_transactions ADD COLUMN IF NOT EXISTS loan_term_months INTEGER;`);
  await query(`ALTER TABLE planned_transactions ADD COLUMN IF NOT EXISTS loan_start_date DATE;`);
  await query(`ALTER TABLE planned_transactions ADD COLUMN IF NOT EXISTS loan_payment_day INTEGER;`);
  await query(`ALTER TABLE planned_transactions ADD COLUMN IF NOT EXISTS loan_regular_payment_amount NUMERIC(15,2);`);
  await query(`ALTER TABLE planned_transactions ADD COLUMN IF NOT EXISTS loan_first_payment_date DATE;`);
  await safeIndex('idx_pt_planned_date', 'planned_transactions', 'planned_date');
  await safeIndex('idx_pt_bank_account', 'planned_transactions', 'bank_account');
  await safeIndex('idx_pt_recipient_id', 'planned_transactions', 'recipient_id');
  await safeIndex('idx_pt_category_id', 'planned_transactions', 'category_id');
  await safeIndex('idx_pt_is_active', 'planned_transactions', 'is_active');
  await safeIndex('idx_pt_is_executed', 'planned_transactions', 'is_executed');
  await safeIndex('idx_pt_is_recurring', 'planned_transactions', 'is_recurring');
  await safeIndex('idx_pt_is_loan', 'planned_transactions', 'is_loan');
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
  // Support reverse lookup: find the planned execution(s) for a given executed transaction
  await safeIndex('idx_pte_executed_tx_id', 'planned_transaction_executions', 'executed_transaction_id');
}

async function createPlannedTransactionLoanSchedule() {
  await query(`
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
  `);
  await safeIndex('idx_ptls_planned_transaction_id', 'planned_transaction_loan_schedule', 'planned_transaction_id');
  await safeIndex('idx_ptls_due_date', 'planned_transaction_loan_schedule', 'due_date');
  await safeTrigger('update_ptls_updated_at', 'planned_transaction_loan_schedule');
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

async function createSABBRaw() {
  await query(`
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
  `);
  await safeIndex('idx_sabb_hash', 'sabb_raw_transactions', 'deduplication_hash');
  await safeIndex('idx_sabb_date', 'sabb_raw_transactions', 'transaction_date');
}

async function createWiseRaw() {
  await query(`
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
  `);
  await safeIndex('idx_wise_hash', 'wise_raw_transactions', 'deduplication_hash');
  await safeIndex('idx_wise_finished_on', 'wise_raw_transactions', 'finished_on');
  await safeIndex('idx_wise_transfer_id', 'wise_raw_transactions', 'transfer_id');
}

async function createVisionRaw() {
  await query(`
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
  `);
  await safeIndex('idx_vision_hash', 'vision_raw_transactions', 'deduplication_hash');
  await safeIndex('idx_vision_date', 'vision_raw_transactions', 'transaction_date');
  await safeIndex('idx_vision_bank_account', 'vision_raw_transactions', 'bank_account');
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
  // Index the transaction_id column to speed joins/lookups; consider converting to a FK if referential integrity is desired
  await safeIndex('idx_manual_transaction_id', 'manual_raw_transactions', 'transaction_id');
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

async function createBelgianInflationRates() {
  await query(`
    CREATE TABLE IF NOT EXISTS belgian_inflation_rates (
      id SERIAL PRIMARY KEY,
      month_date DATE NOT NULL UNIQUE,
      monthly_rate NUMERIC(10,8) NOT NULL,
      source VARCHAR(50) NOT NULL DEFAULT 'statbel',
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );
  `);
  await safeIndex('idx_belgian_inflation_month_date', 'belgian_inflation_rates', 'month_date');
  await safeTrigger('update_belgian_inflation_updated_at', 'belgian_inflation_rates');
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
  `);
  await query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'investments'
          AND n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
      ) THEN
        ALTER TABLE investments ADD COLUMN IF NOT EXISTS price_provider_latest_url VARCHAR(500);
        ALTER TABLE investments ADD COLUMN IF NOT EXISTS price_provider_latest_path VARCHAR(300);
        ALTER TABLE investments ADD COLUMN IF NOT EXISTS price_provider_history_url VARCHAR(500);
        ALTER TABLE investments ADD COLUMN IF NOT EXISTS price_provider_history_path VARCHAR(300);
        ALTER TABLE investments ADD COLUMN IF NOT EXISTS price_provider_history_ts_path VARCHAR(300);
        ALTER TABLE investments ADD COLUMN IF NOT EXISTS price_provider_history_price_path VARCHAR(300);
      END IF;

      IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'investments_base'
          AND n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
      ) THEN
        ALTER TABLE investments_base ADD COLUMN IF NOT EXISTS price_provider_latest_url VARCHAR(500);
        ALTER TABLE investments_base ADD COLUMN IF NOT EXISTS price_provider_latest_path VARCHAR(300);
        ALTER TABLE investments_base ADD COLUMN IF NOT EXISTS price_provider_history_url VARCHAR(500);
        ALTER TABLE investments_base ADD COLUMN IF NOT EXISTS price_provider_history_path VARCHAR(300);
        ALTER TABLE investments_base ADD COLUMN IF NOT EXISTS price_provider_history_ts_path VARCHAR(300);
        ALTER TABLE investments_base ADD COLUMN IF NOT EXISTS price_provider_history_price_path VARCHAR(300);
      END IF;
    END $$;
  `);
  await safeIndex('idx_investments_asset_class', 'investments', 'asset_class');
  await safeIndex('idx_investments_is_active', 'investments', 'is_active');
  await safeTrigger('update_investments_updated_at', 'investments');
}

async function createAssetPriceHistory() {
  await query(`
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
  `);
  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_asset_price_history_investment'
          AND conrelid = 'asset_price_history'::regclass
      ) THEN
        ALTER TABLE asset_price_history
          DROP CONSTRAINT fk_asset_price_history_investment;
      END IF;
    END $$;
  `);
  await safeIndex('idx_asset_price_history_investment_date', 'asset_price_history', 'investment_id, price_date');
  await safeIndex('idx_asset_price_history_date', 'asset_price_history', 'price_date');
  await safeTrigger('update_asset_price_history_updated_at', 'asset_price_history');
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
      fx_rate_to_eur NUMERIC(20,10),
      note TEXT,
      is_recurring BOOLEAN NOT NULL DEFAULT false,
      recurrence_interval recurrence_interval,
      recurrence_end_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'portfolio_transactions'
          AND n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
      ) THEN
        ALTER TABLE portfolio_transactions ADD COLUMN IF NOT EXISTS fx_rate_to_eur NUMERIC(20,10);
      END IF;
    END $$;
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

async function createSavedCharts() {
  // Create table using integer[] for category_ids by default for new DBs.
  await query(`
    CREATE TABLE IF NOT EXISTS saved_charts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      chart_type TEXT NOT NULL DEFAULT 'line',
      category_ids INTEGER[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // If an existing DB had category_ids as JSONB (legacy), migrate safely to integer[]
  await query(`
    DO $$ BEGIN
      IF EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'saved_charts' AND column_name = 'category_ids' AND data_type = 'jsonb'
      ) THEN
        -- add a temporary integer[] column
        ALTER TABLE saved_charts ADD COLUMN IF NOT EXISTS category_ids_tmp INTEGER[] DEFAULT '{}';

        -- populate converting jsonb array elements to integers; coalesce to empty array when absent
        UPDATE saved_charts SET category_ids_tmp = COALESCE((
          SELECT array_agg((e)::text::integer) FROM jsonb_array_elements(category_ids) e
        ), ARRAY[]::integer[]);

        -- drop old jsonb column and rename tmp
        ALTER TABLE saved_charts DROP COLUMN category_ids;
        ALTER TABLE saved_charts RENAME COLUMN category_ids_tmp TO category_ids;
      END IF;
    END $$;
  `);

  await safeTrigger('update_saved_charts_updated_at', 'saved_charts');
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Create a B-tree index if it doesn't already exist.
 */
async function safeIndex(name, table, columns) {
  await query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = '${table}'
          AND n.nspname = 'public'
          AND c.relkind = 'r'
      ) THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${columns})';
      END IF;
    END $$;
  `);
}

/**
 * Create a GIN index if it doesn't already exist (used for trigram/full-text search).
 */
async function safeGinIndex(name, table, expression) {
  await query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = '${table}'
          AND n.nspname = 'public'
          AND c.relkind = 'r'
      ) THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS ${name} ON ${table} USING GIN (${expression})';
      END IF;
    END $$;
  `);
}

/**
 * Create an updated_at trigger if it doesn't already exist.
 */
async function safeTrigger(name, table) {
  await query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = '${table}'
          AND n.nspname = 'public'
          AND c.relkind = 'r'
      ) AND NOT EXISTS (
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
