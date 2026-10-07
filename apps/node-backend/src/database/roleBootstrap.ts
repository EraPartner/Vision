/**
 * Runtime least-privilege role bootstrap.
 *
 * Native installations create the non-superuser application role at runtime.
 * When the operator configures the three-variable setup
 * (DATABASE_URL pointing at the app role + DATABASE_URL_MIGRATIONS keeping the
 * privileged role), it connects ONCE as the privileged role before the runtime
 * pool starts polling, creates the app role if missing, and (re)applies the
 * grant set.
 *
 * Design constraints (see TODO security backlog entry):
 *   - Idempotent: safe to run on every boot; the grant set is a fixed list of
 *     idempotent GRANT / ALTER DEFAULT PRIVILEGES statements.
 *   - Never weakening: if the app role already exists it is NOT altered (no
 *     password reset, no attribute changes) — only missing grants are added.
 *   - Warn, don't crash: on externally-managed Postgres the connecting
 *     migration role may lack CREATEROLE or even fail to authenticate. Every
 *     failure degrades to a logged warning; ensureAppRole never throws. If the
 *     app role genuinely cannot be made to exist, the ordinary pool-connect
 *     path surfaces the failure exactly as any other bad DATABASE_URL would.
 *   - Single source of truth for grants:
 *     config/postgres/app-role-grants.sql.tpl is packaged with the backend;
 *     this module substitutes the psql-style
 *     :"var" placeholders.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { logger } from "../config/logger.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// repo root: apps/node-backend/src/database/ -> ../../../.. (mirrors migrate.js;
// in the packaged runtime this resolves to its resource root).
const REPO_ROOT = process.env.VISION_RUNTIME_ROOT
  ? path.resolve(process.env.VISION_RUNTIME_ROOT)
  : path.resolve(__dirname, "..", "..", "..", "..");

const GRANTS_TEMPLATE_PATH = path.join(
  REPO_ROOT,
  "config",
  "postgres",
  "app-role-grants.sql.tpl",
);

export interface BootstrapResult {
  status:
    "skipped" | "exists" | "created" | "degraded" | "unavailable" | "error";
  reason?: string;
  grantFailures?: number;
}

/** Minimal shape of a connection URL this module needs. `null` when unparseable. */
export interface ParsedDbUrl {
  user: string;
  password: string;
  database: string;
}

/** The slice of `pg.Client` this module calls. */
export interface PgOneShotClient {
  connect: () => Promise<void>;
  query: (
    text: string,
    params?: unknown[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<{ rows: any[] }>;
  end: () => Promise<void>;
}

export type BootstrapLogger = Pick<typeof logger, "info" | "warn">;

export interface EnsureAppRoleOptions {
  /** Runtime pool URL (the app role). */
  databaseUrl: string;
  /** Privileged URL (DDL / Alembic role). */
  migrationsUrl?: string;
  /** Connect attempts while the DB cold-starts. */
  maxAttempts?: number;
  log?: BootstrapLogger;
}

interface GrantTemplateNames {
  appRole: string;
  ownerRole: string;
  dbName: string;
}

/**
 * Parse user/password/database out of a postgres connection URL.
 */
function parseDbUrl(url: string): ParsedDbUrl | null {
  try {
    const parsed = new URL(url);
    return {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    };
  } catch {
    return null;
  }
}

/** Double-quote a SQL identifier (embedded quotes doubled). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Single-quote a SQL string literal. Uses the E'' form with doubled quotes and
 * doubled backslashes so the value is safe regardless of
 * standard_conforming_strings.
 */
function quoteLiteral(value: string): string {
  return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/**
 * Render the shared grant template into individual executable statements.
 * Exported for tests (keeps the template's placeholder contract honest).
 */
function renderGrantStatements({
  appRole,
  ownerRole,
  dbName,
}: GrantTemplateNames): string[] {
  const template = readFileSync(GRANTS_TEMPLATE_PATH, "utf8");
  const substituted = template
    .split(':"app_role"')
    .join(quoteIdent(appRole))
    .split(':"owner_role"')
    .join(quoteIdent(ownerRole))
    .split(':"db_name"')
    .join(quoteIdent(dbName));
  return substituted
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

/**
 * Apply the template's current-table grant relation by relation.
 *
 * PostgreSQL treats materialized views as tables for `ON ALL TABLES`. Vision's
 * runtime-managed materialized views are deliberately owned by the app role so
 * it can refresh them. Once that ownership handoff has happened, the migration
 * role can no longer grant privileges on those views and PostgreSQL rejects the
 * entire broad GRANT before granting ordinary tables. Expanding the statement
 * lets app-owned objects be skipped and isolates any third-party ownership
 * failure to that one relation.
 *
 * @returns number of relation-specific grant failures
 */
async function grantCurrentRelations(
  client: PgOneShotClient,
  appRole: string,
  log: BootstrapLogger,
): Promise<number> {
  const result = await client.query(`
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS relation_name,
      relation.relkind,
      pg_get_userbyid(relation.relowner) AS owner_name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY relation.relname
  `);
  let failures = 0;
  for (const row of result.rows) {
    if (row.owner_name === appRole) continue;
    const privileges =
      row.relkind === "m" ? "SELECT" : "SELECT, INSERT, UPDATE, DELETE";
    const relation = `${quoteIdent(row.schema_name)}.${quoteIdent(row.relation_name)}`;
    try {
      await client.query(
        `GRANT ${privileges} ON TABLE ${relation} TO ${quoteIdent(appRole)}`,
      );
    } catch (err) {
      failures++;
      log.warn(
        `[role-bootstrap] grant failed (${(err as Error).message}) for relation ${relation}`,
      );
    }
  }
  return failures;
}

function isAllTablesGrant(statement: string): boolean {
  return /\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public\b/i.test(statement);
}

/**
 * Errors that mean "the server isn't accepting connections YET" — worth
 * retrying while postgres finishes a cold start. Anything else (bad password,
 * unknown role/database, TLS mismatch, …) is a configuration problem retries
 * cannot fix.
 */
function isRetryableConnectError(err: unknown): boolean {
  const { code, message } = (err ?? {}) as { code?: string; message?: string };
  const transportCodes = [
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
  ];
  return (
    code === "57P03" || // cannot_connect_now: server is starting up
    (code !== undefined && transportCodes.includes(code)) ||
    /Connection terminated/i.test(message || "")
  );
}

/**
 * Connect a one-shot client as the privileged migration role, waiting out a
 * cold Postgres start with the same backoff envelope as main.js's pool poll.
 */
async function connectPrivileged(
  migrationsUrl: string,
  maxAttempts: number,
  log: BootstrapLogger,
): Promise<PgOneShotClient | null> {
  const baseDelay = 50;
  const maxDelay = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = new pg.Client({
      connectionString: migrationsUrl,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    });
    try {
      await client.connect();
      return client;
    } catch (err) {
      // A failed pg.Client keeps its socket handle until end() is called.
      await client.end().catch(() => {});
      if (!isRetryableConnectError(err)) {
        log.warn(
          `[role-bootstrap] cannot connect as the migration role (${(err as Error).message}) — ` +
            "skipping least-privilege bootstrap. Check DATABASE_URL_MIGRATIONS.",
        );
        return null;
      }
      if (attempt === maxAttempts) {
        log.warn(
          `[role-bootstrap] database not reachable after ${maxAttempts} attempts (${(err as Error).message}) — ` +
            "skipping least-privilege bootstrap.",
        );
        return null;
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      await sleep(delay);
    }
  }
  return null;
}

/**
 * Ensure the non-superuser application role referenced by DATABASE_URL exists
 * with the intended grant set, using DATABASE_URL_MIGRATIONS for privilege.
 *
 * No-op (single-role mode) when DATABASE_URL_MIGRATIONS is unset, equal to
 * DATABASE_URL, or names the same role — existing installs keep booting
 * exactly as before. NEVER throws: every failure path logs a warning and
 * returns a status the caller may inspect.
 */
export async function ensureAppRole({
  databaseUrl,
  migrationsUrl,
  maxAttempts = 40,
  log = logger,
}: EnsureAppRoleOptions): Promise<BootstrapResult> {
  try {
    if (!migrationsUrl || migrationsUrl === databaseUrl) {
      // Single-role setup (the pre-existing default): the runtime pool holds
      // full DDL rights. Deliberately not a warning — this is every install
      // that predates the three-variable setup, and it must boot unchanged.
      log.info(
        "[role-bootstrap] DATABASE_URL_MIGRATIONS not set — single-role database setup. " +
          "See .env.example for the least-privilege (ftm_app) configuration.",
      );
      return { status: "skipped", reason: "single-role" };
    }

    const appConn = parseDbUrl(databaseUrl);
    const migConn = parseDbUrl(migrationsUrl);
    if (!appConn || !migConn) {
      log.warn(
        "[role-bootstrap] could not parse DATABASE_URL / DATABASE_URL_MIGRATIONS — skipping bootstrap.",
      );
      return { status: "skipped", reason: "unparseable-url" };
    }
    if (appConn.user === migConn.user) {
      log.info(
        `[role-bootstrap] DATABASE_URL and DATABASE_URL_MIGRATIONS use the same role (${appConn.user}) — nothing to bootstrap.`,
      );
      return { status: "skipped", reason: "same-role" };
    }
    if (!appConn.user || !appConn.password) {
      log.warn(
        "[role-bootstrap] DATABASE_URL carries no credentials — skipping bootstrap.",
      );
      return { status: "skipped", reason: "no-credentials" };
    }
    if (appConn.database !== migConn.database) {
      log.warn(
        `[role-bootstrap] DATABASE_URL (${appConn.database}) and DATABASE_URL_MIGRATIONS (${migConn.database}) ` +
          "point at different databases — refusing to bootstrap across databases.",
      );
      return { status: "degraded", reason: "database-mismatch" };
    }

    // Render the grant set BEFORE touching the database: creating the role and
    // then failing to grant would leave a login that cannot read any table.
    let grantStatements: string[];
    try {
      grantStatements = renderGrantStatements({
        appRole: appConn.user,
        ownerRole: migConn.user,
        dbName: appConn.database,
      });
    } catch (err) {
      log.warn(
        `[role-bootstrap] cannot read grant template ${GRANTS_TEMPLATE_PATH} (${(err as Error).message}) — skipping bootstrap.`,
      );
      return { status: "error", reason: "grants-template-unreadable" };
    }

    const client = await connectPrivileged(migrationsUrl, maxAttempts, log);
    if (!client)
      return { status: "unavailable", reason: "privileged-connect-failed" };

    try {
      const roleRes = await client.query(
        "SELECT rolsuper FROM pg_roles WHERE rolname = $1",
        [appConn.user],
      );
      let roleExists = roleRes.rows.length > 0;
      const appRoleIsSuperuser =
        roleExists && roleRes.rows[0].rolsuper === true;
      if (appRoleIsSuperuser) {
        log.warn(
          `[role-bootstrap] app role ${appConn.user} is a SUPERUSER — least-privilege is not in effect. ` +
            "Point DATABASE_URL at a non-superuser role.",
        );
      }

      let created = false;
      if (!roleExists) {
        const privRes = await client.query(
          "SELECT (rolsuper OR rolcreaterole) AS can_create FROM pg_roles WHERE rolname = current_user",
        );
        if (privRes.rows[0]?.can_create !== true) {
          log.warn(
            `[role-bootstrap] app role ${appConn.user} does not exist and the migration role lacks CREATEROLE — ` +
              "cannot bootstrap it. Create the role manually with config/postgres/app-role-grants.sql.tpl " +
              "or the runtime pool will fail to connect.",
          );
          return { status: "degraded", reason: "no-createrole" };
        }
        try {
          await client.query(
            `CREATE ROLE ${quoteIdent(appConn.user)} LOGIN PASSWORD ${quoteLiteral(appConn.password)} ` +
              "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
          );
          created = true;
          log.info(
            `[role-bootstrap] created least-privilege application role ${appConn.user}.`,
          );
        } catch (err) {
          if ((err as { code?: string }).code === "42710") {
            // duplicate_object: raced another boot — the role now exists.
            roleExists = true;
          } else {
            log.warn(
              `[role-bootstrap] CREATE ROLE ${appConn.user} failed (${(err as Error).message}) — ` +
                "continuing without least-privilege bootstrap.",
            );
            return { status: "degraded", reason: "create-role-failed" };
          }
        }
      }

      // (Re)apply the grant set every boot. All statements are idempotent, so
      // this self-heals a partial earlier bootstrap and picks up grants for
      // tables that changed ownership. Failures are per-statement warnings —
      // on managed Postgres the migration role may own the tables (GRANT ok)
      // but not the database (GRANT CONNECT fails); partial application is
      // still strictly better than none.
      let grantFailures = 0;
      for (const stmt of grantStatements) {
        try {
          if (isAllTablesGrant(stmt)) {
            grantFailures += await grantCurrentRelations(
              client,
              appConn.user,
              log,
            );
            continue;
          }
          await client.query(stmt);
        } catch (err) {
          grantFailures++;
          log.warn(
            `[role-bootstrap] grant failed (${(err as Error).message}): ${stmt.slice(0, 120)}`,
          );
        }
      }
      if (grantFailures === 0 && created) {
        log.info(`[role-bootstrap] grant set applied to ${appConn.user}.`);
      }
      return { status: created ? "created" : "exists", grantFailures };
    } finally {
      await client.end().catch(() => {});
    }
  } catch (err) {
    // Absolute backstop — this function must never take the boot path down.
    logger.warn(
      `[role-bootstrap] unexpected error (${(err as Error | undefined)?.message}) — continuing boot without bootstrap.`,
    );
    return { status: "error", reason: "unexpected" };
  }
}

export { renderGrantStatements as __renderGrantStatements };
