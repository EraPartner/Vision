/**
 * Attachment Service — file storage operations for receipt uploads.
 *
 * Files are stored at:
 *   {ATTACHMENTS_DIR}/{transaction_id}/{uuid}.{ext}
 *
 * Directory is created on demand (mkdirSync recursive) so no boot-time
 * setup is required.
 *
 * Multer uses memoryStorage so the service controls the final path.
 */

import { mkdirSync, promises as fsPromises } from 'fs';
import { join, extname, resolve } from 'path';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { env } from '../config/env.js';

const ALLOWED_MIME_PREFIXES = ['image/', 'application/pdf'];
const MAX_SIZE_BYTES = env.ATTACHMENT_MAX_SIZE_MB * 1024 * 1024;

/** Absolute path to the attachment root directory. */
export function getAttachmentsRoot() {
  return resolve(env.ATTACHMENTS_DIR);
}

/** Absolute path to the per-transaction directory. */
export function getTransactionDir(transactionId) {
  return join(getAttachmentsRoot(), String(transactionId));
}

function isAllowedMime(mimeType) {
  return ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

/** Multer instance configured with in-memory storage + MIME / size guards. */
export const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!isAllowedMime(file.mimetype)) {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: images and PDF.`));
    } else {
      cb(null, true);
    }
  },
});

/**
 * Write an uploaded file (multer memoryStorage buffer) to disk.
 *
 * Returns the stored_path (relative to ATTACHMENTS_DIR root, forward
 * slashes) for persistence in the DB. Callers store this path and pass
 * it back to resolveAbsolutePath() to serve the file later.
 */
export async function storeAttachment(transactionId, file) {
  const ext = extname(file.originalname).toLowerCase() || '';
  const uuid = randomUUID();
  const filename = `${uuid}${ext}`;
  const dir = getTransactionDir(transactionId);

  mkdirSync(dir, { recursive: true });

  const absPath = join(dir, filename);
  await fsPromises.writeFile(absPath, file.buffer);

  // relative path stored in DB  e.g. "123/abc.pdf"
  return `${transactionId}/${filename}`;
}

/**
 * Resolve a DB-stored relative path back to an absolute filesystem path.
 */
export function resolveAbsolutePath(storedPath) {
  return join(getAttachmentsRoot(), storedPath);
}

/**
 * Delete a file from disk. Silently ignores ENOENT (already gone).
 */
export async function removeAttachmentFile(storedPath) {
  const absPath = resolveAbsolutePath(storedPath);
  try {
    await fsPromises.unlink(absPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
