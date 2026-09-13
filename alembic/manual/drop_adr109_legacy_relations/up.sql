-- ADR-109 housekeeping: permanently remove the inheritance conversion rollback copies.
-- OUT-OF-BAND and irreversible without the verified logical backup described in README.md.

\if :{?backup_verified}
\else
  \echo 'Refusing: pass -v backup_verified=yes after verifying a restorable logical backup.'
  \quit 3
\endif
\if :{?canonical_parity_verified}
\else
  \echo 'Refusing: pass -v canonical_parity_verified=yes after reconciling legacy rows to canonical data or quarantine.'
  \quit 3
\endif
BEGIN;
SELECT set_config('vision.backup_verified', :'backup_verified', true);
SELECT set_config('vision.canonical_parity_verified', :'canonical_parity_verified', true);
DO $$
DECLARE
  inv_kind "char";
  txn_kind "char";
  target_relation text;
  relation_kind "char";
  residue_count integer := 0;
  required_residue_count integer := 0;
  source_count bigint;
  archive_count bigint;
  source_digest text;
  archive_digest text;
  view_names text[] := ARRAY[
    'stock_investments_full',
    'etf_investments_full',
    'crypto_investments_full',
    'real_estate_investments_full',
    'savings_investments_full',
    'bond_investments_full',
    'legacy_inh_portfolio_transactions',
    'legacy_inh_investments'
  ];
  required_table_names text[] := ARRAY[
    'legacy_inh_stock_transactions',
    'legacy_inh_etf_transactions',
    'legacy_inh_crypto_transactions',
    'legacy_inh_metals_transactions',
    'legacy_inh_real_estate_transactions',
    'legacy_inh_savings_transactions',
    'legacy_inh_bond_transactions',
    'legacy_inh_portfolio_transactions_base',
    'legacy_inh_stock_investments',
    'legacy_inh_etf_investments',
    'legacy_inh_crypto_investments',
    'legacy_inh_metals_investments',
    'legacy_inh_real_estate_investments',
    'legacy_inh_savings_investments',
    'legacy_inh_bond_investments',
    'legacy_inh_investments_base'
  ];
  optional_table_names text[] := ARRAY[
    'portfolio_transactions_legacy',
    'investments_legacy'
  ];
  table_names text[] := ARRAY[]::text[];
BEGIN
  IF current_setting('vision.backup_verified', true) <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: backup_verified must equal yes';
  END IF;
  IF current_setting('vision.canonical_parity_verified', true) <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: canonical_parity_verified must equal yes';
  END IF;
  SELECT relkind INTO inv_kind FROM pg_class WHERE oid = to_regclass('public.investments');
  SELECT relkind INTO txn_kind FROM pg_class WHERE oid = to_regclass('public.portfolio_transactions');
  IF inv_kind IS DISTINCT FROM 'r' OR txn_kind IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'ADR-109 cleanup requires canonical flat investments and portfolio_transactions tables';
  END IF;

  FOREACH target_relation IN ARRAY view_names LOOP
    SELECT relkind INTO relation_kind
      FROM pg_class
     WHERE oid = to_regclass(format('%I.%I', 'public', target_relation));
    IF relation_kind IS NOT NULL THEN
      residue_count := residue_count + 1;
      required_residue_count := required_residue_count + 1;
      IF relation_kind IS DISTINCT FROM 'v' THEN
        RAISE EXCEPTION 'ADR-109 cleanup expected public.% to be a view, found relkind %',
          target_relation, relation_kind;
      END IF;
    END IF;
  END LOOP;

  FOREACH target_relation IN ARRAY required_table_names LOOP
    SELECT relkind INTO relation_kind
      FROM pg_class
     WHERE oid = to_regclass(format('%I.%I', 'public', target_relation));
    IF relation_kind IS NOT NULL THEN
      residue_count := residue_count + 1;
      required_residue_count := required_residue_count + 1;
      IF relation_kind IS DISTINCT FROM 'r' THEN
        RAISE EXCEPTION 'ADR-109 cleanup expected public.% to be a table, found relkind %',
          target_relation, relation_kind;
      END IF;
      table_names := array_append(table_names, target_relation);
    END IF;
  END LOOP;

  -- Pre-0013 installations can retain these older snapshots. ADR-109 does not
  -- create them, so their absence is valid; if present, archive and drop them
  -- under the same table-kind and digest checks as the required rollback set.
  FOREACH target_relation IN ARRAY optional_table_names LOOP
    SELECT relkind INTO relation_kind
      FROM pg_class
     WHERE oid = to_regclass(format('%I.%I', 'public', target_relation));
    IF relation_kind IS NOT NULL THEN
      residue_count := residue_count + 1;
      IF relation_kind IS DISTINCT FROM 'r' THEN
        RAISE EXCEPTION 'ADR-109 cleanup expected optional public.% to be a table, found relkind %',
          target_relation, relation_kind;
      END IF;
      table_names := array_append(table_names, target_relation);
    END IF;
  END LOOP;

  IF residue_count = 0 THEN
    CREATE TABLE IF NOT EXISTS public.adr109_legacy_cleanup_marker (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      completed_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.adr109_legacy_cleanup_marker (singleton)
    VALUES (true)
    ON CONFLICT (singleton) DO NOTHING;
    RAISE NOTICE 'ADR-109 cleanup: no legacy residue found; nothing to do';
    RETURN;
  END IF;
  IF required_residue_count IS DISTINCT FROM
       cardinality(view_names) + cardinality(required_table_names) THEN
    RAISE EXCEPTION 'ADR-109 cleanup found a partial required residue set (% of % required relations; % total including optional); refusing CASCADE',
      required_residue_count,
      cardinality(view_names) + cardinality(required_table_names),
      residue_count;
  END IF;

  -- Freeze canonical data and every rollback table before copying or comparing.
  -- This keeps the evidence and the destructive step in one race-free transaction.
  LOCK TABLE public.investments, public.portfolio_transactions IN ACCESS EXCLUSIVE MODE;
  FOREACH target_relation IN ARRAY table_names LOOP
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', target_relation);
  END LOOP;

  CREATE TABLE IF NOT EXISTS public.adr109_legacy_archive (
    relation_name text NOT NULL,
    legacy_row jsonb NOT NULL,
    row_digest char(64) NOT NULL,
    disposition text NOT NULL DEFAULT 'rollback-copy'
      CHECK (disposition IN ('rollback-copy', 'legacy-only-quarantine')),
    archived_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (relation_name, row_digest)
  );

  -- Preserve the complete source rows before removing rollback relations.
  -- A relation-level count and order-independent digest proves the archive is
  -- an exact JSONB copy. Canonical parity remains a separate application-level
  -- maintenance-window check described in the runbook.
  FOREACH target_relation IN ARRAY table_names LOOP
    EXECUTE format(
      'INSERT INTO public.adr109_legacy_archive (relation_name, legacy_row, row_digest) '
      || 'SELECT %L, to_jsonb(source_row), encode(digest(to_jsonb(source_row)::text, ''sha256''), ''hex'') '
      || 'FROM public.%I AS source_row ON CONFLICT DO NOTHING',
      target_relation, target_relation
    );
    EXECUTE format('SELECT count(*) FROM public.%I', target_relation) INTO source_count;
    SELECT count(*) INTO archive_count
      FROM public.adr109_legacy_archive
     WHERE adr109_legacy_archive.relation_name = target_relation;
    IF archive_count IS DISTINCT FROM source_count THEN
      RAISE EXCEPTION 'ADR-109 archive count mismatch for %: source %, archive %',
        target_relation, source_count, archive_count;
    END IF;
    EXECUTE format(
      'SELECT encode(digest(COALESCE(string_agg(to_jsonb(source_row)::text, '''' ORDER BY to_jsonb(source_row)::text), ''''), ''sha256''), ''hex'') FROM public.%I AS source_row',
      target_relation
    ) INTO source_digest;
    SELECT encode(
             digest(COALESCE(string_agg(legacy_row::text, '' ORDER BY legacy_row::text), ''), 'sha256'),
             'hex'
           )
      INTO archive_digest
      FROM public.adr109_legacy_archive
     WHERE adr109_legacy_archive.relation_name = target_relation;
    IF archive_digest IS DISTINCT FROM source_digest THEN
      RAISE EXCEPTION 'ADR-109 archive digest mismatch for %', target_relation;
    END IF;
  END LOOP;

  CREATE TABLE IF NOT EXISTS public.adr109_legacy_cleanup_marker (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    completed_at timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO public.adr109_legacy_cleanup_marker (singleton)
  VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;

  FOREACH target_relation IN ARRAY view_names LOOP
    EXECUTE format('DROP VIEW public.%I CASCADE', target_relation);
  END LOOP;
  FOREACH target_relation IN ARRAY table_names LOOP
    EXECUTE format('DROP TABLE public.%I CASCADE', target_relation);
  END LOOP;
END $$;
COMMIT;
