import { z } from "zod";
import { pgInt } from "../database/rowSchemas.ts";
import { queryRows } from "../database/rowContracts.ts";
import { accountActiveRowSchema } from "../database/rows/ledger.ts";
import type { QueryRunner } from "../types/rows.ts";
import { ConflictError, ValidationError } from "../middleware/errorHandler.ts";

const ownershipSchema = z.object({ id: pgInt, account_id: pgInt.nullable() });

/** Lock accounts before ledger rows, matching account closing's lock order. */
export async function lockAccountsForLedgerMutation(
  client: QueryRunner,
  transactionIds: number[],
  targetAccountId?: number,
): Promise<void> {
  const sql = "SELECT id, account_id FROM transactions WHERE id = ANY($1::int[]) ORDER BY id";
  const before = await queryRows(ownershipSchema, sql, [transactionIds], client);
  const ids = [...new Set([...before.map((row) => row.account_id), targetAccountId]
    .filter((id): id is number => id != null))].sort((a, b) => a - b);
  const accounts = await queryRows(accountActiveRowSchema,
    "SELECT id, is_active FROM accounts WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE",
    [ids], client);
  if (accounts.length !== ids.length || accounts.some((account) => !account.is_active)) {
    throw new ValidationError("Reopen the account before changing its ledger balance");
  }
  const after = await queryRows(ownershipSchema, `${sql} FOR UPDATE`, [transactionIds], client);
  if (after.length !== before.length || after.some((row, index) =>
    row.id !== before[index]?.id || row.account_id !== before[index]?.account_id)) {
    throw new ConflictError("Transaction ownership changed; reload and retry the edit");
  }
}
