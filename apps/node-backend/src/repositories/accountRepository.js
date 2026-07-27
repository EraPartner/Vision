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
import { COMPUTED_BALANCE_LATERAL } from './accountBalanceSql.js';
import { buildInsert, buildSetClauses, buildLimitOffset } from '../lib/sqlClauses.js';

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
   * `limit` is optional and defaults to unbounded — the accounts list has always
   * served every row and the hub UI has no paging, so only an explicit
   * limit/offset narrows it (buildLimitOffset).
   */
  async getAll({ active = null, limit = null, offset = 0 } = {}) {
    let sql = `
      SELECT ${COLUMNS},
             lb.balance AS computed_balance,
             lb.anchor_date,
             lb.post_anchor_count,
             CASE WHEN a.statement_balance IS NOT NULL
                  THEN a.statement_balance - COALESCE(lb.balance, 0)
                  ELSE NULL END AS drift,
             EXISTS (
               SELECT 1 FROM transactions t2
               WHERE t2.account_id = a.id AND t2.is_active = true
             ) AS has_transactions
      FROM accounts a
      ${COMPUTED_BALANCE_LATERAL}
      WHERE 1=1`;
    if (active === true) sql += ` AND a.is_active = true`;
    else if (active === false) sql += ` AND a.is_active = false`;
    sql += ` ORDER BY a.name`;
    const params = [];
    sql += buildLimitOffset(params, { limit, offset });
    const result = await query(sql, params);
    // Provenance shaping (WP-B2, mirrors infoRepositoryBanks): anchor_date is
    // already a 'YYYY-MM-DD' string via to_char in the lateral — SQL NULL
    // (nothing stamped) becomes undefined, never null (convention: the backend
    // never returns null). COUNT(*) arrives as a bigint string; emit a number.
    return result.rows.map((row) => ({
      ...row,
      anchor_date: row.anchor_date == null ? undefined : row.anchor_date,
      post_anchor_count: row.post_anchor_count == null
        ? undefined
        : parseInt(row.post_anchor_count, 10),
    }));
  },

  /**
   * Count accounts matching the active filter — the `total` for a paginated
   * list (the unpaginated path uses the returned row count instead).
   *
   * @param {{ active?: boolean|null }} [opts]
   */
  async getCount({ active = null } = {}) {
    let sql = `SELECT COUNT(*) FROM accounts a WHERE 1=1`;
    if (active === true) sql += ` AND a.is_active = true`;
    else if (active === false) sql += ` AND a.is_active = false`;
    const result = await query(sql, []);
    return parseInt(result.rows[0].count, 10);
  },

  async getById(id) {
    const result = await query(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [id]);
    return result.rows[0] ?? undefined;
  },

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

  /** Update an account; returns the updated row, or undefined if not found. */
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
   */
  async remove(id) {
    const result = await query('DELETE FROM accounts WHERE id = $1 RETURNING id', [id]);
    return result.rows[0]?.id ?? undefined;
  },

  /**
   * Lock the merge survivor and read the name the repoints stamp onto
   * `bank_account` (ADR-088). FOR UPDATE so concurrent merges serialize.
   * @returns {Promise<{id:number,name:string}|undefined>}
   */
  async lockByIdForMerge(id) {
    const result = await query('SELECT id, name FROM accounts WHERE id = $1 FOR UPDATE', [id]);
    return result.rows[0] ?? undefined;
  },

  /** Lock the merge sources; returns the ids that exist (caller diffs for 404s). */
  async lockByIdsForMerge(ids) {
    const result = await query('SELECT id FROM accounts WHERE id = ANY($1::int[]) FOR UPDATE', [ids]);
    return result.rows;
  },

  /** Accounts that used a merged source as their funding/settlement account. */
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
