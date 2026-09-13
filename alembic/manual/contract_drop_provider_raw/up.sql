\if :{?backup_verified}
\else
  \echo 'Refusing: pass -v backup_verified=yes after a restore-tested logical backup.'
  \quit 3
\endif

BEGIN;
SELECT set_config('vision.backup_verified', :'backup_verified', true);
DO $$
DECLARE
  item record;
  source_count bigint;
  archive_count bigint;
  mismatch_count bigint;
BEGIN
  IF current_setting('vision.backup_verified', true) <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: backup_verified must equal yes';
  END IF;
  LOCK TABLE transaction_source_records, transaction_source_links,
    manual_transaction_dedup_claims IN ACCESS EXCLUSIVE MODE;

  FOR item IN SELECT * FROM (VALUES
    ('belfius', 'belfius_raw_transactions'),
    ('revolut', 'revolut_raw_transactions'),
    ('kbc', 'kbc_raw_transactions'),
    ('sabb', 'sabb_raw_transactions'),
    ('wise', 'wise_raw_transactions'),
    ('vision', 'vision_raw_transactions'),
    ('custom', 'custom_raw_transactions'),
    ('manual', 'manual_raw_transactions')
  ) AS sources(source_type, table_name)
  LOOP
    IF to_regclass(format('public.%I', item.table_name)) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', item.table_name);
      EXECUTE format('SELECT count(*) FROM public.%I', item.table_name) INTO source_count;
      SELECT count(*) INTO archive_count FROM transaction_source_records
       WHERE source_type = item.source_type
         AND NOT (native_payload ? 'missing_legacy_source');
      IF source_count IS DISTINCT FROM archive_count THEN
        RAISE EXCEPTION 'Refusing: % count mismatch: source %, archive %',
          item.table_name, source_count, archive_count;
      END IF;
      EXECUTE format(
        'SELECT count(*) FROM public.%I AS old JOIN transaction_source_records AS archived '
        || 'ON archived.source_type = %L AND archived.legacy_source_id = old.id '
        || 'WHERE archived.native_payload IS DISTINCT FROM to_jsonb(old)',
        item.table_name, item.source_type
      ) INTO mismatch_count;
      IF mismatch_count <> 0 THEN
        RAISE EXCEPTION 'Refusing: % archived payloads differ for %', mismatch_count, item.table_name;
      END IF;
    END IF;
  END LOOP;

  IF to_regclass('public.transaction_raw_references') IS NOT NULL THEN
    LOCK TABLE transaction_raw_references IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO source_count FROM transaction_raw_references;
    SELECT count(*) INTO archive_count FROM transaction_source_links;
    IF source_count IS DISTINCT FROM archive_count THEN
      RAISE EXCEPTION 'Refusing: raw-reference count mismatch: source %, archive %', source_count, archive_count;
    END IF;
    SELECT count(*) INTO mismatch_count
      FROM transaction_raw_references rr
      LEFT JOIN transaction_source_records sr
        ON sr.source_type = rr.raw_source_type
       AND sr.legacy_source_id = rr.raw_source_id
      LEFT JOIN transaction_source_links sl
        ON sl.source_record_id = sr.id
       AND sl.legacy_transaction_id = rr.transaction_id
     WHERE sl.id IS NULL
        OR sl.transaction_id IS DISTINCT FROM (
             SELECT t.id FROM transactions t WHERE t.id = rr.transaction_id
           )
        OR sl.link_status IS DISTINCT FROM CASE
             WHEN EXISTS (SELECT 1 FROM transactions t WHERE t.id = rr.transaction_id)
             THEN 'linked' ELSE 'dangling-reference' END;
    IF mismatch_count <> 0 THEN
      RAISE EXCEPTION 'Refusing: % raw-reference identities or statuses differ', mismatch_count;
    END IF;
  END IF;

  IF to_regclass('public.manual_raw_transactions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM manual_raw_transactions m JOIN transactions t '
      || 'ON t.id = m.transaction_id AND t.is_active '
      || 'LEFT JOIN manual_transaction_dedup_claims c '
      || 'ON c.deduplication_hash = lower(m.deduplication_hash) AND c.transaction_id = t.id '
      || 'WHERE c.deduplication_hash IS NULL' INTO mismatch_count;
    IF mismatch_count <> 0 THEN
      RAISE EXCEPTION 'Refusing: % active manual identities lack neutral claims', mismatch_count;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS transaction_raw_references;
DROP TABLE IF EXISTS belfius_raw_transactions;
DROP TABLE IF EXISTS revolut_raw_transactions;
DROP TABLE IF EXISTS kbc_raw_transactions;
DROP TABLE IF EXISTS sabb_raw_transactions;
DROP TABLE IF EXISTS wise_raw_transactions;
DROP TABLE IF EXISTS vision_raw_transactions;
DROP TABLE IF EXISTS custom_raw_transactions;
DROP TABLE IF EXISTS manual_raw_transactions;
COMMIT;
