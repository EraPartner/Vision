/**
 * Atomic account close with an optional, visible zero-out adjustment.
 *
 * `preserve` keeps the historical ledger balance. `adjustment` writes one
 * balance-free system adjustment per non-zero currency partition, then closes
 * the account in the same database transaction. The rows are marked as
 * transfers so closing a balance does not appear as income or spending.
 */

import { query, withTransaction } from "../database/connection.js";
import { computedBalanceByCurrencyAggLateral } from "../repositories/accountBalanceSql.js";
import { recipientRepository } from "../repositories/recipientRepository.js";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.js";
import { roundToCents, toDecimal, toNumber } from "../lib/money.js";
import { todayAppDateString } from "../lib/timezone.js";

const VALID_BALANCE_HANDLING = new Set(["preserve", "adjustment"]);
const CLOSE_ADJUSTMENT_MEMO = "ACCOUNT CLOSE ADJUSTMENT";
export const MAX_CLOSE_PORTFOLIO_RETAG_ROWS = 500;
const PORTFOLIO_LOT_TYPES = ["buy", "gift", "sell"];

/**
 * Return the complete account-wide lot event selection when it fits the
 * audited bulk re-tag boundary. Loading this on the server avoids the
 * investment and per-investment pagination caps in the frontend read model.
 *
 * @param {number} accountId
 */
export async function previewAccountPortfolioLots(accountId) {
  const accountResult = await query("SELECT id FROM accounts WHERE id = $1", [
    accountId,
  ]);
  if (!accountResult.rows[0]) {
    throw new NotFoundError(`Account ${accountId} not found`);
  }

  const result = await query(
    `SELECT id, COUNT(*) OVER() AS eligible_count
       FROM portfolio_transactions
      WHERE account_id = $1
        AND type::text = ANY($2::text[])
      ORDER BY id ASC
      LIMIT $3`,
    [accountId, PORTFOLIO_LOT_TYPES, MAX_CLOSE_PORTFOLIO_RETAG_ROWS + 1],
  );
  const eligibleCount = Number(result.rows[0]?.eligible_count ?? 0);
  return {
    account_id: accountId,
    eligible_count: eligibleCount,
    transaction_ids:
      eligibleCount <= MAX_CLOSE_PORTFOLIO_RETAG_ROWS
        ? result.rows.map((row) => Number(row.id))
        : [],
    limit: MAX_CLOSE_PORTFOLIO_RETAG_ROWS,
  };
}

/** @param {{ balance_handling?: unknown }} body */
export function normalizeCloseAccount(body) {
  const balanceHandling = String(body?.balance_handling ?? "");
  if (!VALID_BALANCE_HANDLING.has(balanceHandling)) {
    throw new ValidationError(
      "balance_handling is required and must be 'preserve' or 'adjustment'",
    );
  }
  return /** @type {'preserve'|'adjustment'} */ (balanceHandling);
}

/**
 * @param {number} accountId
 * @param {{ balance_handling?: unknown }} body
 */
export async function closeAccount(accountId, body) {
  const balanceHandling = normalizeCloseAccount(body);
  const today = todayAppDateString();

  return withTransaction(async () => {
    const locked = await query(
      `SELECT id, is_active FROM accounts WHERE id = $1 FOR UPDATE`,
      [accountId],
    );
    const account = locked.rows[0];
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

    /** @type {Array<{currency:string, amount:number}>} */
    let adjustments = [];
    if (balanceHandling === "adjustment") {
      const balanceResult = await query(
        `SELECT bp.balance_parts
           FROM accounts a
           ${computedBalanceByCurrencyAggLateral({ account: "a.id", asOfDate: "$2::date" })}
          WHERE a.id = $1`,
        [accountId, today],
      );
      adjustments = (balanceResult.rows[0]?.balance_parts ?? [])
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
        const inserted = await query(
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
        adjustments = inserted.rows.map((row) => ({
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
