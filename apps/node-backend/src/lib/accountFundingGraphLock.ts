import { ApiErrorCode } from "@vision/types/errors";
import { withTransaction } from "../database/connection.ts";
import { AppError } from "../middleware/errorHandler.ts";

/**
 * The serialization point for every writer of `accounts.funding_account_id`,
 * including the raw admin database editor.
 *
 * PostgreSQL needed a transaction-scoped advisory lock here. Under SQLite
 * (ADR-263) every write transaction is `BEGIN IMMEDIATE` on the single writer
 * connection, so the `withTransaction()` the caller already owns serializes
 * the funding-graph validation reads and the edge write against every other
 * writer until it commits or rolls back. Nothing is left to acquire.
 *
 * The function stays as the documented protocol point, with its signature, so
 * callers keep stating where the graph becomes theirs. Callers must call it
 * inside `withTransaction()` and keep the validation read and the write in
 * that same transaction: outside one, the read and the write are separate
 * statements and another writer can run between them.
 *
 * @param _runQuery the caller's transaction runner; unused, kept so callers
 *   written for the advisory lock compile unchanged.
 */
export function lockAccountFundingGraph(
  _runQuery?: (sql: string, params: readonly number[]) => Promise<unknown>,
): Promise<void> {
  // BEGIN IMMEDIATE already holds the database write lock for the caller.
  return Promise.resolve();
}

/**
 * Run a funding-graph mutation in a write transaction (a savepoint inside an
 * open one). A wait for the database write lock that times out (55P03)
 * answers the retryable 503 that a cancelled advisory-lock wait (57014)
 * answered on PostgreSQL.
 */
export async function withFundingGraphTransaction<T>(
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withTransaction(fn);
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "55P03"
    ) {
      throw new AppError("Account funding graph is busy; retry the request", {
        status: 503,
        code: ApiErrorCode.SERVICE_UNAVAILABLE,
        cause: err,
      });
    }
    throw err;
  }
}
