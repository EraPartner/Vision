/**
 * Shared multipart CSV upload plumbing for the import routers (bank-statement
 * and portfolio). Multer writes to os.tmpdir() with a generated alphanumeric
 * name; cleanup() rebuilds the path from a constant tmpdir + a strict-allowlist
 * basename so a tampered req.file.path can't escape tmp or taint the unlink.
 */

import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../config/logger.js';
import { ValidationError } from '../middleware/errorHandler.js';

/**
 * The slice of a multer `File` this module reads. `multer` ships no type
 * declarations and `@types/multer` is not a workspace dependency, so this is
 * a local structural stand-in rather than `import('multer').File` (same
 * reasoning as the ambient `declare module 'multer'` in
 * thirdPartyModules.d.ts, which only silences the VALUE import above — it
 * does not give the resulting `multer` binding's members any real shape).
 * @typedef {object} MulterFile
 * @property {string} [originalname]
 * @property {string} [mimetype]
 */

/**
 * @param {MulterFile|null|undefined} file
 * @returns {boolean}
 */
export function isLikelyCsvFile(file) {
  const originalName = file?.originalname?.toLowerCase() || '';
  const mimeType = file?.mimetype?.toLowerCase() || '';
  const hasCsvExtension = originalName.endsWith('.csv');
  const hasLikelyCsvMimeType = mimeType.includes('csv')
    || mimeType.includes('text/plain')
    || mimeType.includes('application/vnd.ms-excel')
    || mimeType === 'application/octet-stream'
    || mimeType === '';
  return hasCsvExtension && hasLikelyCsvMimeType;
}

export const csvUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (/** @type {unknown} */ req, /** @type {MulterFile} */ file, /** @type {(err: Error|null, acceptFile?: boolean) => void} */ cb) => {
    if (!isLikelyCsvFile(file)) {
      cb(new Error('File must be a CSV'));
    } else {
      cb(null, true);
    }
  },
});

const SAFE_BASENAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * @param {string|null|undefined} filePath
 */
export function cleanup(filePath) {
  if (!filePath) return;
  const basename = path.basename(filePath);
  if (!SAFE_BASENAME_RE.test(basename)) return;
  const target = path.join(os.tmpdir(), basename);
  void fs.promises.unlink(target).catch((err) => {
    if (err && err.code !== 'ENOENT') {
      logger.warn('Failed to clean up uploaded CSV temp file', { path: target, error: err.message });
    }
  });
}

/**
 * Express error middleware that converts multer's upload errors into typed
 * ValidationErrors so the global handler emits the standard envelope. Mount at
 * the end of any router that uses csvUpload.
 */
/**
 * @param {any} err arbitrary upstream error shape — multer errors, thrown
 *   Errors, and anything else the router's error chain can hand this
 *   middleware; narrowed by `instanceof`/`.message` checks below.
 * @param {unknown} req
 * @param {unknown} res
 * @param {(err?: unknown) => void} next
 */
export function csvUploadErrorTranslator(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new ValidationError('File size exceeds maximum of 50MB'));
    }
    return next(new ValidationError(`Upload error: ${err.message}`));
  }
  if (err.message === 'File must be a CSV') {
    return next(new ValidationError('File must be a CSV'));
  }
  next(err);
}
