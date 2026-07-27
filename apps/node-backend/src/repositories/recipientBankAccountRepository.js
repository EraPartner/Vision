/**
 * Recipient Bank Account Repository - data access for recipient_bank_accounts table.
 *
 *
 * Provides CRUD operations for managing bank accounts linked to recipients.
 */

import { query, withTransaction } from '../database/connection.js';
import { buildSetClauses } from '../lib/sqlClauses.js';

export const recipientBankAccountRepository = {
  async getById(id) {
    const result = await query(
      `SELECT * FROM recipient_bank_accounts WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async getByAccountNumber(accountNumber) {
    if (!accountNumber) return null;
    const result = await query(
      `SELECT * FROM recipient_bank_accounts WHERE account_number = $1`,
      [accountNumber.trim().toUpperCase()]
    );
    return result.rows[0] || null;
  },

  async getByRecipientId(recipientId, activeOnly = true) {
    let sql = `
      SELECT * FROM recipient_bank_accounts
      WHERE recipient_id = $1
    `;
    if (activeOnly) sql += ` AND is_active = true`;
    sql += ` ORDER BY is_primary DESC, created_at ASC`;

    const result = await query(sql, [recipientId]);
    return result.rows;
  },

  async getPrimaryAccount(recipientId) {
    const result = await query(
      `SELECT * FROM recipient_bank_accounts
       WHERE recipient_id = $1 AND is_primary = true AND is_active = true
       LIMIT 1`,
      [recipientId]
    );
    return result.rows[0] || null;
  },

  /**
   * Create or get a bank account, enriching existing accounts with missing metadata.
   */
  async createOrGet({ recipientId, accountNumber, bankName = null, address = null, accountLabel = null, setAsPrimary = false }) {
    if (!accountNumber) throw new Error('Account number is required');

    const existing = await this.getByAccountNumber(accountNumber);
    if (existing) {
      // Enrich with missing metadata. Shared clause builder (lib/sqlClauses.js)
      // skips undefined, so the enrichment conditions map to the field bag.
      const { clauses: updates, params, nextIdx: paramIdx } = buildSetClauses({
        bank_name: bankName && !existing.bank_name ? bankName : undefined,
        address: address && existing.address !== address ? address : undefined,
        account_label: accountLabel && !existing.account_label ? accountLabel : undefined,
      });

      if (updates.length > 0) {
        updates.push(`updated_at = NOW()`);
        params.push(existing.id);
        await query(
          `UPDATE recipient_bank_accounts SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
          params
        );
      }

      if (setAsPrimary && !existing.is_primary) {
        await this.setPrimary(existing.id, existing.recipient_id);
      }

      const refreshed = await this.getById(existing.id);
      return { bankAccount: refreshed, created: false };
    }

    // Check if first account for this recipient — count ALL accounts including
    // soft-deleted ones, so a recipient whose only accounts were deactivated
    // doesn't get a surprise new primary.
    const existingAccounts = await this.getByRecipientId(recipientId, false);
    const isFirst = existingAccounts.length === 0;
    const willBePrimary = setAsPrimary || isFirst;

    // Unset the current primary and insert the new one in a single
    // transaction — doing the insert-as-primary then a separate setPrimary()
    // left a brief window where the recipient had two primary accounts.
    const created = await withTransaction(async (client) => {
      if (willBePrimary) {
        await client.query(
          `UPDATE recipient_bank_accounts SET is_primary = false, updated_at = NOW()
           WHERE recipient_id = $1 AND is_primary = true`,
          [recipientId]
        );
      }
      const result = await client.query(
        `INSERT INTO recipient_bank_accounts (recipient_id, account_number, bank_name, address, account_label, is_primary, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *`,
        [recipientId, accountNumber.trim().toUpperCase(), bankName, address, accountLabel, willBePrimary]
      );
      return result.rows[0];
    });

    return { bankAccount: created, created: true };
  },

  async update(id, { bankName, address, accountLabel }) {
    // Shared clause builder (lib/sqlClauses.js): undefined fields are skipped.
    const { clauses: updates, params, nextIdx: paramIdx } = buildSetClauses({
      bank_name: bankName, address, account_label: accountLabel,
    });

    if (updates.length === 0) return this.getById(id);

    updates.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE recipient_bank_accounts SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] || null;
  },

  async softDelete(id) {
    const result = await query(
      `UPDATE recipient_bank_accounts SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id]
    );
    return result.rowCount > 0;
  },

  /**
   * Recipient merge: drop alias bank accounts that would collide with one the
   * primary already owns on uq_rba_account_number (migration 0029). The
   * primary's row is kept and the alias's deleted, rather than reassigned.
   * Must run BEFORE repointRecipient().
   */
  async deleteMergeDuplicates(primaryId, aliasIds) {
    const result = await query(
      `DELETE FROM recipient_bank_accounts rba
        USING recipient_bank_accounts keep
        WHERE rba.recipient_id = ANY($2::int[])
          AND keep.recipient_id = $1
          AND keep.account_number = rba.account_number`,
      [primaryId, aliasIds],
    );
    return result.rowCount ?? 0;
  },

  /** Repoint surviving alias bank accounts onto the merge primary. */
  async repointRecipient(primaryId, aliasIds) {
    const result = await query(
      `UPDATE recipient_bank_accounts
          SET recipient_id = $1
        WHERE recipient_id = ANY($2::int[])`,
      [primaryId, aliasIds],
    );
    return result.rowCount ?? 0;
  },

  async setPrimary(bankAccountId, recipientId) {
    return withTransaction(async (client) => {
      await client.query(
        `UPDATE recipient_bank_accounts SET is_primary = false, updated_at = NOW()
         WHERE recipient_id = $1 AND is_primary = true`,
        [recipientId]
      );
      const result = await client.query(
        `UPDATE recipient_bank_accounts SET is_primary = true, updated_at = NOW()
         WHERE id = $1 AND recipient_id = $2 RETURNING *`,
        [bankAccountId, recipientId]
      );
      return result.rowCount > 0;
    });
  },
};

export default recipientBankAccountRepository;
