\if :{?backup_verified}
\else
  \echo 'Refusing: pass -v backup_verified=yes after a restore-tested logical backup.'
  \quit 3
\endif
BEGIN;
SELECT set_config('vision.backup_verified', :'backup_verified', true);
LOCK TABLE transactions, import_staging_rows, portfolio_import_staging_rows IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF current_setting('vision.backup_verified', true) <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: backup_verified must equal yes';
  END IF;
  IF EXISTS (
       SELECT 1
         FROM import_staging_rows AS staging
         JOIN import_batches AS batch ON batch.id = staging.batch_id
        WHERE staging.tx_hash IS NOT NULL
          AND batch.status NOT IN ('complete', 'failed', 'aborted')
     ) OR EXISTS (
       SELECT 1
         FROM portfolio_import_staging_rows AS staging
         JOIN portfolio_import_batches AS batch ON batch.id = staging.batch_id
        WHERE staging.tx_hash IS NOT NULL
          AND batch.status NOT IN ('complete', 'failed', 'aborted', 'complete_with_errors')
     ) THEN
    RAISE EXCEPTION 'Refusing: an unfinished import batch still contains tx_hash';
  END IF;
END $$;
DROP INDEX IF EXISTS uq_transactions_tx_hash;
ALTER TABLE transactions DROP COLUMN tx_hash;
ALTER TABLE import_staging_rows DROP COLUMN tx_hash;
ALTER TABLE portfolio_import_staging_rows DROP COLUMN tx_hash;
COMMIT;
