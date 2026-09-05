/**
 * Real-Postgres pins for migrations 0089 (TEXT + named CHECK for the free-text
 * enum columns) and 0090 (canonical chk_/uq_/idx_ constraint & index naming).
 *
 * What only a real database can verify here:
 *   1. The four 0089 CHECKs exist under their pinned names AND are validated
 *      (a NOT VALID leftover would mean the tolerant-VALIDATE path fired on a
 *      clean database — a migration bug).
 *   2. CHECK behaviour at the SQL layer, bypassing app validators entirely:
 *      every value the app can legitimately write is accepted (all
 *      SUPPORTED_PATTERNS — imported from the real module so vocabulary drift
 *      fails here — the "every N days" grammar, both portfolio matcher
 *      sources, both brokerage routes, all eight raw-table source types) and
 *      out-of-vocabulary values are rejected with the pinned constraint name.
 *      Notably `'bi-weekly'` — the recurrence_interval PG-enum spelling — is
 *      REJECTED for planned_transactions.recurrence_pattern: 0089 settles that
 *      column on 'biweekly'.
 *   3. The 0090 rename inventory: every new name present, every old name gone
 *      (constraints via pg_constraint, indexes via pg_indexes), and the
 *      renamed unique indexes are still UNIQUE.
 *
 * Isolation: every data-touching case runs inside BEGIN … ROLLBACK on a
 * dedicated client — nothing this suite writes survives it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import { __getSupportedPatterns as getSupportedPatterns } from '../src/lib/calculations/recurrence.js';

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;

/** Mirror of _CHECKS in alembic/versions/0089_free_text_enum_checks.py. */
const NEW_CHECKS = [
  ['planned_transactions', 'chk_planned_transactions_recurrence_pattern'],
  ['portfolio_import_staging_rows', 'chk_portfolio_import_staging_rows_match_source'],
  ['portfolio_import_staging_rows', 'chk_portfolio_import_staging_rows_route'],
  ['transaction_raw_references', 'chk_transaction_raw_references_raw_source_type'],
];

/** Mirror of _CONSTRAINT_RENAMES in alembic/versions/0090_constraint_index_naming.py. */
const CONSTRAINT_RENAMES = [
  ['accounts', 'ck_accounts_active_not_closed', 'chk_accounts_active_not_closed'],
  ['accounts', 'ck_accounts_statement_balance_has_date', 'chk_accounts_statement_balance_has_date'],
  ['custom_parser_configs', 'ck_custom_parser_configs_kind', 'chk_custom_parser_configs_kind'],
  ['instrument_provider_map', 'ck_instrument_provider_map_key_type', 'chk_instrument_provider_map_key_type'],
  ['instrument_provider_map', 'ck_instrument_provider_map_status', 'chk_instrument_provider_map_status'],
  ['planned_transactions', 'ck_planned_max_occurrences_positive', 'chk_planned_max_occurrences_positive'],
  ['provider_quota', 'ck_provider_quota_count_nonneg', 'chk_provider_quota_count_nonneg'],
  ['transactions', 'ck_transactions_transfer_source', 'chk_transactions_transfer_source'],
  ['transfer_dismissals', 'ck_transfer_dismissals_ordered', 'chk_transfer_dismissals_ordered'],
  ['ai_messages', 'ai_messages_role_check', 'chk_ai_messages_role'],
  ['ai_messages', 'ai_messages_status_check', 'chk_ai_messages_status'],
  ['import_batches', 'import_batches_status_check', 'chk_import_batches_status'],
  ['import_staging_rows', 'import_staging_rows_status_check', 'chk_import_staging_rows_status'],
];

/** Mirror of _INDEX_RENAMES in alembic/versions/0090_constraint_index_naming.py. */
const INDEX_RENAMES = [
  ['uniq_pte_planned_executed', 'uq_pte_planned_executed', true],
  ['uniq_transactions_tx_hash', 'uq_transactions_tx_hash', true],
  ['ux_transactions_opening_anchor', 'uq_transactions_opening_anchor', true],
  ['db_editor_audit_table_time_idx', 'idx_db_editor_audit_table_time', false],
  ['ix_import_staging_rows_matched_pattern_id', 'idx_import_staging_rows_matched_pattern_id', false],
  ['ix_import_staging_rows_user_override_recipient_id', 'idx_import_staging_rows_user_override_recipient_id', false],
  ['ix_instrument_provider_map_provider_symbol', 'idx_instrument_provider_map_provider_symbol', false],
  ['ix_manual_raw_transactions_category_id', 'idx_manual_raw_transactions_category_id', false],
  ['ix_manual_raw_transactions_recipient_id', 'idx_manual_raw_transactions_recipient_id', false],
  ['ix_portfolio_import_staging_rows_resolved_investment_id', 'idx_portfolio_import_staging_rows_resolved_investment_id', false],
  ['ix_portfolio_import_staging_rows_user_override_investment_id', 'idx_portfolio_import_staging_rows_user_override_investment_id', false],
  ['ix_snapshot_accounts_currency_date', 'idx_snapshot_accounts_currency_date', false],
  ['ix_transfer_dismissals_b', 'idx_transfer_dismissals_b', false],
];

/** The eight raw-bank tables `transaction_raw_references.raw_source_type` can name. */
const RAW_SOURCE_TYPES = ['belfius', 'custom', 'kbc', 'manual', 'revolut', 'sabb', 'vision', 'wise'];

/**
 * Run `fn(client)` inside a transaction that is always rolled back.
 * @param {(client: import('pg').PoolClient) => Promise<void>} fn
 */
async function withRollback(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * Expect `sql` to fail with a check_violation (23514) on `constraint`.
 * Uses a SAVEPOINT so the surrounding fixture transaction stays usable.
 * @param {import('pg').PoolClient} client
 * @param {string} sql
 * @param {unknown[]} params
 * @param {string} constraint
 */
async function expectCheckViolation(client, sql, params, constraint) {
  await client.query('SAVEPOINT chk');
  const err = await client.query(sql, params).then(
    () => null,
    (e) => e,
  );
  await client.query('ROLLBACK TO SAVEPOINT chk');
  expect(err, `expected 23514 from: ${sql} ← ${JSON.stringify(params)}`).not.toBeNull();
  expect(err.code).toBe('23514');
  expect(err.constraint).toBe(constraint);
}

describeDb('schema naming discipline (migrations 0089 + 0090)', () => {
  beforeAll(async () => {
    await acquireDbSuiteLock();
  }, 180_000);

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
  });

  // ── 0089: the four named CHECKs ──────────────────────────────────────────
  it('the four 0089 CHECK constraints exist, named and VALIDATED', async () => {
    for (const [table, name] of NEW_CHECKS) {
      const r = await pool.query(
        `SELECT convalidated FROM pg_constraint
          WHERE conname = $1 AND conrelid = $2::regclass AND contype = 'c'`,
        [name, `public.${table}`],
      );
      expect(r.rows, `${name} on ${table}`).toHaveLength(1);
      // A clean database must VALIDATE fully — a lingering NOT VALID means the
      // tolerant path fired where it had nothing to tolerate.
      expect(r.rows[0].convalidated, `${name} validated`).toBe(true);
    }
  });

  it('recurrence_pattern: accepts every SUPPORTED_PATTERNS entry, the "every N days" grammar, case/whitespace variants and NULL', async () => {
    const good = [
      ...getSupportedPatterns(), // real app list — drift fails here
      'every 3 days',
      'every 1 day',
      'every 007 days',
      'Daily', // route stores raw casing; validator lowercases
      '  weekly  ', // validator trims
      null,
    ];
    await withRollback(async (client) => {
      const rec = await client.query(
        `INSERT INTO recipients (name, normalized_name)
         VALUES ('_0089_chk', '_0089_chk') RETURNING id`,
      );
      const recipientId = rec.rows[0].id;
      for (const pattern of good) {
        await client.query(
          `INSERT INTO planned_transactions (planned_date, amount, recipient_id, is_recurring, recurrence_pattern)
           VALUES ('2026-01-01', 1, $1, $2, $3)`,
          [recipientId, pattern !== null, pattern],
        );
      }
    });
  });

  it("recurrence_pattern: rejects out-of-vocabulary values including the enum spelling 'bi-weekly'", async () => {
    const bad = ['fortnightly', 'bi-weekly', 'every 0 days', 'every days', 'monthly x'];
    await withRollback(async (client) => {
      const rec = await client.query(
        `INSERT INTO recipients (name, normalized_name)
         VALUES ('_0089_chk_bad', '_0089_chk_bad') RETURNING id`,
      );
      const recipientId = rec.rows[0].id;
      for (const pattern of bad) {
        await expectCheckViolation(
          client,
          `INSERT INTO planned_transactions (planned_date, amount, recipient_id, is_recurring, recurrence_pattern)
           VALUES ('2026-01-01', 1, $1, true, $2)`,
          [recipientId, pattern],
          'chk_planned_transactions_recurrence_pattern',
        );
      }
    });
  });

  it('portfolio staging match_source and route: accept the pipeline vocabulary + NULL, reject others', async () => {
    await withRollback(async (client) => {
      const batch = await client.query(
        `INSERT INTO portfolio_import_batches (adapter_name) VALUES ('_0089_chk') RETURNING id`,
      );
      const batchId = batch.rows[0].id;
      let rowIndex = 0;
      const insert = (matchSource, route) =>
        client.query(
          `INSERT INTO portfolio_import_staging_rows (batch_id, row_index, match_source, route)
           VALUES ($1, $2, $3, $4)`,
          [batchId, rowIndex++, matchSource, route],
        );
      // accepted: the matcher's two sources, ADR-095's two routes, NULLs
      for (const matchSource of ['symbol', 'name_exact', null]) {
        for (const route of ['cash', 'portfolio', null]) {
          await insert(matchSource, route);
        }
      }
      // rejected: the SIBLING table's vocabulary does not leak in
      await expectCheckViolation(
        client,
        `INSERT INTO portfolio_import_staging_rows (batch_id, row_index, match_source)
         VALUES ($1, $2, 'exact')`,
        [batchId, rowIndex++],
        'chk_portfolio_import_staging_rows_match_source',
      );
      await expectCheckViolation(
        client,
        `INSERT INTO portfolio_import_staging_rows (batch_id, row_index, route)
         VALUES ($1, $2, 'ledger')`,
        [batchId, rowIndex++],
        'chk_portfolio_import_staging_rows_route',
      );
    });
  });

  it('raw_source_type: accepts all eight raw-table names, rejects adapters without a raw table', async () => {
    await withRollback(async (client) => {
      const rec = await client.query(
        `INSERT INTO recipients (name, normalized_name)
         VALUES ('_0089_chk_raw', '_0089_chk_raw') RETURNING id`,
      );
      const txn = await client.query(
        `INSERT INTO transactions (date, amount, recipient_id) VALUES ('2026-01-01', 1, $1) RETURNING id`,
        [rec.rows[0].id],
      );
      const txnId = txn.rows[0].id;
      let sourceId = 1;
      for (const sourceType of RAW_SOURCE_TYPES) {
        await client.query(
          `INSERT INTO transaction_raw_references (transaction_id, raw_source_type, raw_source_id)
           VALUES ($1, $2, $3)`,
          [txnId, sourceType, sourceId++],
        );
      }
      // 'ing' / 'generic' are adapter names but have NO *_raw_transactions
      // table — a reference to them would dangle, so the CHECK excludes them.
      for (const sourceType of ['ing', 'generic', 'BELFIUS']) {
        await expectCheckViolation(
          client,
          `INSERT INTO transaction_raw_references (transaction_id, raw_source_type, raw_source_id)
           VALUES ($1, $2, $3)`,
          [txnId, sourceType, sourceId++],
          'chk_transaction_raw_references_raw_source_type',
        );
      }
    });
  });

  // ── 0090: renames ────────────────────────────────────────────────────────
  it('every 0090 constraint rename applied: new name present, old name gone', async () => {
    for (const [table, oldName, newName] of CONSTRAINT_RENAMES) {
      const r = await pool.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = $1::regclass AND conname = ANY($2::name[])`,
        [`public.${table}`, [oldName, newName]],
      );
      expect(r.rows.map((row) => row.conname), `${table}: ${oldName} → ${newName}`).toEqual([newName]);
    }
  });

  it('every 0090 index rename applied: new name present (uniqueness preserved), old name gone', async () => {
    for (const [oldName, newName, isUnique] of INDEX_RENAMES) {
      const r = await pool.query(
        `SELECT c.relname, i.indisunique
           FROM pg_class c
           JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::name[])`,
        [[oldName, newName]],
      );
      expect(r.rows.map((row) => row.relname), `${oldName} → ${newName}`).toEqual([newName]);
      expect(r.rows[0].indisunique, `${newName} uniqueness`).toBe(isUnique);
    }
  });

  it('no ck_/uniq_/ux_/ix_ prefixed names remain anywhere outside the frozen legacy_inh_* relations', async () => {
    const cons = await pool.query(
      `SELECT conname FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND (conname LIKE 'ck\\_%' OR conname LIKE 'uniq\\_%' OR conname LIKE 'ux\\_%' OR conname LIKE 'ix\\_%')
          AND conname NOT LIKE 'legacy\\_inh\\_%'`,
    );
    expect(cons.rows).toEqual([]);
    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND (indexname LIKE 'uniq\\_%' OR indexname LIKE 'ux\\_%' OR indexname LIKE 'ix\\_%' OR indexname LIKE '%\\_idx')
          AND indexname NOT LIKE 'legacy\\_inh\\_%'
          AND tablename NOT IN ('investments_legacy', 'portfolio_transactions_legacy')`,
    );
    expect(idx.rows).toEqual([]);
  });
});
