/**
 * Atomic account close with an optional, visible zero-out adjustment.
 *
 * `preserve` keeps the historical ledger balance. `adjustment` writes one
 * balance-free system adjustment per non-zero currency partition, then closes
 * the account in the same database transaction. The rows are marked as
 * transfers so closing a balance does not appear as income or spending.
 */

import { query, withTransaction } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
import {
  accountActiveRowSchema,
  balancePartsRowSchema,
  closeAdjustmentRowSchema,
  portfolioLotRowSchema,
} from "../database/rows/ledger.ts";
import { computedBalanceByCurrencyAggLateral } from "../repositories/accountBalanceSql.ts";
import { recipientRepository } from "../repositories/recipientRepository.ts";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.ts";
import { roundToCents, toDecimal, toNumber } from "../lib/money.ts";
import { todayAppDateString } from "../lib/timezone.ts";

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
const PORTFOLIO_LOT_TYPES = ["buy", "gift", "sell"];

/**
 * Return the complete account-wide lot event selection when it fits the
 * audited bulk re-tag boundary. Loading this on the server avoids the
 * investment and per-investment pagination caps in the frontend read model.
 */
export async function previewAccountPortfolioLots(accountId: number) {
  const accountResult = await query("SELECT id FROM accounts WHERE id = $1", [
    accountId,
  ]);
  if (!accountResult.rows[0]) {
    throw new NotFoundError(`Account ${accountId} not found`);
  }

  const rows = await queryRows(
    portfolioLotRowSchema,
    `SELECT id, COUNT(*) OVER() AS eligible_count
       FROM portfolio_transactions
      WHERE account_id = $1
        AND type::text = ANY($2::text[])
      ORDER BY id ASC
      LIMIT $3`,
    [accountId, PORTFOLIO_LOT_TYPES, MAX_CLOSE_PORTFOLIO_RETAG_ROWS + 1],
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

function normalizeCloseAccount(
  body: { balance_handling?: unknown } | null | undefined,
): BalanceHandling {
  const balanceHandling = String(body?.balance_handling ?? "");
  if (!isBalanceHandling(balanceHandling)) {
    throw new ValidationError(
      "balance_handling is required and must be 'preserve' or 'adjustment'",
    );
  }
  return balanceHandling;
}

export async function closeAccount(
  accountId: number,
  body: { balance_handling?: unknown } | null | undefined,
) {
  const balanceHandling = normalizeCloseAccount(body);
  const today = todayAppDateString();

  return withTransaction(async () => {
    const account = await queryOne(
      accountActiveRowSchema,
      `SELECT id, is_active FROM accounts WHERE id = $1 FOR UPDATE`,
      [accountId],
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
      const balanceRow = await queryOne(
        balancePartsRowSchema,
        `SELECT bp.balance_parts
           FROM accounts a
           ${computedBalanceByCurrencyAggLateral({ account: "a.id", asOfDate: "$2::date" })}
          WHERE a.id = $1`,
        [accountId, today],
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
        const inserted = await queryRows(
          closeAdjustmentRowSchema,
          `INSERT INTO transactions
             (date, amount, currency, memo, account_id, recipient_id, is_transfer, transfer_source, is_active)
           SELECT $1, amounts.amount, amounts.currency, $2, $3, $4, true, 'adjustment', true
             FROM unnest($5::numeric[], $6::varchar(3)[]) AS amounts(amount, currency)
           RETURNING id, amount, currency, transfer_source`,
          [
            today,
            CLOSE_ADJUSTMENT_MEMO,
            accountId,
            systemRecipientId,
            adjustments.map((part) => part.amount),
            adjustments.map((part) => part.currency),
          ],
        );
        adjustments = inserted.map((row) => ({
          id: row.id,
          amount: Number(row.amount),
          currency: row.currency,
          transfer_source: row.transfer_source,
        }));
      }
    }

    await query(
      `UPDATE accounts
          SET is_active = false,
              in_net_worth = false,
              closed_at = COALESCE(closed_at, NOW()),
              updated_at = NOW()
        WHERE id = $1`,
      [accountId],
    );

    return {
      account_id: accountId,
      balance_handling: balanceHandling,
      already_closed: false,
      adjustments,
    };
  });
}

export default {
  closeAccount,
  normalizeCloseAccount,
  previewAccountPortfolioLots,
};

export {
  normalizeCloseAccount as __normalizeCloseAccount,
};
