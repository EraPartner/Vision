/** Keep unit-history validation and mutation under one writer transaction. */
import { withTransaction } from "../../database/connection.ts";

/**
 * Run `work` (validate the unit history, then write it) in one write
 * transaction. PostgreSQL needed row locks on the touched accounts and a
 * SHARE ROW EXCLUSIVE lock on the three unit-history tables; on SQLite every
 * write transaction is BEGIN IMMEDIATE on the single writer (ADR-263), so no
 * other write can change the history between the validation and the write.
 *
 * @param _accountIds the accounts the write touches (PostgreSQL locked them)
 */
export async function withPortfolioHistoryWrite<T>(
  _accountIds: readonly unknown[],
  work: () => T | Promise<T>,
): Promise<T> {
  return withTransaction(async () => work());
}
