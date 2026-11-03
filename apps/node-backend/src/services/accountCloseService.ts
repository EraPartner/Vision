/**
 * Atomic account close with an optional, visible zero-out adjustment.
 *
 * `preserve` keeps the historical ledger balance. `adjustment` writes one
 * balance-free system adjustment per non-zero currency partition, then closes
 * the account in the same database transaction. The rows are marked as
 * transfers so closing a balance does not appear as income or spending.
 */

import { looseText } from "../lib/looseText.ts";
import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  accountActiveRowSchema,
  balancePartsRowSchema,
  closeAdjustmentRowSchema,
  portfolioLotRowSchema,
} from "../database/rows/ledger.ts";
import {
  balancePartsColumn,
  computedBalanceByCurrencyAggLateral,
} from "../repositories/accountBalanceSql.ts";
import { recipientRepository } from "../repositories/recipientRepository.ts";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.ts";
import { roundToCents, toDecimal, toNumber } from "../lib/money.ts";
import { todayAppDateString } from "../lib/timezone.ts";
import type { PortfolioTxnType } from "../database/schema.generated.ts";
import type { AccountId } from "@vision/types/brands";

export type BalanceHandling = "preserve" | "adjustment";

export interface CloseAdjustment {
  currency: string;
  amount: number;
  id?: number;
  transfer_source?: string;
}

const VALID_BALANCE_HANDLING: ReadonlySet<string> = new Set([
  "preserve",
  "adjustment",
]);
const CLOSE_ADJUSTMENT_MEMO = "ACCOUNT CLOSE ADJUSTMENT";
export const MAX_CLOSE_PORTFOLIO_RETAG_ROWS = 500;
const PORTFOLIO_LOT_TYPES: PortfolioTxnType[] = ["buy", "gift", "sell"];

/**
 * Return the complete account-wide lot event selection when it fits the
 * bulk re-tag boundary. Loading this on the server avoids the
 * investment and per-investment pagination caps in the frontend read model.
 */
export async function previewAccountPortfolioLots(accountId: AccountId) {
  const account = await db
    .selectFrom("accounts")
    .select("id")
    .where("id", "=", accountId)
    .executeTakeFirst();
  if (!account) {
    throw new NotFoundError(`Account ${accountId} not found`);
  }

  const rows = await checkedRows(
    portfolioLotRowSchema,
    sql`SELECT id, COUNT(*) OVER () AS "eligible_count::bigint"
          FROM portfolio_transactions
         WHERE account_id = ${accountId}
           AND type IN (SELECT value FROM json_each(${JSON.stringify(PORTFOLIO_LOT_TYPES)}))
         ORDER BY id ASC
         LIMIT ${MAX_CLOSE_PORTFOLIO_RETAG_ROWS + 1}`,
  );
  const eligibleCount = Number(rows[0]?.eligible_count ?? 0);
  return {
    account_id: accountId,
    eligible_count: eligibleCount,
    transaction_ids:
      eligibleCount <= MAX_CLOSE_PORTFOLIO_RETAG_ROWS
        ? rows.map((row) => Number(row.id))
        : [],
    limit: MAX_CLOSE_PORTFOLIO_RETAG_ROWS,
  };
}

function isBalanceHandling(value: string): value is BalanceHandling {
  return VALID_BALANCE_HANDLING.has(value);
}

function normalizeCloseAccount(body: unknown): BalanceHandling {
  const raw =
    typeof body === "object" && body !== null && "balance_handling" in body
      ? body.balance_handling
      : undefined;
  const balanceHandling = looseText(raw ?? "");
  if (!isBalanceHandling(balanceHandling)) {
    throw new ValidationError(
      "balance_handling is required and must be 'preserve' or 'adjustment'",
    );
  }
  return balanceHandling;
}

export async function closeAccount(
  accountId: AccountId,
  body: unknown,
) {
  const balanceHandling = normalizeCloseAccount(body);
  const today = todayAppDateString();

  // One BEGIN IMMEDIATE transaction (ADR-263): the active-state read, the
  // balance read, the adjustments and the close run with no other writer in
  // between, which the PostgreSQL version got from FOR UPDATE on the account.
  return withTransaction(async () => {
    const account = await checkedRow(
      accountActiveRowSchema,
      db
        .selectFrom("accounts")
        .select(["id", "is_active"])
        .where("id", "=", accountId),
    );
    if (!account) throw new NotFoundError(`Account ${accountId} not found`);

    // Safe retry after a successful close: never stamp another adjustment.
    if (!account.is_active) {
      return {
        account_id: accountId,
        balance_handling: balanceHandling,
        already_closed: true,
        adjustments: [],
      };
    }

    let adjustments: CloseAdjustment[] = [];
    if (balanceHandling === "adjustment") {
      const balanceRow = await checkedRow(
        balancePartsRowSchema,
        sql`SELECT ${balancePartsColumn()}
           FROM accounts a
           ${computedBalanceByCurrencyAggLateral({ account: sql`a.id`, asOfDate: sql`${today}` })}
          WHERE a.id = ${accountId}`,
      );
      adjustments = (balanceRow?.balance_parts ?? [])
        .map((part) => ({
          currency: String(part.currency).toUpperCase(),
          // Round the canonical displayed balance first, then invert it. This
          // makes the post-adjustment partition zero at Vision's shared
          // two-decimal, ROUND_HALF_EVEN money boundary.
          amount: toNumber(roundToCents(toDecimal(part.balance)).negated()),
        }))
        .filter((part) => Math.abs(part.amount) >= 0.005);

      if (adjustments.length > 0) {
        const systemRecipientId =
          await recipientRepository.getOrCreateSystemId();
        // Money binds as decimal text: String() of the rounded number is the
        // text node-postgres sent for the former numeric[] parameter.
        const parts = JSON.stringify(
          adjustments.map((part) => ({
            amount: String(part.amount),
            currency: part.currency,
          })),
        );
        const inserted = await checkedRows(
          closeAdjustmentRowSchema,
          sql`INSERT INTO transactions
             (date, amount, currency, memo, account_id, recipient_id, is_transfer, transfer_source, is_active)
           SELECT ${today}, vision_numeric(p.value ->> '$.amount', 18, 4), p.value ->> '$.currency',
                  ${CLOSE_ADJUSTMENT_MEMO}, ${accountId}, ${systemRecipientId}, true, 'adjustment', true
             FROM (SELECT value FROM json_each(${parts}) ORDER BY key) p
           RETURNING id, amount, currency, transfer_source`,
        );
        // RETURNING order is unspecified in SQLite; ids follow insert order.
        inserted.sort((a, b) => a.id - b.id);
        adjustments = inserted.map((row) => ({
          id: row.id,
          amount: Number(row.amount),
          currency: row.currency,
          transfer_source: row.transfer_source,
        }));
      }
    }

    await db
      .updateTable("accounts")
      .set({
        is_active: false,
        in_net_worth: false,
        closed_at: sql<Date>`COALESCE(closed_at, now())`,
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", accountId)
      .execute();

    return {
      account_id: accountId,
      balance_handling: balanceHandling,
      already_closed: false,
      adjustments,
    };
  });
}


export {
  normalizeCloseAccount as __normalizeCloseAccount,
};
