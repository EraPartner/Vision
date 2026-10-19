/** Keep unit-history validation and mutation under one writer transaction. */
import { sql } from "kysely";
import type { AccountId } from "@vision/types/brands";
import { withTransaction } from "../../database/connection.ts";
import { db } from "../../database/db.ts";

export async function withPortfolioHistoryWrite<T>(
  accountIds: readonly unknown[],
  work: () => T | Promise<T>,
): Promise<T> {
  return withTransaction(async () => {
    const accounts = [
      ...new Set(
        accountIds.map(Number).filter((id) => Number.isInteger(id) && id > 0),
      ),
    ].sort((a, b) => a - b);
    if (accounts.length > 0)
      await db
        .selectFrom("accounts")
        .select("id")
        .where("id", "=", sql<AccountId>`ANY(${accounts}::int[])`)
        .orderBy("id")
        .forUpdate()
        .execute();
    await sql`LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments IN SHARE ROW EXCLUSIVE MODE`.execute(
      db,
    );
    return work();
  });
}
