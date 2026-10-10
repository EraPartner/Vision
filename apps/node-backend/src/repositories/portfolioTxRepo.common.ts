/** Shared SQL helpers for the split portfolio-transaction repository. */

import { queryOne } from "../database/rowContracts.ts";
import { presentRowSchema } from "../database/rows/portfolio.ts";

let _hasPortfolioTransactionImportBatchIdColumn: boolean | undefined;

export async function hasPortfolioTransactionImportBatchIdColumn(): Promise<boolean> {
  if (_hasPortfolioTransactionImportBatchIdColumn !== undefined) {
    return _hasPortfolioTransactionImportBatchIdColumn;
  }
  const row = await queryOne(
    presentRowSchema,
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('public.portfolio_transactions')
          AND attname = 'import_batch_id'
          AND attnum > 0
          AND NOT attisdropped
     ) AS present`,
  );
  _hasPortfolioTransactionImportBatchIdColumn = Boolean(row?.present);
  return _hasPortfolioTransactionImportBatchIdColumn;
}

export function __resetPortfolioTransactionSchemaCache(): void {
  _hasPortfolioTransactionImportBatchIdColumn = undefined;
}

export function buildListWhereClause({
  investmentId = null,
  type = null,
}: { investmentId?: number | null; type?: string | null } = {}): {
  where: string;
  params: (number | string)[];
  nextParam: number;
} {
  let where = "WHERE 1=1";
  const params: (number | string)[] = [];
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
