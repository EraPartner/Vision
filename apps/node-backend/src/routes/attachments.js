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
import { attachmentRepository } from '../services/attachmentRecordService.js';
import {
  attachmentUpload,
  storeAttachment,
  resolveAbsolutePath,
  removeAttachmentFile,
  verifyAttachmentContent,
} from '../services/attachmentService.js';
import { validateIdParam } from '../middleware/validation.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { listBody, parseOptionalPagination } from '../lib/pagination.js';
import { logger } from '../config/logger.js';

const router = Router();

// ── Upload ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/attachments/transaction/:id
 * Body: multipart/form-data, field "file"
 */
// codeql[js/missing-rate-limiting]: attachmentRateLimiter (60 req/min) is
// applied to this whole router via mountRouter('/api/attachments',
// attachmentRateLimiter, ...) in main.js. The scanner does not trace rate
// limiting middleware bound at the router-mount level in a different file.
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

    const txExists = await attachmentRepository.transactionExists(transactionId);
    if (!txExists) {
      throw new NotFoundError('Transaction not found');
    }

    const storedPath = await storeAttachment(transactionId, req.file);

    // The existence check above races a concurrent hard delete — if the insert
    // fails (FK gone, DB error) the stored file would sit on disk with no row
    // pointing at it. Clean it up before rethrowing.
    let attachment;
    try {
      attachment = await attachmentRepository.create({
        transaction_id: transactionId,
        filename: req.file.originalname,
        stored_path: storedPath,
        mime_type: sniffedMime,
        size_bytes: req.file.size,
      });
    } catch (err) {
      try {
        await removeAttachmentFile(storedPath);
      } catch (cleanupErr) {
        logger.warn('Attachment cleanup after failed insert also failed; file orphaned on disk', {
          transactionId,
          storedPath,
          error: cleanupErr?.message,
        });
      }
      throw err;
    }

    res.status(201);
    res.ok(attachment);
  },
);

// ── List ───────────────────────────────────────────────────────────────────────

/**
 * GET /api/attachments/transaction/:id
 * List attachments for a transaction. Pagination is opt-in: without
 * limit/offset every attachment is returned, as before.
 */
router.get('/transaction/:id', validateIdParam, async (req, res) => {
  const transactionId = parseInt(req.params.id, 10);
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const attachments = await attachmentRepository.listByTransaction(transactionId, page ?? {});
  const total = page
    ? await attachmentRepository.countByTransaction(transactionId)
    : attachments.length;
  res.ok(listBody(attachments, total, page));
});

// ── Download ───────────────────────────────────────────────────────────────────

/**
 * GET /api/attachments/:id/download
 * Stream the file to the client. Envelope (ADR-026) does not apply here —
 * the response is the raw file bytes with Content-Disposition: inline.
 */
// codeql[js/missing-rate-limiting]: attachmentRateLimiter (60 req/min) is
// applied to this whole router via mountRouter('/api/attachments',
// attachmentRateLimiter, ...) in main.js. The scanner does not trace rate
// limiting middleware bound at the router-mount level in a different file.
router.get('/:id/download', validateIdParam, async (req, res, next) => {
  const attachment = await attachmentRepository.findById(parseInt(req.params.id, 10));
  if (!attachment) throw new NotFoundError('Attachment not found');

  const absPath = await resolveAbsolutePath(attachment.stored_path);
  const asciiFallback = attachment.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8Encoded = encodeURIComponent(attachment.filename);
  res.setHeader('Content-Type', attachment.mime_type);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
  );
  // Pass a callback so a file that's missing on disk (DB row exists, bytes
  // gone) becomes a clean 404 instead of a raw ENOENT 500.
  res.sendFile(absPath, (err) => {
    if (!err) return;
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err.code === 'ENOENT' || err.status === 404) {
      next(new NotFoundError('Attachment file not found'));
    } else {
      next(err);
    }
  });
});

// ── Delete ─────────────────────────────────────────────────────────────────────

/**
 * DELETE /api/attachments/:id
 */
// codeql[js/missing-rate-limiting]: attachmentRateLimiter (60 req/min) is
// applied to this whole router via mountRouter('/api/attachments',
// attachmentRateLimiter, ...) in main.js. The scanner does not trace rate
// limiting middleware bound at the router-mount level in a different file.
router.delete('/:id', validateIdParam, async (req, res) => {
  const attachment = await attachmentRepository.findById(parseInt(req.params.id, 10));
  if (!attachment) throw new NotFoundError('Attachment not found');

  // Delete DB row first — if that fails the file is still present and recoverable.
  // Deleting the file first risks orphaning it if the DB delete subsequently fails.
  await attachmentRepository.deleteById(attachment.id);
  // The row is already gone; a file-removal failure must not 500 the request
  // (retrying can't help — there's no row left to retry from). Log the orphan
  // for out-of-band cleanup and still report success to the caller.
  try {
    await removeAttachmentFile(attachment.stored_path);
  } catch (err) {
    logger.warn('Attachment file removal failed; file orphaned on disk', {
      attachmentId: attachment.id,
      storedPath: attachment.stored_path,
      error: err?.message,
    });
  }

  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

export default router;
