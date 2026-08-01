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

import { query, withTransaction } from '../database/connection.js';
import {
  COMPUTED_BALANCE_LATERAL,
  computedBalanceByCurrencyAggLateral,
  statementPartitionBalance,
} from './accountBalanceSql.js';
import { buildInsert, buildSetClauses, buildLimitOffset } from '../lib/sqlClauses.js';
import { loadCurrentRates, convertWithRates } from '../services/currency/currencyConversionService.js';
import { toDecimal, toNumber, roundToCents } from '../lib/money.js';

/** @typedef {import('../types/rows.js').AccountRow} AccountRow */
/** @typedef {import('../types/rows.js').AccountWithBalanceRow} AccountWithBalanceRow */

const COLUMNS = `id, name, display_name, institution, currency, type, liquidity_class,
  spendable, in_net_worth, tax_wrapper, owner, multi_currency_cash, has_cash_sleeve,
  funding_account_id, statement_balance, to_char(statement_balance_date, 'YYYY-MM-DD') AS statement_balance_date, is_active, closed_at,
  created_at, updated_at`;

// Columns a caller may set on create/update. `name` is handled explicitly on
// create; everything else is optional and falls back to the DB default.
// `closed_at` is server-stamped by the service's lifecycle logic (D5) — it is
// writable here but never accepted from a request body.
const WRITABLE = new Set([
  'name', 'display_name', 'institution', 'currency', 'type', 'liquidity_class',
  'spendable', 'in_net_worth', 'tax_wrapper', 'owner', 'multi_currency_cash',
  'has_cash_sleeve', 'funding_account_id', 'statement_balance', 'statement_balance_date',
  'is_active', 'closed_at',
]);

export const accountRepository = {
  /**
   * List accounts (optionally filtered by active status), each with its computed
   * balance (the anchored running balance — see COMPUTED_BALANCE_LATERAL), drift
   * vs the stored statement balance (ADR-094, null when no statement balance),
   * balance provenance (`anchor_date` + `post_anchor_count`, WP-B2 — the
   * "as of {date} statement · {n} entries since" / "sum of {n} entries" fields),
   * and has_transactions — whether the account has any active ledger rows
   * (portfolio accounts whose activity lives in portfolio_transactions have none).
   *
   * Multi-currency accounts: the anchor+delta computation is partitioned by
   * `transactions.currency` (`computedBalanceByCurrencyAggLateral`) and each
   * partition is converted into the account's OWN currency, at today's rate,
   * before the per-account total is summed — `computed_balance` stays a figure
   * denominated in `accounts.currency`, which is what every consumer (the hub
   * cards, the dashboard cards, `groupAccounts.sumConvertedBalances`, the
   * reconcile dialog) already assumes when it re-converts for display. The
   * single-partition form this replaced added a EUR amount to a USD amount as
   * bare numbers (100 EUR + 100 USD at 0.5 → 100 instead of 150). A
   * single-currency account has exactly one partition and is unaffected.
   *
   * `drift` is the statement figure minus that account's OWN-currency partition
   * (`statementPartitionBalance`) — never minus the FX-converted total, which
   * would make the badge move with the daily rate. It stays a native-currency
   * figure, the same one `reconcileService` acts on, so the badge and the
   * reconcile dialog can never disagree.
   *
   * `computed_balance` / `drift` are therefore computed in JS and emitted as
   * NUMBERS (previously raw pg NUMERIC strings — the OpenAPI schema and the
   * frontend `Account` type have always declared `number`).
   *
   * `limit` is optional and defaults to unbounded — the accounts list has always
   * served every row and the hub UI has no paging, so only an explicit
   * limit/offset narrows it (buildLimitOffset). The per-currency lateral is the
   * aggregated (one row per account) form precisely so LIMIT keeps counting
   * accounts rather than currency partitions.
   *
   * @param {{ active?: boolean|null, limit?: number|null, offset?: number }} [opts]
   * @returns {Promise<AccountWithBalanceRow[]>}
   */
  async getAll({ active = null, limit = null, offset = 0 } = {}) {
    let sql = `
      SELECT ${COLUMNS},
             lb.anchor_date,
             lb.post_anchor_count,
             bp.balance_parts,
             EXISTS (
               SELECT 1 FROM transactions t2
               WHERE t2.account_id = a.id AND t2.is_active = true
             ) AS has_transactions
      FROM accounts a
      -- lb stays the account-level (cross-currency) lateral for the PROVENANCE
      -- fields only: "as of {date} statement + {n} entries since" describes the
      -- account's stamping history, not a currency's. The balance and drift
      -- below come from the per-currency partitions.
      ${COMPUTED_BALANCE_LATERAL}
      ${computedBalanceByCurrencyAggLateral({ account: 'a.id' })}
      WHERE 1=1`;
    if (active === true) sql += ` AND a.is_active = true`;
    else if (active === false) sql += ` AND a.is_active = false`;
    sql += ` ORDER BY a.name`;
    /** @type {any[]} */
    const params = [];
    sql += buildLimitOffset(params, { limit, offset });
    const result = await query(sql, params);
    // One rate table for the whole page (memory-cached in the conversion
    // service); converting per partition inside the loop would await it N times.
    const rates = await loadCurrentRates();
    // Provenance shaping (WP-B2, mirrors infoRepositoryBanks): anchor_date is
    // already a 'YYYY-MM-DD' string via to_char in the lateral — SQL NULL
    // (nothing stamped) becomes undefined, never null (convention: the backend
    // never returns null). COUNT(*) arrives as a bigint string; emit a number.
    return result.rows.map((/** @type {any} */ row) => {
      const { balance_parts: parts, ...rest } = row;
      /** @type {Array<{ currency: string, balance: string }>} */
      const partitions = parts ?? [];
      const accountCurrency = (row.currency || 'EUR').toUpperCase();
      let total = toDecimal(0);
      for (const part of partitions) {
        total = total.plus(toDecimal(convertWithRates(
          toNumber(toDecimal(part.balance)),
          (part.currency || 'EUR').toUpperCase(),
          accountCurrency,
          rates,
        )));
      }
      return {
        ...rest,
        computed_balance: toNumber(roundToCents(total)),
        drift: row.statement_balance == null
          ? null
          : toNumber(roundToCents(
            toDecimal(row.statement_balance)
              .minus(toDecimal(statementPartitionBalance(partitions, row.currency))),
          )),
        anchor_date: row.anchor_date == null ? undefined : row.anchor_date,
        post_anchor_count: row.post_anchor_count == null
          ? undefined
          : parseInt(row.post_anchor_count, 10),
      };
    });
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
    const result = await query(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [id]);
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
   * Insert an account. Only whitelisted, defined fields are written; everything
   * else falls back to the column default (e.g. type='checking', owner='me').
   *
   * @param {Record<string, any>} fields
   * @returns {Promise<AccountRow>}
   */
  async create(fields) {
    const { columns: cols, placeholders, params } = buildInsert(fields, { allowed: WRITABLE, quote: true });
    const result = await query(
      `INSERT INTO accounts (${cols.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING ${COLUMNS}`,
      params,
    );
    return result.rows[0];
  },

  /**
   * Update an account; returns the updated row, or undefined if not found.
   *
   * @param {number} id
   * @param {Record<string, any>} fields
   * @returns {Promise<AccountRow|undefined>}
   */
  async update(id, fields) {
    const { clauses: setClauses, params, nextIdx: i } = buildSetClauses(fields, { allowed: WRITABLE, quote: true });
    if (setClauses.length === 0) return this.getById(id);
    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const renaming = Object.prototype.hasOwnProperty.call(fields, 'name') && fields.name !== undefined;
    if (!renaming) {
      const result = await query(
        `UPDATE accounts SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING ${COLUMNS}`,
        params,
      );
      return result.rows[0] ?? undefined;
    }

    // Rename: propagate the new name to the denormalized `bank_account` string on
    // this account's transactions / planned_transactions, so the label stays in
    // sync with accounts.name (the sync trigger keys account_id off that string).
    // Without this the old name lingered and a later edit could resurrect it as a
    // stray account. Atomic so a half-rename can't leave the two out of sync.
    return withTransaction(async (client) => {
      const prev = await client.query('SELECT name FROM accounts WHERE id = $1 FOR UPDATE', [id]);
      if (!prev.rows[0]) return undefined;
      const result = await client.query(
        `UPDATE accounts SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING ${COLUMNS}`,
        params,
      );
      const updated = result.rows[0];
      if (!updated) return undefined;
      if (updated.name !== prev.rows[0].name) {
        await client.query('UPDATE transactions SET bank_account = $1 WHERE account_id = $2', [updated.name, id]);
        await client.query('UPDATE planned_transactions SET bank_account = $1 WHERE account_id = $2', [updated.name, id]);
      }
      return updated;
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
    const result = await query('DELETE FROM accounts WHERE id = $1 RETURNING id', [id]);
    return result.rows[0]?.id ?? undefined;
  },

  /**
   * Lock the merge survivor and read the name the repoints stamp onto
   * `bank_account` (ADR-088). FOR UPDATE so concurrent merges serialize.
   * @param {number} id
   * @returns {Promise<{id:number,name:string}|undefined>}
   */
  async lockByIdForMerge(id) {
    const result = await query('SELECT id, name FROM accounts WHERE id = $1 FOR UPDATE', [id]);
    return result.rows[0] ?? undefined;
  },

  /**
   * Lock the merge sources; returns the ids that exist (caller diffs for 404s).
   *
   * @param {number[]} ids
   * @returns {Promise<{id:number}[]>}
   */
  async lockByIdsForMerge(ids) {
    const result = await query('SELECT id FROM accounts WHERE id = ANY($1::int[]) FOR UPDATE', [ids]);
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
    const result = await query(
      `UPDATE accounts SET statement_balance = NULL, statement_balance_date = NULL, updated_at = NOW()
         WHERE id = $1`,
      [id],
    );
    return result.rowCount ?? 0;
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
      'DELETE FROM accounts WHERE id = ANY($1::int[]) AND id <> $2',
      [sourceIds, targetId],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Resolve an account id by name, creating the row if absent. Mirrors the
   * dual-write trigger's normalization — identity is lower(btrim(name)), D1 —
   * so explicit creation and trigger-driven creation converge on the same row.
   * On conflict the existing row keeps its stored casing (no-op update purely
   * to RETURNING the id in one round-trip).
   *
   * @param {string} name
   * @returns {Promise<number|undefined>} undefined when `name` trims to empty
   */
  async resolveOrCreateByName(name) {
    const trimmed = String(name).trim();
    if (!trimmed) return undefined;
    const result = await query(
      `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
       ON CONFLICT (lower(btrim(name))) DO UPDATE SET name = accounts.name
       RETURNING id`,
      [trimmed],
    );
    return result.rows[0]?.id;
  },
};

export default accountRepository;
