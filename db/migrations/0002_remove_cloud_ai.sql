-- 0002_remove_cloud_ai
-- Runs inside the migrator's transaction. 0002_remove_cloud_ai.down.sql restores the empty schema.
--
-- ADR-229 removes the OpenAI API investigation route, its disclosure grants and records, the
-- reversible references that masked cloud sends, and the AgentCloak preference. Investigations
-- are local-only, so jobs that used the removed route are deleted with their steps.

DELETE FROM "public"."ai_investigation_jobs" WHERE "route" <> 'local';

-- squawk-ignore ban-drop-constraint
ALTER TABLE "public"."ai_investigation_jobs" DROP CONSTRAINT "ai_investigation_jobs_route_check";
ALTER TABLE "public"."ai_investigation_jobs"
    ADD CONSTRAINT "ai_investigation_jobs_route_check" CHECK ("route" = 'local');

-- squawk-ignore ban-drop-column
ALTER TABLE "public"."ai_investigation_jobs" DROP COLUMN "grant_id";

-- squawk-ignore ban-drop-table
DROP TABLE "public"."ai_disclosure_records";
-- squawk-ignore ban-drop-table
DROP TABLE "public"."ai_disclosure_grants";
-- squawk-ignore ban-drop-table
DROP TABLE "public"."ai_reference_entries";
-- squawk-ignore ban-drop-table
DROP TABLE "public"."ai_reference_scopes";

DELETE FROM "public"."user_settings" WHERE "key" = 'agentcloak_desktop_enabled';
