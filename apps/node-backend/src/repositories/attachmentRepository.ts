/**
 * Attachment Repository — data access for the `attachments` table.
 *
 * Stores only metadata; file bytes live on disk at stored_path.
 * Callers (route layer / service) are responsible for creating and
 * removing the physical file before/after calling these methods.
 */

import { query } from '../database/connection.ts';
import { queryOne, queryRows } from '../database/rowContracts.ts';
import { countRowSchema } from '../database/rowSchemas.ts';
import {
  attachmentPathRowSchema,
  attachmentRowSchema,
  requireRow,
} from '../database/rows/catalog.ts';
import { buildLimitOffset } from '../lib/sqlClauses.ts';

import type { AttachmentRow, FormattedAttachment } from '../types/rows.ts';

export type { AttachmentRow, FormattedAttachment };

function formatRow(row: AttachmentRow): FormattedAttachment {
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
   */
  async transactionExists(transactionId: number): Promise<boolean> {
    const result = await query('SELECT id FROM transactions WHERE id = $1', [transactionId]);
    return result.rows.length > 0;
  },

  /**
   * List attachments for a transaction, newest first. `limit` is optional and
   * defaults to unbounded — the attachment strip renders every file on the
   * transaction, so only an explicit limit/offset narrows the result.
   */
  async listByTransaction(
    transactionId: number,
    {
      limit = null,
      offset = 0,
    }: { limit?: number | null; offset?: number } = {},
  ): Promise<FormattedAttachment[]> {
    const params: unknown[] = [transactionId];
    const sql = `
      SELECT * FROM attachments
      WHERE transaction_id = $1
      ORDER BY created_at DESC
    ` + buildLimitOffset(params, { limit, offset });
    const rows = await queryRows(attachmentRowSchema, sql, params);
    return rows.map(formatRow);
  },

  /**
   * Attachment count for a transaction — the `total` for a paginated list.
   */
  async countByTransaction(transactionId: number): Promise<number> {
    const row = await queryOne(
      countRowSchema,
      'SELECT COUNT(*) FROM attachments WHERE transaction_id = $1',
      [transactionId],
    );
    return parseInt(requireRow(row, 'attachment count').count, 10);
  },

  /**
   * List stored file paths for a set of transactions. Used before a hard
   * delete so the DB CASCADE (which only removes the rows) can be followed
   * by best-effort file removal.
   */
  async listPathsByTransactionIds(transactionIds: number[]): Promise<string[]> {
    if (!Array.isArray(transactionIds) || transactionIds.length === 0) return [];
    const rows = await queryRows(
      attachmentPathRowSchema,
      'SELECT stored_path FROM attachments WHERE transaction_id = ANY($1::int[])',
      [transactionIds],
    );
    return rows.map((row) => row.stored_path);
  },

  /**
   * Insert a new attachment row. Returns the created row.
   */
  async create({
    transaction_id,
    filename,
    stored_path,
    mime_type,
    size_bytes,
  }: {
    transaction_id: number | string;
    filename: string;
    stored_path: string;
    mime_type: string;
    size_bytes: number;
  }): Promise<FormattedAttachment> {
    const sql = `
      INSERT INTO attachments (transaction_id, filename, stored_path, mime_type, size_bytes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const row = await queryOne(attachmentRowSchema, sql, [
      transaction_id,
      filename,
      stored_path,
      mime_type,
      size_bytes,
    ]);
    return formatRow(requireRow(row, 'attachment insert'));
  },

  /**
   * Fetch a single attachment by ID. Returns null if not found.
   */
  async findById(id: number | string): Promise<FormattedAttachment | null> {
    const row = await queryOne(attachmentRowSchema, 'SELECT * FROM attachments WHERE id = $1', [id]);
    return row ? formatRow(row) : null;
  },

  /**
   * Delete an attachment row by ID. Returns true if a row was deleted.
   */
  async deleteById(id: number | string): Promise<boolean> {
    const result = await query('DELETE FROM attachments WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  },
};

export default attachmentRepository;
