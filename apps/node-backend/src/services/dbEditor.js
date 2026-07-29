/**
 * DB data-editor service — powers the JetBrains-style table browser/editor in
 * the admin DB Maintenance UI.
 *
 * Safety model (see docs/adr for rationale):
 *   - Table/column identifiers are validated against pg_stat_user_tables /
 *     information_schema and double-quoted — never interpolated raw.
 *   - Reads accept only structured, parameterized filters[] (the raw WHERE
 *     escape hatch was removed, ADR-101 2026-07-10 — any `where` param now 400s)
 *     and run inside a READ ONLY transaction with a short statement_timeout, so a
 *     browse can neither mutate nor hang the DB.
 *   - Writes run in one transaction. Each edited row is locked (FOR UPDATE) and
 *     its version (the `xmin` system column) is compared against the token the
 *     client loaded — a mismatch is a 409 conflict, never a silent overwrite.
 *   - Postgres still enforces every structural constraint (FK / CHECK / NOT
 *     NULL / UNIQUE); violations are mapped to friendly errors in mapDbError().
 *   - Edits to a materialized-view base table schedule a debounced refresh.
 *
 * This bypasses app-level domain logic by design (it is a raw data editor); the
 * deeper trade-offs are documented in the ADR.
 */

import { query, getClient } from '../database/connection.js';
import { logger } from '../config/logger.js';
import { scheduleAggregationRefresh } from './aggregationRefresh.js';
import {
  AppError,
  ValidationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../middleware/errorHandler.js';

/** @typedef {import('../types/rows.js').QueryRunner} QueryRunner */

/**
 * Column metadata for one table column, as introspected from
 * `information_schema.columns` + the primary-key query. Genuinely dynamic —
 * this editor works against any public table, so there is no fixed row shape
 * to type against; `ColumnMeta`/`TableMeta` describe the editor's own
 * bookkeeping, not the tables it edits.
 * @typedef {object} ColumnMeta
 * @property {string} name
 * @property {string} dataType
 * @property {string} udtName
 * @property {boolean} nullable
 * @property {boolean} hasDefault
 * @property {boolean} generated
 * @property {boolean} writable
 */

/**
 * @typedef {object} TableMeta
 * @property {string} table
 * @property {ColumnMeta[]} columns
 * @property {string[]} primaryKey
 */

/**
 * A structured filter clause from the browse UI (see the ADR-101 note on
 * `readRows` — the raw-WHERE escape hatch was removed).
 * @typedef {object} Filter
 * @property {string} column
 * @property {string} [op] one of FILTER_OPS; defaults to 'eq'.
 * @property {unknown} [value]
 */

/**
 * A pending row edit from the DB editor UI. `values`/`set`/`pk` are raw
 * column-name → value maps — genuinely dynamic (any editable table, any
 * column set), typed as `Record<string, unknown>` rather than a fixed shape.
 * @typedef {object} Change
 * @property {'insert'|'update'|'delete'} op
 * @property {Record<string, unknown>} [values] insert only.
 * @property {Record<string, unknown>} [set] update only — changed columns.
 * @property {Record<string, unknown>} [pk] update/delete — primary-key column values identifying the row.
 * @property {unknown} [xmin] optimistic-concurrency token (the row's `xmin`) from the row the client loaded.
 */

/**
 * Per-change context threaded through the mutation builders.
 * @typedef {object} MutationCtx
 * @property {Map<string, ColumnMeta>} colMeta
 * @property {string[]} primaryKey
 * @property {number} index
 */

/**
 * One row of the `db_editor_audit` sink (both the DB table and the
 * structured-logger mirror) — mirrors whatever table/row was edited, so
 * `pk`/`before`/`after` are the same dynamic row shape as `Change`.
 * @typedef {object} AuditEntry
 * @property {string} table
 * @property {string} op
 * @property {Record<string, unknown>|undefined} pk
 * @property {Record<string, unknown>|undefined} before
 * @property {Record<string, unknown>|undefined} after
 * @property {string} statement
 */

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;

// Base tables whose rows feed the dashboard materialized views. Editing any of
// these leaves the views stale until refreshed (see materializedViewService).
const MATVIEW_BASE_TABLES = new Set(['transactions', 'recipients', 'categories']);

const FILTER_OPS = new Set([
  'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'isnull', 'notnull',
]);

// ── Identifier safety ───────────────────────────────────────────────────────

/**
 * @param {unknown} name
 * @returns {string}
 */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, fallback, min, max) {
  // String(value): Number.parseInt already ToStrings a non-string argument
  // internally (same algorithm), so this is a no-op for behavior — it only
  // satisfies parseInt's string-typed signature.
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// The catalog IS the injection allowlist, so it must stay correct — but table
// column/PK metadata is static within a running backend (this editor only does
// data DML, never DDL; a schema migration restarts the process). A short TTL
// memo removes the ~5 catalog round-trips per browse tick / mutation without
// weakening the allowlist semantics.
const META_TTL_MS = 60_000;
let userTablesCache = { value: /** @type {Set<string>|null} */ (null), expiresAt: 0 };
const tableMetaCache = new Map();

async function listUserTables() {
  const now = Date.now();
  if (userTablesCache.value && userTablesCache.expiresAt > now) return userTablesCache.value;
  const r = await query(
    `SELECT relname FROM pg_stat_user_tables WHERE schemaname = 'public'`,
    [],
  );
  const set = new Set(r.rows.map((/** @type {{ relname: string }} */ row) => row.relname));
  userTablesCache = { value: set, expiresAt: now + META_TTL_MS };
  return set;
}

/**
 * @param {unknown} table
 * @returns {Promise<void>}
 */
async function assertEditableTable(table) {
  if (typeof table !== 'string' || table.length === 0) {
    throw new ValidationError('Table name is required');
  }
  const allowed = await listUserTables();
  if (!allowed.has(table)) {
    throw new NotFoundError(`Unknown table: ${table}`);
  }
}

// ── Introspection ───────────────────────────────────────────────────────────

/**
 * Column + primary-key metadata for a public table.
 * @param {string} table
 * @returns {Promise<TableMeta>}
 */
export async function getTableMeta(table) {
  await assertEditableTable(table);

  const now = Date.now();
  const cached = tableMetaCache.get(table);
  if (cached && cached.expiresAt > now) return cached.value;

  const [colsRes, pkRes] = await Promise.all([
    query(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default,
              is_generated, is_identity, ordinal_position
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [table],
    ),
    query(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE n.nspname = 'public' AND c.relname = $1 AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)`,
      [table],
    ),
  ]);

  /** @typedef {{ column_name: string, data_type: string, udt_name: string, is_nullable: string, column_default: string|null, is_generated: string, is_identity: string, ordinal_position: number }} RawColumnRow */
  const columns = (/** @type {RawColumnRow[]} */ (colsRes.rows)).map((r) => {
    const generatedAlways = r.is_generated === 'ALWAYS' || r.is_identity === 'YES';
    return {
      name: r.column_name,
      dataType: r.data_type,
      udtName: r.udt_name,
      nullable: r.is_nullable === 'YES',
      hasDefault: r.column_default !== null,
      generated: generatedAlways,
      // GENERATED ALWAYS (incl. identity-always) columns cannot be written.
      writable: r.is_generated !== 'ALWAYS',
    };
  });

  const meta = {
    table,
    columns,
    primaryKey: (/** @type {{ column_name: string }[]} */ (pkRes.rows)).map((r) => r.column_name),
  };
  tableMetaCache.set(table, { value: meta, expiresAt: now + META_TTL_MS });
  return meta;
}

// ── Reads (browse / filter / sort / paginate) ───────────────────────────────

/**
 * @param {Filter} filter
 * @param {unknown[]} params
 * @param {Set<string>} columnNames
 * @returns {string}
 */
function buildFilterFragment(filter, params, columnNames) {
  if (!columnNames.has(filter.column)) {
    throw new ValidationError(`Unknown filter column: ${filter.column}`);
  }
  const op = filter.op ?? 'eq';
  if (!FILTER_OPS.has(op)) {
    throw new ValidationError(`Unknown filter operator: ${op}`);
  }
  const col = quoteIdent(filter.column);
  switch (op) {
    case 'isnull':
      return `${col} IS NULL`;
    case 'notnull':
      return `${col} IS NOT NULL`;
    case 'contains':
      params.push(`%${filter.value}%`);
      return `${col}::text ILIKE $${params.length}`;
    case 'startsWith':
      params.push(`${filter.value}%`);
      return `${col}::text ILIKE $${params.length}`;
    default: {
      /** @type {Record<string, string>} */
      const sqlOpByOp = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };
      const sqlOp = sqlOpByOp[op];
      params.push(filter.value);
      return `${col} ${sqlOp} $${params.length}`;
    }
  }
}

/**
 * Read a page of rows. Runs inside a READ ONLY transaction.
 *
 * Only the structured, parameterized `filters[]` path exists — the ADR-101
 * raw-WHERE escape hatch was removed (2026-07-10): concatenating a caller
 * string into the SQL was a blind-SQLi timing oracle (pg_sleep in the WHERE
 * survives CORS on this CSRF-exempt GET), and a bare `--` silently truncated
 * the rest of the statement past the `;` guard.
 * @param {string} table
 * @param {{limit?:number, offset?:number, orderBy?:string, dir?:string,
 *          filters?:Filter[],
 *          where?:string}} [opts] `where` is accepted only to be rejected (400) —
 *          the raw-WHERE escape hatch was removed.
 */
export async function readRows(table, opts = {}) {
  const { columns, primaryKey } = await getTableMeta(table);
  const columnNames = new Set(columns.map((c) => c.name));

  const limit = clampInt(opts.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  /** @type {unknown[]} */
  const params = [];
  /** @type {string[]} */
  const whereParts = [];

  for (const filter of opts.filters ?? []) {
    whereParts.push(buildFilterFragment(filter, params, columnNames));
  }

  if (opts.where !== undefined && String(opts.where).trim() !== '') {
    throw new ValidationError(
      'The raw WHERE parameter has been removed. Use the structured filters[] parameter instead.',
    );
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  let orderSql = '';
  if (opts.orderBy !== undefined && String(opts.orderBy) !== '') {
    if (!columnNames.has(opts.orderBy)) {
      throw new ValidationError(`Unknown sort column: ${opts.orderBy}`);
    }
    const dir = String(opts.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    orderSql = `ORDER BY ${quoteIdent(opts.orderBy)} ${dir}`;
  } else if (primaryKey.length) {
    orderSql = `ORDER BY ${primaryKey.map(quoteIdent).join(', ')}`;
  }

  const tbl = quoteIdent(table);
  // xmin (the row version) rides along as a hidden optimistic-concurrency token.
  const dataSql = `SELECT *, xmin::text AS __xmin FROM ${tbl} ${whereSql} ${orderSql} LIMIT ${limit} OFFSET ${offset}`;
  const countSql = `SELECT count(*)::bigint AS total FROM ${tbl} ${whereSql}`;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${READ_TIMEOUT_MS}`);
    const dataRes = await client.query(dataSql, params);
    const countRes = await client.query(countSql, params);
    await client.query('COMMIT');
    return {
      table,
      columns,
      primaryKey,
      rows: dataRes.rows,
      total: Number(countRes.rows[0].total),
      limit,
      offset,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw mapDbError(err);
  } finally {
    client.release();
  }
}

// ── Mutation building ───────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @returns {string}
 */
function literalForDisplay(value) {
  if (value === undefined || value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {string}
 */
function renderPreview(sql, params) {
  return sql.replace(/\$(\d+)/g, (_, n) => literalForDisplay(params[Number(n) - 1]));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeWrite(value) {
  return value === undefined ? null : value;
}

/**
 * Build the primary mutation statement (INSERT/UPDATE/DELETE) for a change.
 * Used both for dry-run previews and for execution, so the SQL shown to the
 * user is exactly what runs.
 *
 * @param {string} table
 * @param {Change} change
 * @param {MutationCtx} ctx
 * @returns {{ sql: string, params: unknown[] }}
 */
function buildMutationSql(table, change, ctx) {
  const tbl = quoteIdent(table);

  // Domain guard: getIncludeTransfers reads user_settings with a strict
  // `=== true`, so a jsonb number 1/0 (or any non-boolean) written for the
  // includeTransfers key would silently be interpreted as false. The API PUT
  // layer already rejects this; close the same gap on the admin editor path.
  if (table === 'user_settings') {
    const key = change.op === 'insert' ? change.values?.key : change.pk?.key;
    const value = change.op === 'insert' ? change.values?.value : change.set?.value;
    if (key === 'includeTransfers' && value !== undefined && typeof value !== 'boolean') {
      throw new ValidationError('user_settings.includeTransfers must be a JSON boolean');
    }
  }

  if (change.op === 'insert') {
    const cols = Object.keys(change.values ?? {}).filter((c) => ctx.colMeta.has(c));
    if (!cols.length) throw new ValidationError(`Insert #${ctx.index} has no values`);
    for (const c of cols) {
      if (!ctx.colMeta.get(c).writable) {
        throw new ValidationError(`Column "${c}" is generated and cannot be written`);
      }
    }
    const params = cols.map((c) => normalizeWrite(change.values[c]));
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const sql = `INSERT INTO ${tbl} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
    return { sql, params };
  }

  if (change.op === 'update') {
    const cols = Object.keys(change.set ?? {}).filter((c) => ctx.colMeta.has(c));
    if (!cols.length) throw new ValidationError(`Update #${ctx.index} has no changed columns`);
    for (const c of cols) {
      if (ctx.primaryKey.includes(c)) {
        throw new ValidationError(`Primary-key column "${c}" cannot be edited`);
      }
      if (!ctx.colMeta.get(c).writable) {
        throw new ValidationError(`Column "${c}" is generated and cannot be written`);
      }
    }
    /** @type {unknown[]} */
    const params = [];
    const assigns = cols.map((c) => {
      params.push(normalizeWrite(change.set[c]));
      return `${quoteIdent(c)} = $${params.length}`;
    });
    const where = ctx.primaryKey.map((k) => {
      params.push(change.pk[k]);
      return `${quoteIdent(k)} = $${params.length}`;
    }).join(' AND ');
    const sql = `UPDATE ${tbl} SET ${assigns.join(', ')} WHERE ${where} RETURNING *`;
    return { sql, params };
  }

  if (change.op === 'delete') {
    /** @type {unknown[]} */
    const params = [];
    const where = ctx.primaryKey.map((k) => {
      params.push(change.pk[k]);
      return `${quoteIdent(k)} = $${params.length}`;
    }).join(' AND ');
    return { sql: `DELETE FROM ${tbl} WHERE ${where}`, params };
  }

  throw new ValidationError(`Unknown op: ${change.op}`);
}

/**
 * @param {Change} change
 * @param {MutationCtx} ctx
 * @returns {void}
 */
function validateChange(change, ctx) {
  if (!change || typeof change !== 'object') {
    throw new ValidationError(`Change #${ctx.index} is malformed`);
  }
  if (change.op === 'update' || change.op === 'delete') {
    const pk = change.pk ?? {};
    for (const k of ctx.primaryKey) {
      if (!(k in pk)) {
        throw new ValidationError(`Change #${ctx.index} is missing primary-key column "${k}"`);
      }
    }
  } else if (change.op !== 'insert') {
    throw new ValidationError(`Unknown op: ${change.op}`);
  }
}

// ── Mutation execution ──────────────────────────────────────────────────────

/**
 * @param {Record<string, unknown>|null|undefined} row
 * @param {string[]} primaryKey
 * @returns {Record<string, unknown>}
 */
function pickPk(row, primaryKey) {
  /** @type {Record<string, unknown>} */
  const pk = {};
  for (const k of primaryKey) pk[k] = row?.[k];
  return pk;
}

/**
 * @param {QueryRunner} client
 * @param {string} table
 * @param {Change} change
 * @param {MutationCtx} ctx
 * @returns {Promise<{ op: string, after?: Record<string, unknown>, audit: AuditEntry }>}
 */
async function applyOne(client, table, change, ctx) {
  // INSERT: no row to lock; structural constraints enforced by Postgres.
  if (change.op === 'insert') {
    const { sql, params } = buildMutationSql(table, change, ctx);
    const res = await client.query(sql, params);
    const after = res.rows[0];
    return {
      op: 'insert',
      after,
      audit: { table, op: 'insert', pk: pickPk(after, ctx.primaryKey), before: undefined, after, statement: renderPreview(sql, params) },
    };
  }

  // UPDATE / DELETE: lock the row, verify its version, then mutate.
  const tbl = quoteIdent(table);
  /** @type {unknown[]} */
  const lockParams = [];
  const pkWhere = ctx.primaryKey.map((k) => {
    lockParams.push(change.pk[k]);
    return `${quoteIdent(k)} = $${lockParams.length}`;
  }).join(' AND ');

  const cur = await client.query(
    `SELECT *, xmin::text AS __xmin FROM ${tbl} WHERE ${pkWhere} FOR UPDATE`,
    lockParams,
  );
  if (cur.rowCount === 0) {
    throw new ConflictError('Row no longer exists — it was deleted since you loaded it', {
      details: { table, pk: change.pk, index: ctx.index },
    });
  }
  const before = { ...cur.rows[0] };
  const currentXmin = before.__xmin;
  delete before.__xmin;
  if (change.xmin !== undefined && String(change.xmin) !== String(currentXmin)) {
    throw new ConflictError('Row changed since it was loaded — refresh and retry', {
      details: { table, pk: change.pk, index: ctx.index },
    });
  }

  const { sql, params } = buildMutationSql(table, change, ctx);
  const res = await client.query(sql, params);

  if (change.op === 'delete') {
    return { op: 'delete', audit: { table, op: 'delete', pk: change.pk, before, after: undefined, statement: renderPreview(sql, params) } };
  }
  const after = res.rows[0];
  return { op: 'update', after, audit: { table, op: 'update', pk: change.pk, before, after, statement: renderPreview(sql, params) } };
}

/**
 * @param {QueryRunner} client
 * @param {AuditEntry[]} audit
 * @returns {Promise<void>}
 */
async function writeAuditRows(client, audit) {
  for (const a of audit) {
    await client.query(
      `INSERT INTO db_editor_audit (table_name, op, pk_json, before_json, after_json, statement)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [a.table, a.op, a.pk ?? undefined, a.before ?? undefined, a.after ?? undefined, a.statement],
    );
  }
}

/**
 * Apply a batch of changes. With dryRun, returns the statements that *would*
 * run without touching the DB. Otherwise executes the whole batch in one
 * transaction (all-or-nothing) and writes an audit row per change.
 *
 * @param {string} table
 * @param {Change[]} changes
 * @param {{dryRun?:boolean}} [opts]
 */
export async function applyMutations(table, changes, { dryRun = false } = {}) {
  const { columns, primaryKey } = await getTableMeta(table);
  if (!primaryKey.length) {
    throw new ValidationError(`Table "${table}" has no primary key and cannot be edited`);
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new ValidationError('No changes provided');
  }

  /** @type {Map<string, ColumnMeta>} */
  const colMeta = new Map(columns.map((c) => [c.name, c]));

  const statements = changes.map((change, index) => {
    const ctx = { colMeta, primaryKey, index };
    validateChange(change, ctx);
    const { sql, params } = buildMutationSql(table, change, ctx);
    return { op: change.op, sql, params, preview: renderPreview(sql, params) };
  });

  if (dryRun) {
    return { dryRun: true, count: statements.length, statements: statements.map(({ op, preview }) => ({ op, preview })) };
  }

  const client = await getClient();
  /** @type {AuditEntry[]} */
  const audit = [];
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${WRITE_TIMEOUT_MS}`);

    /** @type {Array<{ op: string, after: Record<string, unknown>|undefined }>} */
    const results = [];
    for (let index = 0; index < changes.length; index++) {
      const ctx = { colMeta, primaryKey, index };
      const result = await applyOne(client, table, changes[index], ctx);
      results.push({ op: result.op, after: result.after });
      audit.push(result.audit);
    }

    await writeAuditRows(client, audit);
    await client.query('COMMIT');

    // Structured-logger audit sink (in addition to the db_editor_audit table).
    for (const a of audit) {
      logger.info('db-editor mutation committed', { table: a.table, op: a.op, pk: a.pk });
    }

    const refreshed = MATVIEW_BASE_TABLES.has(table);
    if (refreshed) scheduleAggregationRefresh();

    return { dryRun: false, applied: results.length, results, refreshScheduled: refreshed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw mapDbError(err);
  } finally {
    client.release();
  }
}

// ── Error mapping ───────────────────────────────────────────────────────────

/**
 * Translate raw Postgres error codes into friendly, typed API errors so the
 * UI can show "Column X cannot be null" instead of an opaque SQLSTATE.
 *
 * @param {any} err raw pg driver error — shape (code/detail/column/constraint) is upstream-defined.
 * @returns {AppError}
 */
function mapDbError(err) {
  if (err instanceof AppError) return err;

  const detail = err?.detail ? { pgDetail: err.detail } : undefined;
  switch (err?.code) {
    case '23502': // not_null_violation
      return new ValidationError(`Column "${err.column}" cannot be empty`, { details: detail });
    case '23503': // foreign_key_violation
      return new ValidationError('References a row that does not exist (foreign key)', {
        details: { constraint: err.constraint, ...detail },
      });
    case '23505': // unique_violation
      return new ConflictError('Duplicate value violates a uniqueness constraint', {
        details: { constraint: err.constraint, ...detail },
      });
    case '23514': // check_violation
      return new ValidationError('Value violates a check constraint', {
        details: { constraint: err.constraint, ...detail },
      });
    case '22P02': // invalid_text_representation
    case '22003': // numeric_value_out_of_range
    case '22007': // invalid_datetime_format
      return new ValidationError(`Invalid value for column type: ${err.message}`);
    case '42601': // syntax_error
    case '42703': // undefined_column
    case '42883': // undefined_function / operator
    case '42P01': // undefined_table
      // Never echo raw driver text back to the client: with identifiers
      // allowlisted these are unreachable in normal use, and leaking the
      // message hands schema/column names to a prober (data-protection policy,
      // docs/security/data-protection.md). Full detail still goes to the logs
      // via the caught error.
      return new ValidationError('Invalid query');
    case '42501': // insufficient_privilege
      return new ForbiddenError('Insufficient database privileges for this operation');
    case '25006': // read_only_sql_transaction
      return new ForbiddenError('Write attempted inside a read-only query');
    case '57014': // query_canceled (statement timeout)
      return new AppError('Query timed out', { status: 504, code: 'QUERY_TIMEOUT' });
    default:
      return err;
  }
}

export default { getTableMeta, readRows, applyMutations };
