/**
 * Attachment Service — file storage operations for receipt uploads.
 *
 * Files are stored at:
 *   {ATTACHMENTS_DIR}/{transaction_id}/{uuid}.{ext}
 *
 * Directory is created on demand (mkdirSync recursive) so no boot-time
 * setup is required.
 *
 * Upload middleware uses memoryStorage so the service receives a buffer and
 * controls the final path.
 */

/// <reference path="../types/thirdPartyModules.d.ts" />
import { mkdirSync, promises as fsPromises } from 'fs';
import { join, extname, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { env } from '../config/env.js';
import { sniffMime, extensionMime } from '../lib/fileSniff.js';

/**
 * The slice of a multer memoryStorage upload this service reads.
 * @typedef {{ originalname: string, buffer: Buffer, mimetype: string }} MulterFile
 */

const ALLOWED_MIME_PREFIXES = ['image/', 'application/pdf'];
export const ATTACHMENT_MAX_SIZE_BYTES = env.ATTACHMENT_MAX_SIZE_MB * 1024 * 1024;

/** Absolute path to the attachment root directory. */
function getAttachmentsRoot() {
  return resolve(env.ATTACHMENTS_DIR);
}

/**
 * Absolute path to the per-transaction directory.
 * @param {number|string} transactionId
 */
function getTransactionDir(transactionId) {
  return join(getAttachmentsRoot(), String(transactionId));
}

/** @param {string} mimeType */
export function isAllowedAttachmentMime(mimeType) {
  return ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

/**
 * Verify uploaded buffer matches the claimed extension via magic bytes.
 *
 * Returns the canonical sniffed MIME type when valid; throws otherwise.
 * The sniffed value should be persisted to the DB instead of the
 * client-supplied req.file.mimetype.
 * @param {MulterFile} file
 * @returns {string} canonical sniffed MIME type
 */
export function verifyAttachmentContent(file) {
  const sniffed = sniffMime(file.buffer);
  if (!sniffed) {
    throw new Error('Unsupported or unrecognised file content. Allowed: PNG, JPEG, GIF, WEBP, PDF.');
  }
  if (!isAllowedAttachmentMime(sniffed)) {
    throw new Error(`Unsupported file type: ${sniffed}. Allowed: images and PDF.`);
  }
  const ext = extname(file.originalname).toLowerCase();
  const expected = extensionMime(ext);
  // An unrecognized extension is a mismatch, not a free pass — otherwise a
  // valid PNG named x.exe skipped this check and stored as uuid.exe. A missing
  // extension stays allowed (nothing misleading is stored).
  if (ext && !expected) {
    throw new Error(`Unsupported file extension ${ext}. Allowed: .png, .jpg, .jpeg, .gif, .webp, .pdf.`);
  }
  if (expected && expected !== sniffed) {
    throw new Error(`File extension ${ext} does not match content (${sniffed}).`);
  }
  return sniffed;
}

/**
 * Write an uploaded file (multer memoryStorage buffer) to disk.
 *
 * Returns the stored_path (relative to ATTACHMENTS_DIR root, forward
 * slashes) for persistence in the DB. Callers store this path and pass
 * it back to resolveAbsolutePath() to serve the file later.
 * @param {number|string} transactionId
 * @param {MulterFile} file
 * @returns {Promise<string>} stored_path relative to the attachments root
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
 * Throws if the resolved path escapes the attachments root (path traversal guard).
 * Uses realpath to resolve symlinks so a symlinked path cannot escape the root.
 * @param {string} storedPath
 * @returns {Promise<string>}
 */
export async function resolveAbsolutePath(storedPath) {
  const root = getAttachmentsRoot();
  const absolute = resolve(root, storedPath);
  // Fast path-based check catches .. traversal without I/O
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error('Invalid attachment path: outside attachments root');
  }
  // Resolve symlinks — ENOENT is fine (file not yet written or already deleted)
  const real = await fsPromises.realpath(absolute).catch((err) => {
    if (err.code === 'ENOENT') return absolute;
    throw err;
  });
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error('Invalid attachment path: outside attachments root');
  }
  return real;
}

/**
 * Delete a file from disk. Silently ignores ENOENT (already gone).
 * @param {string} storedPath
 */
export async function removeAttachmentFile(storedPath) {
  const absPath = await resolveAbsolutePath(storedPath);
  try {
    await fsPromises.unlink(absPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
