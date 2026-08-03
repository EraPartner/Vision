/**
 * Runtime least-privilege role bootstrap.
 *
 * docker/postgres-init/01-app-role.sh creates the non-superuser `ftm_app`
 * role — but only when the Postgres data volume is FIRST initialised.
 * Already-initialised databases (every install that predates the
 * least-privilege setup, and every packaged desktop install, whose embedded
 * compose does not mount the init dir at all) never run it. This module closes
 * that gap: when the operator configures the three-variable setup
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
 *     docker/postgres-init/app-role-grants.sql.tpl is shared verbatim with the
 *     first-init shell script; this module substitutes the same psql-style
 *     :"var" placeholders.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { logger } from '../config/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// repo root: apps/node-backend/src/database/ -> ../../../.. (mirrors migrate.js;
// in the Docker image this resolves to /app, where the Dockerfile copies
// docker/postgres-init/ alongside alembic/).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const GRANTS_TEMPLATE_PATH = path.join(
  REPO_ROOT, 'docker', 'postgres-init', 'app-role-grants.sql.tpl'
);

/**
 * @typedef {object} BootstrapResult
 * @property {'skipped'|'exists'|'created'|'degraded'|'unavailable'|'error'} status
 * @property {string} [reason]
 * @property {number} [grantFailures]
 */

/**
 * Minimal shape of a connection URL this module needs. `null` when unparseable.
 * @typedef {{ user: string, password: string, database: string }} ParsedDbUrl
 */

/**
 * Structural stand-in for `pg`'s `Client`, scoped to what this module calls on
 * it — `pg` ships no type declarations and the ambient `declare module 'pg'`
 * (thirdPartyModules.d.ts) exposes no named members (same situation as
 * connection.js's PgPoolClient).
 * @typedef {object} PgOneShotClient
 * @property {() => Promise<void>} connect
 * @property {(text: string, params?: any[]) => Promise<{ rows: any[] }>} query
 * @property {() => Promise<void>} end
 */

/**
 * Parse user/password/database out of a postgres connection URL.
 * @param {string} url
 * @returns {ParsedDbUrl|null}
 */
function parseDbUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    };
  } catch {
    return null;
  }
}

/** Double-quote a SQL identifier (embedded quotes doubled). @param {string} name */
function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Single-quote a SQL string literal. Uses the E'' form with doubled quotes and
 * doubled backslashes so the value is safe regardless of
 * standard_conforming_strings.
 * @param {string} value
 */
function quoteLiteral(value) {
  return `E'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * Render the shared grant template into individual executable statements.
 * Exported for tests (keeps the template's placeholder contract honest).
 *
 * @param {{ appRole: string, ownerRole: string, dbName: string }} names
 * @returns {string[]}
 */
export function renderGrantStatements({ appRole, ownerRole, dbName }) {
  const template = readFileSync(GRANTS_TEMPLATE_PATH, 'utf8');
  const substituted = template
    .split(':"app_role"').join(quoteIdent(appRole))
    .split(':"owner_role"').join(quoteIdent(ownerRole))
    .split(':"db_name"').join(quoteIdent(dbName));
  return substituted
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

/**
 * Errors that mean "the server isn't accepting connections YET" — worth
 * retrying while postgres finishes a cold start. Anything else (bad password,
 * unknown role/database, TLS mismatch, …) is a configuration problem retries
 * cannot fix.
 * @param {any} err
 */
function isRetryableConnectError(err) {
  const transportCodes = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'];
  return (
    err?.code === '57P03' // cannot_connect_now: server is starting up
    || transportCodes.includes(err?.code)
    || /Connection terminated/i.test(err?.message || '')
  );
}

/**
 * Connect a one-shot client as the privileged migration role, waiting out a
 * cold Postgres start with the same backoff envelope as main.js's pool poll.
 *
 * @param {string} migrationsUrl
 * @param {number} maxAttempts
 * @param {typeof logger} log
 * @returns {Promise<PgOneShotClient|null>}
 */
async function connectPrivileged(migrationsUrl, maxAttempts, log) {
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
          `[role-bootstrap] cannot connect as the migration role (${err.message}) — `
          + 'skipping least-privilege bootstrap. Check DATABASE_URL_MIGRATIONS.'
        );
        return null;
      }
      if (attempt === maxAttempts) {
        log.warn(
          `[role-bootstrap] database not reachable after ${maxAttempts} attempts (${err.message}) — `
          + 'skipping least-privilege bootstrap.'
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
 *
 * @param {object} opts
 * @param {string} opts.databaseUrl - runtime pool URL (the app role)
 * @param {string} [opts.migrationsUrl] - privileged URL (DDL / Alembic role)
 * @param {number} [opts.maxAttempts] - connect attempts while DB cold-starts
 * @param {typeof logger} [opts.log]
 * @returns {Promise<BootstrapResult>}
 */
export async function ensureAppRole({ databaseUrl, migrationsUrl, maxAttempts = 40, log = logger }) {
  try {
    if (!migrationsUrl || migrationsUrl === databaseUrl) {
      // Single-role setup (the pre-existing default): the runtime pool holds
      // full DDL rights. Deliberately not a warning — this is every install
      // that predates the three-variable setup, and it must boot unchanged.
      log.info(
        '[role-bootstrap] DATABASE_URL_MIGRATIONS not set — single-role database setup. '
        + 'See .env.example for the least-privilege (ftm_app) configuration.'
      );
      return { status: 'skipped', reason: 'single-role' };
    }

    const appConn = parseDbUrl(databaseUrl);
    const migConn = parseDbUrl(migrationsUrl);
    if (!appConn || !migConn) {
      log.warn('[role-bootstrap] could not parse DATABASE_URL / DATABASE_URL_MIGRATIONS — skipping bootstrap.');
      return { status: 'skipped', reason: 'unparseable-url' };
    }
    if (appConn.user === migConn.user) {
      log.info(
        `[role-bootstrap] DATABASE_URL and DATABASE_URL_MIGRATIONS use the same role (${appConn.user}) — nothing to bootstrap.`
      );
      return { status: 'skipped', reason: 'same-role' };
    }
    if (!appConn.user || !appConn.password) {
      log.warn('[role-bootstrap] DATABASE_URL carries no credentials — skipping bootstrap.');
      return { status: 'skipped', reason: 'no-credentials' };
    }
    if (appConn.database !== migConn.database) {
      log.warn(
        `[role-bootstrap] DATABASE_URL (${appConn.database}) and DATABASE_URL_MIGRATIONS (${migConn.database}) `
        + 'point at different databases — refusing to bootstrap across databases.'
      );
      return { status: 'degraded', reason: 'database-mismatch' };
    }

    // Render the grant set BEFORE touching the database: creating the role and
    // then failing to grant would leave a login that cannot read any table.
    /** @type {string[]} */
    let grantStatements;
    try {
      grantStatements = renderGrantStatements({
        appRole: appConn.user,
        ownerRole: migConn.user,
        dbName: appConn.database,
      });
    } catch (err) {
      log.warn(
        `[role-bootstrap] cannot read grant template ${GRANTS_TEMPLATE_PATH} (${/** @type {any} */ (err).message}) — skipping bootstrap.`
      );
      return { status: 'error', reason: 'grants-template-unreadable' };
    }

    const client = await connectPrivileged(migrationsUrl, maxAttempts, log);
    if (!client) return { status: 'unavailable', reason: 'privileged-connect-failed' };

    try {
      const roleRes = await client.query(
        'SELECT rolsuper FROM pg_roles WHERE rolname = $1', [appConn.user]
      );
      let roleExists = roleRes.rows.length > 0;
      const appRoleIsSuperuser = roleExists && roleRes.rows[0].rolsuper === true;
      if (appRoleIsSuperuser) {
        log.warn(
          `[role-bootstrap] app role ${appConn.user} is a SUPERUSER — least-privilege is not in effect. `
          + 'Point DATABASE_URL at a non-superuser role.'
        );
      }

      let created = false;
      if (!roleExists) {
        const privRes = await client.query(
          'SELECT (rolsuper OR rolcreaterole) AS can_create FROM pg_roles WHERE rolname = current_user'
        );
        if (privRes.rows[0]?.can_create !== true) {
          log.warn(
            `[role-bootstrap] app role ${appConn.user} does not exist and the migration role lacks CREATEROLE — `
            + 'cannot bootstrap it. Create the role manually (see docker/postgres-init/01-app-role.sh for the intended shape) '
            + 'or the runtime pool will fail to connect.'
          );
          return { status: 'degraded', reason: 'no-createrole' };
        }
        try {
          await client.query(
            `CREATE ROLE ${quoteIdent(appConn.user)} LOGIN PASSWORD ${quoteLiteral(appConn.password)} `
            + 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION'
          );
          created = true;
          log.info(`[role-bootstrap] created least-privilege application role ${appConn.user}.`);
        } catch (err) {
          if (/** @type {any} */ (err).code === '42710') {
            // duplicate_object: raced another boot — the role now exists.
            roleExists = true;
          } else {
            log.warn(
              `[role-bootstrap] CREATE ROLE ${appConn.user} failed (${/** @type {any} */ (err).message}) — `
              + 'continuing without least-privilege bootstrap.'
            );
            return { status: 'degraded', reason: 'create-role-failed' };
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
          await client.query(stmt);
        } catch (err) {
          grantFailures++;
          log.warn(
            `[role-bootstrap] grant failed (${/** @type {any} */ (err).message}): ${stmt.slice(0, 120)}`
          );
        }
      }
      if (grantFailures === 0 && created) {
        log.info(`[role-bootstrap] grant set applied to ${appConn.user}.`);
      }
      return { status: created ? 'created' : 'exists', grantFailures };
    } finally {
      await client.end().catch(() => {});
    }
  } catch (err) {
    // Absolute backstop — this function must never take the boot path down.
    logger.warn(
      `[role-bootstrap] unexpected error (${/** @type {any} */ (err)?.message}) — continuing boot without bootstrap.`
    );
    return { status: 'error', reason: 'unexpected' };
  }
}
