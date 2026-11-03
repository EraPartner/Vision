-- 0001_baseline: the Vision database schema for SQLite (ADR-263).
--
-- This is the SQLite translation of the PostgreSQL 2.0.0 schema: the former
-- PostgreSQL baseline with migrations 0002_remove_cloud_ai,
-- 0003_remove_life_scenarios, 0004_remove_audit_history and
-- 0005_simplify_portfolio_reconciliation applied. It creates every table,
-- index, view and trigger, the two tables the materialized views became, and
-- the reference rows. Applied migrations are never edited; add a new numbered
-- migration instead.
--
-- Conventions: docs/reference/sqlite-sql-dialect.md (storage types, CHECK
-- constraints, functions). Every connection must register the functions of
-- apps/node-backend/src/database/sqlite/functions.ts and
-- apps/node-backend/src/database/sqlite/schemaFunctions.ts before it writes.
-- SQL here runs on SQLite 3.39.
--
-- Translation of the PostgreSQL schema:
--   * Types follow the dialect page. Each stored type has a column CHECK named
--     <table>_<column>__vtype; column CHECKs run before table CHECKs.
--   * Constraint and index names are the PostgreSQL names, because services
--     read err.constraint. UNIQUE constraints are named unique indexes. Table
--     CHECKs are listed in name order, the order PostgreSQL evaluates them in.
--   * serial keys are INTEGER PRIMARY KEY AUTOINCREMENT. bigint keys draw from
--     vision_sequences through nextval(); portfolio_transactions,
--     portfolio_asset_adjustments and portfolio_asset_transfers share
--     portfolio_transactions_id_seq, as in PostgreSQL. An integer key that a
--     caller supplies is declared INT, so it does not alias the rowid and a
--     NULL key is refused.
--   * Not carried over: the extensions (pg_stat_statements, pg_trgm,
--     pgcrypto), the four GIN indexes (idx_recipients_name_trgm,
--     idx_transactions_comment_trgm, idx_transactions_memo_trgm and
--     idx_ai_research_passages_search; SQLite scans instead), the generated
--     column ai_research_passages.search_vector (search calls
--     vision_fts_match), the Kysely migrator tables kysely_migration and
--     kysely_migration_lock (the runner keeps vision_migrations), and
--     security_barrier view options.
--   * mv_monthly_summary and mv_category_totals were materialized views
--     created at runtime; they are ordinary tables that
--     materializedViewService refreshes.
--   * Triggers: see the Triggers section.

-- ============================================================================
-- Sequences
-- ============================================================================
-- bigint keys: nextval(name) advances last_value on the writer connection, inside
-- the current transaction. PostgreSQL's setval(..., 1, false) is last_value 0.

CREATE TABLE vision_sequences (
  name TEXT PRIMARY KEY NOT NULL,
  last_value INTEGER NOT NULL
);

INSERT INTO vision_sequences (name, last_value) VALUES ('attachments_id_seq', 0);
INSERT INTO vision_sequences (name, last_value) VALUES ('import_batches_id_seq', 0);
INSERT INTO vision_sequences (name, last_value) VALUES ('import_staging_rows_id_seq', 0);
INSERT INTO vision_sequences (name, last_value) VALUES ('insight_dismissals_id_seq', 0);
INSERT INTO vision_sequences (name, last_value) VALUES ('portfolio_import_batches_id_seq', 0);
INSERT INTO vision_sequences (name, last_value) VALUES ('portfolio_import_duplicate_repair_journal_id_seq', 0);
INSERT INTO vision_sequences (name, last_value) VALUES ('portfolio_import_income_recognition_journal_id_seq', 0);
INSERT INTO vision_sequences (name, last_value) VALUES ('portfolio_import_reconciliation_journal_id_seq', 0);
INSERT INTO vision_sequences (name, last_value) VALUES ('portfolio_import_staging_rows_id_seq', 0);
INSERT INTO vision_sequences (name, last_value) VALUES ('portfolio_transactions_id_seq', 0);
INSERT INTO vision_sequences (name, last_value) VALUES ('transaction_source_links_id_seq', 0);
INSERT INTO vision_sequences (name, last_value) VALUES ('transaction_source_records_id_seq', 0);

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE account_statement_balances (
  account_id INTEGER NOT NULL,
  currency TEXT NOT NULL
    CONSTRAINT account_statement_balances_currency__vtype CHECK (length(currency) <= 3),
  balance DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT account_statement_balances_balance__vtype CHECK (vision_numeric_ok(balance, 18, 4)),
  balance_date DATE_TEXT NOT NULL
    CONSTRAINT account_statement_balances_balance_date__vtype CHECK (vision_date_ok(balance_date)),
  CONSTRAINT pk_account_statement_balances PRIMARY KEY (account_id, currency),
  CONSTRAINT chk_account_statement_balances_currency_iso CHECK (currency REGEXP '^[A-Z]{3}$'),
  CONSTRAINT fk_account_statement_balances_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE accounts (
  id INTEGER CONSTRAINT accounts_pkey PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  display_name TEXT,
  institution TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR'
    CONSTRAINT accounts_currency__vtype CHECK (length(currency) <= 3),
  type TEXT NOT NULL DEFAULT 'checking'
    CONSTRAINT accounts_type__vtype CHECK (type IN ('checking', 'savings', 'brokerage', 'crypto_exchange', 'wallet', 'pension', 'liability')),
  liquidity_class TEXT NOT NULL DEFAULT 'liquid'
    CONSTRAINT accounts_liquidity_class__vtype CHECK (liquidity_class IN ('liquid', 'semi_liquid', 'illiquid')),
  spendable BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT accounts_spendable__vtype CHECK (spendable IN (0, 1)),
  in_net_worth BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT accounts_in_net_worth__vtype CHECK (in_net_worth IN (0, 1)),
  tax_wrapper TEXT NOT NULL DEFAULT 'none'
    CONSTRAINT accounts_tax_wrapper__vtype CHECK (tax_wrapper IN ('none', 'pension', 'tax_advantaged')),
  owner TEXT NOT NULL DEFAULT 'me'
    CONSTRAINT accounts_owner__vtype CHECK (owner IN ('me', 'partner', 'joint')),
  multi_currency_cash BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT accounts_multi_currency_cash__vtype CHECK (multi_currency_cash IN (0, 1)),
  has_cash_sleeve BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT accounts_has_cash_sleeve__vtype CHECK (has_cash_sleeve IN (0, 1)),
  funding_account_id INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT accounts_is_active__vtype CHECK (is_active IN (0, 1)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT accounts_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT accounts_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  closed_at TIMESTAMPTZ_TEXT
    CONSTRAINT accounts_closed_at__vtype CHECK (vision_ts_ok(closed_at)),
  import_identity UUID_TEXT NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT accounts_import_identity__vtype CHECK (vision_uuid_ok(import_identity)),
  CONSTRAINT chk_accounts_active_not_closed CHECK ((is_active = 0) OR (closed_at IS NULL)),
  CONSTRAINT chk_accounts_currency_iso CHECK (currency REGEXP '^[A-Z]{3}$'),
  CONSTRAINT accounts_funding_account_id_fkey FOREIGN KEY (funding_account_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE adr109_legacy_cleanup_marker (
  singleton BOOLEAN CONSTRAINT adr109_legacy_cleanup_marker_pkey PRIMARY KEY NOT NULL DEFAULT 1
    CONSTRAINT adr109_legacy_cleanup_marker_singleton__vtype CHECK (singleton IN (0, 1)),
  completed_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT adr109_legacy_cleanup_marker_completed_at__vtype CHECK (vision_ts_ok(completed_at)),
  CONSTRAINT adr109_legacy_cleanup_marker_singleton_check CHECK (singleton)
);

CREATE TABLE agg_split_outstanding (
  split_id INT CONSTRAINT agg_split_outstanding_pkey PRIMARY KEY NOT NULL,
  recipient_id INTEGER NOT NULL,
  original_amount DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT agg_split_outstanding_original_amount__vtype CHECK (vision_numeric_ok(original_amount, 18, 4)),
  paid_amount DECIMAL_TEXT(18,4) NOT NULL DEFAULT '0.0000'
    CONSTRAINT agg_split_outstanding_paid_amount__vtype CHECK (vision_numeric_ok(paid_amount, 18, 4)),
  outstanding_amount DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT agg_split_outstanding_outstanding_amount__vtype CHECK (vision_numeric_ok(outstanding_amount, 18, 4)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT agg_split_outstanding_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT agg_split_outstanding_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES recipients(id) ON DELETE CASCADE,
  CONSTRAINT agg_split_outstanding_split_id_fkey FOREIGN KEY (split_id) REFERENCES transaction_splits(id) ON DELETE CASCADE
);

CREATE TABLE ai_conversations (
  id UUID_TEXT CONSTRAINT ai_conversations_pkey PRIMARY KEY NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT ai_conversations_id__vtype CHECK (vision_uuid_ok(id)),
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT ai_conversations_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT ai_conversations_updated_at__vtype CHECK (vision_ts_ok(updated_at))
);

CREATE TABLE ai_investigation_jobs (
  id UUID_TEXT CONSTRAINT ai_investigation_jobs_pkey PRIMARY KEY NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT ai_investigation_jobs_id__vtype CHECK (vision_uuid_ok(id)),
  conversation_id UUID_TEXT
    CONSTRAINT ai_investigation_jobs_conversation_id__vtype CHECK (vision_uuid_ok(conversation_id)),
  question TEXT NOT NULL,
  route TEXT NOT NULL,
  model TEXT,
  depth TEXT NOT NULL,
  language TEXT NOT NULL,
  state TEXT NOT NULL,
  scope_json JSONB_TEXT NOT NULL
    CONSTRAINT ai_investigation_jobs_scope_json__vtype CHECK (vision_jsonb_ok(scope_json)),
  plan_json JSONB_TEXT
    CONSTRAINT ai_investigation_jobs_plan_json__vtype CHECK (vision_jsonb_ok(plan_json)),
  checkpoint_json JSONB_TEXT NOT NULL DEFAULT '{}'
    CONSTRAINT ai_investigation_jobs_checkpoint_json__vtype CHECK (vision_jsonb_ok(checkpoint_json)),
  result_json JSONB_TEXT
    CONSTRAINT ai_investigation_jobs_result_json__vtype CHECK (vision_jsonb_ok(result_json)),
  error_json JSONB_TEXT
    CONSTRAINT ai_investigation_jobs_error_json__vtype CHECK (vision_jsonb_ok(error_json)),
  cancel_requested_at TIMESTAMPTZ_TEXT
    CONSTRAINT ai_investigation_jobs_cancel_requested_at__vtype CHECK (vision_ts_ok(cancel_requested_at)),
  started_at TIMESTAMPTZ_TEXT
    CONSTRAINT ai_investigation_jobs_started_at__vtype CHECK (vision_ts_ok(started_at)),
  completed_at TIMESTAMPTZ_TEXT
    CONSTRAINT ai_investigation_jobs_completed_at__vtype CHECK (vision_ts_ok(completed_at)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT ai_investigation_jobs_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT ai_investigation_jobs_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT ai_investigation_jobs_depth_check CHECK (depth IN ('quick', 'detailed')),
  CONSTRAINT ai_investigation_jobs_language_check CHECK (language IN ('en', 'nl')),
  CONSTRAINT ai_investigation_jobs_question_check CHECK ((length(question) >= 1) AND (length(question) <= 8000)),
  CONSTRAINT ai_investigation_jobs_route_check CHECK (route = 'local'),
  CONSTRAINT ai_investigation_jobs_state_check CHECK (state IN ('queued', 'running', 'waiting', 'partial', 'completed', 'failed', 'cancelled')),
  CONSTRAINT ai_investigation_jobs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE SET NULL
);

CREATE TABLE ai_investigation_steps (
  job_id UUID_TEXT NOT NULL
    CONSTRAINT ai_investigation_steps_job_id__vtype CHECK (vision_uuid_ok(job_id)),
  step_id TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  result_json JSONB_TEXT
    CONSTRAINT ai_investigation_steps_result_json__vtype CHECK (vision_jsonb_ok(result_json)),
  error_json JSONB_TEXT
    CONSTRAINT ai_investigation_steps_error_json__vtype CHECK (vision_jsonb_ok(error_json)),
  started_at TIMESTAMPTZ_TEXT
    CONSTRAINT ai_investigation_steps_started_at__vtype CHECK (vision_ts_ok(started_at)),
  completed_at TIMESTAMPTZ_TEXT
    CONSTRAINT ai_investigation_steps_completed_at__vtype CHECK (vision_ts_ok(completed_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT ai_investigation_steps_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT ai_investigation_steps_pkey PRIMARY KEY (job_id, step_id),
  CONSTRAINT ai_investigation_steps_attempt_check CHECK (attempt >= 0),
  CONSTRAINT ai_investigation_steps_state_check CHECK (state IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  CONSTRAINT ai_investigation_steps_step_id_check CHECK ((length(step_id) >= 1) AND (length(step_id) <= 64)),
  CONSTRAINT ai_investigation_steps_job_id_fkey FOREIGN KEY (job_id) REFERENCES ai_investigation_jobs(id) ON DELETE CASCADE
);

CREATE TABLE ai_messages (
  id UUID_TEXT CONSTRAINT ai_messages_pkey PRIMARY KEY NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT ai_messages_id__vtype CHECK (vision_uuid_ok(id)),
  conversation_id UUID_TEXT NOT NULL
    CONSTRAINT ai_messages_conversation_id__vtype CHECK (vision_uuid_ok(conversation_id)),
  role TEXT NOT NULL,
  content TEXT,
  tool_name TEXT,
  tool_args JSONB_TEXT
    CONSTRAINT ai_messages_tool_args__vtype CHECK (vision_jsonb_ok(tool_args)),
  tool_result JSONB_TEXT
    CONSTRAINT ai_messages_tool_result__vtype CHECK (vision_jsonb_ok(tool_result)),
  status TEXT NOT NULL DEFAULT 'complete',
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT ai_messages_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT chk_ai_messages_role CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  CONSTRAINT chk_ai_messages_status CHECK (status IN ('complete', 'streaming', 'aborted', 'error')),
  CONSTRAINT ai_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);

CREATE TABLE ai_research_documents (
  id UUID_TEXT CONSTRAINT ai_research_documents_pkey PRIMARY KEY NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT ai_research_documents_id__vtype CHECK (vision_uuid_ok(id)),
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  extraction_status TEXT NOT NULL,
  extraction_error TEXT,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT ai_research_documents_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT ai_research_documents_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT ai_research_documents_content_sha256_check CHECK (content_sha256 REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT ai_research_documents_extraction_status_check CHECK (extraction_status IN ('ready', 'failed', 'unsupported')),
  CONSTRAINT ai_research_documents_source_name_check CHECK ((length(source_name) >= 1) AND (length(source_name) <= 500)),
  CONSTRAINT ai_research_documents_title_check CHECK ((length(title) >= 1) AND (length(title) <= 300)),
  CONSTRAINT ai_research_documents_version_check CHECK (version > 0)
);

-- search_vector (a generated tsvector) is not stored: search calls
-- vision_fts_match(coalesce(section, '') || ' ' || content, query).
CREATE TABLE ai_research_passages (
  id UUID_TEXT CONSTRAINT ai_research_passages_pkey PRIMARY KEY NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT ai_research_passages_id__vtype CHECK (vision_uuid_ok(id)),
  document_id UUID_TEXT NOT NULL
    CONSTRAINT ai_research_passages_document_id__vtype CHECK (vision_uuid_ok(document_id)),
  ordinal INTEGER NOT NULL,
  page_number INTEGER,
  section TEXT,
  content TEXT NOT NULL,
  embedding_json JSONB_TEXT
    CONSTRAINT ai_research_passages_embedding_json__vtype CHECK (vision_jsonb_ok(embedding_json)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT ai_research_passages_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT ai_research_passages_content_check CHECK ((length(content) >= 1) AND (length(content) <= 12000)),
  CONSTRAINT ai_research_passages_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT ai_research_passages_page_number_check CHECK (page_number > 0),
  CONSTRAINT ai_research_passages_document_id_fkey FOREIGN KEY (document_id) REFERENCES ai_research_documents(id) ON DELETE CASCADE
);

CREATE TABLE analysis_monitor_notifications (
  id UUID_TEXT CONSTRAINT analysis_monitor_notifications_pkey PRIMARY KEY NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT analysis_monitor_notifications_id__vtype CHECK (vision_uuid_ok(id)),
  monitor_id UUID_TEXT NOT NULL
    CONSTRAINT analysis_monitor_notifications_monitor_id__vtype CHECK (vision_uuid_ok(monitor_id)),
  observation_id UUID_TEXT NOT NULL
    CONSTRAINT analysis_monitor_notifications_observation_id__vtype CHECK (vision_uuid_ok(observation_id)),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  previous_value TEXT,
  current_value TEXT,
  episode_key TEXT NOT NULL,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT analysis_monitor_notifications_created_at__vtype CHECK (vision_ts_ok(created_at)),
  read_at TIMESTAMPTZ_TEXT
    CONSTRAINT analysis_monitor_notifications_read_at__vtype CHECK (vision_ts_ok(read_at)),
  CONSTRAINT analysis_monitor_notifications_kind_check CHECK (kind IN ('analysis-threshold', 'dossier-evidence')),
  CONSTRAINT analysis_monitor_notifications_monitor_id_fkey FOREIGN KEY (monitor_id) REFERENCES analysis_monitors(id) ON DELETE CASCADE,
  CONSTRAINT analysis_monitor_notifications_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES analysis_monitor_observations(id) ON DELETE CASCADE
);

CREATE TABLE analysis_monitor_observations (
  id UUID_TEXT CONSTRAINT analysis_monitor_observations_pkey PRIMARY KEY NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT analysis_monitor_observations_id__vtype CHECK (vision_uuid_ok(id)),
  monitor_id UUID_TEXT NOT NULL
    CONSTRAINT analysis_monitor_observations_monitor_id__vtype CHECK (vision_uuid_ok(monitor_id)),
  status TEXT NOT NULL,
  previous_value TEXT,
  current_value TEXT,
  previous_evidence_version INTEGER,
  current_evidence_version INTEGER,
  evidence_hash TEXT,
  condition_revision INTEGER NOT NULL,
  analysis_definition_version INTEGER,
  analysis_run_id TEXT,
  historical_analysis_run_id TEXT,
  analysis_run_status TEXT,
  analysis_window_json JSONB_TEXT
    CONSTRAINT analysis_monitor_observations_analysis_window_json__vtype CHECK (vision_jsonb_ok(analysis_window_json)),
  coverage_json JSONB_TEXT NOT NULL DEFAULT '{"status": "unknown"}'
    CONSTRAINT analysis_monitor_observations_coverage_json__vtype CHECK (vision_jsonb_ok(coverage_json)),
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  checked_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT analysis_monitor_observations_checked_at__vtype CHECK (vision_ts_ok(checked_at)),
  CONSTRAINT analysis_monitor_observations_check CHECK (((status IN ('baseline', 'unchanged', 'triggered', 'cooldown-pending')) AND ((current_value IS NOT NULL) OR (evidence_hash IS NOT NULL))) OR (status IN ('partial', 'stale', 'failed'))),
  CONSTRAINT analysis_monitor_observations_condition_revision_check CHECK (condition_revision > 0),
  CONSTRAINT analysis_monitor_observations_coverage_json_check CHECK (json_type(coverage_json) = 'object'),
  CONSTRAINT analysis_monitor_observations_reason_check CHECK ((length(reason) >= 1) AND (length(reason) <= 1000)),
  CONSTRAINT analysis_monitor_observations_status_check CHECK (status IN ('baseline', 'unchanged', 'triggered', 'cooldown-pending', 'partial', 'stale', 'failed')),
  CONSTRAINT analysis_monitor_observations_analysis_run_id_fkey FOREIGN KEY (analysis_run_id) REFERENCES saved_analysis_runs(id) ON DELETE SET NULL,
  CONSTRAINT analysis_monitor_observations_monitor_id_fkey FOREIGN KEY (monitor_id) REFERENCES analysis_monitors(id) ON DELETE CASCADE
);

CREATE TABLE analysis_monitors (
  id UUID_TEXT CONSTRAINT analysis_monitors_pkey PRIMARY KEY NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT analysis_monitors_id__vtype CHECK (vision_uuid_ok(id)),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT analysis_monitors_enabled__vtype CHECK (enabled IN (0, 1)),
  saved_analysis_id TEXT,
  dossier_id UUID_TEXT
    CONSTRAINT analysis_monitors_dossier_id__vtype CHECK (vision_uuid_ok(dossier_id)),
  historical_target_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  field_id TEXT,
  operator TEXT,
  threshold DECIMAL_TEXT
    CONSTRAINT analysis_monitors_threshold__vtype CHECK (vision_numeric_ok(threshold, NULL, NULL)),
  interval_minutes INTEGER NOT NULL DEFAULT 1440,
  cooldown_minutes INTEGER NOT NULL DEFAULT 1440,
  next_due_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT analysis_monitors_next_due_at__vtype CHECK (vision_ts_ok(next_due_at)),
  last_checked_at TIMESTAMPTZ_TEXT
    CONSTRAINT analysis_monitors_last_checked_at__vtype CHECK (vision_ts_ok(last_checked_at)),
  last_status TEXT,
  condition_revision INTEGER NOT NULL DEFAULT 1,
  active_episode_key UUID_TEXT
    CONSTRAINT analysis_monitors_active_episode_key__vtype CHECK (vision_uuid_ok(active_episode_key)),
  pending_signature TEXT,
  pending_since TIMESTAMPTZ_TEXT
    CONSTRAINT analysis_monitors_pending_since__vtype CHECK (vision_ts_ok(pending_since)),
  last_notified_at TIMESTAMPTZ_TEXT
    CONSTRAINT analysis_monitors_last_notified_at__vtype CHECK (vision_ts_ok(last_notified_at)),
  lease_token UUID_TEXT
    CONSTRAINT analysis_monitors_lease_token__vtype CHECK (vision_uuid_ok(lease_token)),
  lease_expires_at TIMESTAMPTZ_TEXT
    CONSTRAINT analysis_monitors_lease_expires_at__vtype CHECK (vision_ts_ok(lease_expires_at)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT analysis_monitors_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT analysis_monitors_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT analysis_monitors_check CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT analysis_monitors_check1 CHECK (((kind = 'analysis-threshold') AND (dossier_id IS NULL) AND (field_id IS NOT NULL) AND ((length(field_id) >= 1) AND (length(field_id) <= 100)) AND (operator IS NOT NULL) AND (threshold IS NOT NULL)) OR ((kind = 'dossier-evidence') AND (saved_analysis_id IS NULL) AND (field_id IS NULL) AND (operator IS NULL) AND (threshold IS NULL))),
  CONSTRAINT analysis_monitors_condition_revision_check CHECK (condition_revision > 0),
  CONSTRAINT analysis_monitors_cooldown_minutes_check CHECK ((cooldown_minutes >= 0) AND (cooldown_minutes <= 10080)),
  CONSTRAINT analysis_monitors_historical_target_id_check CHECK ((length(historical_target_id) >= 1) AND (length(historical_target_id) <= 100)),
  CONSTRAINT analysis_monitors_interval_minutes_check CHECK ((interval_minutes >= 15) AND (interval_minutes <= 10080)),
  CONSTRAINT analysis_monitors_kind_check CHECK (kind IN ('analysis-threshold', 'dossier-evidence')),
  CONSTRAINT analysis_monitors_operator_check CHECK (operator IN ('above', 'below')),
  CONSTRAINT analysis_monitors_target_label_check CHECK ((length(target_label) >= 1) AND (length(target_label) <= 300)),
  CONSTRAINT analysis_monitors_title_check CHECK ((length(title) >= 1) AND (length(title) <= 200)),
  CONSTRAINT analysis_monitors_dossier_id_fkey FOREIGN KEY (dossier_id) REFERENCES research_dossiers(id) ON DELETE SET NULL,
  CONSTRAINT analysis_monitors_saved_analysis_id_fkey FOREIGN KEY (saved_analysis_id) REFERENCES saved_analyses(id) ON DELETE SET NULL
);

CREATE TABLE asset_price_history (
  id INTEGER CONSTRAINT asset_price_history_pkey PRIMARY KEY AUTOINCREMENT,
  investment_id INTEGER NOT NULL,
  price_date DATE_TEXT NOT NULL
    CONSTRAINT asset_price_history_price_date__vtype CHECK (vision_date_ok(price_date)),
  close_price DECIMAL_TEXT(18,6) NOT NULL
    CONSTRAINT asset_price_history_close_price__vtype CHECK (vision_numeric_ok(close_price, 18, 6)),
  source TEXT NOT NULL DEFAULT 'provider'
    CONSTRAINT asset_price_history_source__vtype CHECK (length(source) <= 50),
  fetched_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT asset_price_history_fetched_at__vtype CHECK (vision_ts_ok(fetched_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT asset_price_history_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT fk_aph_investment FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
);

CREATE TABLE attachments (
  id BIGINT CONSTRAINT attachments_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('attachments_id_seq')),
  transaction_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT attachments_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT attachments_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE TABLE belgian_inflation_rates (
  id INTEGER CONSTRAINT belgian_inflation_rates_pkey PRIMARY KEY AUTOINCREMENT,
  month_date DATE_TEXT NOT NULL
    CONSTRAINT belgian_inflation_rates_month_date__vtype CHECK (vision_date_ok(month_date)),
  monthly_rate DECIMAL_TEXT(10,8) NOT NULL
    CONSTRAINT belgian_inflation_rates_monthly_rate__vtype CHECK (vision_numeric_ok(monthly_rate, 10, 8)),
  source TEXT NOT NULL DEFAULT 'statbel'
    CONSTRAINT belgian_inflation_rates_source__vtype CHECK (length(source) <= 50),
  fetched_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT belgian_inflation_rates_fetched_at__vtype CHECK (vision_ts_ok(fetched_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT belgian_inflation_rates_updated_at__vtype CHECK (vision_ts_ok(updated_at))
);

CREATE TABLE cashflow_forecast_accuracy (
  id INTEGER CONSTRAINT cashflow_forecast_accuracy_pkey PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  method_id TEXT NOT NULL,
  as_of_month DATE_TEXT NOT NULL
    CONSTRAINT cashflow_forecast_accuracy_as_of_month__vtype CHECK (vision_date_ok(as_of_month)),
  mae REAL,
  rmse REAL,
  mape REAL,
  sample_days INTEGER,
  recorded_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT cashflow_forecast_accuracy_recorded_at__vtype CHECK (vision_ts_ok(recorded_at))
);

CREATE TABLE cashflow_forecast_mc (
  id INTEGER CONSTRAINT cashflow_forecast_mc_pkey PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  month DATE_TEXT NOT NULL
    CONSTRAINT cashflow_forecast_mc_month__vtype CHECK (vision_date_ok(month)),
  filter_hash TEXT NOT NULL,
  mc_paths INTEGER NOT NULL DEFAULT 1000,
  payload JSONB_TEXT NOT NULL
    CONSTRAINT cashflow_forecast_mc_payload__vtype CHECK (vision_jsonb_ok(payload)),
  computed_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT cashflow_forecast_mc_computed_at__vtype CHECK (vision_ts_ok(computed_at))
);

CREATE TABLE cashflow_forecast_mc_rolling (
  id INTEGER CONSTRAINT cashflow_forecast_mc_rolling_pkey PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'anonymous',
  today_iso DATE_TEXT NOT NULL
    CONSTRAINT cashflow_forecast_mc_rolling_today_iso__vtype CHECK (vision_date_ok(today_iso)),
  days_back INTEGER NOT NULL,
  days_forward INTEGER NOT NULL,
  filter_hash TEXT NOT NULL,
  mc_paths INTEGER NOT NULL DEFAULT 1000,
  payload JSONB_TEXT NOT NULL
    CONSTRAINT cashflow_forecast_mc_rolling_payload__vtype CHECK (vision_jsonb_ok(payload)),
  computed_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT cashflow_forecast_mc_rolling_computed_at__vtype CHECK (vision_ts_ok(computed_at))
);

CREATE TABLE categories (
  id INTEGER CONSTRAINT categories_pkey PRIMARY KEY AUTOINCREMENT,
  general TEXT NOT NULL,
  detail TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT categories_is_active__vtype CHECK (is_active IN (0, 1)),
  created_at TIMESTAMPTZ_TEXT DEFAULT (now())
    CONSTRAINT categories_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT categories_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  parent_id INTEGER,
  name TEXT NOT NULL DEFAULT '__LEGACY_NAME_PENDING__',
  hierarchy_only BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT categories_hierarchy_only__vtype CHECK (hierarchy_only IN (0, 1)),
  legacy_compatible BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT categories_legacy_compatible__vtype CHECK (legacy_compatible IN (0, 1)),
  path_name TEXT NOT NULL DEFAULT '',
  CONSTRAINT ck_categories_hierarchy_only_not_legacy CHECK ((NOT hierarchy_only) OR (NOT legacy_compatible)),
  CONSTRAINT ck_categories_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT ck_categories_not_self_parent CHECK (parent_id IS NOT id),
  CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE RESTRICT
);

CREATE TABLE category_merge_aliases (
  general TEXT NOT NULL,
  detail TEXT NOT NULL,
  target_category_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT category_merge_aliases_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT category_merge_aliases_pkey PRIMARY KEY (general, detail),
  CONSTRAINT category_merge_aliases_target_category_id_fkey FOREIGN KEY (target_category_id) REFERENCES categories(id) ON DELETE RESTRICT
);

CREATE TABLE category_root_aliases (
  general TEXT CONSTRAINT category_root_aliases_pkey PRIMARY KEY NOT NULL,
  target_category_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT category_root_aliases_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT category_root_aliases_target_category_id_fkey FOREIGN KEY (target_category_id) REFERENCES categories(id) ON DELETE RESTRICT
);

CREATE TABLE custom_parser_configs (
  id INTEGER CONSTRAINT custom_parser_configs_pkey PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  config_json JSONB_TEXT NOT NULL
    CONSTRAINT custom_parser_configs_config_json__vtype CHECK (vision_jsonb_ok(config_json)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT custom_parser_configs_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT custom_parser_configs_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  kind TEXT NOT NULL DEFAULT 'transaction',
  CONSTRAINT chk_custom_parser_configs_kind CHECK (kind IN ('transaction', 'portfolio'))
);

CREATE TABLE exchange_rates (
  id INTEGER CONSTRAINT exchange_rates_pkey PRIMARY KEY AUTOINCREMENT,
  currency_code TEXT NOT NULL
    CONSTRAINT exchange_rates_currency_code__vtype CHECK (length(currency_code) <= 3),
  rate_to_eur DECIMAL_TEXT(20,10) NOT NULL
    CONSTRAINT exchange_rates_rate_to_eur__vtype CHECK (vision_numeric_ok(rate_to_eur, 20, 10)),
  rate_date DATE_TEXT NOT NULL
    CONSTRAINT exchange_rates_rate_date__vtype CHECK (vision_date_ok(rate_date)),
  is_latest BOOLEAN DEFAULT 0
    CONSTRAINT exchange_rates_is_latest__vtype CHECK (is_latest IN (0, 1)),
  fetched_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT exchange_rates_fetched_at__vtype CHECK (vision_ts_ok(fetched_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT exchange_rates_updated_at__vtype CHECK (vision_ts_ok(updated_at))
);

CREATE TABLE import_batches (
  id BIGINT CONSTRAINT import_batches_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('import_batches_id_seq')),
  adapter_name TEXT NOT NULL,
  source_filename TEXT,
  source_size_bytes BIGINT,
  custom_config JSONB_TEXT
    CONSTRAINT import_batches_custom_config__vtype CHECK (vision_jsonb_ok(custom_config)),
  status TEXT NOT NULL DEFAULT 'pending',
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  rows_duplicate INTEGER NOT NULL DEFAULT 0,
  rows_error INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  started_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT import_batches_started_at__vtype CHECK (vision_ts_ok(started_at)),
  completed_at TIMESTAMPTZ_TEXT
    CONSTRAINT import_batches_completed_at__vtype CHECK (vision_ts_ok(completed_at)),
  CONSTRAINT chk_import_batches_status CHECK (status IN ('pending', 'staging', 'validating', 'matching', 'committing', 'complete', 'failed', 'aborted', 'awaiting_review'))
);

CREATE TABLE import_staging_rows (
  id BIGINT CONSTRAINT import_staging_rows_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('import_staging_rows_id_seq')),
  batch_id BIGINT NOT NULL,
  row_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_date DATE_TEXT
    CONSTRAINT import_staging_rows_tx_date__vtype CHECK (vision_date_ok(tx_date)),
  bank_account TEXT,
  recipient_raw TEXT,
  memo TEXT,
  amount DECIMAL_TEXT(20,4)
    CONSTRAINT import_staging_rows_amount__vtype CHECK (vision_numeric_ok(amount, 20, 4)),
  currency TEXT,
  balance DECIMAL_TEXT(20,4)
    CONSTRAINT import_staging_rows_balance__vtype CHECK (vision_numeric_ok(balance, 20, 4)),
  recipient_account TEXT,
  recipient_address TEXT,
  recipient_bank_name TEXT,
  comment TEXT,
  raw_data TEXT,
  resolved_recipient_id INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT import_staging_rows_created_at__vtype CHECK (vision_ts_ok(created_at)),
  match_source TEXT,
  matched_pattern_id INTEGER,
  match_similarity REAL,
  user_override_recipient_id INTEGER,
  override_category_id INTEGER,
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT import_staging_rows_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  source_transaction_id TEXT,
  source_account_identity TEXT,
  dedup_occurrence INTEGER,
  source_record_hash TEXT
    CONSTRAINT import_staging_rows_source_record_hash__vtype CHECK (length(source_record_hash) <= 64),
  dedup_fingerprint TEXT
    CONSTRAINT import_staging_rows_dedup_fingerprint__vtype CHECK (length(dedup_fingerprint) <= 64),
  dedup_fingerprint_version INTEGER,
  bank_sequence DECIMAL_TEXT(18,0)
    CONSTRAINT import_staging_rows_bank_sequence__vtype CHECK (vision_numeric_ok(bank_sequence, 18, 0)),
  CONSTRAINT chk_import_staging_bank_sequence CHECK (dec_ge(bank_sequence, 0)),
  CONSTRAINT chk_import_staging_rows_dedup_fingerprint CHECK ((dedup_fingerprint IS NULL) OR (dedup_fingerprint REGEXP '^[0-9a-f]{64}$')),
  CONSTRAINT chk_import_staging_rows_dedup_occurrence CHECK ((dedup_occurrence IS NULL) OR (dedup_occurrence > 0)),
  CONSTRAINT chk_import_staging_rows_dedup_pair CHECK ((dedup_fingerprint IS NULL) = (dedup_fingerprint_version IS NULL)),
  CONSTRAINT chk_import_staging_rows_dedup_version CHECK ((dedup_fingerprint_version IS NULL) OR (dedup_fingerprint_version > 0)),
  CONSTRAINT chk_import_staging_rows_source_record_hash CHECK ((source_record_hash IS NULL) OR (source_record_hash REGEXP '^[0-9a-f]{64}$')),
  CONSTRAINT chk_import_staging_rows_status CHECK (status IN ('pending', 'validated', 'matched', 'committed', 'duplicate', 'error')),
  CONSTRAINT import_staging_rows_match_source_check CHECK (match_source IN ('exact', 'fuzzy', 'pattern', 'new')),
  CONSTRAINT fk_import_staging_rows_resolved_recipient FOREIGN KEY (resolved_recipient_id) REFERENCES recipients(id) ON DELETE SET NULL,
  CONSTRAINT import_staging_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE,
  CONSTRAINT import_staging_rows_matched_pattern_id_fkey FOREIGN KEY (matched_pattern_id) REFERENCES recipient_match_patterns(id) ON DELETE SET NULL,
  CONSTRAINT import_staging_rows_override_category_id_fkey FOREIGN KEY (override_category_id) REFERENCES categories(id) ON DELETE SET NULL,
  CONSTRAINT import_staging_rows_user_override_recipient_id_fkey FOREIGN KEY (user_override_recipient_id) REFERENCES recipients(id) ON DELETE SET NULL
);

CREATE TABLE insight_cash_projections (
  month_start DATE_TEXT NOT NULL
    CONSTRAINT insight_cash_projections_month_start__vtype CHECK (vision_date_ok(month_start)),
  currency TEXT NOT NULL
    CONSTRAINT insight_cash_projections_currency__vtype CHECK (length(currency) <= 3),
  method_id TEXT NOT NULL,
  month_end_net_cashflow DECIMAL_TEXT(20,4) NOT NULL
    CONSTRAINT insight_cash_projections_month_end_net_cashflow__vtype CHECK (vision_numeric_ok(month_end_net_cashflow, 20, 4)),
  observed_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT insight_cash_projections_observed_at__vtype CHECK (vision_ts_ok(observed_at)),
  CONSTRAINT insight_cash_projections_pkey PRIMARY KEY (month_start, currency, method_id),
  CONSTRAINT chk_insight_cash_projection_month CHECK (month_start = date_trunc('month', month_start))
);

CREATE TABLE insight_digest_state (
  singleton_id INT CONSTRAINT insight_digest_state_pkey PRIMARY KEY NOT NULL,
  undismissed_count INTEGER,
  dirty_version BIGINT NOT NULL DEFAULT 1,
  computed_version BIGINT NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ_TEXT
    CONSTRAINT insight_digest_state_computed_at__vtype CHECK (vision_ts_ok(computed_at)),
  expires_at TIMESTAMPTZ_TEXT
    CONSTRAINT insight_digest_state_expires_at__vtype CHECK (vision_ts_ok(expires_at)),
  CONSTRAINT chk_insight_digest_count CHECK ((undismissed_count IS NULL) OR (undismissed_count >= 0)),
  CONSTRAINT chk_insight_digest_singleton CHECK (singleton_id = 1)
);

CREATE TABLE insight_dismissals (
  id BIGINT CONSTRAINT insight_dismissals_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('insight_dismissals_id_seq')),
  kind TEXT NOT NULL,
  recipient_id INTEGER,
  category_id INTEGER,
  month_start DATE_TEXT
    CONSTRAINT insight_dismissals_month_start__vtype CHECK (vision_date_ok(month_start)),
  dismissed_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT insight_dismissals_dismissed_at__vtype CHECK (vision_ts_ok(dismissed_at)),
  deviation_at_dismiss REAL,
  CONSTRAINT chk_insight_dismissals_kind CHECK (kind IN ('subscription_new', 'subscription_price_change', 'category_outlier')),
  CONSTRAINT chk_insight_dismissals_shape CHECK (((kind IN ('subscription_new', 'subscription_price_change')) AND (recipient_id IS NOT NULL) AND (category_id IS NULL) AND (month_start IS NULL) AND (deviation_at_dismiss IS NULL)) OR ((kind = 'category_outlier') AND (recipient_id IS NULL) AND (category_id IS NOT NULL) AND (month_start IS NOT NULL) AND (deviation_at_dismiss IS NOT NULL))),
  CONSTRAINT fk_insight_dismissals_category_id FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
  CONSTRAINT fk_insight_dismissals_recipient_id FOREIGN KEY (recipient_id) REFERENCES recipients(id) ON DELETE CASCADE
);

CREATE TABLE instrument_provider_map (
  id INTEGER CONSTRAINT instrument_provider_map_pkey PRIMARY KEY AUTOINCREMENT,
  instrument_key TEXT NOT NULL,
  key_type TEXT NOT NULL DEFAULT 'isin',
  provider TEXT NOT NULL,
  provider_symbol TEXT,
  resolved_name TEXT,
  exchange TEXT,
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'auto',
  verified_at TIMESTAMPTZ_TEXT
    CONSTRAINT instrument_provider_map_verified_at__vtype CHECK (vision_ts_ok(verified_at)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT instrument_provider_map_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT instrument_provider_map_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT chk_instrument_provider_map_key_type CHECK (key_type IN ('isin', 'internal')),
  CONSTRAINT chk_instrument_provider_map_status CHECK (status IN ('confirmed', 'auto', 'failed'))
);

CREATE TABLE investment_ticker_prefs (
  investment_id INT CONSTRAINT investment_ticker_prefs_pkey PRIMARY KEY NOT NULL,
  show_in_ticker BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT investment_ticker_prefs_show_in_ticker__vtype CHECK (show_in_ticker IN (0, 1)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT investment_ticker_prefs_updated_at__vtype CHECK (vision_ts_ok(updated_at))
);

CREATE TABLE investments (
  id INTEGER CONSTRAINT investments_pkey PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
    CONSTRAINT investments_name__vtype CHECK (length(name) <= 200),
  symbol TEXT
    CONSTRAINT investments_symbol__vtype CHECK (length(symbol) <= 20),
  asset_class TEXT NOT NULL
    CONSTRAINT investments_asset_class__vtype CHECK (asset_class IN ('stock', 'etf', 'crypto', 'metals', 'real_estate', 'savings', 'bond')),
  currency TEXT NOT NULL DEFAULT 'EUR'
    CONSTRAINT investments_currency__vtype CHECK (length(currency) <= 10),
  current_price DECIMAL_TEXT(18,6)
    CONSTRAINT investments_current_price__vtype CHECK (vision_numeric_ok(current_price, 18, 6)),
  interest_rate DECIMAL_TEXT(8,4)
    CONSTRAINT investments_interest_rate__vtype CHECK (vision_numeric_ok(interest_rate, 8, 4)),
  maturity_date DATE_TEXT
    CONSTRAINT investments_maturity_date__vtype CHECK (vision_date_ok(maturity_date)),
  location TEXT
    CONSTRAINT investments_location__vtype CHECK (length(location) <= 300),
  municipality TEXT
    CONSTRAINT investments_municipality__vtype CHECK (length(municipality) <= 200),
  cadastral_income DECIMAL_TEXT(12,2)
    CONSTRAINT investments_cadastral_income__vtype CHECK (vision_numeric_ok(cadastral_income, 12, 2)),
  municipality_tax_rate DECIMAL_TEXT(8,4)
    CONSTRAINT investments_municipality_tax_rate__vtype CHECK (vision_numeric_ok(municipality_tax_rate, 8, 4)),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT investments_is_active__vtype CHECK (is_active IN (0, 1)),
  price_provider TEXT NOT NULL DEFAULT 'manual'
    CONSTRAINT investments_price_provider__vtype CHECK (price_provider IN ('manual', 'binance', 'yahoo', 'custom', 'kinesis')),
  price_provider_id TEXT
    CONSTRAINT investments_price_provider_id__vtype CHECK (length(price_provider_id) <= 200),
  price_provider_url TEXT
    CONSTRAINT investments_price_provider_url__vtype CHECK (length(price_provider_url) <= 500),
  price_provider_latest_url TEXT
    CONSTRAINT investments_price_provider_latest_url__vtype CHECK (length(price_provider_latest_url) <= 500),
  price_provider_latest_path TEXT
    CONSTRAINT investments_price_provider_latest_path__vtype CHECK (length(price_provider_latest_path) <= 300),
  price_provider_history_url TEXT
    CONSTRAINT investments_price_provider_history_url__vtype CHECK (length(price_provider_history_url) <= 500),
  price_provider_history_path TEXT
    CONSTRAINT investments_price_provider_history_path__vtype CHECK (length(price_provider_history_path) <= 300),
  price_provider_history_ts_path TEXT
    CONSTRAINT investments_price_provider_history_ts_path__vtype CHECK (length(price_provider_history_ts_path) <= 300),
  price_provider_history_price_path TEXT
    CONSTRAINT investments_price_provider_history_price_path__vtype CHECK (length(price_provider_history_price_path) <= 300),
  price_updated_at TIMESTAMPTZ_TEXT
    CONSTRAINT investments_price_updated_at__vtype CHECK (vision_ts_ok(price_updated_at)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT investments_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT investments_updated_at__vtype CHECK (vision_ts_ok(updated_at))
);

CREATE TABLE manual_transaction_dedup_claims (
  deduplication_hash TEXT CONSTRAINT manual_transaction_dedup_claims_pkey PRIMARY KEY NOT NULL
    CONSTRAINT manual_transaction_dedup_claims_deduplication_hash__vtype CHECK (length(deduplication_hash) <= 64),
  transaction_id INTEGER,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT manual_transaction_dedup_claims_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT manual_transaction_dedup_claims_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT manual_transaction_dedup_claims_deduplication_hash_check CHECK (deduplication_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT manual_transaction_dedup_claims_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
);

CREATE TABLE planned_transaction_executions (
  id INTEGER CONSTRAINT planned_transaction_executions_pkey PRIMARY KEY AUTOINCREMENT,
  planned_transaction_id INTEGER NOT NULL,
  executed_transaction_id INTEGER NOT NULL,
  execution_date DATE_TEXT NOT NULL
    CONSTRAINT planned_transaction_executions_execution_date__vtype CHECK (vision_date_ok(execution_date)),
  created_at TIMESTAMPTZ_TEXT DEFAULT (now())
    CONSTRAINT planned_transaction_executions_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT planned_transaction_executions_executed_transaction_id_fkey FOREIGN KEY (executed_transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  CONSTRAINT planned_transaction_executions_planned_transaction_id_fkey FOREIGN KEY (planned_transaction_id) REFERENCES planned_transactions(id) ON DELETE CASCADE
);

CREATE TABLE planned_transaction_loan_schedule (
  id INTEGER CONSTRAINT planned_transaction_loan_schedule_pkey PRIMARY KEY AUTOINCREMENT,
  planned_transaction_id INTEGER NOT NULL,
  installment_number INTEGER NOT NULL,
  due_date DATE_TEXT NOT NULL
    CONSTRAINT planned_transaction_loan_schedule_due_date__vtype CHECK (vision_date_ok(due_date)),
  payment_amount DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT planned_transaction_loan_schedule_payment_amount__vtype CHECK (vision_numeric_ok(payment_amount, 18, 4)),
  principal_amount DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT planned_transaction_loan_schedule_principal_amount__vtype CHECK (vision_numeric_ok(principal_amount, 18, 4)),
  interest_amount DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT planned_transaction_loan_schedule_interest_amount__vtype CHECK (vision_numeric_ok(interest_amount, 18, 4)),
  remaining_principal DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT planned_transaction_loan_schedule_remaining_principal__vtype CHECK (vision_numeric_ok(remaining_principal, 18, 4)),
  created_at TIMESTAMPTZ_TEXT DEFAULT (now())
    CONSTRAINT planned_transaction_loan_schedule_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT planned_transaction_loan_schedule_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT planned_transaction_loan_schedule_planned_transaction_id_fkey FOREIGN KEY (planned_transaction_id) REFERENCES planned_transactions(id) ON DELETE CASCADE
);

CREATE TABLE planned_transaction_tags (
  planned_transaction_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT planned_transaction_tags_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT planned_transaction_tags_pkey PRIMARY KEY (planned_transaction_id, tag_id),
  CONSTRAINT planned_transaction_tags_planned_transaction_id_fkey FOREIGN KEY (planned_transaction_id) REFERENCES planned_transactions(id) ON DELETE CASCADE,
  CONSTRAINT planned_transaction_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- reminder_days_before: days before planned_date to surface as a reminder. NULL = no reminder.
CREATE TABLE planned_transactions (
  id INTEGER CONSTRAINT planned_transactions_pkey PRIMARY KEY AUTOINCREMENT,
  planned_date DATE_TEXT NOT NULL
    CONSTRAINT planned_transactions_planned_date__vtype CHECK (vision_date_ok(planned_date)),
  amount DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT planned_transactions_amount__vtype CHECK (vision_numeric_ok(amount, 18, 4)),
  currency TEXT NOT NULL DEFAULT 'EUR'
    CONSTRAINT planned_transactions_currency__vtype CHECK (length(currency) <= 3),
  memo TEXT,
  comment TEXT,
  url TEXT,
  recipient_id INTEGER,
  category_id INTEGER,
  is_recurring BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT planned_transactions_is_recurring__vtype CHECK (is_recurring IN (0, 1)),
  recurrence_pattern TEXT,
  is_loan BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT planned_transactions_is_loan__vtype CHECK (is_loan IN (0, 1)),
  loan_type TEXT,
  loan_principal DECIMAL_TEXT(18,4)
    CONSTRAINT planned_transactions_loan_principal__vtype CHECK (vision_numeric_ok(loan_principal, 18, 4)),
  loan_annual_interest_rate DECIMAL_TEXT(8,4)
    CONSTRAINT planned_transactions_loan_annual_interest_rate__vtype CHECK (vision_numeric_ok(loan_annual_interest_rate, 8, 4)),
  loan_term_months INTEGER,
  loan_start_date DATE_TEXT
    CONSTRAINT planned_transactions_loan_start_date__vtype CHECK (vision_date_ok(loan_start_date)),
  loan_payment_day INTEGER,
  loan_regular_payment_amount DECIMAL_TEXT(18,4)
    CONSTRAINT planned_transactions_loan_regular_payment_amount__vtype CHECK (vision_numeric_ok(loan_regular_payment_amount, 18, 4)),
  loan_first_payment_date DATE_TEXT
    CONSTRAINT planned_transactions_loan_first_payment_date__vtype CHECK (vision_date_ok(loan_first_payment_date)),
  is_executed BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT planned_transactions_is_executed__vtype CHECK (is_executed IN (0, 1)),
  last_executed_date DATE_TEXT
    CONSTRAINT planned_transactions_last_executed_date__vtype CHECK (vision_date_ok(last_executed_date)),
  is_active BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT planned_transactions_is_active__vtype CHECK (is_active IN (0, 1)),
  created_at TIMESTAMPTZ_TEXT DEFAULT (now())
    CONSTRAINT planned_transactions_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT planned_transactions_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  reminder_days_before INTEGER,
  account_id INTEGER,
  recurrence_end_date DATE_TEXT
    CONSTRAINT planned_transactions_recurrence_end_date__vtype CHECK (vision_date_ok(recurrence_end_date)),
  max_occurrences INTEGER,
  CONSTRAINT chk_planned_max_occurrences_positive CHECK ((max_occurrences IS NULL) OR (max_occurrences > 0)),
  CONSTRAINT chk_planned_transactions_currency_iso CHECK (currency REGEXP '^[A-Z]{3}$'),
  CONSTRAINT chk_planned_transactions_recurrence_pattern CHECK ((recurrence_pattern IS NULL) OR (lower(btrim(recurrence_pattern)) IN ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')) OR (lower(btrim(recurrence_pattern)) REGEXP '^every[[:space:]]+0*[1-9][0-9]*[[:space:]]+days?$')),
  CONSTRAINT planned_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT planned_transactions_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  CONSTRAINT planned_transactions_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES recipients(id)
);

CREATE TABLE portfolio_asset_adjustment_sources (
  adjustment_id BIGINT NOT NULL,
  staging_row_id BIGINT NOT NULL,
  source_record_hash TEXT NOT NULL
    CONSTRAINT portfolio_asset_adjustment_sources_source_record_hash__vtype CHECK (length(source_record_hash) <= 64),
  CONSTRAINT portfolio_asset_adjustment_sources_pkey PRIMARY KEY (adjustment_id, staging_row_id),
  CONSTRAINT portfolio_asset_adjustment_sources_source_record_hash_check CHECK (source_record_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT portfolio_asset_adjustment_sources_adjustment_id_fkey FOREIGN KEY (adjustment_id) REFERENCES portfolio_asset_adjustments(id) ON DELETE CASCADE,
  CONSTRAINT portfolio_asset_adjustment_sources_staging_row_id_fkey FOREIGN KEY (staging_row_id) REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT
);

CREATE TABLE portfolio_asset_adjustments (
  id BIGINT CONSTRAINT portfolio_asset_adjustments_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('portfolio_transactions_id_seq')),
  investment_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  date DATE_TEXT NOT NULL
    CONSTRAINT portfolio_asset_adjustments_date__vtype CHECK (vision_date_ok(date)),
  units DECIMAL_TEXT(18,8) NOT NULL
    CONSTRAINT portfolio_asset_adjustments_units__vtype CHECK (vision_numeric_ok(units, 18, 8)),
  adjustment_kind TEXT NOT NULL,
  basis_policy TEXT NOT NULL,
  eligible_source_record_hashes TEXT_ARRAY NOT NULL DEFAULT '[]'
    CONSTRAINT portfolio_asset_adjustments_eligible_source_record_hashes__vtype CHECK (vision_array_ok(eligible_source_record_hashes)),
  basis_allocations JSONB_TEXT NOT NULL DEFAULT '{}'
    CONSTRAINT portfolio_asset_adjustments_basis_allocations__vtype CHECK (vision_jsonb_ok(basis_allocations)),
  import_batch_id BIGINT NOT NULL,
  staging_row_id BIGINT NOT NULL,
  source_record_hash TEXT NOT NULL
    CONSTRAINT portfolio_asset_adjustments_source_record_hash__vtype CHECK (length(source_record_hash) <= 64),
  dedup_fingerprint TEXT NOT NULL
    CONSTRAINT portfolio_asset_adjustments_dedup_fingerprint__vtype CHECK (length(dedup_fingerprint) <= 64),
  dedup_fingerprint_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_asset_adjustments_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT portfolio_asset_adjustments_adjustment_kind_check CHECK (adjustment_kind IN ('yield_reversal', 'asset_fee')),
  CONSTRAINT portfolio_asset_adjustments_basis_policy_check CHECK (basis_policy IN ('zero_yield_only', 'carried')),
  CONSTRAINT portfolio_asset_adjustments_check CHECK (((adjustment_kind = 'yield_reversal') AND (basis_policy = 'zero_yield_only')) OR ((adjustment_kind = 'asset_fee') AND (basis_policy = 'carried'))),
  CONSTRAINT portfolio_asset_adjustments_dedup_fingerprint_check CHECK (dedup_fingerprint REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT portfolio_asset_adjustments_dedup_fingerprint_version_check CHECK (dedup_fingerprint_version > 0),
  CONSTRAINT portfolio_asset_adjustments_source_record_hash_check CHECK (source_record_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT portfolio_asset_adjustments_units_check CHECK (dec_gt(units, 0)),
  CONSTRAINT portfolio_asset_adjustments_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_asset_adjustments_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_asset_adjustments_investment_id_fkey FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_asset_adjustments_staging_row_id_fkey FOREIGN KEY (staging_row_id) REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT
);

CREATE TABLE portfolio_asset_transfers (
  id BIGINT CONSTRAINT portfolio_asset_transfers_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('portfolio_transactions_id_seq')),
  investment_id INTEGER NOT NULL,
  source_account_id INTEGER NOT NULL,
  destination_account_id INTEGER NOT NULL,
  date DATE_TEXT NOT NULL
    CONSTRAINT portfolio_asset_transfers_date__vtype CHECK (vision_date_ok(date)),
  units DECIMAL_TEXT(18,8) NOT NULL
    CONSTRAINT portfolio_asset_transfers_units__vtype CHECK (vision_numeric_ok(units, 18, 8)),
  fee_units DECIMAL_TEXT(18,8) NOT NULL DEFAULT '0.00000000'
    CONSTRAINT portfolio_asset_transfers_fee_units__vtype CHECK (vision_numeric_ok(fee_units, 18, 8)),
  fee_basis_allocations JSONB_TEXT NOT NULL DEFAULT '{}'
    CONSTRAINT portfolio_asset_transfers_fee_basis_allocations__vtype CHECK (vision_jsonb_ok(fee_basis_allocations)),
  import_batch_id BIGINT NOT NULL,
  staging_row_id BIGINT NOT NULL,
  source_record_hash TEXT NOT NULL
    CONSTRAINT portfolio_asset_transfers_source_record_hash__vtype CHECK (length(source_record_hash) <= 64),
  dedup_fingerprint TEXT NOT NULL
    CONSTRAINT portfolio_asset_transfers_dedup_fingerprint__vtype CHECK (length(dedup_fingerprint) <= 64),
  dedup_fingerprint_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_asset_transfers_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT portfolio_asset_transfers_check CHECK (dec_ge(fee_units, 0) AND dec_lt(fee_units, units)),
  CONSTRAINT portfolio_asset_transfers_check1 CHECK (source_account_id <> destination_account_id),
  CONSTRAINT portfolio_asset_transfers_dedup_fingerprint_check CHECK (dedup_fingerprint REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT portfolio_asset_transfers_dedup_fingerprint_version_check CHECK (dedup_fingerprint_version > 0),
  CONSTRAINT portfolio_asset_transfers_source_record_hash_check CHECK (source_record_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT portfolio_asset_transfers_units_check CHECK (dec_gt(units, 0)),
  CONSTRAINT portfolio_asset_transfers_destination_account_id_fkey FOREIGN KEY (destination_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_asset_transfers_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_asset_transfers_investment_id_fkey FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_asset_transfers_source_account_id_fkey FOREIGN KEY (source_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_asset_transfers_staging_row_id_fkey FOREIGN KEY (staging_row_id) REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT
);

CREATE TABLE portfolio_broker_snapshots (
  snapshot_date DATE_TEXT NOT NULL
    CONSTRAINT portfolio_broker_snapshots_snapshot_date__vtype CHECK (vision_date_ok(snapshot_date)),
  currency TEXT NOT NULL
    CONSTRAINT portfolio_broker_snapshots_currency__vtype CHECK (length(currency) <= 3),
  account_key TEXT NOT NULL,
  account_id INTEGER,
  account_name TEXT NOT NULL,
  value DECIMAL_TEXT(18,2) NOT NULL
    CONSTRAINT portfolio_broker_snapshots_value__vtype CHECK (vision_numeric_ok(value, 18, 2)),
  invested DECIMAL_TEXT(18,2) NOT NULL
    CONSTRAINT portfolio_broker_snapshots_invested__vtype CHECK (vision_numeric_ok(invested, 18, 2)),
  gain_loss DECIMAL_TEXT(18,2) NOT NULL
    CONSTRAINT portfolio_broker_snapshots_gain_loss__vtype CHECK (vision_numeric_ok(gain_loss, 18, 2)),
  computed_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_broker_snapshots_computed_at__vtype CHECK (vision_ts_ok(computed_at)),
  CONSTRAINT portfolio_broker_snapshots_pkey PRIMARY KEY (snapshot_date, currency, account_key),
  CONSTRAINT portfolio_broker_snapshots_account_key_check CHECK ((account_key = 'unassigned') OR (account_key REGEXP '^account:[1-9][0-9]*$')),
  CONSTRAINT portfolio_broker_snapshots_check CHECK ((account_key = 'unassigned' AND account_id IS NULL) OR account_key = 'account:' || CAST(account_id AS TEXT)),
  CONSTRAINT portfolio_broker_snapshots_currency_check CHECK (currency REGEXP '^[A-Z]{3}$')
);

CREATE TABLE portfolio_exposure_classifications (
  id UUID_TEXT CONSTRAINT portfolio_exposure_classifications_pkey PRIMARY KEY NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT portfolio_exposure_classifications_id__vtype CHECK (vision_uuid_ok(id)),
  investment_id INTEGER,
  identifier_type TEXT,
  identifier_value TEXT,
  identifier_exchange TEXT,
  issuer_id TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  sector TEXT,
  issuer_country_code TEXT
    CONSTRAINT portfolio_exposure_classifications_issuer_country_code__vtype CHECK (length(issuer_country_code) <= 2),
  source_label TEXT NOT NULL,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_exposure_classifications_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_exposure_classifications_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT portfolio_exposure_classifications_check CHECK (((investment_id IS NOT NULL) AND (identifier_type IS NULL) AND (identifier_value IS NULL) AND (identifier_exchange IS NULL)) OR ((investment_id IS NULL) AND (identifier_type IS NOT NULL) AND (identifier_value IS NOT NULL))),
  CONSTRAINT portfolio_exposure_classifications_identifier_type_check CHECK ((identifier_type IS NULL) OR (identifier_type IN ('isin', 'ticker', 'sedol', 'cusip', 'lei', 'proprietary'))),
  CONSTRAINT portfolio_exposure_classifications_issuer_country_code_check CHECK (issuer_country_code REGEXP '^[A-Z]{2}$'),
  CONSTRAINT portfolio_exposure_classifications_issuer_id_check CHECK ((length(issuer_id) >= 1) AND (length(issuer_id) <= 128)),
  CONSTRAINT portfolio_exposure_classifications_issuer_name_check CHECK ((length(issuer_name) >= 1) AND (length(issuer_name) <= 256)),
  CONSTRAINT portfolio_exposure_classifications_sector_check CHECK ((length(sector) >= 1) AND (length(sector) <= 128)),
  CONSTRAINT portfolio_exposure_classifications_source_label_check CHECK ((length(source_label) >= 1) AND (length(source_label) <= 300)),
  CONSTRAINT portfolio_exposure_classifications_investment_id_fkey FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
);

CREATE TABLE portfolio_fund_holdings_documents (
  id UUID_TEXT CONSTRAINT portfolio_fund_holdings_documents_pkey PRIMARY KEY NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT portfolio_fund_holdings_documents_id__vtype CHECK (vision_uuid_ok(id)),
  investment_id INTEGER NOT NULL,
  share_class_identifier_json JSONB_TEXT NOT NULL
    CONSTRAINT portfolio_fund_holdings_documents_share_class_identifier_json__vtype CHECK (vision_jsonb_ok(share_class_identifier_json)),
  document_json JSONB_TEXT NOT NULL
    CONSTRAINT portfolio_fund_holdings_documents_document_json__vtype CHECK (vision_jsonb_ok(document_json)),
  source_as_of_date DATE_TEXT NOT NULL
    CONSTRAINT portfolio_fund_holdings_documents_source_as_of_date__vtype CHECK (vision_date_ok(source_as_of_date)),
  source_sha256 TEXT NOT NULL
    CONSTRAINT portfolio_fund_holdings_documents_source_sha256__vtype CHECK (length(source_sha256) <= 64),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_fund_holdings_documents_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_fund_holdings_documents_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT portfolio_fund_holdings_documents_source_sha256_check CHECK (source_sha256 REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT portfolio_fund_holdings_documents_investment_id_fkey FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
);

CREATE TABLE portfolio_import_batches (
  id BIGINT CONSTRAINT portfolio_import_batches_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('portfolio_import_batches_id_seq')),
  adapter_name TEXT NOT NULL,
  source_filename TEXT,
  source_size_bytes BIGINT,
  custom_config JSONB_TEXT
    CONSTRAINT portfolio_import_batches_custom_config__vtype CHECK (vision_jsonb_ok(custom_config)),
  default_asset_class TEXT
    CONSTRAINT portfolio_import_batches_default_asset_class__vtype CHECK (default_asset_class IN ('stock', 'etf', 'crypto', 'metals', 'real_estate', 'savings', 'bond')),
  default_type TEXT
    CONSTRAINT portfolio_import_batches_default_type__vtype CHECK (default_type IN ('buy', 'sell', 'dividend', 'fee', 'tax', 'interest', 'rent_income', 'appreciation', 'gift', 'split', 'merger', 'spinoff', 'return_of_capital')),
  status TEXT NOT NULL DEFAULT 'pending',
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  rows_duplicate INTEGER NOT NULL DEFAULT 0,
  rows_error INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  started_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_import_batches_started_at__vtype CHECK (vision_ts_ok(started_at)),
  completed_at TIMESTAMPTZ_TEXT
    CONSTRAINT portfolio_import_batches_completed_at__vtype CHECK (vision_ts_ok(completed_at)),
  account_id INTEGER,
  is_brokerage BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT portfolio_import_batches_is_brokerage__vtype CHECK (is_brokerage IN (0, 1)),
  CONSTRAINT portfolio_import_batches_status_check CHECK (status IN ('pending', 'staging', 'validating', 'matching', 'awaiting_review', 'committing', 'complete', 'failed', 'aborted', 'complete_with_errors')),
  CONSTRAINT portfolio_import_batches_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE portfolio_import_duplicate_repair_journal (
  id BIGINT CONSTRAINT portfolio_import_duplicate_repair_journal_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('portfolio_import_duplicate_repair_journal_id_seq')),
  batch_id BIGINT NOT NULL,
  staging_row_id BIGINT NOT NULL,
  original_import_batch_id BIGINT NOT NULL,
  legacy_transaction_id INTEGER NOT NULL,
  imported_transaction_id INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  policy TEXT NOT NULL,
  before_data JSONB_TEXT NOT NULL
    CONSTRAINT portfolio_import_duplicate_repair_journal_before_data__vtype CHECK (vision_jsonb_ok(before_data)),
  after_data JSONB_TEXT NOT NULL
    CONSTRAINT portfolio_import_duplicate_repair_journal_after_data__vtype CHECK (vision_jsonb_ok(after_data)),
  previous_entry_id BIGINT,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_import_duplicate_repair_journal_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT portfolio_import_duplicate_repair_journal_action_check CHECK ("action" IN ('repair', 'restore')),
  CONSTRAINT portfolio_import_duplicate_repair_journal_after_data_check CHECK (json_type(after_data) = 'object'),
  CONSTRAINT portfolio_import_duplicate_repair_journal_before_data_check CHECK (json_type(before_data) = 'object'),
  CONSTRAINT portfolio_import_duplicate_repair_journal_check CHECK (legacy_transaction_id <> imported_transaction_id),
  CONSTRAINT portfolio_import_duplicate_repair_journal_check1 CHECK (json_type(before_data, '$.legacy') IS NOT NULL AND json_type(before_data, '$.imported') IS NOT NULL
      AND json_type(before_data, '$.originalBatch') IS NOT NULL AND json_type(before_data, '$.originalStaging') IS NOT NULL
      AND json_type(after_data, '$.legacy') IS NOT NULL AND json_type(after_data, '$.imported') IS NOT NULL
      AND json_type(after_data, '$.originalBatch') IS NOT NULL AND json_type(after_data, '$.originalStaging') IS NOT NULL),
  CONSTRAINT portfolio_import_duplicate_repair_journal_check2 CHECK ((json_type(before_data, '$.legacy') = 'object') AND (json_type(after_data, '$.legacy') = 'object')),
  CONSTRAINT portfolio_import_duplicate_repair_journal_check3 CHECK ((json_type(before_data, '$.originalBatch') = 'object') AND (json_type(after_data, '$.originalBatch') = 'object')),
  CONSTRAINT portfolio_import_duplicate_repair_journal_check4 CHECK ((json_type(before_data, '$.originalStaging') = 'array') AND (json_type(after_data, '$.originalStaging') = 'array')),
  CONSTRAINT portfolio_import_duplicate_repair_journal_check5 CHECK ((json_type(before_data, '$.imported') IN ('object', 'null')) AND (json_type(after_data, '$.imported') IN ('object', 'null'))),
  CONSTRAINT portfolio_import_duplicate_repair_journal_check6 CHECK ((("action" = 'repair') AND (json_type(before_data, '$.imported') = 'object') AND (json_type(after_data, '$.imported') = 'null')) OR (("action" = 'restore') AND (json_type(before_data, '$.imported') = 'null') AND (json_type(after_data, '$.imported') = 'object'))),
  CONSTRAINT portfolio_import_duplicate_repair_journal_check7 CHECK (("action" = 'restore') = (previous_entry_id IS NOT NULL)),
  CONSTRAINT portfolio_import_duplicate_repair_journal_policy_check CHECK (policy IN ('preserve_existing', 'prefer_source')),
  CONSTRAINT portfolio_import_duplicate_repair_journa_previous_entry_id_fkey FOREIGN KEY (previous_entry_id) REFERENCES portfolio_import_duplicate_repair_journal(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_import_duplicate_repair_journal_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_import_duplicate_repair_journal_staging_row_id_fkey FOREIGN KEY (staging_row_id) REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_import_duplicate_repair_original_import_batch_id_fkey FOREIGN KEY (original_import_batch_id) REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT
);

CREATE TABLE portfolio_import_income_recognition_journal (
  id BIGINT CONSTRAINT portfolio_import_income_recognition_journal_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('portfolio_import_income_recognition_journal_id_seq')),
  batch_id BIGINT NOT NULL,
  staging_row_id BIGINT NOT NULL,
  unit_staging_row_id BIGINT NOT NULL,
  income_transaction_id INTEGER NOT NULL,
  unit_transaction_id INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  previous_entry_id BIGINT,
  income_data JSONB_TEXT NOT NULL
    CONSTRAINT portfolio_import_income_recognition_journal_income_data__vtype CHECK (vision_jsonb_ok(income_data)),
  unit_data JSONB_TEXT NOT NULL
    CONSTRAINT portfolio_import_income_recognition_journal_unit_data__vtype CHECK (vision_jsonb_ok(unit_data)),
  proof_data JSONB_TEXT NOT NULL
    CONSTRAINT portfolio_import_income_recognition_journal_proof_data__vtype CHECK (vision_jsonb_ok(proof_data)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_import_income_recognition_journal_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT portfolio_import_income_recognition_income_transaction_id_check CHECK (income_transaction_id > 0),
  CONSTRAINT portfolio_import_income_recognition_j_unit_transaction_id_check CHECK (unit_transaction_id > 0),
  CONSTRAINT portfolio_import_income_recognition_journal_action_check CHECK ("action" IN ('record', 'restore')),
  CONSTRAINT portfolio_import_income_recognition_journal_check CHECK (("action" = 'restore') = (previous_entry_id IS NOT NULL)),
  CONSTRAINT portfolio_import_income_recognition_journal_income_data_check CHECK (json_type(income_data) = 'object'),
  CONSTRAINT portfolio_import_income_recognition_journal_proof_data_check CHECK (json_type(proof_data) = 'object'),
  CONSTRAINT portfolio_import_income_recognition_journal_unit_data_check CHECK (json_type(unit_data) = 'object'),
  CONSTRAINT portfolio_import_income_recognition_jo_unit_staging_row_id_fkey FOREIGN KEY (unit_staging_row_id) REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_import_income_recognition_jour_previous_entry_id_fkey FOREIGN KEY (previous_entry_id) REFERENCES portfolio_import_income_recognition_journal(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_import_income_recognition_journal_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_import_income_recognition_journal_staging_row_id_fkey FOREIGN KEY (staging_row_id) REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT
);

CREATE TABLE portfolio_import_reconciliation_journal (
  id BIGINT CONSTRAINT portfolio_import_reconciliation_journal_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('portfolio_import_reconciliation_journal_id_seq')),
  batch_id BIGINT NOT NULL,
  staging_row_id BIGINT NOT NULL,
  transaction_id INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  policy TEXT NOT NULL,
  previous_entry_id BIGINT,
  before_data JSONB_TEXT NOT NULL
    CONSTRAINT portfolio_import_reconciliation_journal_before_data__vtype CHECK (vision_jsonb_ok(before_data)),
  after_data JSONB_TEXT NOT NULL
    CONSTRAINT portfolio_import_reconciliation_journal_after_data__vtype CHECK (vision_jsonb_ok(after_data)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_import_reconciliation_journal_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT portfolio_import_reconciliation_journal_action_check CHECK ("action" IN ('adopt', 'restore')),
  CONSTRAINT portfolio_import_reconciliation_journal_after_data_check CHECK (json_type(after_data) = 'object'),
  CONSTRAINT portfolio_import_reconciliation_journal_before_data_check CHECK (json_type(before_data) = 'object'),
  CONSTRAINT portfolio_import_reconciliation_journal_check CHECK (("action" = 'restore') = (previous_entry_id IS NOT NULL)),
  CONSTRAINT portfolio_import_reconciliation_journal_policy_check CHECK (policy IN ('exact', 'preserve_existing', 'prefer_source')),
  CONSTRAINT portfolio_import_reconciliation_journal_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES portfolio_import_batches(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_import_reconciliation_journal_previous_entry_id_fkey FOREIGN KEY (previous_entry_id) REFERENCES portfolio_import_reconciliation_journal(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_import_reconciliation_journal_staging_row_id_fkey FOREIGN KEY (staging_row_id) REFERENCES portfolio_import_staging_rows(id) ON DELETE RESTRICT
);

CREATE TABLE portfolio_import_staging_rows (
  id BIGINT CONSTRAINT portfolio_import_staging_rows_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('portfolio_import_staging_rows_id_seq')),
  batch_id BIGINT NOT NULL,
  row_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_date DATE_TEXT
    CONSTRAINT portfolio_import_staging_rows_tx_date__vtype CHECK (vision_date_ok(tx_date)),
  type_raw TEXT,
  type TEXT
    CONSTRAINT portfolio_import_staging_rows_type__vtype CHECK (type IN ('buy', 'sell', 'dividend', 'fee', 'tax', 'interest', 'rent_income', 'appreciation', 'gift', 'split', 'merger', 'spinoff', 'return_of_capital')),
  symbol_raw TEXT,
  name_raw TEXT,
  units DECIMAL_TEXT(18,8)
    CONSTRAINT portfolio_import_staging_rows_units__vtype CHECK (vision_numeric_ok(units, 18, 8)),
  price_per_unit DECIMAL_TEXT(18,6)
    CONSTRAINT portfolio_import_staging_rows_price_per_unit__vtype CHECK (vision_numeric_ok(price_per_unit, 18, 6)),
  amount DECIMAL_TEXT(18,4)
    CONSTRAINT portfolio_import_staging_rows_amount__vtype CHECK (vision_numeric_ok(amount, 18, 4)),
  fees DECIMAL_TEXT(18,4)
    CONSTRAINT portfolio_import_staging_rows_fees__vtype CHECK (vision_numeric_ok(fees, 18, 4)),
  taxes DECIMAL_TEXT(18,4)
    CONSTRAINT portfolio_import_staging_rows_taxes__vtype CHECK (vision_numeric_ok(taxes, 18, 4)),
  currency TEXT,
  fx_rate_to_eur DECIMAL_TEXT(20,10)
    CONSTRAINT portfolio_import_staging_rows_fx_rate_to_eur__vtype CHECK (vision_numeric_ok(fx_rate_to_eur, 20, 10)),
  note TEXT,
  raw_data TEXT,
  resolved_investment_id INTEGER,
  user_override_investment_id INTEGER,
  match_source TEXT,
  match_similarity REAL,
  committed_txn_id INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_import_staging_rows_created_at__vtype CHECK (vision_ts_ok(created_at)),
  route TEXT,
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT portfolio_import_staging_rows_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  source_transaction_id TEXT,
  source_account_identity TEXT,
  dedup_occurrence INTEGER,
  source_record_hash TEXT
    CONSTRAINT portfolio_import_staging_rows_source_record_hash__vtype CHECK (length(source_record_hash) <= 64),
  dedup_fingerprint TEXT
    CONSTRAINT portfolio_import_staging_rows_dedup_fingerprint__vtype CHECK (length(dedup_fingerprint) <= 64),
  dedup_fingerprint_version INTEGER,
  asset_transfer_details JSON_TEXT
    CONSTRAINT portfolio_import_staging_rows_asset_transfer_details__vtype CHECK (json_valid(asset_transfer_details)),
  asset_adjustment_details JSON_TEXT
    CONSTRAINT portfolio_import_staging_rows_asset_adjustment_details__vtype CHECK (json_valid(asset_adjustment_details)),
  CONSTRAINT chk_portfolio_import_staging_rows_dedup_fingerprint CHECK ((dedup_fingerprint IS NULL) OR (dedup_fingerprint REGEXP '^[0-9a-f]{64}$')),
  CONSTRAINT chk_portfolio_import_staging_rows_dedup_occurrence CHECK ((dedup_occurrence IS NULL) OR (dedup_occurrence > 0)),
  CONSTRAINT chk_portfolio_import_staging_rows_dedup_pair CHECK ((dedup_fingerprint IS NULL) = (dedup_fingerprint_version IS NULL)),
  CONSTRAINT chk_portfolio_import_staging_rows_dedup_version CHECK ((dedup_fingerprint_version IS NULL) OR (dedup_fingerprint_version > 0)),
  CONSTRAINT chk_portfolio_import_staging_rows_match_source CHECK ((match_source IS NULL) OR (match_source IN ('symbol', 'name_exact'))),
  CONSTRAINT chk_portfolio_import_staging_rows_route CHECK ((route IS NULL) OR (route IN ('cash', 'portfolio', 'asset_transfer', 'account_internal', 'asset_adjustment'))),
  CONSTRAINT chk_portfolio_import_staging_rows_source_record_hash CHECK ((source_record_hash IS NULL) OR (source_record_hash REGEXP '^[0-9a-f]{64}$')),
  CONSTRAINT portfolio_import_staging_rows_status_check CHECK (status IN ('pending', 'validated', 'matched', 'committed', 'duplicate', 'error')),
  CONSTRAINT fk_pf_staging_override_investment FOREIGN KEY (user_override_investment_id) REFERENCES investments(id) ON DELETE SET NULL,
  CONSTRAINT fk_pf_staging_resolved_investment FOREIGN KEY (resolved_investment_id) REFERENCES investments(id) ON DELETE SET NULL,
  CONSTRAINT portfolio_import_staging_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES portfolio_import_batches(id) ON DELETE CASCADE
);

CREATE TABLE portfolio_performance_snapshots (
  id INTEGER CONSTRAINT portfolio_performance_snapshots_pkey PRIMARY KEY AUTOINCREMENT,
  snapshot_date DATE_TEXT NOT NULL
    CONSTRAINT portfolio_performance_snapshots_snapshot_date__vtype CHECK (vision_date_ok(snapshot_date)),
  invested DECIMAL_TEXT(18,6) NOT NULL DEFAULT '0.000000'
    CONSTRAINT portfolio_performance_snapshots_invested__vtype CHECK (vision_numeric_ok(invested, 18, 6)),
  value DECIMAL_TEXT(18,6) NOT NULL DEFAULT '0.000000'
    CONSTRAINT portfolio_performance_snapshots_value__vtype CHECK (vision_numeric_ok(value, 18, 6)),
  stocks_etfs_value DECIMAL_TEXT(18,6) NOT NULL DEFAULT '0.000000'
    CONSTRAINT portfolio_performance_snapshots_stocks_etfs_value__vtype CHECK (vision_numeric_ok(stocks_etfs_value, 18, 6)),
  crypto_value DECIMAL_TEXT(18,6) NOT NULL DEFAULT '0.000000'
    CONSTRAINT portfolio_performance_snapshots_crypto_value__vtype CHECK (vision_numeric_ok(crypto_value, 18, 6)),
  metals_value DECIMAL_TEXT(18,6) NOT NULL DEFAULT '0.000000'
    CONSTRAINT portfolio_performance_snapshots_metals_value__vtype CHECK (vision_numeric_ok(metals_value, 18, 6)),
  cash_value DECIMAL_TEXT(18,6) NOT NULL DEFAULT '0.000000'
    CONSTRAINT portfolio_performance_snapshots_cash_value__vtype CHECK (vision_numeric_ok(cash_value, 18, 6)),
  gain_loss DECIMAL_TEXT(18,6) NOT NULL DEFAULT '0.000000'
    CONSTRAINT portfolio_performance_snapshots_gain_loss__vtype CHECK (vision_numeric_ok(gain_loss, 18, 6)),
  return_pct DECIMAL_TEXT(10,4) NOT NULL DEFAULT '0.0000'
    CONSTRAINT portfolio_performance_snapshots_return_pct__vtype CHECK (vision_numeric_ok(return_pct, 10, 4)),
  inflation_adjusted_value DECIMAL_TEXT(18,6) NOT NULL DEFAULT '0.000000'
    CONSTRAINT portfolio_performance_snapshots_inflation_adjusted_value__vtype CHECK (vision_numeric_ok(inflation_adjusted_value, 18, 6)),
  cumulative_inflation DECIMAL_TEXT(10,4) NOT NULL DEFAULT '1.0000'
    CONSTRAINT portfolio_performance_snapshots_cumulative_inflation__vtype CHECK (vision_numeric_ok(cumulative_inflation, 10, 4)),
  real_return_pct DECIMAL_TEXT(10,4) NOT NULL DEFAULT '0.0000'
    CONSTRAINT portfolio_performance_snapshots_real_return_pct__vtype CHECK (vision_numeric_ok(real_return_pct, 10, 4)),
  currency TEXT NOT NULL DEFAULT 'EUR'
    CONSTRAINT portfolio_performance_snapshots_currency__vtype CHECK (length(currency) <= 3),
  computed_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_performance_snapshots_computed_at__vtype CHECK (vision_ts_ok(computed_at)),
  stocks_etfs_invested DECIMAL_TEXT(18,6) NOT NULL DEFAULT '0.000000'
    CONSTRAINT portfolio_performance_snapshots_stocks_etfs_invested__vtype CHECK (vision_numeric_ok(stocks_etfs_invested, 18, 6)),
  crypto_invested DECIMAL_TEXT(18,6) NOT NULL DEFAULT '0.000000'
    CONSTRAINT portfolio_performance_snapshots_crypto_invested__vtype CHECK (vision_numeric_ok(crypto_invested, 18, 6)),
  metals_invested DECIMAL_TEXT(18,6) NOT NULL DEFAULT '0.000000'
    CONSTRAINT portfolio_performance_snapshots_metals_invested__vtype CHECK (vision_numeric_ok(metals_invested, 18, 6)),
  value_fx_neutral DECIMAL_TEXT(18,2)
    CONSTRAINT portfolio_performance_snapshots_value_fx_neutral__vtype CHECK (vision_numeric_ok(value_fx_neutral, 18, 2))
);

CREATE TABLE portfolio_snapshot_accounts (
  snapshot_date DATE_TEXT NOT NULL
    CONSTRAINT portfolio_snapshot_accounts_snapshot_date__vtype CHECK (vision_date_ok(snapshot_date)),
  currency TEXT NOT NULL
    CONSTRAINT portfolio_snapshot_accounts_currency__vtype CHECK (length(currency) <= 3),
  account_key TEXT NOT NULL,
  value DECIMAL_TEXT(18,2) NOT NULL
    CONSTRAINT portfolio_snapshot_accounts_value__vtype CHECK (vision_numeric_ok(value, 18, 2)),
  computed_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_snapshot_accounts_computed_at__vtype CHECK (vision_ts_ok(computed_at)),
  CONSTRAINT portfolio_snapshot_accounts_pkey PRIMARY KEY (snapshot_date, currency, account_key)
);

CREATE TABLE portfolio_transactions (
  id INT CONSTRAINT portfolio_transactions_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('portfolio_transactions_id_seq')),
  investment_id INTEGER NOT NULL,
  type TEXT NOT NULL
    CONSTRAINT portfolio_transactions_type__vtype CHECK (type IN ('buy', 'sell', 'dividend', 'fee', 'tax', 'interest', 'rent_income', 'appreciation', 'gift', 'split', 'merger', 'spinoff', 'return_of_capital')),
  date DATE_TEXT NOT NULL
    CONSTRAINT portfolio_transactions_date__vtype CHECK (vision_date_ok(date)),
  amount DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT portfolio_transactions_amount__vtype CHECK (vision_numeric_ok(amount, 18, 4)),
  units DECIMAL_TEXT(18,8)
    CONSTRAINT portfolio_transactions_units__vtype CHECK (vision_numeric_ok(units, 18, 8)),
  price_per_unit DECIMAL_TEXT(18,6)
    CONSTRAINT portfolio_transactions_price_per_unit__vtype CHECK (vision_numeric_ok(price_per_unit, 18, 6)),
  fees DECIMAL_TEXT(18,4) DEFAULT '0.0000'
    CONSTRAINT portfolio_transactions_fees__vtype CHECK (vision_numeric_ok(fees, 18, 4)),
  taxes DECIMAL_TEXT(18,4) DEFAULT '0.0000'
    CONSTRAINT portfolio_transactions_taxes__vtype CHECK (vision_numeric_ok(taxes, 18, 4)),
  currency TEXT NOT NULL DEFAULT 'EUR'
    CONSTRAINT portfolio_transactions_currency__vtype CHECK (length(currency) <= 10),
  fx_rate_to_eur DECIMAL_TEXT(20,10)
    CONSTRAINT portfolio_transactions_fx_rate_to_eur__vtype CHECK (vision_numeric_ok(fx_rate_to_eur, 20, 10)),
  note TEXT,
  is_recurring BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT portfolio_transactions_is_recurring__vtype CHECK (is_recurring IN (0, 1)),
  recurrence_interval TEXT,
  recurrence_end_date DATE_TEXT
    CONSTRAINT portfolio_transactions_recurrence_end_date__vtype CHECK (vision_date_ok(recurrence_end_date)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT portfolio_transactions_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT portfolio_transactions_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  account_id INTEGER,
  import_batch_id BIGINT,
  dividend_amount_convention TEXT NOT NULL DEFAULT 'unknown'
    CONSTRAINT portfolio_transactions_dividend_amount_convention__vtype CHECK (length(dividend_amount_convention) <= 7),
  source_record_hash TEXT
    CONSTRAINT portfolio_transactions_source_record_hash__vtype CHECK (length(source_record_hash) <= 64),
  dedup_fingerprint TEXT
    CONSTRAINT portfolio_transactions_dedup_fingerprint__vtype CHECK (length(dedup_fingerprint) <= 64),
  dedup_fingerprint_version INTEGER,
  income_recognition_role TEXT NOT NULL DEFAULT 'standard',
  CONSTRAINT chk_portfolio_income_recognition_role CHECK ((income_recognition_role IN ('standard', 'included_in_units')) AND ((income_recognition_role = 'standard') OR (type = 'dividend'))),
  CONSTRAINT chk_portfolio_transactions_dedup_fingerprint CHECK ((dedup_fingerprint IS NULL) OR (dedup_fingerprint REGEXP '^[0-9a-f]{64}$')),
  CONSTRAINT chk_portfolio_transactions_dedup_pair CHECK ((dedup_fingerprint IS NULL) = (dedup_fingerprint_version IS NULL)),
  CONSTRAINT chk_portfolio_transactions_dedup_version CHECK ((dedup_fingerprint_version IS NULL) OR (dedup_fingerprint_version > 0)),
  CONSTRAINT chk_portfolio_transactions_dividend_amount_convention CHECK (dividend_amount_convention IN ('gross', 'net', 'unknown')),
  CONSTRAINT chk_portfolio_transactions_recurrence_interval CHECK ((recurrence_interval IS NULL) OR (recurrence_interval IN ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'))),
  CONSTRAINT chk_portfolio_transactions_source_record_hash CHECK ((source_record_hash IS NULL) OR (source_record_hash REGEXP '^[0-9a-f]{64}$')),
  CONSTRAINT portfolio_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_transactions_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES portfolio_import_batches(id) ON DELETE SET NULL,
  CONSTRAINT portfolio_transactions_investment_id_fkey FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE
);

CREATE TABLE provider_api_keys (
  provider TEXT CONSTRAINT provider_api_keys_pkey PRIMARY KEY NOT NULL,
  api_key TEXT NOT NULL,
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT provider_api_keys_updated_at__vtype CHECK (vision_ts_ok(updated_at))
);

CREATE TABLE provider_health (
  provider TEXT CONSTRAINT provider_health_pkey PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  last_success_at TIMESTAMPTZ_TEXT
    CONSTRAINT provider_health_last_success_at__vtype CHECK (vision_ts_ok(last_success_at)),
  last_error_at TIMESTAMPTZ_TEXT
    CONSTRAINT provider_health_last_error_at__vtype CHECK (vision_ts_ok(last_error_at)),
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT provider_health_updated_at__vtype CHECK (vision_ts_ok(updated_at))
);

CREATE TABLE provider_quota (
  provider TEXT NOT NULL,
  window_date DATE_TEXT NOT NULL
    CONSTRAINT provider_quota_window_date__vtype CHECK (vision_date_ok(window_date)),
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT provider_quota_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT provider_quota_pkey PRIMARY KEY (provider, window_date),
  CONSTRAINT chk_provider_quota_count_nonneg CHECK (count >= 0)
);

CREATE TABLE recipient_bank_accounts (
  id INTEGER CONSTRAINT recipient_bank_accounts_pkey PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER,
  account_number TEXT NOT NULL
    CONSTRAINT recipient_bank_accounts_account_number__vtype CHECK (length(account_number) <= 34),
  bank_name TEXT,
  account_label TEXT,
  address TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT recipient_bank_accounts_is_primary__vtype CHECK (is_primary IN (0, 1)),
  is_active BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT recipient_bank_accounts_is_active__vtype CHECK (is_active IN (0, 1)),
  created_at TIMESTAMPTZ_TEXT DEFAULT (now())
    CONSTRAINT recipient_bank_accounts_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT recipient_bank_accounts_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT recipient_bank_accounts_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES recipients(id)
);

CREATE TABLE recipient_match_patterns (
  id INTEGER CONSTRAINT recipient_match_patterns_pkey PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER NOT NULL,
  pattern TEXT NOT NULL,
  pattern_kind TEXT NOT NULL DEFAULT 'literal_prefix',
  case_sensitive BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT recipient_match_patterns_case_sensitive__vtype CHECK (case_sensitive IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT recipient_match_patterns_is_active__vtype CHECK (is_active IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'user',
  notes TEXT,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT recipient_match_patterns_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT recipient_match_patterns_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT recipient_match_patterns_pattern_kind_check CHECK (pattern_kind IN ('regex', 'glob', 'literal_prefix')),
  CONSTRAINT recipient_match_patterns_source_check CHECK (source IN ('user', 'suggested', 'system')),
  CONSTRAINT recipient_match_patterns_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES recipients(id) ON DELETE CASCADE
);

CREATE TABLE recipients (
  id INTEGER CONSTRAINT recipients_pkey PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  default_category_id INTEGER,
  primary_recipient_id INTEGER,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT recipients_is_active__vtype CHECK (is_active IN (0, 1)),
  created_at TIMESTAMPTZ_TEXT DEFAULT (now())
    CONSTRAINT recipients_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT recipients_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT recipients_default_category_id_fkey FOREIGN KEY (default_category_id) REFERENCES categories(id) ON DELETE SET NULL,
  CONSTRAINT recipients_primary_recipient_id_fkey FOREIGN KEY (primary_recipient_id) REFERENCES recipients(id) ON DELETE SET NULL
);

CREATE TABLE research_dossier_links (
  dossier_id UUID_TEXT NOT NULL
    CONSTRAINT research_dossier_links_dossier_id__vtype CHECK (vision_uuid_ok(dossier_id)),
  link_type TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  historical_id TEXT NOT NULL,
  label_snapshot TEXT NOT NULL,
  category_id INTEGER,
  investment_id INTEGER,
  saved_analysis_id TEXT,
  CONSTRAINT research_dossier_links_pkey PRIMARY KEY (dossier_id, link_type, ordinal),
  CONSTRAINT research_dossier_links_check CHECK (((link_type = 'category') AND (investment_id IS NULL) AND (saved_analysis_id IS NULL)) OR ((link_type = 'investment') AND (category_id IS NULL) AND (saved_analysis_id IS NULL)) OR ((link_type = 'saved-analysis') AND (category_id IS NULL) AND (investment_id IS NULL))),
  CONSTRAINT research_dossier_links_historical_id_check CHECK ((length(historical_id) >= 1) AND (length(historical_id) <= 100)),
  CONSTRAINT research_dossier_links_label_snapshot_check CHECK ((length(label_snapshot) >= 1) AND (length(label_snapshot) <= 500)),
  CONSTRAINT research_dossier_links_link_type_check CHECK (link_type IN ('category', 'investment', 'saved-analysis')),
  CONSTRAINT research_dossier_links_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT research_dossier_links_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  CONSTRAINT research_dossier_links_dossier_id_fkey FOREIGN KEY (dossier_id) REFERENCES research_dossiers(id) ON DELETE CASCADE,
  CONSTRAINT research_dossier_links_investment_id_fkey FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE SET NULL,
  CONSTRAINT research_dossier_links_saved_analysis_id_fkey FOREIGN KEY (saved_analysis_id) REFERENCES saved_analyses(id) ON DELETE SET NULL
);

CREATE TABLE research_dossier_versions (
  dossier_id UUID_TEXT NOT NULL
    CONSTRAINT research_dossier_versions_dossier_id__vtype CHECK (vision_uuid_ok(dossier_id)),
  version INTEGER NOT NULL,
  snapshot_json JSONB_TEXT NOT NULL
    CONSTRAINT research_dossier_versions_snapshot_json__vtype CHECK (vision_jsonb_ok(snapshot_json)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT research_dossier_versions_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT research_dossier_versions_pkey PRIMARY KEY (dossier_id, version),
  CONSTRAINT research_dossier_versions_snapshot_json_check CHECK (json_type(snapshot_json) = 'object'),
  CONSTRAINT research_dossier_versions_version_check CHECK (version > 0),
  CONSTRAINT research_dossier_versions_dossier_id_fkey FOREIGN KEY (dossier_id) REFERENCES research_dossiers(id) ON DELETE CASCADE
);

CREATE TABLE research_dossiers (
  id UUID_TEXT CONSTRAINT research_dossiers_pkey PRIMARY KEY NOT NULL DEFAULT (gen_random_uuid())
    CONSTRAINT research_dossiers_id__vtype CHECK (vision_uuid_ok(id)),
  version INTEGER NOT NULL DEFAULT 1,
  workspace TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json JSONB_TEXT NOT NULL
    CONSTRAINT research_dossiers_content_json__vtype CHECK (vision_jsonb_ok(content_json)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT research_dossiers_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT research_dossiers_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT research_dossiers_content_json_check CHECK (json_type(content_json) = 'object'),
  CONSTRAINT research_dossiers_title_check CHECK ((length(title) >= 1) AND (length(title) <= 300)),
  CONSTRAINT research_dossiers_version_check CHECK (version > 0),
  CONSTRAINT research_dossiers_workspace_check CHECK (workspace IN ('budgeting', 'portfolio', 'research', 'cross-workspace'))
);

CREATE TABLE saved_analyses (
  id TEXT CONSTRAINT saved_analyses_pkey PRIMARY KEY NOT NULL,
  definition_id TEXT NOT NULL,
  name TEXT NOT NULL,
  workspace TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  refresh_mode TEXT NOT NULL DEFAULT 'live',
  parameters_json JSONB_TEXT NOT NULL DEFAULT '{}'
    CONSTRAINT saved_analyses_parameters_json__vtype CHECK (vision_jsonb_ok(parameters_json)),
  charts_json JSONB_TEXT NOT NULL DEFAULT '[]'
    CONSTRAINT saved_analyses_charts_json__vtype CHECK (vision_jsonb_ok(charts_json)),
  source_references_json JSONB_TEXT NOT NULL DEFAULT '[]'
    CONSTRAINT saved_analyses_source_references_json__vtype CHECK (vision_jsonb_ok(source_references_json)),
  refresh_status TEXT NOT NULL DEFAULT 'never-run',
  last_successful_run_id TEXT,
  last_error_json JSONB_TEXT
    CONSTRAINT saved_analyses_last_error_json__vtype CHECK (vision_jsonb_ok(last_error_json)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT saved_analyses_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT saved_analyses_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT saved_analyses_current_version_check CHECK (current_version > 0),
  CONSTRAINT saved_analyses_name_check CHECK ((length(name) >= 1) AND (length(name) <= 200)),
  CONSTRAINT saved_analyses_refresh_mode_check CHECK (refresh_mode IN ('live', 'frozen')),
  CONSTRAINT saved_analyses_refresh_status_check CHECK (refresh_status IN ('never-run', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT saved_analyses_workspace_check CHECK (workspace IN ('budgeting', 'portfolio', 'research', 'cross-workspace')),
  CONSTRAINT fk_saved_analyses_last_successful_run FOREIGN KEY (last_successful_run_id) REFERENCES saved_analysis_runs(id) ON DELETE SET NULL
);

CREATE TABLE saved_analysis_definition_versions (
  saved_analysis_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition_json JSONB_TEXT NOT NULL
    CONSTRAINT saved_analysis_definition_versions_definition_json__vtype CHECK (vision_jsonb_ok(definition_json)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT saved_analysis_definition_versions_created_at__vtype CHECK (vision_ts_ok(created_at)),
  state_json JSONB_TEXT
    CONSTRAINT saved_analysis_definition_versions_state_json__vtype CHECK (vision_jsonb_ok(state_json)),
  CONSTRAINT saved_analysis_definition_versions_pkey PRIMARY KEY (saved_analysis_id, version),
  CONSTRAINT saved_analysis_definition_versions_version_check CHECK (version > 0),
  CONSTRAINT saved_analysis_definition_versions_saved_analysis_id_fkey FOREIGN KEY (saved_analysis_id) REFERENCES saved_analyses(id) ON DELETE CASCADE
);

CREATE TABLE saved_analysis_runs (
  id TEXT CONSTRAINT saved_analysis_runs_pkey PRIMARY KEY NOT NULL,
  saved_analysis_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  parameters_json JSONB_TEXT NOT NULL DEFAULT '{}'
    CONSTRAINT saved_analysis_runs_parameters_json__vtype CHECK (vision_jsonb_ok(parameters_json)),
  result_json JSONB_TEXT
    CONSTRAINT saved_analysis_runs_result_json__vtype CHECK (vision_jsonb_ok(result_json)),
  error_json JSONB_TEXT
    CONSTRAINT saved_analysis_runs_error_json__vtype CHECK (vision_jsonb_ok(error_json)),
  started_at TIMESTAMPTZ_TEXT
    CONSTRAINT saved_analysis_runs_started_at__vtype CHECK (vision_ts_ok(started_at)),
  completed_at TIMESTAMPTZ_TEXT
    CONSTRAINT saved_analysis_runs_completed_at__vtype CHECK (vision_ts_ok(completed_at)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT saved_analysis_runs_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT saved_analysis_runs_check CHECK ((status IN ('completed', 'partial')) = (result_json IS NOT NULL)),
  CONSTRAINT saved_analysis_runs_check1 CHECK ((status IN ('failed', 'cancelled')) = (error_json IS NOT NULL)),
  CONSTRAINT saved_analysis_runs_definition_version_check CHECK (definition_version > 0),
  CONSTRAINT saved_analysis_runs_status_check CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  CONSTRAINT saved_analysis_runs_saved_analysis_id_definition_version_fkey FOREIGN KEY (saved_analysis_id, definition_version) REFERENCES saved_analysis_definition_versions(saved_analysis_id, version),
  CONSTRAINT saved_analysis_runs_saved_analysis_id_fkey FOREIGN KEY (saved_analysis_id) REFERENCES saved_analyses(id) ON DELETE CASCADE
);

CREATE TABLE saved_chart_categories (
  saved_chart_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  CONSTRAINT pk_saved_chart_categories PRIMARY KEY (saved_chart_id, category_id),
  CONSTRAINT fk_saved_chart_categories_chart FOREIGN KEY (saved_chart_id) REFERENCES saved_charts(id) ON DELETE CASCADE,
  CONSTRAINT fk_saved_chart_categories_entity FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE saved_chart_recipients (
  saved_chart_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  CONSTRAINT pk_saved_chart_recipients PRIMARY KEY (saved_chart_id, recipient_id),
  CONSTRAINT fk_saved_chart_recipients_chart FOREIGN KEY (saved_chart_id) REFERENCES saved_charts(id) ON DELETE CASCADE,
  CONSTRAINT fk_saved_chart_recipients_entity FOREIGN KEY (recipient_id) REFERENCES recipients(id) ON DELETE CASCADE
);

CREATE TABLE saved_chart_tags (
  saved_chart_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  CONSTRAINT pk_saved_chart_tags PRIMARY KEY (saved_chart_id, tag_id),
  CONSTRAINT fk_saved_chart_tags_chart FOREIGN KEY (saved_chart_id) REFERENCES saved_charts(id) ON DELETE CASCADE,
  CONSTRAINT fk_saved_chart_tags_entity FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE saved_charts (
  id INTEGER CONSTRAINT saved_charts_pkey PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  chart_type TEXT NOT NULL DEFAULT 'line',
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT saved_charts_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT saved_charts_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  chart_variant TEXT NOT NULL DEFAULT 'default',
  time_bucket TEXT NOT NULL DEFAULT 'monthly',
  date_range_start DATE_TEXT
    CONSTRAINT saved_charts_date_range_start__vtype CHECK (vision_date_ok(date_range_start)),
  date_range_end DATE_TEXT
    CONSTRAINT saved_charts_date_range_end__vtype CHECK (vision_date_ok(date_range_end)),
  all_categories BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT saved_charts_all_categories__vtype CHECK (all_categories IN (0, 1)),
  all_recipients BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT saved_charts_all_recipients__vtype CHECK (all_recipients IN (0, 1)),
  all_tags BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT saved_charts_all_tags__vtype CHECK (all_tags IN (0, 1))
);

CREATE TABLE split_payments (
  id INTEGER CONSTRAINT split_payments_pkey PRIMARY KEY AUTOINCREMENT,
  split_id INTEGER NOT NULL,
  amount DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT split_payments_amount__vtype CHECK (vision_numeric_ok(amount, 18, 4)),
  paid_at DATE_TEXT NOT NULL DEFAULT (today())
    CONSTRAINT split_payments_paid_at__vtype CHECK (vision_date_ok(paid_at)),
  note TEXT,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT split_payments_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT chk_split_payment_amount_positive CHECK (dec_gt(amount, 0)),
  CONSTRAINT split_payments_split_id_fkey FOREIGN KEY (split_id) REFERENCES transaction_splits(id) ON DELETE CASCADE
);

CREATE TABLE tags (
  id INTEGER CONSTRAINT tags_pkey PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  color TEXT,
  is_active BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT tags_is_active__vtype CHECK (is_active IN (0, 1)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT tags_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT tags_updated_at__vtype CHECK (vision_ts_ok(updated_at))
);

CREATE TABLE transaction_source_links (
  id BIGINT CONSTRAINT transaction_source_links_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('transaction_source_links_id_seq')),
  source_record_id BIGINT NOT NULL,
  transaction_id INTEGER,
  legacy_transaction_id INTEGER,
  link_status TEXT NOT NULL,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT transaction_source_links_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT transaction_source_links_link_status_check CHECK (link_status IN ('linked', 'dangling-reference')),
  CONSTRAINT transaction_source_links_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES transaction_source_records(id) ON DELETE CASCADE,
  CONSTRAINT transaction_source_links_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
);

CREATE TABLE transaction_source_records (
  id BIGINT CONSTRAINT transaction_source_records_pkey PRIMARY KEY NOT NULL DEFAULT (nextval('transaction_source_records_id_seq')),
  source_type TEXT NOT NULL,
  legacy_source_id BIGINT NOT NULL,
  recorded_at TIMESTAMPTZ_TEXT NOT NULL
    CONSTRAINT transaction_source_records_recorded_at__vtype CHECK (vision_ts_ok(recorded_at)),
  deduplication_hash TEXT,
  raw_csv_line TEXT,
  native_payload JSONB_TEXT NOT NULL
    CONSTRAINT transaction_source_records_native_payload__vtype CHECK (vision_jsonb_ok(native_payload)),
  migration_status TEXT NOT NULL DEFAULT 'linked',
  migrated_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT transaction_source_records_migrated_at__vtype CHECK (vision_ts_ok(migrated_at)),
  CONSTRAINT transaction_source_records_migration_status_check CHECK (migration_status IN ('linked', 'unlinked', 'dangling-reference'))
);

CREATE TABLE transaction_splits (
  id INTEGER CONSTRAINT transaction_splits_pkey PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  amount DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT transaction_splits_amount__vtype CHECK (vision_numeric_ok(amount, 18, 4)),
  note TEXT,
  is_settled BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT transaction_splits_is_settled__vtype CHECK (is_settled IN (0, 1)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT transaction_splits_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT transaction_splits_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  CONSTRAINT chk_split_amount_positive CHECK (dec_gt(amount, 0)),
  CONSTRAINT transaction_splits_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES recipients(id) ON DELETE CASCADE,
  CONSTRAINT transaction_splits_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE TABLE transaction_tags (
  transaction_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT transaction_tags_created_at__vtype CHECK (vision_ts_ok(created_at)),
  CONSTRAINT transaction_tags_pkey PRIMARY KEY (transaction_id, tag_id),
  CONSTRAINT transaction_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
  CONSTRAINT transaction_tags_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE TABLE transactions (
  id INTEGER CONSTRAINT transactions_pkey PRIMARY KEY AUTOINCREMENT,
  date DATE_TEXT NOT NULL
    CONSTRAINT transactions_date__vtype CHECK (vision_date_ok(date)),
  amount DECIMAL_TEXT(18,4) NOT NULL
    CONSTRAINT transactions_amount__vtype CHECK (vision_numeric_ok(amount, 18, 4)),
  currency TEXT NOT NULL DEFAULT 'EUR'
    CONSTRAINT transactions_currency__vtype CHECK (length(currency) <= 3),
  balance DECIMAL_TEXT(18,4)
    CONSTRAINT transactions_balance__vtype CHECK (vision_numeric_ok(balance, 18, 4)),
  memo TEXT,
  comment TEXT,
  recipient_id INTEGER NOT NULL,
  recipient_bank_account_id INTEGER,
  category_id INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT 1
    CONSTRAINT transactions_is_active__vtype CHECK (is_active IN (0, 1)),
  created_at TIMESTAMPTZ_TEXT DEFAULT (now())
    CONSTRAINT transactions_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT transactions_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  import_batch_id BIGINT,
  matched_pattern_id INTEGER,
  is_transfer BOOLEAN NOT NULL DEFAULT 0
    CONSTRAINT transactions_is_transfer__vtype CHECK (is_transfer IN (0, 1)),
  transfer_peer_id INTEGER,
  transfer_source TEXT,
  account_id INTEGER,
  source_record_hash TEXT
    CONSTRAINT transactions_source_record_hash__vtype CHECK (length(source_record_hash) <= 64),
  dedup_fingerprint TEXT
    CONSTRAINT transactions_dedup_fingerprint__vtype CHECK (length(dedup_fingerprint) <= 64),
  dedup_fingerprint_version INTEGER,
  bank_sequence DECIMAL_TEXT(18,0)
    CONSTRAINT transactions_bank_sequence__vtype CHECK (vision_numeric_ok(bank_sequence, 18, 0)),
  CONSTRAINT chk_transactions_bank_sequence CHECK (dec_ge(bank_sequence, 0)),
  CONSTRAINT chk_transactions_currency_iso CHECK (currency REGEXP '^[A-Z]{3}$'),
  CONSTRAINT chk_transactions_dedup_fingerprint CHECK ((dedup_fingerprint IS NULL) OR (dedup_fingerprint REGEXP '^[0-9a-f]{64}$')),
  CONSTRAINT chk_transactions_dedup_pair CHECK ((dedup_fingerprint IS NULL) = (dedup_fingerprint_version IS NULL)),
  CONSTRAINT chk_transactions_dedup_version CHECK ((dedup_fingerprint_version IS NULL) OR (dedup_fingerprint_version > 0)),
  CONSTRAINT chk_transactions_source_record_hash CHECK ((source_record_hash IS NULL) OR (source_record_hash REGEXP '^[0-9a-f]{64}$')),
  CONSTRAINT chk_transactions_transfer_source CHECK ((transfer_source IS NULL) OR (transfer_source IN ('auto', 'manual', 'opening', 'adjustment', 'brokerage'))),
  CONSTRAINT fk_transactions_transfer_peer FOREIGN KEY (transfer_peer_id) REFERENCES transactions(id) ON DELETE SET NULL,
  CONSTRAINT transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT transactions_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  CONSTRAINT transactions_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL,
  CONSTRAINT transactions_matched_pattern_id_fkey FOREIGN KEY (matched_pattern_id) REFERENCES recipient_match_patterns(id) ON DELETE SET NULL,
  CONSTRAINT transactions_recipient_bank_account_id_fkey FOREIGN KEY (recipient_bank_account_id) REFERENCES recipient_bank_accounts(id),
  CONSTRAINT transactions_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES recipients(id)
);

CREATE TABLE transfer_dismissals (
  txn_a_id INTEGER NOT NULL,
  txn_b_id INTEGER NOT NULL,
  dismissed_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT transfer_dismissals_dismissed_at__vtype CHECK (vision_ts_ok(dismissed_at)),
  CONSTRAINT transfer_dismissals_pkey PRIMARY KEY (txn_a_id, txn_b_id),
  CONSTRAINT chk_transfer_dismissals_ordered CHECK (txn_a_id < txn_b_id),
  CONSTRAINT transfer_dismissals_txn_a_id_fkey FOREIGN KEY (txn_a_id) REFERENCES transactions(id) ON DELETE CASCADE,
  CONSTRAINT transfer_dismissals_txn_b_id_fkey FOREIGN KEY (txn_b_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE TABLE user_settings (
  "key" TEXT CONSTRAINT user_settings_pkey PRIMARY KEY NOT NULL,
  value JSONB_TEXT NOT NULL DEFAULT '{}'
    CONSTRAINT user_settings_value__vtype CHECK (vision_jsonb_ok(value)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT user_settings_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT user_settings_created_at__vtype CHECK (vision_ts_ok(created_at))
);

CREATE TABLE watchlist (
  id INTEGER CONSTRAINT watchlist_pkey PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
    CONSTRAINT watchlist_name__vtype CHECK (length(name) <= 200),
  symbol TEXT
    CONSTRAINT watchlist_symbol__vtype CHECK (length(symbol) <= 20),
  asset_class TEXT NOT NULL
    CONSTRAINT watchlist_asset_class__vtype CHECK (asset_class IN ('stock', 'etf', 'crypto', 'metals', 'real_estate', 'savings', 'bond')),
  target_price DECIMAL_TEXT(18,6) NOT NULL
    CONSTRAINT watchlist_target_price__vtype CHECK (vision_numeric_ok(target_price, 18, 6)),
  currency TEXT NOT NULL DEFAULT 'EUR'
    CONSTRAINT watchlist_currency__vtype CHECK (length(currency) <= 10),
  notes TEXT,
  price_provider_id TEXT
    CONSTRAINT watchlist_price_provider_id__vtype CHECK (length(price_provider_id) <= 200),
  created_at TIMESTAMPTZ_TEXT NOT NULL DEFAULT (now())
    CONSTRAINT watchlist_created_at__vtype CHECK (vision_ts_ok(created_at)),
  updated_at TIMESTAMPTZ_TEXT NOT NULL ON CONFLICT REPLACE DEFAULT (now())
    CONSTRAINT watchlist_updated_at__vtype CHECK (vision_ts_ok(updated_at)),
  added_price DECIMAL_TEXT(18,6)
    CONSTRAINT watchlist_added_price__vtype CHECK (vision_numeric_ok(added_price, 18, 6))
);

-- ============================================================================
-- Former materialized views (caches materializedViewService refills with DELETE + INSERT ... SELECT; no foreign keys)
-- ============================================================================

CREATE TABLE mv_category_totals (
  category_id INTEGER NOT NULL,
  name TEXT,
  count BIGINT,
  total DECIMAL_TEXT
    CONSTRAINT mv_category_totals_total__vtype CHECK (vision_numeric_ok(total, NULL, NULL)),
  currency TEXT
    CONSTRAINT mv_category_totals_currency__vtype CHECK (length(currency) <= 3)
);

CREATE TABLE mv_monthly_summary (
  month_start DATE_TEXT
    CONSTRAINT mv_monthly_summary_month_start__vtype CHECK (vision_date_ok(month_start)),
  month INTEGER,
  year INTEGER,
  currency TEXT
    CONSTRAINT mv_monthly_summary_currency__vtype CHECK (length(currency) <= 3),
  transaction_count BIGINT,
  total_income DECIMAL_TEXT
    CONSTRAINT mv_monthly_summary_total_income__vtype CHECK (vision_numeric_ok(total_income, NULL, NULL)),
  total_spending DECIMAL_TEXT
    CONSTRAINT mv_monthly_summary_total_spending__vtype CHECK (vision_numeric_ok(total_spending, NULL, NULL)),
  net_amount DECIMAL_TEXT
    CONSTRAINT mv_monthly_summary_net_amount__vtype CHECK (vision_numeric_ok(net_amount, NULL, NULL)),
  category_id INTEGER,
  category_id_key INTEGER NOT NULL,
  category_name TEXT
);

CREATE UNIQUE INDEX idx_mv_category_totals ON mv_category_totals (category_id, currency);
CREATE UNIQUE INDEX idx_mv_monthly_summary ON mv_monthly_summary (month_start, currency, category_id_key);

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE UNIQUE INDEX uq_accounts_import_identity ON accounts (import_identity);
CREATE UNIQUE INDEX uq_accounts_name_norm ON accounts (lower(btrim(name)));

CREATE INDEX idx_agg_split_outstanding_open ON agg_split_outstanding (recipient_id) WHERE dec_ne(outstanding_amount, 0);
CREATE INDEX idx_agg_split_outstanding_recipient ON agg_split_outstanding (recipient_id);

CREATE INDEX idx_ai_conversations_updated_at ON ai_conversations (updated_at DESC);

CREATE INDEX idx_ai_investigation_jobs_state_updated ON ai_investigation_jobs (state, updated_at DESC);

CREATE INDEX idx_ai_messages_conv_created ON ai_messages (conversation_id, created_at);

CREATE UNIQUE INDEX ai_research_documents_source_name_content_sha256_key ON ai_research_documents (source_name, content_sha256);
CREATE UNIQUE INDEX ai_research_documents_source_name_version_key ON ai_research_documents (source_name, version);

CREATE UNIQUE INDEX ai_research_passages_document_id_ordinal_key ON ai_research_passages (document_id, ordinal);
CREATE INDEX idx_ai_research_passages_document ON ai_research_passages (document_id, ordinal);

CREATE UNIQUE INDEX analysis_monitor_notifications_monitor_id_episode_key_key ON analysis_monitor_notifications (monitor_id, episode_key);
CREATE UNIQUE INDEX analysis_monitor_notifications_observation_id_key ON analysis_monitor_notifications (observation_id);
CREATE INDEX idx_analysis_monitor_notifications_inbox ON analysis_monitor_notifications (created_at DESC, id DESC);

CREATE INDEX idx_analysis_monitor_observations_history ON analysis_monitor_observations (monitor_id, checked_at DESC, id DESC);

CREATE INDEX idx_analysis_monitors_dossier ON analysis_monitors (dossier_id) WHERE dossier_id IS NOT NULL;
CREATE INDEX idx_analysis_monitors_due ON analysis_monitors (next_due_at, id) WHERE enabled;
CREATE INDEX idx_analysis_monitors_saved_analysis ON analysis_monitors (saved_analysis_id) WHERE saved_analysis_id IS NOT NULL;

CREATE UNIQUE INDEX uq_asset_price_history_investment_date ON asset_price_history (investment_id, price_date);
CREATE INDEX idx_asset_price_history_date ON asset_price_history (price_date);

CREATE INDEX idx_attachments_transaction_id ON attachments (transaction_id);

CREATE UNIQUE INDEX belgian_inflation_rates_month_date_key ON belgian_inflation_rates (month_date);
CREATE INDEX idx_belgian_inflation_month_date ON belgian_inflation_rates (month_date);

CREATE UNIQUE INDEX uq_cfa_user_method_month ON cashflow_forecast_accuracy (user_id, method_id, as_of_month);
CREATE INDEX idx_cfa_as_of_month ON cashflow_forecast_accuracy (as_of_month);
CREATE INDEX idx_cfa_user_method ON cashflow_forecast_accuracy (user_id, method_id);

CREATE UNIQUE INDEX cashflow_forecast_mc_user_id_month_filter_hash_key ON cashflow_forecast_mc (user_id, month, filter_hash);
CREATE INDEX idx_cfmc_user_month ON cashflow_forecast_mc (user_id, month);

CREATE UNIQUE INDEX cashflow_forecast_mc_rolling_user_id_today_iso_days_back_da_key ON cashflow_forecast_mc_rolling (user_id, today_iso, days_back, days_forward, filter_hash);
CREATE INDEX idx_cfmcr_user_today ON cashflow_forecast_mc_rolling (user_id, today_iso);

CREATE UNIQUE INDEX uq_general_detail ON categories (general, detail);
CREATE INDEX idx_categories_detail ON categories (detail);
CREATE INDEX idx_categories_general ON categories (general);
CREATE INDEX idx_categories_parent_id ON categories (parent_id);
CREATE UNIQUE INDEX uq_categories_root_name ON categories (name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX uq_categories_sibling_name ON categories (parent_id, name) WHERE parent_id IS NOT NULL;

CREATE INDEX idx_category_merge_aliases_target ON category_merge_aliases (target_category_id);

CREATE UNIQUE INDEX uq_custom_parser_configs_name_kind ON custom_parser_configs (name, kind);

CREATE UNIQUE INDEX uq_currency_date ON exchange_rates (currency_code, rate_date);
CREATE INDEX idx_exchange_rates_currency ON exchange_rates (currency_code);
CREATE INDEX idx_exchange_rates_date ON exchange_rates (rate_date);
CREATE INDEX idx_exchange_rates_latest ON exchange_rates (is_latest);

CREATE INDEX idx_import_batches_started_at ON import_batches (started_at DESC);
CREATE INDEX idx_import_batches_status ON import_batches (status) WHERE status NOT IN ('complete', 'failed', 'aborted');

CREATE INDEX idx_import_staging_rows_dedup_fingerprint ON import_staging_rows (batch_id, dedup_fingerprint_version, dedup_fingerprint) WHERE dedup_fingerprint IS NOT NULL;
CREATE INDEX idx_import_staging_rows_matched_pattern_id ON import_staging_rows (matched_pattern_id) WHERE matched_pattern_id IS NOT NULL;
CREATE INDEX idx_import_staging_rows_resolved_recipient_id ON import_staging_rows (resolved_recipient_id) WHERE resolved_recipient_id IS NOT NULL;
CREATE INDEX idx_import_staging_rows_user_override_recipient_id ON import_staging_rows (user_override_recipient_id) WHERE user_override_recipient_id IS NOT NULL;
CREATE INDEX idx_staging_batch_status ON import_staging_rows (batch_id, status);
CREATE INDEX idx_staging_override_category ON import_staging_rows (override_category_id) WHERE override_category_id IS NOT NULL;

CREATE UNIQUE INDEX uq_insight_dismissals_outlier ON insight_dismissals (category_id, month_start) WHERE kind = 'category_outlier';
CREATE UNIQUE INDEX uq_insight_dismissals_subscription ON insight_dismissals (kind, recipient_id) WHERE kind IN ('subscription_new', 'subscription_price_change');

CREATE INDEX idx_instrument_provider_map_provider_symbol ON instrument_provider_map (provider, provider_symbol);
CREATE UNIQUE INDEX uq_instrument_provider_map_key_provider ON instrument_provider_map (instrument_key, key_type, provider);

CREATE INDEX idx_investments_asset_class ON investments (asset_class);
CREATE INDEX idx_investments_is_active ON investments (is_active);

CREATE INDEX idx_pte_executed_tx_id ON planned_transaction_executions (executed_transaction_id);
CREATE INDEX idx_pte_planned_id ON planned_transaction_executions (planned_transaction_id);
CREATE UNIQUE INDEX uq_pte_planned_executed ON planned_transaction_executions (planned_transaction_id, executed_transaction_id);

CREATE UNIQUE INDEX uq_ptls_planned_installment ON planned_transaction_loan_schedule (planned_transaction_id, installment_number);
CREATE INDEX idx_ptls_due_date ON planned_transaction_loan_schedule (due_date);
CREATE INDEX idx_ptls_planned_transaction_id ON planned_transaction_loan_schedule (planned_transaction_id);

CREATE INDEX idx_planned_transaction_tags_tag ON planned_transaction_tags (tag_id);

CREATE INDEX idx_planned_active_executed_date ON planned_transactions (is_active, is_executed, planned_date);
CREATE INDEX idx_planned_transactions_account_id ON planned_transactions (account_id);
CREATE INDEX idx_pt_category_id ON planned_transactions (category_id);
CREATE INDEX idx_pt_is_active ON planned_transactions (is_active);
CREATE INDEX idx_pt_is_executed ON planned_transactions (is_executed);
CREATE INDEX idx_pt_is_loan ON planned_transactions (is_loan);
CREATE INDEX idx_pt_is_recurring ON planned_transactions (is_recurring);
CREATE INDEX idx_pt_planned_date ON planned_transactions (planned_date);
CREATE INDEX idx_pt_recipient_id ON planned_transactions (recipient_id);

CREATE UNIQUE INDEX portfolio_asset_adjustments_dedup_fingerprint_version_dedup_key ON portfolio_asset_adjustments (dedup_fingerprint_version, dedup_fingerprint);
CREATE UNIQUE INDEX portfolio_asset_adjustments_staging_row_id_key ON portfolio_asset_adjustments (staging_row_id);
CREATE INDEX idx_portfolio_asset_adjustments_batch ON portfolio_asset_adjustments (import_batch_id);
CREATE INDEX idx_portfolio_asset_adjustments_replay ON portfolio_asset_adjustments (investment_id, date, id);

CREATE UNIQUE INDEX portfolio_asset_transfers_dedup_fingerprint_version_dedup_f_key ON portfolio_asset_transfers (dedup_fingerprint_version, dedup_fingerprint);
CREATE UNIQUE INDEX portfolio_asset_transfers_staging_row_id_key ON portfolio_asset_transfers (staging_row_id);
CREATE INDEX idx_portfolio_asset_transfers_batch ON portfolio_asset_transfers (import_batch_id);
CREATE INDEX idx_portfolio_asset_transfers_replay ON portfolio_asset_transfers (investment_id, date, id);

CREATE INDEX idx_portfolio_broker_snapshots_currency_date ON portfolio_broker_snapshots (currency, snapshot_date);

CREATE UNIQUE INDEX uq_portfolio_exposure_classification_identifier ON portfolio_exposure_classifications (identifier_type, identifier_value, COALESCE(identifier_exchange, '')) WHERE investment_id IS NULL;
CREATE UNIQUE INDEX uq_portfolio_exposure_classification_investment ON portfolio_exposure_classifications (investment_id) WHERE investment_id IS NOT NULL;

CREATE UNIQUE INDEX portfolio_fund_holdings_documents_investment_id_key ON portfolio_fund_holdings_documents (investment_id);
CREATE INDEX idx_portfolio_fund_holdings_as_of ON portfolio_fund_holdings_documents (source_as_of_date DESC);

CREATE INDEX idx_portfolio_import_batches_account_id ON portfolio_import_batches (account_id);
CREATE INDEX idx_portfolio_import_batches_started_at ON portfolio_import_batches (started_at DESC);
CREATE INDEX idx_portfolio_import_batches_status ON portfolio_import_batches (status) WHERE status NOT IN ('complete', 'failed', 'aborted');

CREATE UNIQUE INDEX portfolio_import_duplicate_repair_journal_previous_entry_id_key ON portfolio_import_duplicate_repair_journal (previous_entry_id);
CREATE INDEX idx_portfolio_import_duplicate_repair_batch ON portfolio_import_duplicate_repair_journal (batch_id, "action");
CREATE UNIQUE INDEX uq_portfolio_import_duplicate_repair_source ON portfolio_import_duplicate_repair_journal (staging_row_id) WHERE "action" = 'repair';

CREATE UNIQUE INDEX portfolio_import_income_recognition_journ_previous_entry_id_key ON portfolio_import_income_recognition_journal (previous_entry_id);
CREATE INDEX idx_portfolio_income_batch ON portfolio_import_income_recognition_journal (batch_id, "action");
CREATE INDEX idx_portfolio_income_unit ON portfolio_import_income_recognition_journal (unit_transaction_id, "action");
CREATE UNIQUE INDEX uq_portfolio_income_source ON portfolio_import_income_recognition_journal (staging_row_id) WHERE "action" = 'record';
CREATE UNIQUE INDEX uq_portfolio_income_transaction ON portfolio_import_income_recognition_journal (income_transaction_id) WHERE "action" = 'record';

CREATE UNIQUE INDEX portfolio_import_reconciliation_journal_previous_entry_id_key ON portfolio_import_reconciliation_journal (previous_entry_id);
CREATE INDEX idx_portfolio_import_reconciliation_batch ON portfolio_import_reconciliation_journal (batch_id, "action");
CREATE UNIQUE INDEX uq_portfolio_import_adoption_source ON portfolio_import_reconciliation_journal (staging_row_id) WHERE "action" = 'adopt';

CREATE INDEX idx_pf_staging_batch_status ON portfolio_import_staging_rows (batch_id, status);
CREATE INDEX idx_portfolio_import_staging_rows_dedup_fingerprint ON portfolio_import_staging_rows (batch_id, dedup_fingerprint_version, dedup_fingerprint) WHERE dedup_fingerprint IS NOT NULL;
CREATE INDEX idx_portfolio_import_staging_rows_resolved_investment_id ON portfolio_import_staging_rows (resolved_investment_id) WHERE resolved_investment_id IS NOT NULL;
CREATE INDEX idx_portfolio_import_staging_rows_user_override_investment_id ON portfolio_import_staging_rows (user_override_investment_id) WHERE user_override_investment_id IS NOT NULL;

CREATE UNIQUE INDEX uq_pps_date_currency ON portfolio_performance_snapshots (snapshot_date, currency);
CREATE INDEX idx_portfolio_performance_snapshots_currency ON portfolio_performance_snapshots (currency);

CREATE INDEX idx_snapshot_accounts_currency_date ON portfolio_snapshot_accounts (currency, snapshot_date);

CREATE INDEX idx_portfolio_transactions_account_id ON portfolio_transactions (account_id);
CREATE INDEX idx_portfolio_transactions_import_batch_id ON portfolio_transactions (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX idx_portfolio_txn_date ON portfolio_transactions (date);
CREATE INDEX idx_portfolio_txn_investment_id ON portfolio_transactions (investment_id);
CREATE INDEX idx_portfolio_txn_type ON portfolio_transactions (type);
CREATE INDEX idx_ptxn_investment_account ON portfolio_transactions (investment_id, account_id);
CREATE INDEX idx_ptxn_investment_date_id ON portfolio_transactions (investment_id, date, id);
CREATE UNIQUE INDEX uq_portfolio_transactions_dedup_fingerprint ON portfolio_transactions (dedup_fingerprint_version, dedup_fingerprint) WHERE dedup_fingerprint IS NOT NULL;

CREATE INDEX idx_ph_kind ON provider_health (kind);

CREATE UNIQUE INDEX recipient_bank_accounts_account_number_key ON recipient_bank_accounts (account_number);
CREATE INDEX idx_rba_recipient_id ON recipient_bank_accounts (recipient_id);
CREATE UNIQUE INDEX uq_recipient_primary_account ON recipient_bank_accounts (recipient_id) WHERE is_primary;

CREATE INDEX idx_rmp_active_priority ON recipient_match_patterns (priority) WHERE is_active = 1;
CREATE INDEX idx_rmp_recipient ON recipient_match_patterns (recipient_id);

CREATE UNIQUE INDEX recipients_normalized_name_key ON recipients (normalized_name);
CREATE INDEX idx_recipients_default_category_id ON recipients (default_category_id);
CREATE INDEX idx_recipients_name ON recipients (name);
CREATE INDEX idx_recipients_primary_recipient_id ON recipients (primary_recipient_id);

CREATE INDEX idx_research_dossier_links_category ON research_dossier_links (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX idx_research_dossier_links_investment ON research_dossier_links (investment_id) WHERE investment_id IS NOT NULL;
CREATE INDEX idx_research_dossier_links_saved_analysis ON research_dossier_links (saved_analysis_id) WHERE saved_analysis_id IS NOT NULL;

CREATE INDEX idx_research_dossiers_workspace_updated ON research_dossiers (workspace, updated_at DESC, id);

CREATE UNIQUE INDEX saved_analyses_definition_id_key ON saved_analyses (definition_id);
CREATE INDEX idx_saved_analyses_workspace_updated ON saved_analyses (workspace, updated_at DESC);

CREATE INDEX idx_saved_analysis_runs_analysis_created ON saved_analysis_runs (saved_analysis_id, created_at DESC);

CREATE INDEX idx_saved_chart_categories_category ON saved_chart_categories (category_id);

CREATE INDEX idx_saved_chart_recipients_recipient ON saved_chart_recipients (recipient_id);

CREATE INDEX idx_saved_chart_tags_tag ON saved_chart_tags (tag_id);

CREATE INDEX idx_split_payments_split ON split_payments (split_id);

CREATE INDEX idx_tags_active ON tags (is_active) WHERE is_active = 1;
CREATE UNIQUE INDEX uq_tags_slug ON tags (slug);

CREATE UNIQUE INDEX uq_transaction_source_link ON transaction_source_links (source_record_id, legacy_transaction_id);
CREATE INDEX idx_transaction_source_links_transaction_id ON transaction_source_links (transaction_id) WHERE transaction_id IS NOT NULL;

CREATE UNIQUE INDEX uq_transaction_source_record ON transaction_source_records (source_type, legacy_source_id);
CREATE INDEX idx_transaction_source_records_hash ON transaction_source_records (source_type, deduplication_hash) WHERE deduplication_hash IS NOT NULL;

CREATE INDEX idx_splits_recipient ON transaction_splits (recipient_id);
CREATE INDEX idx_splits_transaction ON transaction_splits (transaction_id);
CREATE INDEX idx_splits_unsettled ON transaction_splits (is_settled) WHERE is_settled = 0;

CREATE INDEX idx_transaction_tags_tag ON transaction_tags (tag_id);

CREATE INDEX idx_transaction_date_recipient ON transactions (date, recipient_id);
CREATE INDEX idx_transactions_abs_amount_date ON transactions (dec_abs(amount), date);
CREATE INDEX idx_transactions_account_date_active ON transactions (account_id, date DESC) WHERE is_active = 1;
CREATE INDEX idx_transactions_account_id ON transactions (account_id);
CREATE INDEX idx_transactions_account_stamped ON transactions (account_id, date DESC, id DESC) WHERE (is_active = 1) AND (balance IS NOT NULL);
CREATE INDEX idx_transactions_active ON transactions (date DESC, id DESC) WHERE is_active = 1;
CREATE INDEX idx_transactions_amount_date ON transactions (amount, date);
CREATE INDEX idx_transactions_bank_chronology ON transactions (account_id, currency, date DESC, dec_key(coalesce(bank_sequence, dec_add('1000000000000000000000000000000', id))) DESC, id DESC) WHERE is_active = 1;
CREATE INDEX idx_transactions_category_date ON transactions (category_id, date DESC);
CREATE INDEX idx_transactions_category_date_active ON transactions (category_id, date DESC) WHERE is_active = 1;
CREATE INDEX idx_transactions_category_id ON transactions (category_id);
CREATE INDEX idx_transactions_category_recipient_active ON transactions (category_id, recipient_id) WHERE is_active = 1;
CREATE INDEX idx_transactions_import_batch_id ON transactions (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX idx_transactions_matched_pattern ON transactions (matched_pattern_id) WHERE matched_pattern_id IS NOT NULL;
CREATE INDEX idx_transactions_recipient_bank_account_id ON transactions (recipient_bank_account_id);
CREATE INDEX idx_transactions_recipient_date ON transactions (recipient_id, date DESC);
CREATE INDEX idx_transactions_recipient_date_active ON transactions (recipient_id, date DESC) WHERE is_active = 1;
CREATE INDEX idx_transactions_recipient_id ON transactions (recipient_id);
CREATE INDEX idx_transactions_transfer_peer ON transactions (transfer_peer_id) WHERE transfer_peer_id IS NOT NULL;
CREATE UNIQUE INDEX uq_transactions_dedup_fingerprint ON transactions (dedup_fingerprint_version, dedup_fingerprint) WHERE dedup_fingerprint IS NOT NULL;
CREATE UNIQUE INDEX uq_transactions_opening_anchor ON transactions (account_id, currency) WHERE transfer_source = 'opening';

CREATE INDEX idx_transfer_dismissals_b ON transfer_dismissals (txn_b_id);

CREATE INDEX idx_watchlist_asset_class ON watchlist (asset_class);

-- ============================================================================
-- Views
-- ============================================================================
-- PostgreSQL's vision_analysis schema becomes the vision_analysis_ name prefix.
-- A view column that names a table column keeps that column's declared type,
-- so the driver reads it as it did from PostgreSQL. A computed column has no
-- declared type: ids and names of category_paths, the category_path_segments
-- and category_path_ids columns built from them, and
-- vision_analysis_accounts_v1.statement_balances hold JSON text, which a
-- caller reads with a "::json" alias hint.

-- Every (category, ancestor) pair; a category is its own ancestor at distance 0.
CREATE VIEW category_ancestors AS
WITH RECURSIVE ancestry(category_id, ancestor_id, distance) AS (
  SELECT categories.id, categories.id, 0
    FROM categories
  UNION ALL
  SELECT a.category_id, c.parent_id, a.distance + 1
    FROM ancestry a
    JOIN categories c ON c.id = a.ancestor_id
   WHERE c.parent_id IS NOT NULL
)
SELECT category_id, ancestor_id, distance
  FROM ancestry;

-- The root-to-leaf path of every category reachable from a root. ids and
-- names are JSON arrays in root-first order (PostgreSQL integer[] and text[]).
CREATE VIEW category_paths AS
WITH RECURSIVE paths(id, parent_id, ids, names, path_name) AS (
  SELECT categories.id, categories.parent_id,
         json_array(categories.id), json_array(categories.name), categories.name
    FROM categories
   WHERE categories.parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id,
         json_insert(p.ids, '$[#]', c.id), json_insert(p.names, '$[#]', c.name),
         p.path_name || ':' || c.name
    FROM categories c
    JOIN paths p ON c.parent_id = p.id
)
SELECT id, parent_id, ids, names, path_name, json_array_length(ids) AS depth
  FROM paths;

CREATE VIEW vision_analysis_accounts_v1 AS
SELECT a.id AS account_id,
       a.name AS account_name,
       a.display_name,
       a.institution,
       a.currency,
       a.type AS account_type,
       a.liquidity_class,
       a.spendable,
       a.in_net_worth,
       a.tax_wrapper,
       a.owner,
       a.multi_currency_cash,
       a.has_cash_sleeve,
       a.funding_account_id,
       a.is_active,
       -- jsonb_agg(... ORDER BY sb.currency): an ordered subquery feeds the
       -- aggregate. Keys follow PostgreSQL's jsonb order; balance is a JSON number.
       (SELECT json_group_array(json(b.balance_json))
          FROM (SELECT json_object('balance', json(sb.balance),
                                   'currency', sb.currency,
                                   'balance_date', sb.balance_date) AS balance_json
                  FROM account_statement_balances sb
                 WHERE sb.account_id = a.id
                 ORDER BY sb.currency) AS b) AS statement_balances,
       a.created_at,
       a.updated_at
  FROM accounts a;

CREATE VIEW vision_analysis_cash_flows_v1 AS
SELECT t.id AS cash_flow_id,
       t.date AS cash_flow_date,
       t.account_id,
       a.name AS account_name,
       t.currency,
       t.amount AS signed_amount,
       CASE
         WHEN t.is_transfer THEN 'transfer'
         WHEN dec_lt(t.amount, 0) THEN 'expense'
         ELSE 'income_or_refund'
       END AS flow_type,
       CASE
         WHEN NOT t.is_transfer AND dec_lt(t.amount, 0) THEN dec_neg(t.amount)
         ELSE '0'
       END AS spending_amount,
       CASE
         WHEN NOT t.is_transfer AND dec_gt(t.amount, 0) THEN t.amount
         ELSE '0'
       END AS positive_flow_amount,
       t.is_transfer,
       t.transfer_peer_id,
       t.recipient_id,
       r.name AS recipient_name,
       t.category_id,
       c.general AS category_general,
       c.detail AS category_detail,
       t.is_active,
       t.updated_at
  FROM transactions t
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN recipients r ON r.id = t.recipient_id
  LEFT JOIN categories c ON c.id = t.category_id;

CREATE VIEW vision_analysis_cash_flows_v2 AS
SELECT v1.cash_flow_id,
       v1.cash_flow_date,
       v1.account_id,
       v1.account_name,
       v1.currency,
       v1.signed_amount,
       v1.flow_type,
       v1.spending_amount,
       v1.positive_flow_amount,
       v1.is_transfer,
       v1.transfer_peer_id,
       v1.recipient_id,
       v1.recipient_name,
       v1.category_id,
       v1.category_general,
       v1.category_detail,
       v1.is_active,
       v1.updated_at,
       c.path_name AS category_path,
       p.names AS category_path_segments,
       p.ids AS category_path_ids
  FROM vision_analysis_cash_flows_v1 v1
  LEFT JOIN categories c ON c.id = v1.category_id
  LEFT JOIN category_paths p ON p.id = v1.category_id;

CREATE VIEW vision_analysis_holding_events_v1 AS
SELECT pt.id AS event_id,
       pt.investment_id,
       i.name AS investment_name,
       i.symbol,
       i.asset_class,
       pt.account_id,
       a.name AS account_name,
       pt.type AS event_type,
       pt.date AS event_date,
       pt.amount,
       pt.units,
       pt.price_per_unit,
       coalesce(pt.fees, '0') AS fees,
       coalesce(pt.taxes, '0') AS taxes,
       pt.currency,
       pt.fx_rate_to_eur,
       pt.is_recurring,
       pt.recurrence_interval,
       pt.recurrence_end_date,
       pt.import_batch_id,
       pt.created_at,
       pt.updated_at
  FROM portfolio_transactions pt
  JOIN investments i ON i.id = pt.investment_id
  LEFT JOIN accounts a ON a.id = pt.account_id;

CREATE VIEW vision_analysis_transactions_v1 AS
SELECT t.id AS transaction_id,
       t.date AS transaction_date,
       t.amount,
       t.currency,
       t.account_id,
       a.name AS account_name,
       a.display_name AS account_display_name,
       t.recipient_id,
       r.name AS recipient_name,
       t.category_id,
       c.general AS category_general,
       c.detail AS category_detail,
       t.memo,
       t.comment,
       t.is_transfer,
       t.transfer_peer_id,
       t.transfer_source,
       t.is_active,
       t.import_batch_id,
       t.created_at,
       t.updated_at
  FROM transactions t
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN recipients r ON r.id = t.recipient_id
  LEFT JOIN categories c ON c.id = t.category_id;

CREATE VIEW vision_analysis_transactions_v2 AS
SELECT v1.transaction_id,
       v1.transaction_date,
       v1.amount,
       v1.currency,
       v1.account_id,
       v1.account_name,
       v1.account_display_name,
       v1.recipient_id,
       v1.recipient_name,
       v1.category_id,
       v1.category_general,
       v1.category_detail,
       v1.memo,
       v1.comment,
       v1.is_transfer,
       v1.transfer_peer_id,
       v1.transfer_source,
       v1.is_active,
       v1.import_batch_id,
       v1.created_at,
       v1.updated_at,
       c.path_name AS category_path,
       p.names AS category_path_segments,
       p.ids AS category_path_ids
  FROM vision_analysis_transactions_v1 v1
  LEFT JOIN categories c ON c.id = v1.category_id
  LEFT JOIN category_paths p ON p.id = v1.category_id;

-- ============================================================================
-- Triggers
-- ============================================================================
-- updated_at NOT NULL on INSERT. The column's NOT NULL is ON CONFLICT REPLACE,
-- so that an UPDATE writing NULL stores now() as update_updated_at_column() did;
-- an INSERT of NULL was refused in PostgreSQL and is refused here. These are
-- created first so they fire after every other BEFORE INSERT trigger, as the
-- NOT NULL check ran after the BEFORE triggers.

CREATE TRIGGER update_accounts_updated_at__insert_not_null
BEFORE INSERT ON accounts FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "accounts" violates not-null constraint');
END;

CREATE TRIGGER update_ai_conversations_updated_at__insert_not_null
BEFORE INSERT ON ai_conversations FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "ai_conversations" violates not-null constraint');
END;

CREATE TRIGGER update_asset_price_history_updated_at__insert_not_null
BEFORE INSERT ON asset_price_history FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "asset_price_history" violates not-null constraint');
END;

CREATE TRIGGER update_belgian_inflation_updated_at__insert_not_null
BEFORE INSERT ON belgian_inflation_rates FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "belgian_inflation_rates" violates not-null constraint');
END;

CREATE TRIGGER update_categories_updated_at__insert_not_null
BEFORE INSERT ON categories FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "categories" violates not-null constraint');
END;

CREATE TRIGGER update_custom_parser_configs_updated_at__insert_not_null
BEFORE INSERT ON custom_parser_configs FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "custom_parser_configs" violates not-null constraint');
END;

CREATE TRIGGER update_exchange_rates_updated_at__insert_not_null
BEFORE INSERT ON exchange_rates FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "exchange_rates" violates not-null constraint');
END;

CREATE TRIGGER update_import_staging_rows_updated_at__insert_not_null
BEFORE INSERT ON import_staging_rows FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "import_staging_rows" violates not-null constraint');
END;

CREATE TRIGGER update_instrument_provider_map_updated_at__insert_not_null
BEFORE INSERT ON instrument_provider_map FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "instrument_provider_map" violates not-null constraint');
END;

CREATE TRIGGER update_investment_ticker_prefs_updated_at__insert_not_null
BEFORE INSERT ON investment_ticker_prefs FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "investment_ticker_prefs" violates not-null constraint');
END;

CREATE TRIGGER update_investments_updated_at__insert_not_null
BEFORE INSERT ON investments FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "investments" violates not-null constraint');
END;

CREATE TRIGGER update_ptls_updated_at__insert_not_null
BEFORE INSERT ON planned_transaction_loan_schedule FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "planned_transaction_loan_schedule" violates not-null constraint');
END;

CREATE TRIGGER update_pt_updated_at__insert_not_null
BEFORE INSERT ON planned_transactions FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "planned_transactions" violates not-null constraint');
END;

CREATE TRIGGER update_portfolio_import_staging_rows_updated_at__insert_not_null
BEFORE INSERT ON portfolio_import_staging_rows FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "portfolio_import_staging_rows" violates not-null constraint');
END;

CREATE TRIGGER update_portfolio_txn_updated_at__insert_not_null
BEFORE INSERT ON portfolio_transactions FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "portfolio_transactions" violates not-null constraint');
END;

CREATE TRIGGER update_provider_api_keys_updated_at__insert_not_null
BEFORE INSERT ON provider_api_keys FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "provider_api_keys" violates not-null constraint');
END;

CREATE TRIGGER update_provider_health_updated_at__insert_not_null
BEFORE INSERT ON provider_health FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "provider_health" violates not-null constraint');
END;

CREATE TRIGGER update_provider_quota_updated_at__insert_not_null
BEFORE INSERT ON provider_quota FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "provider_quota" violates not-null constraint');
END;

CREATE TRIGGER update_rba_updated_at__insert_not_null
BEFORE INSERT ON recipient_bank_accounts FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "recipient_bank_accounts" violates not-null constraint');
END;

CREATE TRIGGER update_recipient_match_patterns_updated_at__insert_not_null
BEFORE INSERT ON recipient_match_patterns FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "recipient_match_patterns" violates not-null constraint');
END;

CREATE TRIGGER update_recipients_updated_at__insert_not_null
BEFORE INSERT ON recipients FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "recipients" violates not-null constraint');
END;

CREATE TRIGGER update_saved_charts_updated_at__insert_not_null
BEFORE INSERT ON saved_charts FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "saved_charts" violates not-null constraint');
END;

CREATE TRIGGER update_tags_updated_at__insert_not_null
BEFORE INSERT ON tags FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "tags" violates not-null constraint');
END;

CREATE TRIGGER update_transaction_splits_updated_at__insert_not_null
BEFORE INSERT ON transaction_splits FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "transaction_splits" violates not-null constraint');
END;

CREATE TRIGGER update_transactions_updated_at__insert_not_null
BEFORE INSERT ON transactions FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "transactions" violates not-null constraint');
END;

CREATE TRIGGER update_user_settings_updated_at__insert_not_null
BEFORE INSERT ON user_settings FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "user_settings" violates not-null constraint');
END;

CREATE TRIGGER update_watchlist_updated_at__insert_not_null
BEFORE INSERT ON watchlist FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "updated_at" of relation "watchlist" violates not-null constraint');
END;

-- Naming: a PostgreSQL trigger that maps to one SQLite trigger keeps its name.
-- One that SQLite must split by event or timing becomes <name>__insert,
-- <name>__update, <name>__delete (and <name>__insert_check/__update_check for
-- the validation half of a split BEFORE trigger).
--
-- Order: SQLite fires the most recently created trigger first. Where several
-- triggers of one table fire on the same event, they are created in the reverse
-- of PostgreSQL's firing order (by name), so they fire in PostgreSQL's order.
--
-- Errors: RAISE(ABORT, 'vision:<sqlstate>:<constraint>:<message>') with the
-- SQLSTATE and message the PL/pgSQL function raised (RAISE EXCEPTION without
-- ERRCODE is P0001). SQLite 3.39 accepts only a string literal in RAISE, so the
-- one message that quotes row values calls vision_raise(sqlstate, constraint,
-- message) from schemaFunctions.ts instead.
--
-- Statement-level PostgreSQL triggers (the insight digest dirty markers) are
-- row-level here: the marker only has to change when rows change, so a
-- statement that touches no row no longer bumps it and one that touches n rows
-- bumps it n times.
--
-- BEFORE triggers that assigned NEW.<column> are AFTER triggers that UPDATE the
-- row, because a SQLite BEFORE trigger cannot change NEW. RETURNING does not
-- see what they write:
--   update_*_updated_at (updated_at = now(); the Kysely write plugin also sets
--     updated_at in the statement, so RETURNING sees the same value),
--   trg_categories_0_sync_legacy__insert/__update (parent_id and name of a
--     legacy category).

-- ---------------------------------------------------------------------------
-- ai_messages
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_ai_messages_touch_conversation
AFTER INSERT ON ai_messages FOR EACH ROW
BEGIN
  UPDATE ai_conversations SET updated_at = now() WHERE id = NEW.conversation_id;
END;

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
-- PostgreSQL order: trg_categories_0_sync_legacy, trg_categories_acyclic
-- (BEFORE), trg_categories_refresh_path_names (AFTER ROW),
-- trg_categories_insight_digest_dirty (AFTER STATEMENT).

-- name is NOT NULL, but a legacy category is inserted without one and takes
-- its detail (category_sync_legacy_row). The column default is the
-- placeholder '__LEGACY_NAME_PENDING__', which trg_categories_0_sync_legacy__insert
-- replaces; a non-legacy row that leaves name out is refused as PostgreSQL's
-- NOT NULL refused it.
CREATE TRIGGER trg_categories_name_required
BEFORE INSERT ON categories FOR EACH ROW
WHEN NOT NEW.legacy_compatible AND NEW.name = '__LEGACY_NAME_PENDING__'
BEGIN
  SELECT RAISE(ABORT, 'vision:23502::null value in column "name" of relation "categories" violates not-null constraint');
END;

-- category_assert_acyclic(): the new parent must not have the row among its
-- ancestors. UNION (not UNION ALL) also ends the walk on corrupt cyclic data.
CREATE TRIGGER trg_categories_acyclic__insert
BEFORE INSERT ON categories FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23514::Category hierarchy cycle is not allowed')
   WHERE EXISTS (
     WITH RECURSIVE ancestors(id, parent_id) AS (
       SELECT id, parent_id FROM categories WHERE id = NEW.parent_id
       UNION
       SELECT p.id, p.parent_id FROM categories p JOIN ancestors a ON p.id = a.parent_id
     )
     SELECT 1 FROM ancestors WHERE id = NEW.id);
END;

CREATE TRIGGER trg_categories_acyclic__update
BEFORE UPDATE OF parent_id ON categories FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'vision:23514::Category hierarchy cycle is not allowed')
   WHERE EXISTS (
     WITH RECURSIVE ancestors(id, parent_id) AS (
       SELECT id, parent_id FROM categories WHERE id = NEW.parent_id
       UNION
       SELECT p.id, p.parent_id FROM categories p JOIN ancestors a ON p.id = a.parent_id
     )
     SELECT 1 FROM ancestors WHERE id = NEW.id);
END;

-- category_sync_legacy_row(), validation half: runs before the row is written,
-- as in PostgreSQL.
CREATE TRIGGER trg_categories_0_sync_legacy__insert_check
BEFORE INSERT ON categories FOR EACH ROW
WHEN NEW.legacy_compatible
BEGIN
  SELECT RAISE(ABORT, 'vision:23514::Legacy categories require general and detail')
   WHERE NEW.general IS NULL OR btrim(NEW.general) = ''
      OR NEW.detail IS NULL OR btrim(NEW.detail) = '';
  SELECT RAISE(ABORT, 'vision:23514::Merged legacy category must be resolved through its alias')
   WHERE EXISTS (SELECT 1 FROM category_merge_aliases
                  WHERE general = NEW.general AND detail = NEW.detail);
END;

CREATE TRIGGER trg_categories_0_sync_legacy__update_check
BEFORE UPDATE OF general, detail ON categories FOR EACH ROW
WHEN NEW.legacy_compatible
BEGIN
  SELECT RAISE(ABORT, 'vision:23514::Legacy categories require general and detail')
   WHERE NEW.general IS NULL OR btrim(NEW.general) = ''
      OR NEW.detail IS NULL OR btrim(NEW.detail) = '';
  SELECT RAISE(ABORT, 'vision:23514::Merged legacy category must be resolved through its alias')
   WHERE EXISTS (SELECT 1 FROM category_merge_aliases
                  WHERE general = NEW.general AND detail = NEW.detail);
END;

CREATE TRIGGER trg_categories_insight_digest_dirty__delete
AFTER DELETE ON categories FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_categories_insight_digest_dirty__update
AFTER UPDATE ON categories FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_categories_insight_digest_dirty__insert
AFTER INSERT ON categories FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

-- category_refresh_path_names(): recompute path_name of the row and of every
-- descendant. The seed reads the row as stored now rather than NEW, because
-- trg_categories_0_sync_legacy__* may already have moved it. The coalesce is
-- reached only for a parent that does not exist, a statement the foreign key
-- check then refuses (23503) at its end.
CREATE TRIGGER trg_categories_refresh_path_names__update
AFTER UPDATE OF name, parent_id, general, detail ON categories FOR EACH ROW
BEGIN
  UPDATE categories SET path_name = affected.path_name
    FROM (WITH RECURSIVE tree(id, path_name) AS (
            SELECT c.id,
                   CASE WHEN c.parent_id IS NULL THEN c.name
                        ELSE coalesce((SELECT parent.path_name FROM categories parent
                                        WHERE parent.id = c.parent_id), '') || ':' || c.name
                   END
              FROM categories c WHERE c.id = NEW.id
            UNION ALL
            SELECT child.id, tree.path_name || ':' || child.name
              FROM categories child JOIN tree ON child.parent_id = tree.id
          )
          SELECT id, path_name FROM tree) AS affected
   WHERE categories.id = affected.id;
END;

CREATE TRIGGER trg_categories_refresh_path_names__insert
AFTER INSERT ON categories FOR EACH ROW
BEGIN
  UPDATE categories SET path_name = affected.path_name
    FROM (WITH RECURSIVE tree(id, path_name) AS (
            SELECT c.id,
                   CASE WHEN c.parent_id IS NULL THEN c.name
                        ELSE coalesce((SELECT parent.path_name FROM categories parent
                                        WHERE parent.id = c.parent_id), '') || ':' || c.name
                   END
              FROM categories c WHERE c.id = NEW.id
            UNION ALL
            SELECT child.id, tree.path_name || ':' || child.name
              FROM categories child JOIN tree ON child.parent_id = tree.id
          )
          SELECT id, path_name FROM tree) AS affected
   WHERE categories.id = affected.id;
END;

-- category_sync_legacy_row(), assignment half (EMULATED: PostgreSQL set
-- NEW.parent_id and NEW.name before the write; here they are written right
-- after it, so INSERT/UPDATE ... RETURNING shows the pre-sync parent_id, name
-- and path_name). A legacy category hangs under the root named after its
-- general (or the root its general is aliased to), created when missing, and
-- takes its detail as name. On INSERT the new row itself is not a candidate
-- root: in PostgreSQL it did not exist yet when the root was looked up.
CREATE TRIGGER trg_categories_0_sync_legacy__update
AFTER UPDATE OF general, detail ON categories FOR EACH ROW
WHEN NEW.legacy_compatible
BEGIN
  INSERT INTO categories (general, detail, name, hierarchy_only, legacy_compatible, is_active)
  SELECT NEW.general, '', NEW.general, 1, 0, 1
   WHERE NOT EXISTS (SELECT 1 FROM categories WHERE parent_id IS NULL AND name = NEW.general)
     AND NOT EXISTS (SELECT 1 FROM category_root_aliases WHERE general = NEW.general)
  ON CONFLICT (general, detail) DO NOTHING;
  SELECT RAISE(ABORT, 'vision:23514::Legacy category root could not be resolved')
   WHERE coalesce((SELECT id FROM categories WHERE parent_id IS NULL AND name = NEW.general),
                  (SELECT target_category_id FROM category_root_aliases WHERE general = NEW.general)) IS NULL;
  UPDATE categories
     SET parent_id = coalesce((SELECT id FROM categories WHERE parent_id IS NULL AND name = NEW.general),
                              (SELECT target_category_id FROM category_root_aliases WHERE general = NEW.general)),
         name = NEW.detail
   WHERE id = NEW.id;
END;

CREATE TRIGGER trg_categories_0_sync_legacy__insert
AFTER INSERT ON categories FOR EACH ROW
WHEN NEW.legacy_compatible
BEGIN
  INSERT INTO categories (general, detail, name, hierarchy_only, legacy_compatible, is_active)
  SELECT NEW.general, '', NEW.general, 1, 0, 1
   WHERE NOT EXISTS (SELECT 1 FROM categories WHERE parent_id IS NULL AND name = NEW.general AND id <> NEW.id)
     AND NOT EXISTS (SELECT 1 FROM category_root_aliases WHERE general = NEW.general)
  ON CONFLICT (general, detail) DO NOTHING;
  SELECT RAISE(ABORT, 'vision:23514::Legacy category root could not be resolved')
   WHERE coalesce((SELECT id FROM categories WHERE parent_id IS NULL AND name = NEW.general AND id <> NEW.id),
                  (SELECT target_category_id FROM category_root_aliases WHERE general = NEW.general)) IS NULL;
  UPDATE categories
     SET parent_id = coalesce((SELECT id FROM categories WHERE parent_id IS NULL AND name = NEW.general AND id <> NEW.id),
                              (SELECT target_category_id FROM category_root_aliases WHERE general = NEW.general)),
         name = NEW.detail
   WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- insight digest dirty markers (mark_insight_digest_dirty())
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_insight_dismissals_digest_dirty__insert
AFTER INSERT ON insight_dismissals FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_insight_dismissals_digest_dirty__update
AFTER UPDATE ON insight_dismissals FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_insight_dismissals_digest_dirty__delete
AFTER DELETE ON insight_dismissals FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_planned_transactions_insight_digest_dirty__insert
AFTER INSERT ON planned_transactions FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_planned_transactions_insight_digest_dirty__update
AFTER UPDATE ON planned_transactions FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_planned_transactions_insight_digest_dirty__delete
AFTER DELETE ON planned_transactions FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_recipients_insight_digest_dirty__insert
AFTER INSERT ON recipients FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_recipients_insight_digest_dirty__update
AFTER UPDATE ON recipients FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_recipients_insight_digest_dirty__delete
AFTER DELETE ON recipients FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_transactions_insight_digest_dirty__insert
AFTER INSERT ON transactions FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_transactions_insight_digest_dirty__update
AFTER UPDATE ON transactions FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

CREATE TRIGGER trg_transactions_insight_digest_dirty__delete
AFTER DELETE ON transactions FOR EACH ROW
BEGIN
  UPDATE insight_digest_state SET dirty_version = dirty_version + 1 WHERE singleton_id = 1;
END;

-- ---------------------------------------------------------------------------
-- portfolio custody ledger and paired income
-- ---------------------------------------------------------------------------

-- guard_portfolio_asset_adjustment_source_change(): a source receipt may only
-- go with its adjustment (the ON DELETE CASCADE runs after the adjustment row
-- is gone).
CREATE TRIGGER portfolio_asset_adjustment_sources_immutable__update
BEFORE UPDATE ON portfolio_asset_adjustment_sources FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'vision:P0001::Asset adjustment source receipts are immutable; roll back their import batch');
END;

CREATE TRIGGER portfolio_asset_adjustment_sources_immutable__delete
BEFORE DELETE ON portfolio_asset_adjustment_sources FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM portfolio_asset_adjustments WHERE id = OLD.adjustment_id)
BEGIN
  SELECT RAISE(ABORT, 'vision:P0001::Asset adjustment source receipts are immutable; roll back their import batch');
END;

-- reject_portfolio_asset_adjustment_update()
CREATE TRIGGER portfolio_asset_adjustments_immutable
BEFORE UPDATE ON portfolio_asset_adjustments FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'vision:P0001::Asset adjustments are immutable; roll back their import batch');
END;

-- reject_portfolio_asset_transfer_update()
CREATE TRIGGER portfolio_asset_transfers_immutable
BEFORE UPDATE ON portfolio_asset_transfers FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'vision:P0001::Asset transfers are immutable; roll back their import batch');
END;

-- guard_active_portfolio_income_pair(): a transaction named by a 'record'
-- receipt that no 'restore' has undone may not be deleted, nor changed in any
-- field of portfolio_income_transaction_snapshot() (every column except
-- created_at and updated_at; a standard income_recognition_role is dropped from
-- the snapshot, which compares the same). Decimal columns compare in their
-- canonical text, as the snapshot's ::text did.
CREATE TRIGGER portfolio_income_active_pair_guard__update
BEFORE UPDATE ON portfolio_transactions FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.investment_id IS NOT OLD.investment_id
  OR NEW.type IS NOT OLD.type
  OR NEW.date IS NOT OLD.date
  OR vision_numeric(NEW.amount, 18, 4) IS NOT OLD.amount
  OR vision_numeric(NEW.units, 18, 8) IS NOT OLD.units
  OR vision_numeric(NEW.price_per_unit, 18, 6) IS NOT OLD.price_per_unit
  OR vision_numeric(NEW.fees, 18, 4) IS NOT OLD.fees
  OR vision_numeric(NEW.taxes, 18, 4) IS NOT OLD.taxes
  OR NEW.currency IS NOT OLD.currency
  OR vision_numeric(NEW.fx_rate_to_eur, 20, 10) IS NOT OLD.fx_rate_to_eur
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.note IS NOT OLD.note
  OR NEW.dividend_amount_convention IS NOT OLD.dividend_amount_convention
  OR NEW.is_recurring IS NOT OLD.is_recurring
  OR NEW.recurrence_interval IS NOT OLD.recurrence_interval
  OR NEW.recurrence_end_date IS NOT OLD.recurrence_end_date
  OR NEW.import_batch_id IS NOT OLD.import_batch_id
  OR NEW.source_record_hash IS NOT OLD.source_record_hash
  OR NEW.dedup_fingerprint IS NOT OLD.dedup_fingerprint
  OR NEW.dedup_fingerprint_version IS NOT OLD.dedup_fingerprint_version
  OR NEW.income_recognition_role IS NOT OLD.income_recognition_role
BEGIN
  SELECT RAISE(ABORT, 'vision:P0001::Roll back active paired income before changing its income or acquisition')
   WHERE EXISTS (
     SELECT 1 FROM portfolio_import_income_recognition_journal r
      WHERE r."action" = 'record'
        AND (r.unit_transaction_id = OLD.id OR r.income_transaction_id = OLD.id)
        AND NOT EXISTS (SELECT 1 FROM portfolio_import_income_recognition_journal undo
                         WHERE undo.previous_entry_id = r.id));
END;

CREATE TRIGGER portfolio_income_active_pair_guard__delete
BEFORE DELETE ON portfolio_transactions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'vision:P0001::Roll back active paired income before changing its income or acquisition')
   WHERE EXISTS (
     SELECT 1 FROM portfolio_import_income_recognition_journal r
      WHERE r."action" = 'record'
        AND (r.unit_transaction_id = OLD.id OR r.income_transaction_id = OLD.id)
        AND NOT EXISTS (SELECT 1 FROM portfolio_import_income_recognition_journal undo
                         WHERE undo.previous_entry_id = r.id));
END;

-- ---------------------------------------------------------------------------
-- research dossiers and saved analyses
-- ---------------------------------------------------------------------------

-- reject_research_dossier_version_update()
CREATE TRIGGER trg_research_dossier_version_immutable
BEFORE UPDATE ON research_dossier_versions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'vision:P0001::research dossier versions are immutable');
END;

-- reject_saved_analysis_version_update()
CREATE TRIGGER trg_saved_analysis_version_immutable
BEFORE UPDATE ON saved_analysis_definition_versions FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'vision:P0001::saved analysis definition versions are immutable');
END;

-- ---------------------------------------------------------------------------
-- splits: agg_split_outstanding (fn_agg_split_outstanding_sync(split_id))
-- ---------------------------------------------------------------------------
-- The sync recomputes one split's row: the split amount, the sum of its
-- payments (both held in NUMERIC(18,4) variables, hence vision_numeric) and the
-- difference; a split that no longer exists loses its row.

CREATE TRIGGER trg_split_outstanding_sync__insert
AFTER INSERT ON transaction_splits FOR EACH ROW
BEGIN
  DELETE FROM agg_split_outstanding
   WHERE split_id = NEW.id
     AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.id = NEW.id AND s.recipient_id IS NOT NULL);
  INSERT INTO agg_split_outstanding
         (split_id, recipient_id, original_amount, paid_amount, outstanding_amount, updated_at)
  SELECT x.split_id, x.recipient_id, x.original, x.paid,
         vision_numeric(dec_sub(x.original, x.paid), 18, 4), now()
    FROM (SELECT s.id AS split_id, s.recipient_id,
                 vision_numeric(s.amount, 18, 4) AS original,
                 vision_numeric(coalesce((SELECT dec_sum(p.amount) FROM split_payments p
                                           WHERE p.split_id = s.id), 0), 18, 4) AS paid
            FROM transaction_splits s
           WHERE s.id = NEW.id AND s.recipient_id IS NOT NULL) AS x
   WHERE true
  ON CONFLICT (split_id) DO UPDATE
     SET recipient_id = excluded.recipient_id,
         original_amount = excluded.original_amount,
         paid_amount = excluded.paid_amount,
         outstanding_amount = excluded.outstanding_amount,
         updated_at = now();
END;

CREATE TRIGGER trg_split_outstanding_sync__update
AFTER UPDATE ON transaction_splits FOR EACH ROW
BEGIN
  DELETE FROM agg_split_outstanding
   WHERE split_id = NEW.id
     AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.id = NEW.id AND s.recipient_id IS NOT NULL);
  INSERT INTO agg_split_outstanding
         (split_id, recipient_id, original_amount, paid_amount, outstanding_amount, updated_at)
  SELECT x.split_id, x.recipient_id, x.original, x.paid,
         vision_numeric(dec_sub(x.original, x.paid), 18, 4), now()
    FROM (SELECT s.id AS split_id, s.recipient_id,
                 vision_numeric(s.amount, 18, 4) AS original,
                 vision_numeric(coalesce((SELECT dec_sum(p.amount) FROM split_payments p
                                           WHERE p.split_id = s.id), 0), 18, 4) AS paid
            FROM transaction_splits s
           WHERE s.id = NEW.id AND s.recipient_id IS NOT NULL) AS x
   WHERE true
  ON CONFLICT (split_id) DO UPDATE
     SET recipient_id = excluded.recipient_id,
         original_amount = excluded.original_amount,
         paid_amount = excluded.paid_amount,
         outstanding_amount = excluded.outstanding_amount,
         updated_at = now();
END;

CREATE TRIGGER trg_split_outstanding_sync__delete
AFTER DELETE ON transaction_splits FOR EACH ROW
BEGIN
  DELETE FROM agg_split_outstanding WHERE split_id = OLD.id;
END;

-- fn_trg_split_payment_sync(): an UPDATE syncs only NEW.split_id, as in
-- PostgreSQL.
CREATE TRIGGER trg_split_payment_outstanding_sync__insert
AFTER INSERT ON split_payments FOR EACH ROW
BEGIN
  DELETE FROM agg_split_outstanding
   WHERE split_id = NEW.split_id
     AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.id = NEW.split_id AND s.recipient_id IS NOT NULL);
  INSERT INTO agg_split_outstanding
         (split_id, recipient_id, original_amount, paid_amount, outstanding_amount, updated_at)
  SELECT x.split_id, x.recipient_id, x.original, x.paid,
         vision_numeric(dec_sub(x.original, x.paid), 18, 4), now()
    FROM (SELECT s.id AS split_id, s.recipient_id,
                 vision_numeric(s.amount, 18, 4) AS original,
                 vision_numeric(coalesce((SELECT dec_sum(p.amount) FROM split_payments p
                                           WHERE p.split_id = s.id), 0), 18, 4) AS paid
            FROM transaction_splits s
           WHERE s.id = NEW.split_id AND s.recipient_id IS NOT NULL) AS x
   WHERE true
  ON CONFLICT (split_id) DO UPDATE
     SET recipient_id = excluded.recipient_id,
         original_amount = excluded.original_amount,
         paid_amount = excluded.paid_amount,
         outstanding_amount = excluded.outstanding_amount,
         updated_at = now();
END;

CREATE TRIGGER trg_split_payment_outstanding_sync__update
AFTER UPDATE ON split_payments FOR EACH ROW
BEGIN
  DELETE FROM agg_split_outstanding
   WHERE split_id = NEW.split_id
     AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.id = NEW.split_id AND s.recipient_id IS NOT NULL);
  INSERT INTO agg_split_outstanding
         (split_id, recipient_id, original_amount, paid_amount, outstanding_amount, updated_at)
  SELECT x.split_id, x.recipient_id, x.original, x.paid,
         vision_numeric(dec_sub(x.original, x.paid), 18, 4), now()
    FROM (SELECT s.id AS split_id, s.recipient_id,
                 vision_numeric(s.amount, 18, 4) AS original,
                 vision_numeric(coalesce((SELECT dec_sum(p.amount) FROM split_payments p
                                           WHERE p.split_id = s.id), 0), 18, 4) AS paid
            FROM transaction_splits s
           WHERE s.id = NEW.split_id AND s.recipient_id IS NOT NULL) AS x
   WHERE true
  ON CONFLICT (split_id) DO UPDATE
     SET recipient_id = excluded.recipient_id,
         original_amount = excluded.original_amount,
         paid_amount = excluded.paid_amount,
         outstanding_amount = excluded.outstanding_amount,
         updated_at = now();
END;

CREATE TRIGGER trg_split_payment_outstanding_sync__delete
AFTER DELETE ON split_payments FOR EACH ROW
BEGIN
  DELETE FROM agg_split_outstanding
   WHERE split_id = OLD.split_id
     AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.id = OLD.split_id AND s.recipient_id IS NOT NULL);
  INSERT INTO agg_split_outstanding
         (split_id, recipient_id, original_amount, paid_amount, outstanding_amount, updated_at)
  SELECT x.split_id, x.recipient_id, x.original, x.paid,
         vision_numeric(dec_sub(x.original, x.paid), 18, 4), now()
    FROM (SELECT s.id AS split_id, s.recipient_id,
                 vision_numeric(s.amount, 18, 4) AS original,
                 vision_numeric(coalesce((SELECT dec_sum(p.amount) FROM split_payments p
                                           WHERE p.split_id = s.id), 0), 18, 4) AS paid
            FROM transaction_splits s
           WHERE s.id = OLD.split_id AND s.recipient_id IS NOT NULL) AS x
   WHERE true
  ON CONFLICT (split_id) DO UPDATE
     SET recipient_id = excluded.recipient_id,
         original_amount = excluded.original_amount,
         paid_amount = excluded.paid_amount,
         outstanding_amount = excluded.outstanding_amount,
         updated_at = now();
END;

-- ---------------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------------

-- enforce_split_within_amount(): a changed amount must still cover the splits
-- (0.005 tolerance). The message quotes values, so it is raised through
-- vision_raise (RAISE takes only a literal before SQLite 3.47).
CREATE TRIGGER trg_enforce_split_within_amount
BEFORE UPDATE ON transactions FOR EACH ROW
WHEN dec_ne(NEW.amount, OLD.amount)
BEGIN
  SELECT vision_raise('23514', NULL,
           'transaction ' || NEW.id || ' amount ' || vision_numeric(NEW.amount, 18, 4)
           || ' is below its split total ' || s.total)
    FROM (SELECT coalesce(dec_sum(amount), '0') AS total
            FROM transaction_splits WHERE transaction_id = NEW.id) AS s
   WHERE dec_gt(s.total, dec_add(dec_abs(NEW.amount), '0.005'));
END;

-- ---------------------------------------------------------------------------
-- updated_at (update_updated_at_column(); EMULATED: an AFTER trigger writes
-- updated_at = now() after the row is written, so RETURNING does not see it
-- unless the statement set updated_at itself, as the Kysely write plugin does)
-- ---------------------------------------------------------------------------

CREATE TRIGGER update_accounts_updated_at
AFTER UPDATE ON accounts FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE accounts SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_ai_conversations_updated_at
AFTER UPDATE ON ai_conversations FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE ai_conversations SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_asset_price_history_updated_at
AFTER UPDATE ON asset_price_history FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE asset_price_history SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_belgian_inflation_updated_at
AFTER UPDATE ON belgian_inflation_rates FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE belgian_inflation_rates SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_categories_updated_at
AFTER UPDATE ON categories FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE categories SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_custom_parser_configs_updated_at
AFTER UPDATE ON custom_parser_configs FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE custom_parser_configs SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_exchange_rates_updated_at
AFTER UPDATE ON exchange_rates FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE exchange_rates SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_import_staging_rows_updated_at
AFTER UPDATE ON import_staging_rows FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE import_staging_rows SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_instrument_provider_map_updated_at
AFTER UPDATE ON instrument_provider_map FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE instrument_provider_map SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_investment_ticker_prefs_updated_at
AFTER UPDATE ON investment_ticker_prefs FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE investment_ticker_prefs SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_investments_updated_at
AFTER UPDATE ON investments FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE investments SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_ptls_updated_at
AFTER UPDATE ON planned_transaction_loan_schedule FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE planned_transaction_loan_schedule SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_pt_updated_at
AFTER UPDATE ON planned_transactions FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE planned_transactions SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_portfolio_import_staging_rows_updated_at
AFTER UPDATE ON portfolio_import_staging_rows FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE portfolio_import_staging_rows SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_portfolio_txn_updated_at
AFTER UPDATE ON portfolio_transactions FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE portfolio_transactions SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_provider_api_keys_updated_at
AFTER UPDATE ON provider_api_keys FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE provider_api_keys SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_provider_health_updated_at
AFTER UPDATE ON provider_health FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE provider_health SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_provider_quota_updated_at
AFTER UPDATE ON provider_quota FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE provider_quota SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_rba_updated_at
AFTER UPDATE ON recipient_bank_accounts FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE recipient_bank_accounts SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_recipient_match_patterns_updated_at
AFTER UPDATE ON recipient_match_patterns FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE recipient_match_patterns SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_recipients_updated_at
AFTER UPDATE ON recipients FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE recipients SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_saved_charts_updated_at
AFTER UPDATE ON saved_charts FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE saved_charts SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_tags_updated_at
AFTER UPDATE ON tags FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE tags SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_transaction_splits_updated_at
AFTER UPDATE ON transaction_splits FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE transaction_splits SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_transactions_updated_at
AFTER UPDATE ON transactions FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE transactions SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_user_settings_updated_at
AFTER UPDATE ON user_settings FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE user_settings SET updated_at = now() WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER update_watchlist_updated_at
AFTER UPDATE ON watchlist FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE watchlist SET updated_at = now() WHERE rowid = NEW.rowid;
END;

-- ============================================================================
-- Reference rows
-- ============================================================================

INSERT INTO adr109_legacy_cleanup_marker (singleton, completed_at)
VALUES (1, '2026-10-19T13:47:28.355570Z');

INSERT INTO insight_digest_state
       (singleton_id, undismissed_count, dirty_version, computed_version, computed_at, expires_at)
VALUES (1, NULL, 6, 0, NULL, NULL);
