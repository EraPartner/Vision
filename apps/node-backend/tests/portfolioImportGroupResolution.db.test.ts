/**
 * Real-Postgres evidence for atomic portfolio-import group resolution.
 *
 * The repository unit tests pin the SQL shape. These tests prove the observable
 * database properties: a 2,000-row group is updated as one set, create-new
 * creates exactly one holding, and a cross-batch id rolls the whole request back.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.ts';
import { closePool } from '../src/database/connection.ts';
import { resolveInvestmentRows } from '../src/services/portfolioImportBatchService.ts';
import {
  asInvestmentId,
} from "@vision/types/brands";
import { must } from "./helpers/must.ts";
import type { Pool } from "pg";

/** A row from an ad-hoc SQL read: column values are narrowed where used. */
type DbRow = Record<string, unknown>;
interface IdRow {
  id: number;
}
/** BIGINT ids arrive from node-postgres as strings. */
interface BigIdRow {
  id: string;
}

let pool: Pool;
const describeDb = hasTestDatabase() ? describe : describe.skip;

async function wipe() {
  await pool.query('DELETE FROM portfolio_import_staging_rows');
  await pool.query('DELETE FROM portfolio_import_batches');
  await pool.query(`DELETE FROM investments WHERE name LIKE 'GROUP-RESOLUTION-%'`);
}

async function newBatch() {
  const { rows } = await pool.query<BigIdRow>(
    `INSERT INTO portfolio_import_batches
       (adapter_name, status, rows_total, default_asset_class)
     VALUES ('group-resolution-test', 'awaiting_review', 0, 'stock')
     RETURNING id`,
  );
  return Number(must(rows[0], "rows[0]").id);
}

async function stageRows(batchId: number, count: number, startIndex = 0) {
  const { rows } = await pool.query<BigIdRow>(
    `INSERT INTO portfolio_import_staging_rows
       (batch_id, row_index, status, symbol_raw, name_raw, currency)
     SELECT $1, $2 + n, 'matched', 'GRP', 'GROUP-RESOLUTION-HOLDING', 'EUR'
       FROM generate_series(0, $3 - 1) AS n
     RETURNING id`,
    [batchId, startIndex, count],
  );
  return rows.map((row) => Number(row.id));
}

describeDb('portfolio import group resolution (real Postgres)', () => {
  beforeAll(() => {
    pool = must(getTestPool(), "test pool");
  });
  beforeAll(acquireDbSuiteLock, 180_000);

  beforeEach(wipe);

  afterAll(async () => {
    await wipe();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it('resolves a 2,000-row group to one existing holding', async () => {
    const batchId = await newBatch();
    const rowIds = await stageRows(batchId, 2_000);
    const { rows: investments } = await pool.query<IdRow>(
      `INSERT INTO investments (name, symbol, asset_class, currency)
       VALUES ('GROUP-RESOLUTION-EXISTING', 'GRE', 'stock', 'EUR')
       RETURNING id`,
    );
    const investmentId = must(investments[0], "investments[0]").id;

    await expect(resolveInvestmentRows({ batchId, rowIds, investmentId: asInvestmentId(investmentId) }))
      .resolves.toMatchObject({ investmentId, created: false, resolved: 2_000 });

    const { rows } = await pool.query<DbRow>(
      `SELECT COUNT(*)::int AS resolved
         FROM portfolio_import_staging_rows
        WHERE batch_id = $1 AND user_override_investment_id = $2`,
      [batchId, investmentId],
    );
    expect(must(rows[0], "rows[0]").resolved).toBe(2_000);
  });

  it('creates exactly one holding and rejects a cross-batch set without partial writes', async () => {
    const batchId = await newBatch();
    const otherBatchId = await newBatch();
    const rowIds = await stageRows(batchId, 2);
    const [foreignRowId] = await stageRows(otherBatchId, 1);

    const created = await resolveInvestmentRows({ batchId, rowIds, createNew: true });
    expect(created).toMatchObject({ created: true, resolved: 2 });

    const { rows: holdingCount } = await pool.query<DbRow>(
      `SELECT COUNT(*)::int AS count FROM investments WHERE name = 'GROUP-RESOLUTION-HOLDING'`,
    );
    expect(must(holdingCount[0], "holdingCount[0]").count).toBe(1);

    const before = await pool.query<DbRow>(
      `SELECT id, user_override_investment_id
         FROM portfolio_import_staging_rows
        WHERE id = ANY($1::bigint[])
        ORDER BY id`,
      [[...rowIds, foreignRowId]],
    );

    await expect(resolveInvestmentRows({
      batchId,
      rowIds: [must(rowIds[0], "rowIds[0]"), must(foreignRowId, "foreignRowId")],
      investmentId: created.investmentId,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const after = await pool.query<DbRow>(
      `SELECT id, user_override_investment_id
         FROM portfolio_import_staging_rows
        WHERE id = ANY($1::bigint[])
        ORDER BY id`,
      [[...rowIds, foreignRowId]],
    );
    expect(after.rows).toEqual(before.rows);
  });
});
