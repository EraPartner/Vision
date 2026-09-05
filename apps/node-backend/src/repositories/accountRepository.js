/**
 * Account Repository — data access for the accounts table (ADR-088).
 *
 * Accounts are the user's own accounts (distinct from recipient_bank_accounts,
 * which are counterparty IBANs). `name` is unique on its normalized form —
 * lower(btrim(name)), migration 0066 / ADR-088 addendum (D1) — while the stored
 * value keeps the user's casing for display. The flag columns
 * (type / liquidity_class / spendable / in_net_worth / tax_wrapper / owner /
 * multi_currency_cash / has_cash_sleeve) exist here from migration 0050; their
 * semantics are activated in ADR-089.
 */

import { query, withTransaction } from "../database/connection.js";
import {
  balanceProvenanceLateral,
  computedBalanceByCurrencyAggLateral,
} from "./accountBalanceSql.js";
import {
  buildInsert,
  buildSetClauses,
  buildLimitOffset,
} from "../lib/sqlClauses.js";
import { todayAppDateString } from "../lib/timezone.js";
import { lockAccountFundingGraph } from "../lib/accountFundingGraphLock.js";

/** @typedef {import('../types/rows.js').AccountRow} AccountRow */
/** @typedef {import('../types/rows.js').AccountBalanceQueryRow} AccountBalanceQueryRow */

const COLUMNS = `id, name, display_name, institution, currency, type, liquidity_class,
  spendable, in_net_worth, tax_wrapper, owner, multi_currency_cash, has_cash_sleeve,
  funding_account_id, statement_balance, to_char(statement_balance_date, 'YYYY-MM-DD') AS statement_balance_date, is_active, closed_at,
  created_at, updated_at`;

// Columns a caller may set on create/update. `name` is handled explicitly on
// create; everything else is optional and falls back to the DB default.
// `closed_at` is server-stamped by the service's lifecycle logic (D5) — it is
// writable here but never accepted from a request body.
const WRITABLE = new Set([
  "name",
  "display_name",
  "institution",
  "currency",
  "type",
  "liquidity_class",
  "spendable",
  "in_net_worth",
  "tax_wrapper",
  "owner",
  "multi_currency_cash",
  "has_cash_sleeve",
  "funding_account_id",
  "statement_balance",
  "statement_balance_date",
  "is_active",
  "closed_at",
]);

/**
 * SQL `btrim(x)` — strips ASCII space (U+0020) ONLY, exactly like the sync
 * trigger's `btrim(NEW.bank_account)`. Deliberately NOT `String#trim()`, which
 * strips all Unicode whitespace: a label ending in e.g. U+00A0 (NBSP) must
 * resolve to the SAME identity the trigger computes, or explicit resolution
 * and the trigger fork — two accounts minted for one label, and the trigger
 * overwrites the explicitly-written account_id with the other one.
 *
 * @param {unknown} s
 * @returns {string}
 */
function sqlBtrim(s) {
  return String(s).replace(/^ +| +$/g, "");
}

export const accountRepository = {
  /**
   * List raw account rows (optionally filtered by active status) with native
   * balance partitions, per-currency statement readings, provenance columns,
   * and `has_transactions`. Currency conversion, drift, and the public numeric
   * response shape belong to `accountService.list`.
   *
   * Multi-currency accounts: the anchor+delta computation is partitioned by
   * `transactions.currency` (`computedBalanceByCurrencyAggLateral`) and each
   * partition with an available rate is converted into the account's OWN
   * currency, at today's rate, before the per-account total is summed —
   * `computed_balance` stays a figure
   * denominated in `accounts.currency`, which is what every consumer (the hub
   * cards, the dashboard cards, `groupAccounts.sumConvertedBalances`, the
   * reconcile dialog) already assumes when it re-converts for display. The
   * single-partition form this replaced added a EUR amount to a USD amount as
   * bare numbers (100 EUR + 100 USD at 0.5 → 100 instead of 150). A
   * single-currency account has exactly one partition and is unaffected. A
   * partition without a usable rate is exposed in native units and excluded
   * from the explicitly incomplete converted total (ADR-127).
   *
   * `drift` is the statement figure minus the RECONCILIATION BASE — the balance
   * of the partition the statement figure is a statement for (`statementPartition`)
   * — never minus the FX-converted total, which would make the badge move with
   * the daily rate. It stays a native-currency figure, the same one
   * `reconcileService` acts on, so the badge and the reconcile dialog can never
   * disagree.
   *
   * That base is emitted alongside it as `reconcilable_balance` /
   * `reconcilable_currency`, because on a multi-currency account it is NOT
   * `computed_balance` (which is the converted all-currency total) and the
   * reconcile dialog must preview `typed reading − base`, not
   * `typed reading − computed_balance`. The three native figures on that dialog
   * satisfy `drift = statement_balance − reconcilable_balance` by construction,
   * all denominated in `reconcilable_currency`.
   *
   * The repository returns the raw SQL rows, including `balance_parts`; the
   * service owns currency conversion and API shaping.
   *
   * `limit` is optional and defaults to unbounded — the accounts list has always
   * served every row and the hub UI has no paging, so only an explicit
   * limit/offset narrows it (buildLimitOffset). The per-currency lateral is the
   * aggregated (one row per account) form precisely so LIMIT keeps counting
   * accounts rather than currency partitions.
   *
   * @param {{ active?: boolean|null, limit?: number|null, offset?: number }} [opts]
   * @returns {Promise<AccountBalanceQueryRow[]>}
   */
  async getAll({ active = null, limit = null, offset = 0 } = {}) {
    const asOfDate = todayAppDateString();
    let sql = `
      SELECT ${COLUMNS},
             lb.anchor_date,
             lb.post_anchor_count,
             bp.balance_parts,
             COALESCE(sb.statement_balances, '[]'::json) AS statement_balances,
             EXISTS (
               SELECT 1 FROM transactions t2
               WHERE t2.account_id = a.id AND t2.is_active = true
             ) AS has_transactions
      FROM accounts a
      -- lb stays the account-level (cross-currency) lateral for the PROVENANCE
      -- fields only: "as of {date} statement + {n} entries since" describes the
      -- account's stamping history, not a currency's. The balance and drift
      -- below come from the per-currency partitions.
      ${balanceProvenanceLateral({ asOfDate: "$1::date" })}
      ${computedBalanceByCurrencyAggLateral({ account: "a.id", asOfDate: "$1::date" })}
      LEFT JOIN LATERAL (
        SELECT json_agg(
                 json_build_object(
                   'currency', s.currency,
                   'balance', s.balance,
                   'balance_date', to_char(s.balance_date, 'YYYY-MM-DD')
                 ) ORDER BY s.currency
               ) AS statement_balances
          FROM account_statement_balances s
         WHERE s.account_id = a.id
      ) sb ON TRUE
      WHERE 1=1`;
    if (active === true) sql += ` AND a.is_active = true`;
    else if (active === false) sql += ` AND a.is_active = false`;
    sql += ` ORDER BY a.name`;
    /** @type {any[]} */
    const params = [asOfDate];
    sql += buildLimitOffset(params, { limit, offset });
    const result = await query(sql, params);
    return result.rows;
  },

  /**
   * Count accounts matching the active filter — the `total` for a paginated
   * list (the unpaginated path uses the returned row count instead).
   *
   * @param {{ active?: boolean|null }} [opts]
   * @returns {Promise<number>}
   */
  async getCount({ active = null } = {}) {
    let sql = `SELECT COUNT(*) FROM accounts a WHERE 1=1`;
    if (active === true) sql += ` AND a.is_active = true`;
    else if (active === false) sql += ` AND a.is_active = false`;
    const result = await query(sql, []);
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * @param {number} id
   * @returns {Promise<AccountRow|undefined>}
   */
  async getById(id) {
    const result = await query(
      `SELECT ${COLUMNS} FROM accounts WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? undefined;
  },

  /**
   * @param {string} name Matched case/whitespace-insensitively (D1).
   * @returns {Promise<AccountRow|undefined>}
   */
  async getByName(name) {
    // Identity is case/whitespace-insensitive (D1) — match how the sync
    // trigger and resolveOrCreateByName resolve labels.
    const result = await query(
      `SELECT ${COLUMNS} FROM accounts WHERE lower(btrim(name)) = lower(btrim($1))`,
      [name],
    );
    return result.rows[0] ?? undefined;
  },

  /**
   * Serialize every mutation of the account funding graph. Callers must hold
   * this transaction-scoped lock before validating or changing a
   * funding_account_id edge. A single graph lock is deliberately coarse: the
   * graph is small, writes are rare, and partial row-lock protocols can miss a
   * dependent whose edge is repointed by an account merge.
   *
   * @returns {Promise<void>}
   */
  async lockFundingGraphForMutation() {
    await lockAccountFundingGraph(query);
  },

  /**
   * Insert an account. Only whitelisted, defined fields are written; everything
   * else falls back to the column default (e.g. type='checking', owner='me').
   *
   * @param {Record<string, any>} fields
   * @returns {Promise<AccountRow>}
   */
  async create(fields) {
    const {
      columns: cols,
      placeholders,
      params,
    } = buildInsert(fields, { allowed: WRITABLE, quote: true });
    return withTransaction(async () => {
      const result = await query(
        `INSERT INTO accounts (${cols.join(", ")})
         VALUES (${placeholders.join(", ")})
         RETURNING ${COLUMNS}`,
        params,
      );
      const created = result.rows[0];
      if (
        created.statement_balance != null &&
        created.statement_balance_date != null
      ) {
        await query(
          `INSERT INTO account_statement_balances
             (account_id, currency, balance, balance_date)
           VALUES ($1, $2, $3, $4)`,
          [
            created.id,
            created.currency,
            created.statement_balance,
            created.statement_balance_date,
          ],
        );
      }
      return created;
    });
  },

  /**
   * Update an account; returns the updated row, or undefined if not found.
   *
   * @param {number} id
   * @param {Record<string, any>} fields
   * @returns {Promise<AccountRow|undefined>}
   */
  async update(id, fields) {
    const {
      clauses: setClauses,
      params,
      nextIdx: i,
    } = buildSetClauses(fields, { allowed: WRITABLE, quote: true });
    if (setClauses.length === 0) return this.getById(id);
    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const renaming =
      Object.prototype.hasOwnProperty.call(fields, "name") &&
      fields.name !== undefined;
    const touchesStatement =
      Object.prototype.hasOwnProperty.call(fields, "statement_balance") ||
      Object.prototype.hasOwnProperty.call(fields, "statement_balance_date");
    const touchesCurrency =
      Object.prototype.hasOwnProperty.call(fields, "currency") &&
      fields.currency !== undefined;
    if (!renaming && !touchesStatement && !touchesCurrency) {
      const result = await query(
        `UPDATE accounts SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING ${COLUMNS}`,
        params,
      );
      return result.rows[0] ?? undefined;
    }

    // Rename and legacy statement compatibility both need the pre-update row
    // and must commit atomically with the account mutation.
    return withTransaction(async (client) => {
      const prev = await client.query(
        `SELECT name, currency, statement_balance,
                to_char(statement_balance_date, 'YYYY-MM-DD') AS statement_balance_date
           FROM accounts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!prev.rows[0]) return undefined;
      const result = await client.query(
        `UPDATE accounts SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING ${COLUMNS}`,
        params,
      );
      const updated = result.rows[0];
      if (!updated) return undefined;
      if (updated.name !== prev.rows[0].name) {
        await client.query(
          "UPDATE transactions SET bank_account = $1 WHERE account_id = $2",
          [updated.name, id],
        );
        await client.query(
          "UPDATE planned_transactions SET bank_account = $1 WHERE account_id = $2",
          [updated.name, id],
        );
      }

      const accountCurrency = updated.currency;
      if (touchesStatement) {
        const balance = Object.prototype.hasOwnProperty.call(
          fields,
          "statement_balance",
        )
          ? fields.statement_balance
          : prev.rows[0].statement_balance;
        const balanceDate = Object.prototype.hasOwnProperty.call(
          fields,
          "statement_balance_date",
        )
          ? fields.statement_balance_date
          : prev.rows[0].statement_balance_date;
        if (balance == null || balanceDate == null) {
          await client.query(
            `DELETE FROM account_statement_balances
              WHERE account_id = $1 AND currency = $2`,
            [id, accountCurrency],
          );
        } else {
          await client.query(
            `INSERT INTO account_statement_balances
               (account_id, currency, balance, balance_date)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (account_id, currency) DO UPDATE
               SET balance = EXCLUDED.balance,
                   balance_date = EXCLUDED.balance_date`,
            [id, accountCurrency, balance, balanceDate],
          );
        }
      } else if (touchesCurrency && accountCurrency !== prev.rows[0].currency) {
        // A currency-only PATCH changes which side-table row the legacy scalar
        // projects. Never leave the previous currency's reading mislabeled.
        await client.query(
          `UPDATE accounts a
              SET statement_balance = s.balance,
                  statement_balance_date = s.balance_date,
                  updated_at = NOW()
             FROM (SELECT balance, balance_date
                     FROM account_statement_balances
                    WHERE account_id = $1 AND currency = $2) s
            WHERE a.id = $1`,
          [id, accountCurrency],
        );
        await client.query(
          `UPDATE accounts
              SET statement_balance = NULL,
                  statement_balance_date = NULL,
                  updated_at = NOW()
            WHERE id = $1
              AND NOT EXISTS (
                SELECT 1 FROM account_statement_balances
                 WHERE account_id = $1 AND currency = $2
              )`,
          [id, accountCurrency],
        );
      }
      const refreshed = await client.query(
        `SELECT ${COLUMNS} FROM accounts WHERE id = $1`,
        [id],
      );
      return refreshed.rows[0] ?? undefined;
    });
  },

  /**
   * Hard-delete an account. Raises Postgres 23503 if transactions or planned
   * transactions still reference it (account_id FK is ON DELETE RESTRICT) — the
   * caller turns that into a 409 (archive instead). Returns the id, or undefined.
   *
   * @param {number} id
   * @returns {Promise<number|undefined>}
   */
  async remove(id) {
    const result = await query(
      "DELETE FROM accounts WHERE id = $1 RETURNING id",
      [id],
    );
    return result.rows[0]?.id ?? undefined;
  },

  /**
   * Lock the merge survivor and read the name the repoints stamp onto
   * `bank_account` (ADR-088). FOR UPDATE so concurrent merges serialize.
   * @param {number} id
   * @returns {Promise<{id:number,name:string}|undefined>}
   */
  async lockByIdForMerge(id) {
    const result = await query(
      "SELECT id, name FROM accounts WHERE id = $1 FOR UPDATE",
      [id],
    );
    return result.rows[0] ?? undefined;
  },

  /**
   * Lock the merge sources; returns the ids that exist (caller diffs for 404s).
   *
   * @param {number[]} ids
   * @returns {Promise<{id:number}[]>}
   */
  async lockByIdsForMerge(ids) {
    const result = await query(
      "SELECT id FROM accounts WHERE id = ANY($1::int[]) FOR UPDATE",
      [ids],
    );
    return result.rows;
  },

  /**
   * Accounts that used a merged source as their funding/settlement account.
   *
   * @param {number} targetId
   * @param {number[]} sourceIds
   * @returns {Promise<number>} rows repointed
   */
  async repointFundingAccount(targetId, sourceIds) {
    const result = await query(
      `UPDATE accounts SET funding_account_id = $1 WHERE funding_account_id = ANY($2::int[])`,
      [targetId, sourceIds],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Clear a statement anchor invalidated by an interleaved-stamp merge (§1 F2).
   * Per-row `balance` stamps are historical facts and stay untouched.
   *
   * @param {number} id
   * @returns {Promise<number>} rows affected
   */
  async clearStatementAnchor(id) {
    return withTransaction(async () => {
      await query(
        "DELETE FROM account_statement_balances WHERE account_id = $1",
        [id],
      );
      const result = await query(
        `UPDATE accounts SET statement_balance = NULL, statement_balance_date = NULL, updated_at = NOW()
           WHERE id = $1`,
        [id],
      );
      return result.rowCount ?? 0;
    });
  },

  /** Store one authoritative statement reading, mirroring the legacy scalar
   * projection only when it is in the account's declared currency. */
  async upsertStatementBalance(accountId, currency, balance, balanceDate) {
    return withTransaction(async () => {
      const result = await query(
        `INSERT INTO account_statement_balances
           (account_id, currency, balance, balance_date)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id, currency) DO UPDATE
           SET balance = EXCLUDED.balance, balance_date = EXCLUDED.balance_date
         RETURNING account_id, currency, balance,
                   to_char(balance_date, 'YYYY-MM-DD') AS balance_date`,
        [accountId, currency, balance, balanceDate],
      );
      await query(
        `UPDATE accounts
            SET statement_balance = $3, statement_balance_date = $4, updated_at = NOW()
          WHERE id = $1 AND currency = $2`,
        [accountId, currency, balance, balanceDate],
      );
      return result.rows[0];
    });
  },

  async deleteStatementBalance(accountId, currency) {
    return withTransaction(async () => {
      const result = await query(
        `DELETE FROM account_statement_balances
          WHERE account_id = $1 AND currency = $2
        RETURNING account_id`,
        [accountId, currency],
      );
      await query(
        `UPDATE accounts
            SET statement_balance = NULL, statement_balance_date = NULL, updated_at = NOW()
          WHERE id = $1 AND currency = $2`,
        [accountId, currency],
      );
      return result.rowCount ?? 0;
    });
  },

  /**
   * Delete the merged-away sources. The account_id FKs are ON DELETE RESTRICT,
   * so this only succeeds once every reference has been repointed.
   *
   * @param {number[]} sourceIds
   * @param {number} targetId
   * @returns {Promise<number>} rows deleted
   */
  async deleteMergedSources(sourceIds, targetId) {
    const result = await query(
      "DELETE FROM accounts WHERE id = ANY($1::int[]) AND id <> $2",
      [sourceIds, targetId],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Resolve an account id by name, creating the row if absent. Mirrors the
   * dual-write trigger's normalization EXACTLY — identity is
   * lower(btrim(name)), D1, and the JS-side pre-trim is `sqlBtrim` (U+0020
   * only), never `String#trim()` — so explicit creation and trigger-driven
   * creation converge on the same row for every label, including ones padded
   * with non-ASCII whitespace. On conflict the existing row keeps its stored
   * casing (no-op update purely to RETURNING the id in one round-trip).
   *
   * @param {string|null|undefined} name
   * @param {{ multiCurrencyCash?: boolean }} [capabilities]
   * @returns {Promise<number|undefined>} undefined when `name` is null or
   *   btrims to empty (the trigger's blank path — no account)
   */
  async resolveOrCreateByName(name, { multiCurrencyCash = false } = {}) {
    if (name == null) return undefined;
    const trimmed = sqlBtrim(name);
    if (!trimmed) return undefined;
    const result = await query(
      `INSERT INTO accounts (name, display_name, multi_currency_cash) VALUES ($1, $1, $2)
       ON CONFLICT (lower(btrim(name))) DO UPDATE
         SET multi_currency_cash = accounts.multi_currency_cash OR EXCLUDED.multi_currency_cash
       RETURNING id`,
      [trimmed, multiCurrencyCash],
    );
    return result.rows[0]?.id;
  },
};

export default accountRepository;
