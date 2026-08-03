/**
 * Backup Coverage Registry
 *
 * Single source of truth for every persistence surface that the Vision
 * backup system must capture.  Imported by:
 *   - packaging/electron/backup/bundle.js  (runtime assertion before dump)
 *   - apps/node-backend/tests/backup-coverage.test.js (CI enforcement)
 *
 * ADDING A TABLE? Add it here first, then update the backup bundle logic.
 * The coverage test will fail in CI until both are done.
 */

/**
 * All Postgres tables that exist in the current schema and must be included
 * in every backup.  Sorted alphabetically for easy diffing.
 *
 * Derived from alembic/versions/ — compute as:
 *   all CREATE TABLE ... across all upgrade() blocks
 *   minus all DROP TABLE ... across all upgrade() blocks
 *   minus Alembic internals (alembic_version)
 *
 * Last verified against: 0080_drop_agg_recipient_totals
 */
export const BACKUP_COVERED_TABLES = Object.freeze([
  'accounts',
  'agg_split_outstanding',
  'ai_conversations',
  'ai_messages',
  'asset_price_history',
  'attachments',
  'belfius_raw_transactions',
  'belgian_inflation_rates',
  'cashflow_forecast_accuracy',
  'cashflow_forecast_mc',
  'cashflow_forecast_mc_rolling',
  'categories',
  'custom_parser_configs',
  'custom_raw_transactions',
  'db_editor_audit',
  'exchange_rates',
  'import_batches',
  'import_staging_rows',
  'instrument_provider_map',
  'investment_ticker_prefs',
  'investments',
  'kbc_raw_transactions',
  'manual_raw_transactions',
  'planned_transaction_executions',
  'planned_transaction_loan_schedule',
  'planned_transaction_tags',
  'planned_transactions',
  'portfolio_import_batches',
  'portfolio_import_staging_rows',
  'portfolio_performance_snapshots',
  'portfolio_snapshot_accounts',
  'portfolio_transactions',
  'provider_api_keys',
  'provider_health',
  'provider_quota',
  'recipient_bank_accounts',
  'recipient_match_patterns',
  'recipients',
  'revolut_raw_transactions',
  'sabb_raw_transactions',
  'saved_charts',
  'split_audit',
  'split_payments',
  'tags',
  'transaction_raw_references',
  'transaction_splits',
  'transaction_tags',
  'transactions',
  'transfer_dismissals',
  'user_settings',
  'vision_raw_transactions',
  'watchlist',
  'wise_raw_transactions',
]);

/**
 * Tables intentionally excluded from backup coverage.
 * Document the reason so reviewers understand each omission.
 */
export const BACKUP_EXCLUDED_TABLES = Object.freeze({
  alembic_version: 'Alembic internal — schema version is re-derived on restore via alembic upgrade head',
  agg_shadow_divergences: 'Dropped in migration 0009 — no longer exists in current schema',
  feature_flags: 'Dropped in migration 0011 — no longer exists in current schema',
  bank_statements: 'Dropped in migration 0014 — bank reconciliation feature was removed',
  reconciliation_entries: 'Dropped in migration 0014 — bank reconciliation feature was removed',
  investments_flat:
    'Transient name inside migration 0087 (ADR-109 conversion) — renamed to `investments` before the migration commits, so no table of this name exists at head',
  portfolio_transactions_flat:
    'Transient name inside migration 0087 (ADR-109 conversion) — renamed to `portfolio_transactions` before the migration commits, so no table of this name exists at head',
});
