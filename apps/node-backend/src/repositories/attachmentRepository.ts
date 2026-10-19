/**
 * Attachment Repository — data access for the `attachments` table.
 *
 * Stores only metadata; file bytes live on disk at stored_path.
 * Callers (route layer / service) are responsible for creating and
 * removing the physical file before/after calling these methods.
 */

import { sql } from 'kysely';
import { asTransactionId } from '@vision/types/brands';
import { checkedRow, checkedRows, db } from '../database/db.ts';
import { countRowSchema } from '../database/rowSchemas.ts';
import {
  attachmentPathRowSchema,
  attachmentRowSchema,
  requireRow,
} from '../database/rows/catalog.ts';

import type { AttachmentRow, FormattedAttachment } from '../types/rows.ts';

export type { FormattedAttachment };

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
    const row = await db
      .selectFrom('transactions')
      .select('id')
      .where('id', '=', asTransactionId(transactionId))
      .executeTakeFirst();
    return row !== undefined;
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
    let builder = db
      .selectFrom('attachments')
      .selectAll()
      .where('transaction_id', '=', asTransactionId(transactionId))
      .orderBy('created_at', 'desc');
    if (limit !== null) builder = builder.limit(limit).offset(offset);
    const rows = await checkedRows(attachmentRowSchema, builder);
    return rows.map(formatRow);
  },

  /**
   * Attachment count for a transaction — the `total` for a paginated list.
   */
  async countByTransaction(transactionId: number): Promise<number> {
    const row = await checkedRow(
      countRowSchema,
      db
        .selectFrom('attachments')
        .select(sql<string>`COUNT(*)`.as('count'))
        .where('transaction_id', '=', asTransactionId(transactionId)),
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
    const rows = await checkedRows(
      attachmentPathRowSchema,
      db
        .selectFrom('attachments')
        .select('stored_path')
        .where(sql<boolean>`transaction_id = ANY(${transactionIds}::int[])`),
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
    transaction_id: number;
    filename: string;
    stored_path: string;
    mime_type: string;
    size_bytes: number;
  }): Promise<FormattedAttachment> {
    const row = await checkedRow(
      attachmentRowSchema,
      db
        .insertInto('attachments')
        .values({
          transaction_id: asTransactionId(transaction_id),
          filename,
          stored_path,
          mime_type,
          size_bytes,
        })
        .returningAll(),
    );
    return formatRow(requireRow(row, 'attachment insert'));
  },

  /**
   * Fetch a single attachment by ID. Returns null if not found.
   */
  async findById(id: number | string): Promise<FormattedAttachment | null> {
    const row = await checkedRow(
      attachmentRowSchema,
      db.selectFrom('attachments').selectAll().where('id', '=', String(id)),
    );
    return row ? formatRow(row) : null;
  },

  /**
   * Delete an attachment row by ID. Returns true if a row was deleted.
   */
  async deleteById(id: number | string): Promise<boolean> {
    const result = await db
      .deleteFrom('attachments')
      .where('id', '=', String(id))
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  },
};

export default attachmentRepository;
