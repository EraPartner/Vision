/**
 * One transaction-scoped lock serializes every writer of
 * `accounts.funding_account_id`, including the raw admin database editor.
 *
 * The two-key advisory namespace spells "VISI" plus the funding-graph slot.
 * Callers must already own a transaction: PostgreSQL releases the lock when
 * that transaction commits or rolls back.
 */
export const ACCOUNT_FUNDING_GRAPH_LOCK_SQL =
  "SELECT pg_advisory_xact_lock($1::integer, $2::integer)";

export const ACCOUNT_FUNDING_GRAPH_LOCK_PARAMS = Object.freeze([0x56495349, 1]);

/**
 * @param {(sql: string, params: readonly number[]) => Promise<unknown>} runQuery
 * @returns {Promise<void>}
 */
export async function lockAccountFundingGraph(runQuery) {
  try {
    await runQuery(
      ACCOUNT_FUNDING_GRAPH_LOCK_SQL,
      ACCOUNT_FUNDING_GRAPH_LOCK_PARAMS,
    );
  } catch (err) {
    if (err?.code === "57014") {
      throw new AppError("Account funding graph is busy; retry the request", {
        status: 503,
        code: ApiErrorCode.SERVICE_UNAVAILABLE,
        cause: err,
      });
    }
    throw err;
  }
}
import { ApiErrorCode } from "@vision/types/errors";
import { AppError } from "../middleware/errorHandler.js";
