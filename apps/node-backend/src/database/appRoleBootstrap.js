/**
 * Runtime bootstrap for the least-privilege application role (`ftm_app`).
 *
 * Background (security backlog: "Backend DB role is the Postgres bootstrap
 * superuser"). `docker/postgres-init/01-app-role.sh` already creates a
 * non-superuser `ftm_app` role — but ONLY on a database whose data directory
 * is initialised for the first time with POSTGRES_APP_PASSWORD set. That
 * covers neither of the two populations that matter:
 *
 *   1. Existing docker/compose installs — the volume was initialised long ago,
 *      so `docker-entrypoint-initdb.d` never runs again.
 *   2. Every desktop (Electron) install — the packaged compose in
 *      `packaging/electron/resources/docker-compose.yml` does not even mount
 *      the init directory, so `01-app-role.sh` never runs there at all.
 *
 * This module is the runtime equivalent: on every boot, when the operator has
 * configured a two-role setup, it connects with the PRIVILEGED url and makes
 * the app role exist and be sufficiently privileged, then points the runtime
 * pool at it.
 *
 * ── THE VARIABLE MODEL (and why it is this way round) ──────────────────────
 *   DATABASE_URL             privileged/DDL role. NEVER repointed.
 *   DATABASE_URL_MIGRATIONS  optional override for the above (back-compat).
 *   DATABASE_URL_APP         the least-privilege runtime role. Opt-in.
 *
 * The runtime pool starts on the privileged URL — exactly where every existing
 * install already had it — and only moves to DATABASE_URL_APP after this
 * bootstrap has created and verified the role. The desktop shell and the
 * backend image update independently (the packaged compose pins
 * `vision:latest` with `pull_policy: missing`, so a cached older image is not
 * re-pulled), so a NEW shell routinely runs against an OLD backend. Repointing
 * DATABASE_URL would hand that old backend — which has no bootstrap — a role
 * that does not exist, and it would die in its readiness loop before the UI
 * (and the in-app image-update button) ever loads. An extra variable an old
 * image does not read is structurally skew-proof; version coordination is not
 * required.
 *
 * ── SAFETY IS THE INVARIANT ────────────────────────────────────────────────
 * A user's finance app that stops booting is strictly worse than one that runs
 * another day as the superuser. Therefore:
 *
 *   • ensureAppRole() NEVER throws and never calls process.exit.
 *   • Every step is idempotent and tolerates partial prior state (role present
 *     without grants, grants present under a different owner, drifted
 *     password, database recreated by a bundle restore so all grants vanished
 *     while the cluster-level role survived).
 *   • If ANY part of the verification fails, the runtime pool FAILS OPEN by
 *     staying on the privileged URL — i.e. exactly the single-role behaviour
 *     the install had before — and logs loudly at error level with the reason.
 *   • Unset DATABASE_URL_APP (CI, the test harness, every legacy install)
 *     short-circuits to a no-op before a single statement is issued.
 *
 * The password is never logged: only role/URL identities are, always through
 * redact().
 */

import pg from 'pg';
import { getSettings } from '../config/config.js';
import { logger } from '../config/logger.js';
import { setRuntimeConnectionString } from './connection.js';

const settings = getSettings();

// Matches the same connect budget main.js's own db-readiness loop uses (40
// attempts, exponential backoff capped at 1s ≈ 40s): on a first-ever `docker
// compose up` postgres can spend ~30s initialising its data directory, and
// concluding "privileged connect failed" during that window would fail open on
// every cold start.
const CONNECT_ATTEMPTS = 40;
// Short budget for the case where the app role ALREADY logs in: the privileged
// connection is then only wanted to re-verify grants, so an unreachable DDL
// host must not add ~40s to boot. This is the shape a local dev run takes when
// apps/node-backend/.env.local overrides DATABASE_URL to localhost while the
// repo .env's DATABASE_URL_MIGRATIONS still names the compose host `db`.
const CONNECT_ATTEMPTS_WHEN_APP_ROLE_WORKS = 3;
const CONNECT_BASE_DELAY_MS = 50;
const CONNECT_MAX_DELAY_MS = 1000;
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Predefined roles that hand out instance-level reach even without SUPERUSER —
 * membership in any of these defeats the point of the split, so the bootstrap
 * revokes them and verification rejects them.
 */
const PRIVILEGED_PREDEFINED_ROLES = [
  'pg_execute_server_program',
  'pg_read_server_files',
  'pg_write_server_files',
];

/** Grants the app role needs on every existing/future table. */
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
/** Grants the app role needs on every existing/future sequence. */
const SEQUENCE_PRIVILEGES = ['USAGE', 'SELECT', 'UPDATE'];

/**
 * @typedef {object} RoleConfig
 * @property {string} runtimeUrl   DATABASE_URL_APP — where the pool should end up
 * @property {string} runtimeUser  role name inside runtimeUrl
 * @property {string} runtimePassword password inside runtimeUrl ('' when absent)
 * @property {string} privilegedUrl  DATABASE_URL(_MIGRATIONS) — DDL rights
 * @property {string} privilegedUser role name inside privilegedUrl
 */

/**
 * Strip credentials from a connection string for logging.
 * @param {string} url
 * @returns {string}
 */
function redact(url) {
  return String(url).replace(/:\/\/([^:/@]*)(:[^@]*)?@/, '://$1:***@');
}

/**
 * Belt-and-braces: the app-role password is interpolated into `ALTER ROLE ...
 * PASSWORD` SQL by the server's own format(), and a server-side error for such
 * a statement can quote the offending text back. Scrub the secret out of
 * anything that reaches the log.
 *
 * @param {unknown} text
 * @param {string} secret
 * @returns {string}
 */
function scrub(text, secret) {
  const str = String(text ?? '');
  return secret ? str.split(secret).join('***') : str;
}

/**
 * @param {string} url
 * @returns {{ user: string, password: string }|null}
 */
function parseCredentials(url) {
  try {
    const parsed = new URL(url);
    return {
      user: decodeURIComponent(parsed.username || ''),
      password: decodeURIComponent(parsed.password || ''),
    };
  } catch {
    return null;
  }
}

/**
 * Decide whether this process is configured for the two-role setup, and with
 * which identities. Config-only: no I/O, no dependence on bootstrap state, so
 * standalone entrypoints (scripts/db-migrate.js) reach the same conclusion as
 * the app boot.
 *
 * @returns {RoleConfig|null} null when single-role (the unchanged default)
 */
export function resolveRoleConfig() {
  const runtimeUrl = settings.database.appUrl;
  const privilegedUrl = settings.database.migrationsUrl || settings.database.url;
  if (!privilegedUrl || !runtimeUrl) return null;

  const runtime = parseCredentials(runtimeUrl);
  const privileged = parseCredentials(privilegedUrl);
  if (!runtime || !privileged) return null;
  // Same role on both URLs is not a two-role setup — nothing to bootstrap.
  if (!runtime.user || !privileged.user || runtime.user === privileged.user) return null;

  return {
    runtimeUrl,
    runtimeUser: runtime.user,
    runtimePassword: runtime.password,
    privilegedUrl,
    privilegedUser: privileged.user,
  };
}

/**
 * The connection string to use for privileged DDL, or null when the runtime
 * pool is already privileged (every single-role install, and the two-role
 * installs whose bootstrap failed open — there the pool IS the privileged URL,
 * so a second connection would be redundant but harmless).
 *
 * @returns {string|null}
 */
export function privilegedDdlUrl() {
  const config = resolveRoleConfig();
  if (config) return config.privilegedUrl;

  // Legacy opt-in shape, as documented by the first half of this change:
  // DATABASE_URL already names a low-privilege role and DATABASE_URL_MIGRATIONS
  // holds the DDL role. No bootstrap runs there (the operator wired it by hand
  // on a fresh volume via 01-app-role.sh), but migration-time DDL must still
  // not be attempted on the runtime pool.
  const migrationsUrl = settings.database.migrationsUrl;
  if (!migrationsUrl) return null;
  const privileged = parseCredentials(migrationsUrl);
  const runtime = parseCredentials(settings.database.url);
  if (!privileged?.user || !runtime || privileged.user === runtime.user) return null;
  return migrationsUrl;
}

/**
 * Run `fn(runner)` with a query runner that has DDL rights on the schema.
 *
 * In a two-role setup that is a dedicated short-lived connection on
 * DATABASE_URL_MIGRATIONS; otherwise (and if that connection cannot be
 * established) it is `fallbackRunner` — the ordinary runtime pool, which is
 * what every single-role install has always used. Migration-time DDL
 * (`alembic_version` preflight, post-migration ANALYZE) goes through here so
 * it is not attempted by the deliberately-unprivileged app role.
 *
 * @template T
 * @param {(runner: (text: string, params?: any[]) => Promise<any>) => Promise<T>} fn
 * @param {(text: string, params?: any[]) => Promise<any>} fallbackRunner
 * @returns {Promise<T>}
 */
export async function withDdlRunner(fn, fallbackRunner) {
  const url = privilegedDdlUrl();
  if (!url) return fn(fallbackRunner);

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  try {
    await client.connect();
  } catch (err) {
    // Fail open: fall back to the runtime pool exactly as a single-role
    // install would. The statement may then be rejected on privileges, which
    // every caller already treats as non-fatal.
    logger.warn(
      { err: /** @type {any} */ (err)?.message, url: redact(url) },
      'privileged DDL connection unavailable; falling back to the runtime pool',
    );
    return fn(fallbackRunner);
  }
  try {
    return await fn((text, params) => client.query(text, params));
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Connect a pg.Client with the same retry budget as main.js's readiness loop.
 * @param {string} url
 * @param {number} [attempts]
 * @returns {Promise<any|null>} connected client, or null when unreachable
 */
async function connectWithRetry(url, attempts = CONNECT_ATTEMPTS) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => {});
      // Authentication/authorization failures are terminal — retrying 40× only
      // delays the fail-open decision by ~40s. 28P01 invalid_password,
      // 28000 invalid_authorization_specification, 3D000 invalid_catalog_name.
      const code = /** @type {any} */ (err)?.code;
      if (code === '28P01' || code === '28000' || code === '3D000') break;
      const delay = Math.min(CONNECT_BASE_DELAY_MS * 2 ** attempt, CONNECT_MAX_DELAY_MS);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  logger.warn(
    { err: /** @type {any} */ (lastError)?.message, url: redact(url) },
    'could not establish a connection for the app-role bootstrap',
  );
  return null;
}

/**
 * Can we log in with `url` at all? Used as the final go/no-go before handing
 * the runtime pool to the app role: everything else is inference from the
 * catalog, this is the real thing.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function canConnect(url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Build a statement string through Postgres' own `format()`, so identifiers
 * and literals (notably the generated password) are quoted by the server
 * rather than by string concatenation here. Costs one extra round trip per
 * DDL statement, on a path that runs once per boot.
 *
 * @param {any} client
 * @param {string} template `format()` template, e.g. 'GRANT %I TO %I'
 * @param {any[]} args
 * @returns {Promise<string>}
 */
async function formatSql(client, template, args) {
  // Every placeholder is cast explicitly: format() takes VARIADIC "any", so an
  // untyped parameter makes the server give up with
  // "could not determine data type of parameter $2".
  const placeholders = args.map((_, i) => `$${i + 2}::text`).join(', ');
  const sql = placeholders ? `SELECT format($1::text, ${placeholders}) AS sql` : 'SELECT format($1::text) AS sql';
  const { rows } = await client.query(sql, [template, ...args]);
  return rows[0].sql;
}

/**
 * format() a statement and execute it.
 * @param {any} client
 * @param {string} template
 * @param {any[]} [args]
 */
async function execFormatted(client, template, args = []) {
  const sql = await formatSql(client, template, args);
  await client.query(sql);
}

/**
 * Roles whose future objects must carry grants for the app role.
 *
 * The migration role is the obvious one (Alembic creates every table). But an
 * install can legitimately have tables owned by someone else — a bundle
 * restore replays a `--no-owner` dump as whoever ran psql, an older install
 * may have been created by `postgres` directly. ALTER DEFAULT PRIVILEGES is
 * per-creating-role, so a sweep keyed only on the migration role would leave
 * the app 500ing after the next migration adds a table under a different
 * owner. Collect the actual owners, keep the ones we are a member of (we can
 * only set default privileges for those), and always include the migration
 * role itself even if it owns nothing yet (fresh database).
 *
 * @param {any} client
 * @param {RoleConfig} config
 * @returns {Promise<string[]>}
 */
async function resolveDefaultPrivilegeRoles(client, config) {
  const { rows } = await client.query(
    `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'S')
        AND pg_get_userbyid(c.relowner) <> $1
        AND pg_has_role(current_user, c.relowner, 'USAGE')`,
    [config.runtimeUser],
  );
  const owners = new Set([config.privilegedUser]);
  for (const row of rows) if (row.owner) owners.add(row.owner);
  return [...owners];
}

/**
 * Make the app role exist with the credentials in DATABASE_URL and the
 * privilege set the runtime actually needs. Idempotent; safe to re-run on
 * every boot.
 *
 * @param {any} client privileged connection
 * @param {RoleConfig} config
 * @param {number} serverVersionNum
 */
async function applyRoleAndGrants(client, config, serverVersionNum) {
  const role = config.runtimeUser;

  const { rows: existing } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (existing.length === 0) {
    await execFormatted(
      client,
      'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      [role],
    );
    logger.info({ role }, 'created least-privilege application role');
  }

  // Re-assert the attributes on every boot: a role that was hand-edited (or
  // created by an older revision of 01-app-role.sh) must not silently keep
  // SUPERUSER/CREATEROLE. CONNECTION LIMIT is part of this: a limit lower than
  // the pool's `max` lets a single connection (and therefore this bootstrap's
  // own login check) succeed while the app 500s the moment it opens a second
  // one. Cheap, idempotent catalog update.
  await execFormatted(
    client,
    'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1',
    [role],
  );

  // Membership in a privileged role is escalation that `rolsuper = false`
  // does NOT show: `GRANT postgres TO ftm_app` leaves the app role one
  // SET ROLE from superuser, and with the default INHERIT it does not even
  // need that — the superuser's object privileges apply directly. Revoke any
  // such membership; verifyGrants() re-checks and fails open if a revoke
  // did not take.
  const { rows: escalating } = await client.query(
    `SELECT r.rolname
       FROM pg_roles r
      WHERE r.rolname <> $1
        AND pg_has_role($1, r.oid, 'MEMBER')
        AND (r.rolsuper OR r.rolname = ANY($2::text[]))`,
    [role, PRIVILEGED_PREDEFINED_ROLES],
  );
  for (const { rolname } of escalating) {
    try {
      await execFormatted(client, 'REVOKE %I FROM %I', [rolname, role]);
      logger.warn({ role, revoked: rolname }, 'revoked a privileged role membership from the application role');
    } catch (err) {
      logger.error(
        { err: /** @type {any} */ (err)?.message, role, membership: rolname },
        'could not revoke a privileged role membership — verification will fail open',
      );
    }
  }

  // Password drift: the .env that the desktop app writes is the single source
  // of truth for this credential, so sync the role to DATABASE_URL_APP's. Skipped when the URL
  // carries no password (trust/peer auth or a .pgpass setup) — blanking the
  // password there would lock the app out.
  if (config.runtimePassword) {
    await execFormatted(client, 'ALTER ROLE %I PASSWORD %L', [role, config.runtimePassword]);
  } else {
    logger.warn({ role }, 'DATABASE_URL_APP carries no password — leaving the app role password untouched');
  }

  const { rows: dbRows } = await client.query('SELECT current_database() AS db');
  await execFormatted(client, 'GRANT CONNECT ON DATABASE %I TO %I', [dbRows[0].db, role]);
  // CREATE on the schema is required: the backend creates its materialized
  // views and their unique indexes at runtime (materializedViewService).
  await execFormatted(client, 'GRANT USAGE, CREATE ON SCHEMA public TO %I', [role]);
  await execFormatted(client, `GRANT ${TABLE_PRIVILEGES.join(', ')} ON ALL TABLES IN SCHEMA public TO %I`, [role]);
  await execFormatted(client, `GRANT ${SEQUENCE_PRIVILEGES.join(', ')} ON ALL SEQUENCES IN SCHEMA public TO %I`, [role]);

  // Objects created LATER (the next migration's tables/sequences) must be
  // reachable without a manual re-grant, otherwise the app 500s right after an
  // upgrade adds a table. Mirrors 01-app-role.sh, widened to every owning role.
  for (const owner of await resolveDefaultPrivilegeRoles(client, config)) {
    await execFormatted(
      client,
      `ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ${TABLE_PRIVILEGES.join(', ')} ON TABLES TO %I`,
      [owner, role],
    );
    await execFormatted(
      client,
      `ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ${SEQUENCE_PRIVILEGES.join(', ')} ON SEQUENCES TO %I`,
      [owner, role],
    );
  }

  // MAINTAIN (PostgreSQL 17+, and the shipped image is postgres:18-alpine)
  // covers ANALYZE / VACUUM / REFRESH MATERIALIZED VIEW without ownership.
  //
  // Best-effort: on PostgreSQL 16 and older the privilege does not exist, and
  // both call sites that want it degrade — but note HOW. Postgres does NOT
  // raise 42501 for a non-owner VACUUM/ANALYZE: it emits a WARNING
  // ("permission denied to vacuum \"x\", skipping it", SQLSTATE 01000) and
  // SKIPS the relation, so the statement *succeeds* having done nothing. The
  // boot-time whole-DB ANALYZE in main.js therefore silently narrows to the
  // app-owned relations, and the admin VACUUM route pre-checks maintainability
  // itself (routes/admin.js) rather than relying on an error that never comes.
  //
  // Deliberately NOT part of the critical path: wrapped so that a MAINTAIN
  // grant which some future/edge server rejects costs a warning and slightly
  // degraded maintenance, rather than the whole least-privilege switch.
  if (serverVersionNum >= 170000) {
    try {
      await execFormatted(client, 'GRANT MAINTAIN ON ALL TABLES IN SCHEMA public TO %I', [role]);
      for (const owner of await resolveDefaultPrivilegeRoles(client, config)) {
        await execFormatted(
          client,
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT MAINTAIN ON TABLES TO %I',
          [owner, role],
        );
      }
    } catch (err) {
      logger.warn(
        { err: /** @type {any} */ (err)?.message, role, serverVersionNum },
        'could not grant MAINTAIN — boot-time ANALYZE and the admin VACUUM route will degrade; continuing',
      );
    }
  }

  // Materialized views are runtime artifacts (ADR-027): the app CREATEs them,
  // indexes them and REFRESHes them. REFRESH MATERIALIZED VIEW requires
  // OWNERSHIP (or MAINTAIN) — a plain SELECT/INSERT sweep is not enough. On a
  // fresh two-role install the app creates them and therefore owns them; on an
  // install that has been running single-role they are owned by the superuser,
  // so hand them over. Ownership of an MV only confers rights over an artifact
  // the app rebuilds from scratch anyway.
  const { rows: matviews } = await client.query(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'm'
        AND pg_get_userbyid(c.relowner) <> $1`,
    [role],
  );
  for (const { relname } of matviews) {
    await execFormatted(client, 'ALTER MATERIALIZED VIEW public.%I OWNER TO %I', [relname, role]);
    logger.info({ view: relname, role }, 'reassigned materialized view to the application role');
  }
}

/**
 * Confirm, from the catalog, that the app role can actually do everything the
 * runtime does. Anything short of a clean bill of health fails open.
 *
 * `has_*_privilege` with a comma list is an OR, not an AND — hence one call
 * per privilege.
 *
 * @param {any} client privileged connection
 * @param {RoleConfig} config
 * @param {number} serverVersionNum
 * @returns {Promise<string[]>} list of shortfalls; empty means verified
 */
async function verifyGrants(client, config, serverVersionNum) {
  const role = config.runtimeUser;
  const tableChecks = TABLE_PRIVILEGES.map((p) => `has_table_privilege($1, c.oid, '${p}')`).join(' AND ');
  const sequenceChecks = SEQUENCE_PRIVILEGES.map((p) => `has_sequence_privilege($1, c.oid, '${p}')`).join(' AND ');
  const maintainCheck = serverVersionNum >= 170000 ? `has_table_privilege($1, c.oid, 'MAINTAIN')` : 'false';

  const { rows } = await client.query(
    `SELECT
       has_database_privilege($1, current_database(), 'CONNECT') AS db_connect,
       has_schema_privilege($1, 'public', 'USAGE')  AS schema_usage,
       has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
       (SELECT count(*)::int FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
           AND NOT (${tableChecks})) AS tables_missing_dml,
       (SELECT count(*)::int FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'S'
           AND NOT (${sequenceChecks})) AS sequences_missing,
       -- Views need SELECT only (GRANT ... ON ALL TABLES covers them, but the
       -- schema has none at 0086 — this is future-proofing, and requiring only
       -- SELECT avoids a spurious fail-open on a read-only view).
       (SELECT count(*)::int FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'v'
           AND NOT has_table_privilege($1, c.oid, 'SELECT')) AS views_missing_select,
       (SELECT count(*)::int FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'm'
           AND NOT pg_has_role($1, c.relowner, 'USAGE')
           AND NOT (${maintainCheck})) AS matviews_unrefreshable,
       (SELECT rolsuper FROM pg_roles WHERE rolname = $1) AS is_superuser,
       -- Escalation by MEMBERSHIP: rolsuper stays false while the role is one
       -- SET ROLE (or, under INHERIT, zero steps) from a superuser.
       EXISTS (SELECT 1 FROM pg_roles r
                WHERE r.rolname <> $1
                  AND pg_has_role($1, r.oid, 'MEMBER')
                  AND (r.rolsuper OR r.rolname = ANY($2::text[]))) AS inherits_privileged,
       (SELECT rolconnlimit FROM pg_roles WHERE rolname = $1) AS conn_limit`,
    [role, PRIVILEGED_PREDEFINED_ROLES],
  );
  const r = rows[0];
  /** @type {string[]} */
  const shortfalls = [];
  if (!r.db_connect) shortfalls.push('no CONNECT on the database');
  if (!r.schema_usage) shortfalls.push('no USAGE on schema public');
  if (!r.schema_create) shortfalls.push('no CREATE on schema public (materialized views cannot be built)');
  if (r.tables_missing_dml > 0) shortfalls.push(`${r.tables_missing_dml} table(s) without full DML`);
  if (r.sequences_missing > 0) shortfalls.push(`${r.sequences_missing} sequence(s) without USAGE/SELECT/UPDATE`);
  if (r.views_missing_select > 0) shortfalls.push(`${r.views_missing_select} view(s) without SELECT`);
  if (r.matviews_unrefreshable > 0) {
    shortfalls.push(`${r.matviews_unrefreshable} materialized view(s) the app role cannot REFRESH`);
  }
  // Not a shortfall — the opposite. If the "app role" turns out to be a
  // superuser the two-role split buys nothing, and silently pretending
  // otherwise would be the worst outcome of this whole change.
  if (r.is_superuser) shortfalls.push('the configured app role is a SUPERUSER — refusing to claim least privilege');
  if (r.inherits_privileged) {
    shortfalls.push('the app role is a member of a SUPERUSER or instance-level predefined role — refusing to claim least privilege');
  }
  // -1 = unlimited. Anything else can be lower than the pool's `max`, which
  // turns into 53300 "too many connections for role" under concurrency while
  // every single-connection check here still passes.
  if (r.conn_limit !== -1) shortfalls.push(`the app role has CONNECTION LIMIT ${r.conn_limit} (expected -1)`);
  return shortfalls;
}

/**
 * @typedef {object} BootstrapResult
 * @property {'single-role'|'two-role'|'fail-open'} mode
 * @property {string} reason
 * @property {string} [role] the role the runtime pool ended up as
 */

/**
 * Ensure the runtime pool runs as the least-privilege application role,
 * creating/repairing that role first. Never throws.
 *
 * @returns {Promise<BootstrapResult>}
 */
export async function ensureAppRole() {
  const config = resolveRoleConfig();
  if (!config) {
    // The default for every install that has not opted in, for CI and for the
    // vitest DB harness: not a single statement is issued and the pool keeps
    // DATABASE_URL untouched.
    return { mode: 'single-role', reason: 'DATABASE_URL_APP not set (or same role as the privileged URL)' };
  }

  /**
   * Point the pool back at the privileged role — i.e. the behaviour the
   * install had before two-role was configured — and say why, loudly.
   * @param {string} reason
   * @returns {BootstrapResult}
   */
  const failOpen = (reason) => {
    // Normally a no-op: the pool's default IS the privileged URL, and this
    // bootstrap is the only thing that ever moves it. Called explicitly so the
    // invariant holds regardless of how far the bootstrap got.
    setRuntimeConnectionString(config.privilegedUrl);
    logger.error(
      { reason, appRole: config.runtimeUser, fallbackRole: config.privilegedUser },
      'least-privilege DB role bootstrap did not complete — FALLING BACK to the privileged role so the app still boots. ' +
        'The runtime pool is running with the privileged database role; fix the cause and restart to regain least privilege.',
    );
    return { mode: 'fail-open', reason, role: config.privilegedUser };
  };

  if (settings.database.disableAppRoleBootstrap) {
    return failOpen('VISION_DISABLE_APP_ROLE_BOOTSTRAP is set');
  }

  // Probe the app role first. Two things come out of it: how patient to be
  // about the privileged connection (see CONNECT_ATTEMPTS_WHEN_APP_ROLE_WORKS),
  // and which branch to take if that connection never comes up.
  const appRoleAlreadyWorks = await canConnect(config.runtimeUrl);
  const client = await connectWithRetry(
    config.privilegedUrl,
    appRoleAlreadyWorks ? CONNECT_ATTEMPTS_WHEN_APP_ROLE_WORKS : CONNECT_ATTEMPTS,
  );
  if (!client) {
    // No DDL connection. If the app role already works (bootstrapped on an
    // earlier boot) keep least privilege rather than escalating on a transient
    // blip; otherwise fail open and let main.js's own readiness loop report a
    // genuinely unreachable database.
    if (appRoleAlreadyWorks) {
      logger.warn(
        { role: config.runtimeUser },
        'privileged connection unavailable; keeping the existing least-privilege role (grants not re-verified this boot)',
      );
      setRuntimeConnectionString(config.runtimeUrl);
      return { mode: 'two-role', reason: 'privileged connection unavailable, app role already usable', role: config.runtimeUser };
    }
    return failOpen('privileged connection unavailable and the app role cannot log in');
  }

  try {
    const { rows } = await client.query('SHOW server_version_num');
    const serverVersionNum = Number(rows[0].server_version_num) || 0;

    await applyRoleAndGrants(client, config, serverVersionNum);

    const shortfalls = await verifyGrants(client, config, serverVersionNum);
    if (shortfalls.length > 0) return failOpen(`grant verification failed: ${shortfalls.join('; ')}`);
  } catch (err) {
    return failOpen(
      `bootstrap statement failed: ${scrub(/** @type {any} */ (err)?.message, config.runtimePassword)}`,
    );
  } finally {
    await client.end().catch(() => {});
  }

  // Catalog says yes; now prove it by actually logging in as the app role.
  if (!(await canConnect(config.runtimeUrl))) {
    return failOpen('app role could not log in with the credentials in DATABASE_URL_APP');
  }

  setRuntimeConnectionString(config.runtimeUrl);
  logger.info(
    { role: config.runtimeUser, ddlRole: config.privilegedUser, url: redact(config.runtimeUrl) },
    'runtime database pool is running on the least-privilege application role',
  );
  return { mode: 'two-role', reason: 'bootstrap verified', role: config.runtimeUser };
}
