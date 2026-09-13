-- Remove the obsolete recurrence_interval enum only after ADR-109 cleanup.
\if :{?backup_verified}
\else
  \echo 'Refusing: pass -v backup_verified=yes after verifying a restorable logical backup.'
  \quit 3
\endif

BEGIN;
SELECT set_config('vision.backup_verified', :'backup_verified', true);
DO $$
DECLARE
  enum_oid oid := to_regtype('public.recurrence_interval');
  dependent_count bigint;
BEGIN
  IF current_setting('vision.backup_verified', true) <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: backup_verified must equal yes';
  END IF;
  IF enum_oid IS NULL THEN
    RAISE NOTICE 'recurrence_interval is already absent; nothing to do';
    RETURN;
  END IF;
  IF to_regclass('public.adr109_legacy_cleanup_marker') IS NULL THEN
    RAISE EXCEPTION 'Refusing: ADR-109 cleanup marker is absent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class
     WHERE relnamespace = 'public'::regnamespace
       AND relname LIKE 'legacy_inh_%'
  ) THEN
    RAISE EXCEPTION 'Refusing: ADR-109 legacy relations still exist';
  END IF;

  SELECT count(*) INTO dependent_count
    FROM pg_depend
   WHERE refobjid = enum_oid
     AND deptype IN ('n', 'a', 'i')
     AND NOT (
       classid = 'pg_type'::regclass
       AND objid = (SELECT typarray FROM pg_type WHERE oid = enum_oid)
       AND deptype = 'i'
     );
  IF dependent_count <> 0 THEN
    RAISE EXCEPTION 'Refusing: recurrence_interval still has % catalog dependencies', dependent_count;
  END IF;

  DROP TYPE public.recurrence_interval;
END $$;
COMMIT;
