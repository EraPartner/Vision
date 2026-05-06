/**
 * Recipient Bank Account Repository - data access for recipient_bank_accounts table.
 *
 * Mirrors: apps/backend/repositories/recipient_bank_account_repository.py
 *
 * Provides CRUD operations for managing bank accounts linked to recipients.
 */

import { query, withTransaction } from '../database/connection.js';

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
   * Mirrors: RecipientBankAccountService.create_or_get_bank_account
   */
  async createOrGet({ recipientId, accountNumber, bankName = null, address = null, accountLabel = null, setAsPrimary = false }) {
    if (!accountNumber) throw new Error('Account number is required');

    const existing = await this.getByAccountNumber(accountNumber);
    if (existing) {
      // Enrich with missing metadata
      const updates = [];
      const params = [];
      let paramIdx = 1;

      if (bankName && !existing.bank_name) {
        updates.push(`bank_name = $${paramIdx++}`);
        params.push(bankName);
      }
      if (address && existing.address !== address) {
        updates.push(`address = $${paramIdx++}`);
        params.push(address);
      }
      if (accountLabel && !existing.account_label) {
        updates.push(`account_label = $${paramIdx++}`);
        params.push(accountLabel);
      }

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

    // Check if first account for this recipient
    const existingAccounts = await this.getByRecipientId(recipientId);
    const isFirst = existingAccounts.length === 0;

    const result = await query(
      `INSERT INTO recipient_bank_accounts (recipient_id, account_number, bank_name, address, account_label, is_primary, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *`,
      [recipientId, accountNumber.trim().toUpperCase(), bankName, address, accountLabel, setAsPrimary || isFirst]
    );

    const created = result.rows[0];

    // If setting as primary and not first, unset others
    if (created.is_primary && !isFirst) {
      await this.setPrimary(created.id, recipientId);
    }

    return { bankAccount: created, created: true };
  },

  async update(id, { bankName, address, accountLabel }) {
    const updates = [];
    const params = [];
    let paramIdx = 1;

    if (bankName !== undefined) { updates.push(`bank_name = $${paramIdx++}`); params.push(bankName); }
    if (address !== undefined) { updates.push(`address = $${paramIdx++}`); params.push(address); }
    if (accountLabel !== undefined) { updates.push(`account_label = $${paramIdx++}`); params.push(accountLabel); }

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
