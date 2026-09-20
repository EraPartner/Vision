import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

export const FRESH_BASELINE_REVISION = "0119_squashed_baseline";
const BASELINE_SHA256 =
  "fc5c527ef9e4c7925dd372626d1c36e0214061ccd76a9471f951e30adaaa5dd0";
const RESTORED_SCHEMA_FINGERPRINT =
  "8508bf6f1c047ff28ea0eaa3e0381580c7c4e5ea94d5f772b0e4e5a2bd6cbc10";

/**
 * Install the reviewed PostgreSQL 18 schema only into a genuinely empty DB.
 * The entire dump and its checks run under one transaction and an advisory
 * lock. A partially prepared or divergent database is never auto-stamped.
 */
export async function installFreshBaseline({ repoRoot, connectionString }) {
  if (!connectionString) throw new Error("Migration database URL is required");
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10 * 60_000,
  });
  await client.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('vision:fresh-baseline:0119'))",
    );
    const { rows } = await client.query(`
      SELECT current_setting('server_version_num')::int / 10000 AS major,
             to_regclass('public.alembic_version') IS NOT NULL AS has_version,
             to_regnamespace('vision_analysis') IS NOT NULL AS has_analysis,
             EXISTS (
               SELECT 1 FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
                 AND NOT EXISTS (
                   SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                     AND d.objid = c.oid AND d.deptype = 'e'
                 )
             ) AS has_relations,
             EXISTS (
               SELECT 1 FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public'
                 AND NOT EXISTS (
                   SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                     AND d.objid = p.oid AND d.deptype = 'e'
                 )
             ) AS has_routines,
             EXISTS (
               SELECT 1 FROM pg_extension WHERE extname NOT IN
                 ('plpgsql', 'pgcrypto', 'pg_trgm', 'pg_stat_statements')
             ) AS unknown_extension
    `);
    const state = rows[0];
    if (state.major !== 18) {
      throw new Error("The reviewed fresh baseline requires PostgreSQL 18");
    }
    if (state.has_version) {
      await client.query("ROLLBACK");
      began = false;
      return false;
    }
    if (
      state.has_analysis ||
      state.has_relations ||
      state.has_routines ||
      state.unknown_extension
    ) {
      throw new Error(
        "Database has objects but no revision marker; refusing fresh baseline",
      );
    }

    const sql = readFileSync(
      path.join(repoRoot, "alembic", "baseline", "0119_fresh.sql"),
      "utf8",
    );
    if (createHash("sha256").update(sql).digest("hex") !== BASELINE_SHA256) {
      throw new Error("Fresh baseline SQL integrity check failed");
    }
    const fingerprintSql = readFileSync(
      path.join(repoRoot, "alembic", "baseline", "schema_fingerprint.sql"),
      "utf8",
    );
    await client.query(sql);
    const revision = await client.query(
      "SELECT version_num FROM public.alembic_version",
    );
    if (
      revision.rows.length !== 1 ||
      revision.rows[0].version_num !== FRESH_BASELINE_REVISION
    ) {
      throw new Error(
        "Fresh baseline revision does not match the reviewed head",
      );
    }
    await client.query('SET LOCAL search_path = "$user", public');
    const fingerprint = await client.query(fingerprintSql);
    if (
      fingerprint.rows[0]?.schema_fingerprint !== RESTORED_SCHEMA_FINGERPRINT
    ) {
      throw new Error("Fresh baseline schema differs from the reviewed shape");
    }
    await client.query("COMMIT");
    began = false;
    return true;
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
