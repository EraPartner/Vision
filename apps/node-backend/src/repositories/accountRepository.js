/**
 * Account Repository — data access for the accounts table (ADR-088).
 *
 * Accounts are the user's own accounts (distinct from recipient_bank_accounts,
 * which are counterparty IBANs). `name` is globally unique. The flag columns
 * (type / liquidity_class / spendable / in_net_worth / tax_wrapper / owner /
 * multi_currency_cash / has_cash_sleeve) exist here from migration 0050; their
 * semantics are activated in ADR-089.
 */

import { query } from '../database/connection.js';

const COLUMNS = `id, name, display_name, institution, currency, type, liquidity_class,
  spendable, in_net_worth, tax_wrapper, owner, multi_currency_cash, has_cash_sleeve,
  funding_account_id, statement_balance, statement_balance_date, is_active, created_at, updated_at`;

// Columns a caller may set on create/update. `name` is handled explicitly on
// create; everything else is optional and falls back to the DB default.
const WRITABLE = new Set([
  'name', 'display_name', 'institution', 'currency', 'type', 'liquidity_class',
  'spendable', 'in_net_worth', 'tax_wrapper', 'owner', 'multi_currency_cash',
  'has_cash_sleeve', 'funding_account_id', 'statement_balance', 'statement_balance_date', 'is_active',
]);

export const accountRepository = {
  /**
   * List accounts (optionally filtered by active status), each with its computed
   * balance (latest active transaction's balance) and drift vs the stored
   * statement balance (ADR-094). drift is null when no statement balance is set.
   */
  async getAll({ active = null } = {}) {
    let sql = `
      SELECT ${COLUMNS},
             lb.balance AS computed_balance,
             CASE WHEN a.statement_balance IS NOT NULL
                  THEN a.statement_balance - COALESCE(lb.balance, 0)
                  ELSE NULL END AS drift
      FROM accounts a
      LEFT JOIN LATERAL (
        SELECT t.balance FROM transactions t
        WHERE t.account_id = a.id AND t.is_active = true AND t.balance IS NOT NULL
        ORDER BY t.date DESC, t.id DESC
        LIMIT 1
      ) lb ON true
      WHERE 1=1`;
    if (active === true) sql += ` AND a.is_active = true`;
    else if (active === false) sql += ` AND a.is_active = false`;
    sql += ` ORDER BY a.name`;
    const result = await query(sql, []);
    return result.rows;
  },

  async getById(id) {
    const result = await query(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [id]);
    return result.rows[0] ?? undefined;
  },

  async getByName(name) {
    const result = await query(`SELECT ${COLUMNS} FROM accounts WHERE name = $1`, [name]);
    return result.rows[0] ?? undefined;
  },

  /**
   * Insert an account. Only whitelisted, defined fields are written; everything
   * else falls back to the column default (e.g. type='checking', owner='me').
   */
  async create(fields) {
    const cols = [];
    const placeholders = [];
    const params = [];
    let i = 1;
    for (const [key, value] of Object.entries(fields)) {
      if (!WRITABLE.has(key) || value === undefined) continue;
      cols.push(`"${key}"`);
      placeholders.push(`$${i++}`);
      params.push(value);
    }
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
    const setClauses = [];
    const params = [];
    let i = 1;
    for (const [key, value] of Object.entries(fields)) {
      if (!WRITABLE.has(key) || value === undefined) continue;
      setClauses.push(`"${key}" = $${i++}`);
      params.push(value);
    }
    if (setClauses.length === 0) return this.getById(id);
    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const result = await query(
      `UPDATE accounts SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING ${COLUMNS}`,
      params,
    );
    return result.rows[0] ?? undefined;
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
   * Resolve an account id by name, creating the row if absent. Mirrors the
   * dual-write trigger's normalization (trimmed name) so explicit creation and
   * trigger-driven creation converge on the same row.
   */
  async resolveOrCreateByName(name) {
    const trimmed = String(name).trim();
    if (!trimmed) return undefined;
    const result = await query(
      `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [trimmed],
    );
    return result.rows[0]?.id;
  },
};

export default accountRepository;
