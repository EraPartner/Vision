/**
 * Attachment Repository — data access for the `attachments` table.
 *
 * Stores only metadata; file bytes live on disk at stored_path.
 * Callers (route layer / service) are responsible for creating and
 * removing the physical file before/after calling these methods.
 */

import { query } from '../database/connection.js';

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
   * List all attachments for a transaction, newest first.
   */
  async listByTransaction(transactionId) {
    const sql = `
      SELECT * FROM attachments
      WHERE transaction_id = $1
      ORDER BY created_at DESC
    `;
    const result = await query(sql, [transactionId]);
    return result.rows.map(formatRow);
  },

  /**
   * Insert a new attachment row. Returns the created row.
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
   */
  async findById(id) {
    const result = await query('SELECT * FROM attachments WHERE id = $1', [id]);
    return result.rows[0] ? formatRow(result.rows[0]) : null;
  },

  /**
   * Delete an attachment row by ID. Returns true if a row was deleted.
   */
  async deleteById(id) {
    const result = await query('DELETE FROM attachments WHERE id = $1', [id]);
    return result.rowCount > 0;
  },
};

export default attachmentRepository;
