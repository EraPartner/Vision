-- ADR-109 housekeeping: permanently remove the inheritance conversion rollback copies.
-- OUT-OF-BAND and irreversible without the verified logical backup described in README.md.

\if :{?backup_verified}
\else
  \echo 'Refusing: pass -v backup_verified=yes after verifying a restorable logical backup.'
  \quit 3
\endif
BEGIN;
SELECT set_config('vision.backup_verified', :'backup_verified', true);
DO $$
DECLARE
  inv_kind "char";
  txn_kind "char";
  relation_name text;
  relation_kind "char";
  residue_count integer := 0;
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
  table_names text[] := ARRAY[
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
    'legacy_inh_investments_base',
    'portfolio_transactions_legacy',
    'investments_legacy'
  ];
BEGIN
  IF current_setting('vision.backup_verified', true) <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: backup_verified must equal yes';
  END IF;
  SELECT relkind INTO inv_kind FROM pg_class WHERE oid = to_regclass('public.investments');
  SELECT relkind INTO txn_kind FROM pg_class WHERE oid = to_regclass('public.portfolio_transactions');
  IF inv_kind IS DISTINCT FROM 'r' OR txn_kind IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'ADR-109 cleanup requires canonical flat investments and portfolio_transactions tables';
  END IF;

  FOREACH relation_name IN ARRAY view_names LOOP
    SELECT relkind INTO relation_kind
      FROM pg_class
     WHERE oid = to_regclass(format('%I.%I', 'public', relation_name));
    IF relation_kind IS NOT NULL THEN
      residue_count := residue_count + 1;
      IF relation_kind IS DISTINCT FROM 'v' THEN
        RAISE EXCEPTION 'ADR-109 cleanup expected public.% to be a view, found relkind %',
          relation_name, relation_kind;
      END IF;
    END IF;
  END LOOP;

  FOREACH relation_name IN ARRAY table_names LOOP
    SELECT relkind INTO relation_kind
      FROM pg_class
     WHERE oid = to_regclass(format('%I.%I', 'public', relation_name));
    IF relation_kind IS NOT NULL THEN
      residue_count := residue_count + 1;
      IF relation_kind IS DISTINCT FROM 'r' THEN
        RAISE EXCEPTION 'ADR-109 cleanup expected public.% to be a table, found relkind %',
          relation_name, relation_kind;
      END IF;
    END IF;
  END LOOP;

  IF residue_count = 0 THEN
    RAISE NOTICE 'ADR-109 cleanup: no legacy residue found; nothing to do';
    RETURN;
  END IF;
  IF residue_count IS DISTINCT FROM cardinality(view_names) + cardinality(table_names) THEN
    RAISE EXCEPTION 'ADR-109 cleanup found a partial residue set (% of % relations); refusing CASCADE',
      residue_count, cardinality(view_names) + cardinality(table_names);
  END IF;

  CREATE TABLE IF NOT EXISTS public.adr109_legacy_cleanup_marker (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    completed_at timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO public.adr109_legacy_cleanup_marker (singleton)
  VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;

  FOREACH relation_name IN ARRAY view_names LOOP
    EXECUTE format('DROP VIEW public.%I CASCADE', relation_name);
  END LOOP;
  FOREACH relation_name IN ARRAY table_names LOOP
    EXECUTE format('DROP TABLE public.%I CASCADE', relation_name);
  END LOOP;
END $$;
COMMIT;
