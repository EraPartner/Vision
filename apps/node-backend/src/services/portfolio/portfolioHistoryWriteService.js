/** Keep unit-history validation and mutation under one writer transaction. */
import { query, withTransaction } from "../../database/connection.ts";

export async function withPortfolioHistoryWrite(accountIds, work) {
  return withTransaction(async () => {
    const accounts = [
      ...new Set(
        accountIds.map(Number).filter((id) => Number.isInteger(id) && id > 0),
      ),
    ].sort((a, b) => a - b);
    if (accounts.length)
      await query(
        "SELECT id FROM accounts WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE",
        [accounts],
      );
    await query(
      "LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments IN SHARE ROW EXCLUSIVE MODE",
    );
    return work();
  });
}
