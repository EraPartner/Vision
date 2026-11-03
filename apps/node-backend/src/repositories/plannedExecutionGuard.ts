import { sql } from "kysely";
import { db } from "../database/db.ts";
import { ConflictError } from "../middleware/errorHandler.ts";
import type { TransactionId } from "@vision/types/brands";

/**
 * Call inside the deletion transaction. The single SQLite writer (BEGIN
 * IMMEDIATE) serializes the deletion with execution, which runs in its own
 * write transaction: no execution can link one of these rows between this
 * check and the caller's delete.
 */
export async function protectPlannedExecutions(
  transactionIds: readonly TransactionId[],
) {
  if (transactionIds.length === 0) return;
  const linked = await db
    .selectFrom("planned_transaction_executions")
    .select(sql<number>`1`.as("linked"))
    .where(
      sql<boolean>`executed_transaction_id IN (SELECT value FROM json_each(${JSON.stringify(transactionIds)}))`,
    )
    .limit(1)
    .executeTakeFirst();
  if (linked)
    throw new ConflictError(
      "A selected transaction is linked to a planned payment. Remove that planned payment explicitly before deleting the transaction",
    );
}
