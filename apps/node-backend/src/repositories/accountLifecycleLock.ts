import { sql } from "kysely";
import { z } from "zod";
import { checkedRows, db } from "../database/db.ts";
import { pgAccountId, pgTransactionId } from "../database/rowSchemas.ts";
import { accountActiveRowSchema } from "../database/rows/ledger.ts";
import type { QueryRunner } from "../types/rows.ts";
import type { AccountId, TransactionId } from "@vision/types/brands";
import { ConflictError, ValidationError } from "../middleware/errorHandler.ts";

const ownershipSchema = z.object({
  id: pgTransactionId,
  account_id: pgAccountId.nullable(),
});

/** Lock accounts before ledger rows, matching account closing's lock order. */
export async function lockAccountsForLedgerMutation(
  client: QueryRunner,
  transactionIds: TransactionId[],
  targetAccountId?: AccountId,
): Promise<void> {
  const ownership = db
    .selectFrom("transactions")
    .select(["id", "account_id"])
    .where("id", "=", sql<TransactionId>`ANY(${transactionIds}::int[])`)
    .orderBy("id");
  const before = await checkedRows(ownershipSchema, ownership, client);
  const ids = [...new Set([...before.map((row) => row.account_id), targetAccountId]
    .filter((id): id is AccountId => id != null))].sort((a, b) => a - b);
  const accounts = await checkedRows(
    accountActiveRowSchema,
    db
      .selectFrom("accounts")
      .select(["id", "is_active"])
      .where("id", "=", sql<AccountId>`ANY(${ids}::int[])`)
      .orderBy("id")
      .forShare(),
    client,
  );
  if (accounts.length !== ids.length || accounts.some((account) => !account.is_active)) {
    throw new ValidationError("Reopen the account before changing its ledger balance");
  }
  const after = await checkedRows(ownershipSchema, ownership.forUpdate(), client);
  if (after.length !== before.length || after.some((row, index) =>
    row.id !== before[index]?.id || row.account_id !== before[index].account_id)) {
    throw new ConflictError("Transaction ownership changed; reload and retry the edit");
  }
}
