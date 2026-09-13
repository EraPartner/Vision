BEGIN;
DO $$ BEGIN
  CREATE TYPE public.recurrence_interval AS ENUM (
    'daily', 'weekly', 'bi-weekly', 'monthly', 'quarterly', 'yearly'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
COMMIT;
