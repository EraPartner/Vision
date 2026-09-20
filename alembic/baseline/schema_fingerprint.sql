-- Exact catalog inventory for the PostgreSQL 18 baseline bridge.
-- Excludes object IDs, owners, row data and sequence values. Includes objects
-- in the two application schemas and installed extension versions.
WITH objects AS (
  SELECT 'schema' AS kind, n.nspname::text AS name,
         jsonb_build_array(n.nspname) AS definition
    FROM pg_namespace n WHERE n.nspname IN ('public', 'vision_analysis')
  UNION ALL
  SELECT 'relation', n.nspname || '.' || c.relname,
         jsonb_build_array(c.relkind, c.relpersistence, c.relrowsecurity,
                           c.relforcerowsecurity, c.reloptions,
                           pg_get_expr(c.relpartbound, c.oid),
                           CASE WHEN c.relkind IN ('v', 'm')
                             THEN pg_get_viewdef(c.oid, false) END)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'vision_analysis')
     AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname,
         jsonb_build_array(a.attnum, format_type(a.atttypid, a.atttypmod),
                           a.attnotnull, a.attidentity, a.attgenerated,
                           a.attcollation::regcollation::text,
                           pg_get_expr(d.adbin, d.adrelid))
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname IN ('public', 'vision_analysis')
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint', n.nspname || '.' || c.relname || '.' || co.conname,
         jsonb_build_array(co.contype, co.convalidated, co.condeferrable,
                           co.condeferred, pg_get_constraintdef(co.oid, false))
    FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'vision_analysis')
  UNION ALL
  SELECT 'domain_constraint', n.nspname || '.' || t.typname || '.' || co.conname,
         jsonb_build_array(co.convalidated, pg_get_constraintdef(co.oid, false))
    FROM pg_constraint co JOIN pg_type t ON t.oid = co.contypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname IN ('public', 'vision_analysis')
  UNION ALL
  SELECT 'index', n.nspname || '.' || c.relname,
         jsonb_build_array(pg_get_indexdef(c.oid, 0, false))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'vision_analysis') AND c.relkind = 'i'
  UNION ALL
  SELECT 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname,
         jsonb_build_array(t.tgenabled, pg_get_triggerdef(t.oid, false))
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'vision_analysis') AND NOT t.tgisinternal
  UNION ALL
  SELECT 'routine', n.nspname || '.' || p.proname || '(' ||
         pg_get_function_identity_arguments(p.oid) || ')',
         jsonb_build_array(pg_get_functiondef(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'vision_analysis')
     AND p.prokind IN ('f', 'p', 'w')
  UNION ALL
  SELECT 'enum', n.nspname || '.' || t.typname,
         jsonb_build_array((SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
                              FROM pg_enum e WHERE e.enumtypid = t.oid))
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname IN ('public', 'vision_analysis') AND t.typtype = 'e'
  UNION ALL
  SELECT 'domain', n.nspname || '.' || t.typname,
         jsonb_build_array(format_type(t.typbasetype, t.typtypmod),
                           t.typnotnull, t.typdefault)
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname IN ('public', 'vision_analysis') AND t.typtype = 'd'
  UNION ALL
  SELECT 'policy', n.nspname || '.' || c.relname || '.' || p.polname,
         jsonb_build_array(p.polcmd, p.polpermissive,
                           (SELECT jsonb_agg(CASE WHEN role_id = 0 THEN 'PUBLIC'
                                                  ELSE pg_get_userbyid(role_id) END
                                             ORDER BY role_id)
                              FROM unnest(p.polroles) AS role_id),
                           pg_get_expr(p.polqual, p.polrelid),
                           pg_get_expr(p.polwithcheck, p.polrelid))
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'vision_analysis')
  UNION ALL
  SELECT 'rule', n.nspname || '.' || c.relname || '.' || r.rulename,
         jsonb_build_array(pg_get_ruledef(r.oid, false))
    FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'vision_analysis') AND r.rulename <> '_RETURN'
  UNION ALL
  SELECT 'sequence', n.nspname || '.' || c.relname,
         jsonb_build_array(s.seqtypid::regtype::text, s.seqstart, s.seqincrement,
                           s.seqmin, s.seqmax, s.seqcache, s.seqcycle)
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'vision_analysis')
  UNION ALL
  SELECT 'extension', e.extname,
         jsonb_build_array(e.extname, e.extversion, n.nspname)
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname <> 'plpgsql'
)
SELECT encode(public.digest(convert_to(jsonb_agg(
         jsonb_build_array(kind, name, definition)
         ORDER BY kind, name, definition::text
       )::text, 'UTF8'), 'sha256'), 'hex') AS schema_fingerprint
  FROM objects;
