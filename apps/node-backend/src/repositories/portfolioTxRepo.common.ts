/** Shared SQL helpers for the split portfolio-transaction repository. */

import { sql } from "kysely";
import { checkedRow } from "../database/db.ts";
import { presentRowSchema } from "../database/rows/portfolio.ts";

let _hasPortfolioTransactionImportBatchIdColumn: boolean | undefined;

export async function hasPortfolioTransactionImportBatchIdColumn(): Promise<boolean> {
  if (_hasPortfolioTransactionImportBatchIdColumn !== undefined) {
    return _hasPortfolioTransactionImportBatchIdColumn;
  }
  const row = await checkedRow(
    presentRowSchema,
    sql`SELECT EXISTS (
       SELECT 1 FROM pragma_table_info('portfolio_transactions')
        WHERE name = 'import_batch_id'
     ) AS "present::bool"`,
  );
  _hasPortfolioTransactionImportBatchIdColumn = Boolean(row?.present);
  return _hasPortfolioTransactionImportBatchIdColumn;
}

export function __resetPortfolioTransactionSchemaCache(): void {
  _hasPortfolioTransactionImportBatchIdColumn = undefined;
}
