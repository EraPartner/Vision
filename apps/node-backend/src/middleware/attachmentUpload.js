/**
 * Multipart upload middleware for transaction attachments.
 *
 * Multer is an HTTP transport concern. The attachment service owns content
 * verification and persistence after this middleware has produced a buffer.
 */

/// <reference path="../types/thirdPartyModules.d.ts" />
import multer from 'multer';
import {
  ATTACHMENT_MAX_SIZE_BYTES,
  isAllowedAttachmentMime,
} from '../services/attachmentService.js';

/**
 * The slice of a multer upload used by the declaration-only MIME filter.
 * @typedef {{ mimetype: string }} MulterFile
 */

export const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_MAX_SIZE_BYTES },
  fileFilter: (
    /** @type {unknown} */ _req,
    /** @type {MulterFile} */ file,
    /** @type {(error: Error|null, acceptFile?: boolean) => void} */ cb,
  ) => {
    if (!isAllowedAttachmentMime(file.mimetype)) {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: images and PDF.`));
    } else {
      cb(null, true);
    }
  },
});
