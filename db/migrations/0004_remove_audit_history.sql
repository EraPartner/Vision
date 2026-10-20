-- 0004_remove_audit_history
-- Runs inside the migrator's transaction. 0004_remove_audit_history.down.sql restores the empty
-- schema.
--
-- Removes the audit history feature: the tamper-evidence hash chain (head, entries, checkpoints,
-- their append-only triggers and the retention pruning function) and the plain change records of
-- the database editor, splits and portfolio broker re-tags. The broker re-tag now recognises a
-- repeated request from the current assignments, so it no longer needs portfolio_retag_audit.

-- squawk-ignore ban-drop-table
DROP TABLE "public"."audit_chain_checkpoints";
-- squawk-ignore ban-drop-table
DROP TABLE "public"."audit_chain_entries";
-- squawk-ignore ban-drop-table
DROP TABLE "public"."audit_chain_head";

-- squawk-ignore ban-drop-function
DROP FUNCTION "public"."audit_chain_prune_prefix"(bigint, character);
-- squawk-ignore ban-drop-function
DROP FUNCTION "public"."audit_chain_reject_mutation"();

-- squawk-ignore ban-drop-table
DROP TABLE "public"."db_editor_audit";
-- squawk-ignore ban-drop-table
DROP TABLE "public"."split_audit";
-- squawk-ignore ban-drop-table
DROP TABLE "public"."portfolio_retag_audit";
