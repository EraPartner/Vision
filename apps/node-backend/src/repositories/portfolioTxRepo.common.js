/** Shared SQL helpers for the split portfolio-transaction repository. */

import { query } from "../database/connection.js";

/** @type {boolean|undefined} */
let _hasPortfolioTransactionImportBatchIdColumn;

/** @returns {Promise<boolean>} */
export async function hasPortfolioTransactionImportBatchIdColumn() {
  if (_hasPortfolioTransactionImportBatchIdColumn !== undefined) {
    return _hasPortfolioTransactionImportBatchIdColumn;
  }
  const result = await query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('public.portfolio_transactions')
          AND attname = 'import_batch_id'
          AND attnum > 0
          AND NOT attisdropped
     ) AS present`,
  );
  _hasPortfolioTransactionImportBatchIdColumn = Boolean(
    result.rows[0]?.present,
  );
  return _hasPortfolioTransactionImportBatchIdColumn;
}

export function __resetPortfolioTransactionSchemaCache() {
  _hasPortfolioTransactionImportBatchIdColumn = undefined;
}

/**
 * @param {{ investmentId?: number|null, type?: string|null }} [filters]
 * @returns {{ where: string, params: any[], nextParam: number }}
 */
export function buildListWhereClause({
  investmentId = null,
  type = null,
} = {}) {
  let where = "WHERE 1=1";
  const params = [];
  let idx = 1;
  if (investmentId) {
    where += ` AND investment_id = $${idx++}`;
    params.push(investmentId);
  }
  if (type) {
    where += ` AND type = $${idx++}`;
    params.push(type);
  }
  return { where, params, nextParam: idx };
}
