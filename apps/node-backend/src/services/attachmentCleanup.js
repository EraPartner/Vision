/**
 * Best-effort attachment FILE cleanup after transaction hard-deletes.
 *
 * Hard deletes CASCADE the attachments ROWS, but nothing removes the FILES —
 * receipt PII persisted forever on disk and re-entered every backup. Callers
 * collect stored paths before the delete and invoke this after; removal
 * failures are logged and never thrown (same log-only pattern as
 * DELETE /api/attachments/:id — a removal failure must not fail the
 * already-committed transaction delete).
 *
 * Shared by transactionService (single delete) and transactionBulkService
 * (bulk delete).
 */

import { removeAttachmentFile } from './attachmentService.js';
import { logger } from '../config/logger.js';

/**
 * @param {string[]} storedPaths
 * @returns {Promise<void>}
 */
export async function removeAttachmentFilesBestEffort(storedPaths) {
  for (const storedPath of storedPaths) {
    try {
      await removeAttachmentFile(storedPath);
    } catch (err) {
      logger.warn('Attachment file removal failed after transaction delete; file orphaned on disk', {
        storedPath,
        error: err?.message,
      });
    }
  }
}
