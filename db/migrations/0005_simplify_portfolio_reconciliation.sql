-- 0005_simplify_portfolio_reconciliation
-- Runs inside the migrator's transaction. 0005_simplify_portfolio_reconciliation.down.sql
-- recreates every dropped function and trigger from the 0001 baseline.
--
-- ADR-236 removes the bounded Kinesis, IBKR and Saxo reconciliation workflows. Their
-- receipts were guarded by triggers that the application now checks itself, and
-- in-kind income no longer needs a `record` receipt. No table, column or row is
-- dropped: every journal stays readable, and batch rollback still restores what
-- an applied receipt changed.
--
-- Kept: the custody ledger triggers (portfolio_asset_*_immutable), the
-- active-pair guard on portfolio_transactions (portfolio_income_active_pair_guard),
-- and the snapshot functions that application SQL calls
-- (portfolio_income_transaction_snapshot, normalize_portfolio_income_snapshot,
-- portfolio_cash_receipt).

DROP TRIGGER "portfolio_duplicate_repair_receipt_guard" ON "public"."portfolio_import_duplicate_repair_journal";
DROP TRIGGER "portfolio_import_reconciliation_immutable" ON "public"."portfolio_import_reconciliation_journal";
DROP TRIGGER "portfolio_import_reconciliation_valid_receipt" ON "public"."portfolio_import_reconciliation_journal";
DROP TRIGGER "portfolio_income_journal_immutable" ON "public"."portfolio_import_income_recognition_journal";
DROP TRIGGER "portfolio_income_requires_pair" ON "public"."portfolio_transactions";
DROP TRIGGER "portfolio_income_valid_receipt" ON "public"."portfolio_import_income_recognition_journal";
DROP TRIGGER "trg_portfolio_cash_receipt_immutable" ON "public"."portfolio_import_staging_rows";

-- squawk-ignore ban-drop-function
DROP FUNCTION "public"."enforce_portfolio_duplicate_repair_receipt"();
-- squawk-ignore ban-drop-function
DROP FUNCTION "public"."portfolio_duplicate_repair_state"("jsonb");
-- squawk-ignore ban-drop-function
DROP FUNCTION "public"."forbid_portfolio_import_receipt_mutation"();
-- squawk-ignore ban-drop-function
DROP FUNCTION "public"."guard_portfolio_cash_receipt"();
-- squawk-ignore ban-drop-function
DROP FUNCTION "public"."require_portfolio_income_pair"();
-- squawk-ignore ban-drop-function
DROP FUNCTION "public"."validate_portfolio_import_receipt"();
-- squawk-ignore ban-drop-function
DROP FUNCTION "public"."validate_portfolio_income_receipt"();
