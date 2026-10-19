import { sql } from "kysely";
import { db } from "../database/db.ts";
import { ConflictError } from "../middleware/errorHandler.ts";
import type { TransactionId } from "@vision/types/brands";

/** Call inside the deletion transaction; row locks serialize with execution. */
export async function protectPlannedExecutions(
  transactionIds: readonly TransactionId[],
) {
  if (transactionIds.length === 0) return;
  const anyId = sql<TransactionId>`ANY(${transactionIds}::int[])`;
  await db
    .selectFrom("transactions")
    .select("id")
    .where("id", "=", anyId)
    .orderBy("id")
    .forUpdate()
    .execute();
  const linked = await db
    .selectFrom("planned_transaction_executions")
    .select(sql<number>`1`.as("linked"))
    .where("executed_transaction_id", "=", anyId)
    .limit(1)
    .executeTakeFirst();
  if (linked)
    throw new ConflictError(
      "A selected transaction is linked to a planned payment. Remove that planned payment explicitly before deleting the transaction",
    );
}
