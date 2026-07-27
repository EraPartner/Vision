/**
 * Attachment Repository — data access for the `attachments` table.
 *
 * Stores only metadata; file bytes live on disk at stored_path.
 * Callers (route layer / service) are responsible for creating and
 * removing the physical file before/after calling these methods.
 */

import { query } from '../database/connection.js';
import { buildLimitOffset } from '../lib/sqlClauses.js';

/** @typedef {import('../types/rows.js').AttachmentRow} AttachmentRow */
/** @typedef {import('../types/rows.js').FormattedAttachment} FormattedAttachment */

/**
 * @param {AttachmentRow} row
 * @returns {FormattedAttachment}
 */
function formatRow(row) {
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    filename: row.filename,
    stored_path: row.stored_path,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    created_at: row.created_at,
  };
}

export const attachmentRepository = {
  /**
   * Whether the parent transaction row exists. Upload guard — checked before
   * the file is written to disk so a bad id 404s instead of orphaning a file.
   * @param {number} transactionId
   * @returns {Promise<boolean>}
   */
  async transactionExists(transactionId) {
    const result = await query('SELECT id FROM transactions WHERE id = $1', [transactionId]);
    return result.rows.length > 0;
  },

  /**
   * List attachments for a transaction, newest first. `limit` is optional and
   * defaults to unbounded — the attachment strip renders every file on the
   * transaction, so only an explicit limit/offset narrows the result.
   *
   * @param {number} transactionId
   * @param {{ limit?: number|null, offset?: number }} [page]
   * @returns {Promise<FormattedAttachment[]>}
   */
  async listByTransaction(transactionId, { limit = null, offset = 0 } = {}) {
    const params = [transactionId];
    const sql = `
      SELECT * FROM attachments
      WHERE transaction_id = $1
      ORDER BY created_at DESC
    ` + buildLimitOffset(params, { limit, offset });
    const result = await query(sql, params);
    return result.rows.map(formatRow);
  },

  /**
   * Attachment count for a transaction — the `total` for a paginated list.
   * @param {number} transactionId
   * @returns {Promise<number>}
   */
  async countByTransaction(transactionId) {
    const result = await query(
      'SELECT COUNT(*) FROM attachments WHERE transaction_id = $1',
      [transactionId],
    );
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * List stored file paths for a set of transactions. Used before a hard
   * delete so the DB CASCADE (which only removes the rows) can be followed
   * by best-effort file removal.
   * @param {number[]} transactionIds
   * @returns {Promise<string[]>}
   */
  async listPathsByTransactionIds(transactionIds) {
    if (!Array.isArray(transactionIds) || transactionIds.length === 0) return [];
    const result = await query(
      'SELECT stored_path FROM attachments WHERE transaction_id = ANY($1::int[])',
      [transactionIds],
    );
    return result.rows.map((/** @type {{ stored_path: string }} */ row) => row.stored_path);
  },

  /**
   * Insert a new attachment row. Returns the created row.
   * @param {{
   *   transaction_id: number|string,
   *   filename: string,
   *   stored_path: string,
   *   mime_type: string,
   *   size_bytes: number,
   * }} input
   * @returns {Promise<FormattedAttachment>}
   */
  async create({ transaction_id, filename, stored_path, mime_type, size_bytes }) {
    const sql = `
      INSERT INTO attachments (transaction_id, filename, stored_path, mime_type, size_bytes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const result = await query(sql, [
      transaction_id,
      filename,
      stored_path,
      mime_type,
      size_bytes,
    ]);
    return formatRow(result.rows[0]);
  },

  /**
   * Fetch a single attachment by ID. Returns null if not found.
   * @param {number|string} id
   * @returns {Promise<FormattedAttachment|null>}
   */
  async findById(id) {
    const result = await query('SELECT * FROM attachments WHERE id = $1', [id]);
    return result.rows[0] ? formatRow(result.rows[0]) : null;
  },

  /**
   * Delete an attachment row by ID. Returns true if a row was deleted.
   * @param {number|string} id
   * @returns {Promise<boolean>}
   */
  async deleteById(id) {
    const result = await query('DELETE FROM attachments WHERE id = $1', [id]);
    return result.rowCount > 0;
  },
};

export default attachmentRepository;
