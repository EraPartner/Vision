import { query } from "../database/connection.ts";
import { ConflictError } from "../middleware/errorHandler.ts";
import type { TransactionId } from "@vision/types/brands";

/** Call inside the deletion transaction; row locks serialize with execution. */
export async function protectPlannedExecutions(
  transactionIds: readonly TransactionId[],
) {
  if (transactionIds.length === 0) return;
  await query(
    "SELECT id FROM transactions WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE",
    [transactionIds],
  );
  const linked = await query(
    "SELECT 1 FROM planned_transaction_executions WHERE executed_transaction_id = ANY($1::int[]) LIMIT 1",
    [transactionIds],
  );
  if ((linked.rowCount ?? 0) > 0)
    throw new ConflictError(
      "A selected transaction is linked to a planned payment. Remove that planned payment explicitly before deleting the transaction",
    );
}
