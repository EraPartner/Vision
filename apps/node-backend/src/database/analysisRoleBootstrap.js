/** Provision the fixed, login-capable, least-privilege analysis role. */

import pg from "pg";
import { logger } from "../config/logger.js";

const ANALYSIS_ROLE = "vision_analysis_executor";

function parseUrl(value) {
  try {
    const parsed = new URL(value);
    return {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    };
  } catch {
    return null;
  }
}

function quoteLiteral(value) {
  return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/**
 * Ensure the executor login exists and can read only the approved views.
 * This is fail-soft at boot; query execution itself fails closed if the role
 * is unavailable or its grants are incomplete.
 */
export async function ensureAnalysisRole({
  databaseUrl,
  analysisUrl,
  migrationsUrl,
  log = logger,
}) {
  const analysis = parseUrl(analysisUrl);
  const runtime = parseUrl(databaseUrl);
  if (!analysis || !runtime || analysis.user !== ANALYSIS_ROLE) {
    log.warn(
      `[analysis-role] DATABASE_URL_ANALYSIS must use the fixed ${ANALYSIS_ROLE} role.`,
    );
    return { status: "degraded", reason: "invalid-analysis-url" };
  }
  if (!analysis.password || analysis.database !== runtime.database) {
    log.warn(
      "[analysis-role] analysis URL needs credentials and the runtime database.",
    );
    return { status: "degraded", reason: "invalid-analysis-credentials" };
  }

  const client = new pg.Client({
    connectionString: migrationsUrl || databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    const privileges = await client.query(
      "SELECT rolsuper OR rolcreaterole AS can_create FROM pg_roles WHERE rolname = current_user",
    );
    const exists = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [ANALYSIS_ROLE],
    );
    if (exists.rows.length === 0) {
      if (privileges.rows[0]?.can_create !== true) {
        log.warn("[analysis-role] owner lacks CREATEROLE; executor disabled.");
        return { status: "degraded", reason: "no-createrole" };
      }
      await client.query(
        `CREATE ROLE ${ANALYSIS_ROLE} LOGIN PASSWORD ${quoteLiteral(analysis.password)} ` +
          "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
      );
    } else {
      await client.query(
        `ALTER ROLE ${ANALYSIS_ROLE} PASSWORD ${quoteLiteral(analysis.password)} ` +
          "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
      );
    }

    await client.query(
      `ALTER ROLE ${ANALYSIS_ROLE} SET default_transaction_read_only = on`,
    );
    await client.query(
      `ALTER ROLE ${ANALYSIS_ROLE} SET statement_timeout = '5000ms'`,
    );
    await client.query(
      `ALTER ROLE ${ANALYSIS_ROLE} SET lock_timeout = '1000ms'`,
    );
    await client.query(
      `ALTER ROLE ${ANALYSIS_ROLE} SET idle_in_transaction_session_timeout = '5000ms'`,
    );
    await client.query(
      `ALTER ROLE ${ANALYSIS_ROLE} SET search_path = vision_analysis, pg_catalog`,
    );
    await client.query(`REVOKE ALL ON SCHEMA public FROM ${ANALYSIS_ROLE}`);
    await client.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${ANALYSIS_ROLE}`,
    );
    await client.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA vision_analysis FROM ${ANALYSIS_ROLE}`,
    );
    await client.query(
      `GRANT USAGE ON SCHEMA vision_analysis TO ${ANALYSIS_ROLE}`,
    );
    for (const relation of [
      "transactions_v1",
      "accounts_v1",
      "holding_events_v1",
      "cash_flows_v1",
    ]) {
      await client.query(
        `GRANT SELECT ON vision_analysis.${relation} TO ${ANALYSIS_ROLE}`,
      );
    }
    return { status: exists.rows.length ? "exists" : "created" };
  } catch (error) {
    log.warn(
      `[analysis-role] bootstrap failed (${error.message}); executor disabled.`,
    );
    return { status: "degraded", reason: "bootstrap-failed" };
  } finally {
    await client.end().catch(() => {});
  }
}

export { ANALYSIS_ROLE as __ANALYSIS_ROLE };
