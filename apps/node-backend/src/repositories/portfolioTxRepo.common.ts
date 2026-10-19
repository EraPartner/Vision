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
