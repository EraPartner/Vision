/**
 * Reconciliation Repository — data access for bank_statements and
 * reconciliation_entries.
 *
 * All monetary values stored as NUMERIC; returned as strings from pg driver,
 * so callers should parseFloat() where needed.
 */

import { query } from '../database/connection.js';

const ENTRY_SELECT = `
  re.id,
  re.bank_statement_id,
  re.entry_date::text,
  re.description,
  re.amount,
  re.currency,
  re.transaction_id,
  re.match_status,
  re.match_score,
  re.created_at
`;

const STATEMENT_SELECT = `
  bs.id,
  bs.bank_account,
  bs.currency,
  bs.period_start::text,
  bs.period_end::text,
  bs.opening_balance,
  bs.closing_balance,
  bs.notes,
  bs.created_at,
  bs.updated_at,
  COUNT(re.id)                                      AS total_entries,
  COUNT(re.id) FILTER (WHERE re.match_status = 'unmatched') AS unmatched_count,
  COUNT(re.id) FILTER (WHERE re.match_status IN ('confirmed','manual')) AS matched_count
`;

export const reconciliationRepository = {
  // ── Statements ──────────────────────────────────────────────────────────────

  async listStatements({ bankAccount = null, limit = 50, offset = 0 } = {}) {
    const params = [];
    let where = 'WHERE 1=1';
    if (bankAccount) {
      params.push(bankAccount);
      where += ` AND bs.bank_account ILIKE $${params.length}`;
    }
    params.push(limit, offset);
    const sql = `
      SELECT ${STATEMENT_SELECT}
      FROM bank_statements bs
      LEFT JOIN reconciliation_entries re ON re.bank_statement_id = bs.id
      ${where}
      GROUP BY bs.id
      ORDER BY bs.period_end DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `;
    const result = await query(sql, params);
    return result.rows;
  },

  async getStatement(id) {
    const sql = `
      SELECT ${STATEMENT_SELECT}
      FROM bank_statements bs
      LEFT JOIN reconciliation_entries re ON re.bank_statement_id = bs.id
      WHERE bs.id = $1
      GROUP BY bs.id
    `;
    const result = await query(sql, [id]);
    return result.rows[0] ?? null;
  },

  async createStatement({ bank_account, currency = 'EUR', period_start, period_end, opening_balance, closing_balance, notes }) {
    const sql = `
      INSERT INTO bank_statements (bank_account, currency, period_start, period_end, opening_balance, closing_balance, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, bank_account, currency, period_start::text, period_end::text,
                opening_balance, closing_balance, notes, created_at
    `;
    const result = await query(sql, [
      bank_account,
      currency.toUpperCase(),
      period_start,
      period_end,
      opening_balance ?? null,
      closing_balance ?? null,
      notes ?? null,
    ]);
    return result.rows[0];
  },

  async updateStatement(id, { bank_account, currency, period_start, period_end, opening_balance, closing_balance, notes }) {
    const fields = {};
    if (bank_account !== undefined) fields.bank_account = bank_account;
    if (currency !== undefined) fields.currency = currency.toUpperCase();
    if (period_start !== undefined) fields.period_start = period_start;
    if (period_end !== undefined) fields.period_end = period_end;
    if (opening_balance !== undefined) fields.opening_balance = opening_balance;
    if (closing_balance !== undefined) fields.closing_balance = closing_balance;
    if (notes !== undefined) fields.notes = notes;

    const keys = Object.keys(fields);
    if (keys.length === 0) return this.getStatement(id);

    const setClauses = keys.map((k, i) => `"${k}" = $${i + 1}`);
    const params = [...Object.values(fields), id];
    const sql = `
      UPDATE bank_statements
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING id
    `;
    const result = await query(sql, params);
    if (result.rowCount === 0) return null;
    return this.getStatement(id);
  },

  async deleteStatement(id) {
    const result = await query('DELETE FROM bank_statements WHERE id = $1', [id]);
    return result.rowCount > 0;
  },

  // ── Entries ──────────────────────────────────────────────────────────────────

  async listEntries(statementId, { matchStatus = null } = {}) {
    const params = [statementId];
    let where = 'WHERE re.bank_statement_id = $1';
    if (matchStatus) {
      params.push(matchStatus);
      where += ` AND re.match_status = $${params.length}`;
    }
    const sql = `
      SELECT ${ENTRY_SELECT}
      FROM reconciliation_entries re
      ${where}
      ORDER BY re.entry_date ASC, re.id ASC
    `;
    const result = await query(sql, params);
    return result.rows;
  },

  async createEntry({ bank_statement_id, entry_date, description, amount, currency = 'EUR' }) {
    const sql = `
      INSERT INTO reconciliation_entries (bank_statement_id, entry_date, description, amount, currency)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, bank_statement_id, entry_date::text, description, amount, currency,
                transaction_id, match_status, match_score, created_at
    `;
    const result = await query(sql, [
      bank_statement_id,
      entry_date,
      description ?? null,
      amount,
      currency.toUpperCase(),
    ]);
    return result.rows[0];
  },

  async getEntry(entryId) {
    const sql = `
      SELECT ${ENTRY_SELECT}
      FROM reconciliation_entries re
      WHERE re.id = $1
    `;
    const result = await query(sql, [entryId]);
    return result.rows[0] ?? null;
  },

  async bulkCreateEntries(statementId, entries) {
    if (!entries || entries.length === 0) return [];

    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const e of entries) {
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(
        statementId,
        e.entry_date,
        e.description ?? null,
        e.amount,
        (e.currency ?? 'EUR').toUpperCase(),
      );
    }

    const sql = `
      INSERT INTO reconciliation_entries (bank_statement_id, entry_date, description, amount, currency)
      VALUES ${values.join(', ')}
      RETURNING id, bank_statement_id, entry_date::text, description, amount, currency,
                transaction_id, match_status, match_score, created_at
    `;
    const result = await query(sql, params);
    return result.rows;
  },

  async updateEntryMatch(entryId, { transaction_id, match_status, match_score }) {
    const sql = `
      UPDATE reconciliation_entries
      SET transaction_id = $1,
          match_status   = $2,
          match_score    = $3,
          updated_at     = NOW()
      WHERE id = $4
      RETURNING id, bank_statement_id, entry_date::text, description, amount, currency,
                transaction_id, match_status, match_score, created_at
    `;
    const result = await query(sql, [
      transaction_id ?? null,
      match_status,
      match_score ?? null,
      entryId,
    ]);
    return result.rows[0] ?? null;
  },

  async deleteEntry(entryId) {
    const result = await query('DELETE FROM reconciliation_entries WHERE id = $1', [entryId]);
    return result.rowCount > 0;
  },

  // ── Match candidates ─────────────────────────────────────────────────────────

  /**
   * Find transaction candidates for a reconciliation entry.
   *
   * Scoring heuristic:
   *   +50  exact amount match
   *   +30  date within 1 day
   *   +20  date within 3 days
   *   +10  date within 7 days
   *   +20  description token overlap ≥ 50%
   *
   * Returns up to `limit` candidates ordered by score desc.
   *
   * @param {{ statementBankAccount: string, entryDate: string, amount: number, description?: string, limit?: number }} opts
   */
  async findMatchCandidates({ statementBankAccount, entryDate, amount, description, limit = 5 }) {
    const sql = `
      SELECT
        t.id,
        t.date::text,
        t.amount,
        t.currency,
        t.memo,
        t.bank_account,
        r.name AS recipient_name,
        -- Score: amount match + date proximity
        (
          CASE WHEN t.amount = $1 THEN 50 ELSE 0 END
          +
          CASE
            WHEN ABS(t.date - $2::date) = 0 THEN 30
            WHEN ABS(t.date - $2::date) <= 1 THEN 25
            WHEN ABS(t.date - $2::date) <= 3 THEN 20
            WHEN ABS(t.date - $2::date) <= 7 THEN 10
            ELSE 0
          END
        ) AS score
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      WHERE t.is_active = true
        AND t.amount = $1
        AND t.bank_account ILIKE $3
        AND ABS(t.date - $2::date) <= 7
        AND t.id NOT IN (
          SELECT re.transaction_id
          FROM reconciliation_entries re
          WHERE re.transaction_id IS NOT NULL
            AND re.match_status IN ('confirmed', 'manual', 'auto')
        )
      ORDER BY score DESC, ABS(t.date - $2::date) ASC
      LIMIT $4
    `;
    const result = await query(sql, [amount, entryDate, `%${statementBankAccount}%`, limit]);
    return result.rows;
  },
};

export default reconciliationRepository;
