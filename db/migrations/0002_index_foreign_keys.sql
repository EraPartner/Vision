-- 0002_index_foreign_keys: an index on every foreign key whose child columns
-- had none (ADR-263 audit, 2026-11-04).
--
-- SQLite does not index the referencing side of a foreign key. Without an
-- index, deleting or re-keying a parent row scans the whole child table once
-- per parent row to apply ON DELETE (SET NULL, CASCADE, RESTRICT). Every
-- other foreign key in the baseline already leads an index, full or partial.
-- Adding indexes changes no rows and no constraint; it only costs one index
-- build per table at the first start.

CREATE INDEX idx_accounts_funding_account_id ON accounts (funding_account_id);
CREATE INDEX idx_ai_investigation_jobs_conversation_id ON ai_investigation_jobs (conversation_id);
CREATE INDEX idx_analysis_monitor_observations_analysis_run_id ON analysis_monitor_observations (analysis_run_id);
CREATE INDEX idx_category_root_aliases_target_category_id ON category_root_aliases (target_category_id);
CREATE INDEX idx_insight_dismissals_recipient_id ON insight_dismissals (recipient_id);
CREATE INDEX idx_manual_transaction_dedup_claims_transaction_id ON manual_transaction_dedup_claims (transaction_id);
CREATE INDEX idx_portfolio_asset_adjustment_sources_staging_row_id ON portfolio_asset_adjustment_sources (staging_row_id);
CREATE INDEX idx_portfolio_asset_adjustments_account_id ON portfolio_asset_adjustments (account_id);
CREATE INDEX idx_portfolio_asset_transfers_source_account_id ON portfolio_asset_transfers (source_account_id);
CREATE INDEX idx_portfolio_asset_transfers_destination_account_id ON portfolio_asset_transfers (destination_account_id);
CREATE INDEX idx_portfolio_import_duplicate_repair_journal_original_batch ON portfolio_import_duplicate_repair_journal (original_import_batch_id);
CREATE INDEX idx_portfolio_import_income_recognition_journal_unit_row ON portfolio_import_income_recognition_journal (unit_staging_row_id);
CREATE INDEX idx_saved_analyses_last_successful_run_id ON saved_analyses (last_successful_run_id);
CREATE INDEX idx_saved_analysis_runs_definition_version ON saved_analysis_runs (saved_analysis_id, definition_version);
