-- 0003_remove_life_scenarios
-- Runs inside the migrator's transaction. 0003_remove_life_scenarios.down.sql is a no-op.
--
-- ADR-230 removes the Life scenario panel from the Portfolio Forecast page. Its saved
-- definitions lived in the `life_scenarios` settings row, which the settings API no longer
-- accepts, so the stale row is deleted.

DELETE FROM "public"."user_settings" WHERE "key" = 'life_scenarios';
