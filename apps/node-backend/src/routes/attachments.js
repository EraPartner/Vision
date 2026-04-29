/**
 * Attachment routes — receipt and document uploads for transactions.
 *
 * POST   /api/attachments/transaction/:id   upload a file
 * GET    /api/transactions/:id/attachments  list attachments for a transaction
 * GET    /api/attachments/:id/download      serve the file
 * DELETE /api/attachments/:id              delete a file + its DB row
 */

import { Router } from 'express';
import multer from 'multer';
// eslint-disable-next-line vision-local/no-repo-direct-from-route
import { attachmentRepository } from '../repositories/attachmentRepository.js';
import {
  attachmentUpload,
  storeAttachment,
  resolveAbsolutePath,
  removeAttachmentFile,
  verifyAttachmentContent,
} from '../services/attachmentService.js';
import { validateIdParam } from '../middleware/validation.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { query } from '../database/connection.js';

const router = Router();

// ── Upload ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/attachments/transaction/:id
 * Body: multipart/form-data, field "file"
 */
router.post(
  '/transaction/:id',
  validateIdParam,
  (req, res, next) => {
    attachmentUpload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return next(new ValidationError(`Upload error: ${err.message}`));
      }
      if (err) {
        return next(new ValidationError(err.message));
      }
      next();
    });
  },
  async (req, res) => {
    const transactionId = parseInt(req.params.id, 10);

    if (!req.file) {
      throw new ValidationError('No file uploaded. Send a file as multipart/form-data with field name "file".');
    }

    let sniffedMime;
    try {
      sniffedMime = verifyAttachmentContent(req.file);
    } catch (err) {
      throw new ValidationError(err.message);
    }

    const txResult = await query('SELECT id FROM transactions WHERE id = $1', [transactionId]);
    if (txResult.rows.length === 0) {
      throw new NotFoundError('Transaction not found');
    }

    const storedPath = await storeAttachment(transactionId, req.file);

    const attachment = await attachmentRepository.create({
      transaction_id: transactionId,
      filename: req.file.originalname,
      stored_path: storedPath,
      mime_type: sniffedMime,
      size_bytes: req.file.size,
    });

    res.status(201);
    res.ok(attachment);
  },
);

// ── List ───────────────────────────────────────────────────────────────────────

/**
 * GET /api/attachments/transaction/:id
 * List all attachments for a transaction.
 */
router.get('/transaction/:id', validateIdParam, async (req, res) => {
  const transactionId = parseInt(req.params.id, 10);
  const attachments = await attachmentRepository.listByTransaction(transactionId);
  res.ok({ items: attachments, total: attachments.length });
});

// ── Download ───────────────────────────────────────────────────────────────────

/**
 * GET /api/attachments/:id/download
 * Stream the file to the client. Envelope (ADR-026) does not apply here —
 * the response is the raw file bytes with Content-Disposition: inline.
 */
router.get('/:id/download', validateIdParam, async (req, res) => {
  const attachment = await attachmentRepository.findById(parseInt(req.params.id, 10));
  if (!attachment) throw new NotFoundError('Attachment not found');

  const absPath = resolveAbsolutePath(attachment.stored_path);
  const asciiFallback = attachment.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8Encoded = encodeURIComponent(attachment.filename);
  res.setHeader('Content-Type', attachment.mime_type);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
  );
  res.sendFile(absPath);
});

// ── Delete ─────────────────────────────────────────────────────────────────────

/**
 * DELETE /api/attachments/:id
 */
router.delete('/:id', validateIdParam, async (req, res) => {
  const attachment = await attachmentRepository.findById(parseInt(req.params.id, 10));
  if (!attachment) throw new NotFoundError('Attachment not found');

  await removeAttachmentFile(attachment.stored_path);
  await attachmentRepository.deleteById(attachment.id);

  res.ok({ deleted: true });
});

export default router;
