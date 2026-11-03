import { sql } from "kysely";
import { z } from "zod";
import { checkedRows, db } from "../database/db.ts";
import { dbAccountId, dbTransactionId } from "../database/rowSchemas.ts";
import { accountActiveRowSchema } from "../database/rows/ledger.ts";
import type { QueryRunner } from "../types/rows.ts";
import type { AccountId, TransactionId } from "@vision/types/brands";
import { ValidationError } from "../middleware/errorHandler.ts";

const ownershipSchema = z.object({
  id: dbTransactionId,
  account_id: dbAccountId.nullable(),
});

/** `IN (...)` over one JSON array parameter, however many ids there are. */
function inIds<T extends number>(ids: readonly T[]) {
  return sql<T>`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}

/**
 * Refuse a ledger mutation that would change the balance of a closed account:
 * every account owning one of `transactionIds`, and `targetAccountId` when a
 * row moves to it, must be active.
 *
 * `client` must be the caller's `withTransaction()` client, and the caller's
 * ledger write must run in that same transaction. PostgreSQL needed FOR SHARE
 * on the accounts and FOR UPDATE on the ledger rows, plus a re-read, to keep
 * this check true until commit; under SQLite (ADR-263) the transaction is
 * `BEGIN IMMEDIATE` on the single writer, so no other writer (account close
 * included) can run between this check and the caller's write.
 */
export async function lockAccountsForLedgerMutation(
  client: QueryRunner,
  transactionIds: TransactionId[],
  targetAccountId?: AccountId,
): Promise<void> {
  const ownership = await checkedRows(
    ownershipSchema,
    db
      .selectFrom("transactions")
      .select(["id", "account_id"])
      .where("id", "in", inIds(transactionIds))
      .orderBy("id"),
    client,
  );
  const ids = [...new Set([...ownership.map((row) => row.account_id), targetAccountId]
    .filter((id): id is AccountId => id != null))].sort((a, b) => a - b);
  const accounts = await checkedRows(
    accountActiveRowSchema,
    db
      .selectFrom("accounts")
      .select(["id", "is_active"])
      .where("id", "in", inIds(ids))
      .orderBy("id"),
    client,
  );
  if (accounts.length !== ids.length || accounts.some((account) => !account.is_active)) {
    throw new ValidationError("Reopen the account before changing its ledger balance");
  }
}
