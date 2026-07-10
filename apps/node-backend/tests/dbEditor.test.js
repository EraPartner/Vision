import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/services/materializedViewService.js', () => ({
  scheduleRefresh: vi.fn(),
  refreshMaterializedViews: vi.fn(),
}));

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

import { query, getClient } from '../src/database/connection.js';
import { scheduleRefresh } from '../src/services/materializedViewService.js';
import { getTableMeta, readRows, applyMutations } from '../src/services/dbEditor.js';

// ── Catalog fixtures ────────────────────────────────────────────────────────

const ALLOWED_TABLES = ['transactions', 'recipients', 'tags', 'kv_settings'];

const COLUMNS = {
  transactions: [
    { column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: "nextval('x')", is_generated: 'NEVER', is_identity: 'NO', ordinal_position: 1 },
    { column_name: 'amount', data_type: 'numeric', udt_name: 'numeric', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', is_identity: 'NO', ordinal_position: 2 },
    { column_name: 'currency', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', is_identity: 'NO', ordinal_position: 3 },
    { column_name: 'is_active', data_type: 'boolean', udt_name: 'bool', is_nullable: 'NO', column_default: 'true', is_generated: 'NEVER', is_identity: 'NO', ordinal_position: 4 },
  ],
  tags: [
    { column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: "nextval('x')", is_generated: 'NEVER', is_identity: 'NO', ordinal_position: 1 },
    { column_name: 'slug', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', is_identity: 'NO', ordinal_position: 2 },
  ],
  // A table with no primary key (read-only for writes).
  kv_settings: [
    { column_name: 'k', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', is_identity: 'NO', ordinal_position: 1 },
    { column_name: 'v', data_type: 'text', udt_name: 'text', is_nullable: 'YES', column_default: null, is_generated: 'NEVER', is_identity: 'NO', ordinal_position: 2 },
  ],
};

const PRIMARY_KEYS = {
  transactions: [{ column_name: 'id' }],
  tags: [{ column_name: 'id' }],
  kv_settings: [],
};

/** Route a top-level query() call to the right catalog fixture. */
function catalogRouter(table) {
  return (sql) => {
    if (sql.includes('pg_stat_user_tables')) {
      return { rows: ALLOWED_TABLES.map((relname) => ({ relname })) };
    }
    if (sql.includes('information_schema.columns')) {
      return { rows: COLUMNS[table] ?? [] };
    }
    if (sql.includes('pg_index')) {
      return { rows: PRIMARY_KEYS[table] ?? [] };
    }
    return { rows: [] };
  };
}

function makeClient(handlers) {
  const calls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      for (const [needle, value] of handlers) {
        if (sql.includes(needle)) return typeof value === 'function' ? value(sql, params) : value;
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { client, calls };
}

beforeEach(() => vi.clearAllMocks());

// ── Introspection ───────────────────────────────────────────────────────────

describe('getTableMeta', () => {
  it('returns columns and primary key for a known table', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    const meta = await getTableMeta('transactions');
    expect(meta.primaryKey).toEqual(['id']);
    expect(meta.columns.map((c) => c.name)).toEqual(['id', 'amount', 'currency', 'is_active']);
    expect(meta.columns.every((c) => c.writable)).toBe(true);
  });

  it('rejects an unknown table with 404', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    await expect(getTableMeta('robert"; DROP TABLE x;--')).rejects.toMatchObject({ status: 404 });
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────

describe('readRows', () => {
  it('runs inside a READ ONLY transaction and returns rows + total', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    const { client } = makeClient([
      ['count(*)', { rows: [{ total: '42' }] }],
      ['SELECT *', { rows: [{ id: 1, amount: '10', currency: 'EUR', is_active: true, __xmin: '500' }] }],
    ]);
    getClient.mockResolvedValue(client);

    const result = await readRows('transactions', { limit: 25, offset: 0 });

    expect(result.total).toBe(42);
    expect(result.rows[0].__xmin).toBe('500');
    const issued = client.query.mock.calls.map((c) => c[0]);
    expect(issued).toContain('SET TRANSACTION READ ONLY');
    expect(issued.some((s) => s.includes('xmin::text AS __xmin'))).toBe(true);
    expect(issued.some((s) => s.includes('LIMIT 25'))).toBe(true);
  });

  it('rejects any raw WHERE parameter (escape hatch removed — SQLi oracle)', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    getClient.mockResolvedValue(makeClient([]).client);
    // Even a benign-looking clause is refused: the structured filters[] path
    // is the only way to filter now.
    await expect(readRows('transactions', { where: 'amount > 0' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(readRows('transactions', { where: '1=1; DROP TABLE transactions' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('does not run any SQL when a raw WHERE is supplied (rejected before query)', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    const { client, calls } = makeClient([]);
    getClient.mockResolvedValue(client);
    await expect(readRows('transactions', { where: 'pg_sleep(5)' }))
      .rejects.toMatchObject({ status: 400 });
    expect(calls.some((c) => c.sql.includes('SELECT *'))).toBe(false);
  });

  it('rejects sorting by an unknown column', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    getClient.mockResolvedValue(makeClient([]).client);
    await expect(readRows('transactions', { orderBy: 'evil' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('parameterizes structured filters', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    const { client } = makeClient([
      ['count(*)', { rows: [{ total: '1' }] }],
      ['SELECT *', { rows: [] }],
    ]);
    getClient.mockResolvedValue(client);

    await readRows('transactions', { filters: [{ column: 'currency', op: 'eq', value: 'EUR' }] });
    const dataCall = client.query.mock.calls.find((c) => c[0].includes('SELECT *'));
    expect(dataCall[0]).toContain('"currency" = $1');
    expect(dataCall[1]).toEqual(['EUR']);
  });
});

// ── Mutations — dry run ─────────────────────────────────────────────────────

describe('applyMutations (dryRun)', () => {
  it('previews an UPDATE with inlined literals without touching the DB', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    const result = await applyMutations(
      'transactions',
      [{ op: 'update', pk: { id: 5 }, xmin: '500', set: { amount: '20' } }],
      { dryRun: true },
    );
    expect(getClient).not.toHaveBeenCalled();
    expect(result.statements[0].preview).toBe('UPDATE "transactions" SET "amount" = \'20\' WHERE "id" = 5 RETURNING *');
  });

  it('refuses to edit a primary-key column', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    await expect(applyMutations(
      'transactions',
      [{ op: 'update', pk: { id: 5 }, set: { id: 9 } }],
      { dryRun: true },
    )).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to edit a table with no primary key', async () => {
    query.mockImplementation(catalogRouter('kv_settings'));
    await expect(applyMutations(
      'kv_settings',
      [{ op: 'update', pk: {}, set: { v: 'x' } }],
      { dryRun: true },
    )).rejects.toMatchObject({ status: 400 });
  });
});

// ── Mutations — execution ───────────────────────────────────────────────────

describe('applyMutations (execute)', () => {
  it('locks, checks version, updates, audits, and schedules a view refresh', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    const { client, calls } = makeClient([
      ['db_editor_audit', { rows: [], rowCount: 0 }],
      ['FOR UPDATE', { rowCount: 1, rows: [{ id: 5, amount: '10', currency: 'EUR', is_active: true, __xmin: '500' }] }],
      ['UPDATE', { rows: [{ id: 5, amount: '20', currency: 'EUR', is_active: true }] }],
    ]);
    getClient.mockResolvedValue(client);

    const result = await applyMutations(
      'transactions',
      [{ op: 'update', pk: { id: 5 }, xmin: '500', set: { amount: '20' } }],
    );

    expect(result.applied).toBe(1);
    expect(result.refreshScheduled).toBe(true);
    expect(scheduleRefresh).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.sql.includes('db_editor_audit'))).toBe(true);
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(true);
  });

  it('returns a 409 conflict when the row version changed', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    const { client, calls } = makeClient([
      ['FOR UPDATE', { rowCount: 1, rows: [{ id: 5, amount: '10', __xmin: '999' }] }],
    ]);
    getClient.mockResolvedValue(client);

    await expect(applyMutations(
      'transactions',
      [{ op: 'update', pk: { id: 5 }, xmin: '500', set: { amount: '20' } }],
    )).rejects.toMatchObject({ status: 409 });
    expect(calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
  });

  it('returns a 409 conflict when the row was deleted', async () => {
    query.mockImplementation(catalogRouter('transactions'));
    const { client } = makeClient([
      ['FOR UPDATE', { rowCount: 0, rows: [] }],
    ]);
    getClient.mockResolvedValue(client);

    await expect(applyMutations(
      'transactions',
      [{ op: 'delete', pk: { id: 5 }, xmin: '500' }],
    )).rejects.toMatchObject({ status: 409 });
  });

  it('does not schedule a refresh for non-matview tables', async () => {
    query.mockImplementation(catalogRouter('tags'));
    const { client } = makeClient([
      ['db_editor_audit', { rows: [] }],
      ['INSERT INTO "tags"', { rows: [{ id: 7, slug: 'new' }] }],
    ]);
    getClient.mockResolvedValue(client);

    const result = await applyMutations('tags', [{ op: 'insert', values: { slug: 'new' } }]);
    expect(result.applied).toBe(1);
    expect(result.refreshScheduled).toBe(false);
    expect(scheduleRefresh).not.toHaveBeenCalled();
  });
});

// ── Constraint-error mapping ────────────────────────────────────────────────

describe('mapDbError (via applyMutations)', () => {
  it('maps a unique violation to a 409 conflict', async () => {
    query.mockImplementation(catalogRouter('tags'));
    const { client } = makeClient([
      ['INSERT INTO "tags"', () => { const e = new Error('dup'); e.code = '23505'; e.constraint = 'tags_slug_key'; throw e; }],
    ]);
    getClient.mockResolvedValue(client);

    await expect(applyMutations('tags', [{ op: 'insert', values: { slug: 'dup' } }]))
      .rejects.toMatchObject({ status: 409 });
  });

  it('maps a not-null violation to a 400 validation error', async () => {
    query.mockImplementation(catalogRouter('tags'));
    const { client } = makeClient([
      ['INSERT INTO "tags"', () => { const e = new Error('null'); e.code = '23502'; e.column = 'slug'; throw e; }],
    ]);
    getClient.mockResolvedValue(client);

    await expect(applyMutations('tags', [{ op: 'insert', values: { slug: '' } }]))
      .rejects.toMatchObject({ status: 400 });
  });
});
