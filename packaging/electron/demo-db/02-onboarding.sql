-- Demo app-state seed — runs after 01-demo.sql (init scripts run in name order).
--
-- The demo ships a fully-populated household, so the first-run onboarding wizard
-- must never appear. The wizard shows whenever user_settings.onboarding_complete
-- is not JSON true (frontend: components/onboarding/OnboardingWizard.tsx, which
-- reads value === true; backend default is false in routes/settings.js).
--
-- 01-demo.sql is a pg_dump of the generated dataset (financial data only) and does
-- not carry this app-state flag, and the demo install wipes the volume (down -v) on
-- every reinstall, so without this the wizard reappears on every fresh demo.
-- Idempotent, so it stays correct even if a future 01-demo.sql ever seeds the key.
INSERT INTO user_settings (key, value)
VALUES ('onboarding_complete', 'true'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
