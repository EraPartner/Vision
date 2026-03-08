/**
 * Recipient Repository - data access for recipients table.
 *
 * Mirrors: apps/backend/repositories/recipient_repository.py
 */

import { query } from '../database/connection.js';

export const recipientRepository = {
  async getAll({ limit = 50, offset = 0, name = null, defaultCategoryId = null, search = null, active = true } = {}) {
    let sql = `
      SELECT r.*,
             CASE WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail ELSE NULL END AS default_category_name,
             (SELECT rba.account_number FROM recipient_bank_accounts rba
              WHERE rba.recipient_id = r.id AND rba.is_active = true
              ORDER BY rba.is_primary DESC LIMIT 1) AS primary_bank_account,
             pr.name AS primary_recipient_name,
             (SELECT count(*) FROM recipients alias WHERE alias.primary_recipient_id = r.id) AS alias_count
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (active) sql += ` AND r.is_active = true`;
    if (name) { sql += ` AND r.name ILIKE $${paramIdx++}`; params.push(`%${name}%`); }
    if (defaultCategoryId != null) { sql += ` AND r.default_category_id = $${paramIdx++}`; params.push(defaultCategoryId); }
    if (search) {
      const sp = `%${search}%`;
      sql += ` AND (
        r.name ILIKE $${paramIdx} OR
        r.notes ILIKE $${paramIdx} OR
        c.general ILIKE $${paramIdx} OR
        c.detail ILIKE $${paramIdx} OR
        EXISTS (SELECT 1 FROM recipient_bank_accounts rba WHERE rba.recipient_id = r.id AND rba.account_number ILIKE $${paramIdx})
      )`;
      paramIdx++;
      params.push(sp);
    }

    sql += ` ORDER BY r.name LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows;
  },

  async getCount({ name = null, defaultCategoryId = null, search = null, active = true } = {}) {
    let sql = `
      SELECT count(*) FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (active) sql += ` AND r.is_active = true`;
    if (name) { sql += ` AND r.name ILIKE $${paramIdx++}`; params.push(`%${name}%`); }
    if (defaultCategoryId != null) { sql += ` AND r.default_category_id = $${paramIdx++}`; params.push(defaultCategoryId); }
    if (search) {
      const sp = `%${search}%`;
      sql += ` AND (
        r.name ILIKE $${paramIdx} OR
        r.notes ILIKE $${paramIdx} OR
        c.general ILIKE $${paramIdx} OR
        c.detail ILIKE $${paramIdx} OR
        EXISTS (SELECT 1 FROM recipient_bank_accounts rba WHERE rba.recipient_id = r.id AND rba.account_number ILIKE $${paramIdx})
      )`;
      paramIdx++;
      params.push(sp);
    }

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  async getById(id) {
    const sql = `
      SELECT r.*,
             CASE WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail ELSE NULL END AS default_category_name,
             (SELECT rba.account_number FROM recipient_bank_accounts rba
              WHERE rba.recipient_id = r.id AND rba.is_active = true
              ORDER BY rba.is_primary DESC LIMIT 1) AS primary_bank_account,
             pr.name AS primary_recipient_name,
             (SELECT count(*) FROM recipients alias WHERE alias.primary_recipient_id = r.id) AS alias_count
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE r.id = $1
    `;
    const result = await query(sql, [id]);
    return result.rows[0] || null;
  },

  async getByName(name) {
    const normalized = name.toUpperCase().trim().replace(/\s+/g, ' ');
    const result = await query(
      `SELECT * FROM recipients WHERE normalized_name = $1`,
      [normalized]
    );
    return result.rows[0] || null;
  },

  async createOrGet({ name }) {
    const upperName = name.toUpperCase().trim();
    const normalizedName = upperName.replace(/\s+/g, ' ');

    const existing = await this.getByName(name);
    if (existing) {
      const full = await this.getById(existing.id);
      return { recipient: full, created: false };
    }

    const result = await query(
      `INSERT INTO recipients (name, normalized_name, is_active) VALUES ($1, $2, true) RETURNING *`,
      [upperName, normalizedName]
    );
    const full = await this.getById(result.rows[0].id);
    return { recipient: full, created: true };
  },

  async update(id, { name, default_category_id, notes, is_active }) {
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    if (name !== undefined && name !== null) {
      const upperName = name.toUpperCase().trim();
      setClauses.push(`name = $${paramIdx++}`);
      params.push(upperName);
      setClauses.push(`normalized_name = $${paramIdx++}`);
      params.push(upperName.replace(/\s+/g, ' '));
    }
    if (default_category_id !== undefined) { setClauses.push(`default_category_id = $${paramIdx++}`); params.push(default_category_id); }
    if (notes !== undefined) { setClauses.push(`notes = $${paramIdx++}`); params.push(notes); }
    if (is_active !== undefined && is_active !== null) { setClauses.push(`is_active = $${paramIdx++}`); params.push(is_active); }

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE recipients SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
    const result = await query(sql, params);
    if (result.rows.length === 0) return null;
    return this.getById(id);
  },

  async hardDelete(id) {
    const result = await query('DELETE FROM recipients WHERE id = $1', [id]);
    return result.rowCount > 0;
  },

  /**
   * Merge: set primary_recipient_id on alias recipients pointing to a primary.
   * @param {number} primaryId - The primary recipient ID
   * @param {number[]} aliasIds - Array of recipient IDs to merge into the primary
   */
  async mergeRecipients(primaryId, aliasIds) {
    if (!aliasIds.length) return [];
    const placeholders = aliasIds.map((_, i) => `$${i + 2}`).join(',');
    const sql = `UPDATE recipients SET primary_recipient_id = $1, updated_at = NOW() WHERE id IN (${placeholders}) AND id != $1 RETURNING id`;
    const result = await query(sql, [primaryId, ...aliasIds]);
    return result.rows.map(r => r.id);
  },

  /**
   * Unmerge: remove primary_recipient_id from a recipient.
   */
  async unmergeRecipient(id) {
    const sql = `UPDATE recipients SET primary_recipient_id = NULL, updated_at = NOW() WHERE id = $1 RETURNING id`;
    const result = await query(sql, [id]);
    return result.rows.length > 0;
  },

  /**
   * Get all aliases for a primary recipient.
   */
  async getAliases(primaryId) {
    const sql = `
      SELECT r.*, 
             CASE WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail ELSE NULL END AS default_category_name
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      WHERE r.primary_recipient_id = $1
      ORDER BY r.name
    `;
    const result = await query(sql, [primaryId]);
    return result.rows;
  },
};

export default recipientRepository;
