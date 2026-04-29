/**
 * Data Import Service
 *
 * Handles bulk CSV import for recipients and categories.
 *
 * Recipient CSV format:
 *   name (required), bank_account (optional), address (optional),
 *   category (optional, format: "GENERAL:DETAIL")
 *
 * Category CSV format:
 *   category (required, format: "GENERAL:DETAIL")
 *   — falls back to the first column if no "category" header is found.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { logger } from '../config/logger.js';
import { query } from '../database/connection.js';
import { recipientRepository } from '../repositories/recipientRepository.js';
import { categoryRepository } from '../repositories/categoryRepository.js';
import { recipientBankAccountRepository } from '../repositories/recipientBankAccountRepository.js';

const ALLOWED_ENCODINGS = new Set(['utf-8', 'utf8', 'latin1', 'iso-8859-1', 'windows-1252']);
const SAFE_BASENAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Read a CSV file from os.tmpdir() identified by its basename only.
 *
 * Multer writes uploads into os.tmpdir() with a generated alphanumeric
 * filename. We rebuild the read path from the basename joined to a
 * constant os.tmpdir() so a tampered filePath can't escape the tmp
 * directory, and we validate the basename against a strict allowlist
 * to break any taint flow into the readFile call.
 *
 * @param {string} filePath
 * @param {string} encoding
 * @returns {Promise<string>}
 */
async function safeReadCsv(filePath, encoding) {
  const basename = path.basename(filePath);
  if (!SAFE_BASENAME_RE.test(basename)) {
    throw new Error('Refusing to read CSV with unsafe filename');
  }
  const safeEncoding = ALLOWED_ENCODINGS.has(String(encoding).toLowerCase()) ? encoding : 'utf-8';
  return fs.promises.readFile(path.join(os.tmpdir(), basename), safeEncoding);
}

// ─── Recipients ───────────────────────────────────────────────────────────────

/**
 * Import recipients from a CSV file.
 *
 * @param {string} filePath  - Path to the temporary CSV file
 * @param {Object} options
 * @param {string} options.separator - Column delimiter (default: ',')
 * @param {string} options.encoding  - File encoding (default: 'utf-8')
 * @returns {Promise<{total_processed, imported, skipped, errors}>}
 */
export async function importRecipientsCSV(filePath, { separator = ',', encoding = 'utf-8' } = {}) {
    const content = await safeReadCsv(filePath, encoding);

    let records;
    try {
        records = parse(content, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
            delimiter: separator,
            relax_column_count: true,
        });
    } catch (parseErr) {
        throw new Error(`CSV parse error: ${parseErr.message}`, { cause: parseErr });
    }

    const results = { total_processed: records.length, imported: 0, skipped: 0, errors: 0, bank_account_errors: 0 };
    if (records.length === 0) return results;

    for (const record of records) {
        const rowKeys = Object.keys(record);
        const col = (name) => {
            const key = rowKeys.find(k => k.toLowerCase().trim() === name);
            return key ? (record[key] ?? '').trim() : '';
        };

        const name = col('name');
        if (!name) {
            logger.warn('Recipient import: skipping row with missing name');
            results.errors++;
            continue;
        }

        const bankAccount = col('bank_account') || col('account_number');
        const address = col('address');
        const categoryStr = col('category');

        try {
            const { recipient, created } = await recipientRepository.createOrGet({ name });

            // Store address in notes only if the recipient is new or has no notes
            if (address && !recipient.notes) {
                await query(`UPDATE recipients SET notes = $1 WHERE id = $2`, [address, recipient.id]);
            }

            // Add bank account if provided
            if (bankAccount) {
                await recipientBankAccountRepository.createOrGet({
                    recipientId: recipient.id,
                    accountNumber: bankAccount,
                    setAsPrimary: false,
                }).catch((err) => {
                    logger.warn(`Recipient import: could not add bank account for "${name}": ${err.message}`);
                    results.bank_account_errors++;
                });
            }

            // Assign category if provided and recipient has none yet
            if (categoryStr) {
                const colonIdx = categoryStr.indexOf(':');
                if (colonIdx > 0) {
                    const general = categoryStr.slice(0, colonIdx).trim().toUpperCase();
                    const detail = categoryStr.slice(colonIdx + 1).trim().toUpperCase();
                    if (general && detail) {
                        const { category } = await categoryRepository.createOrGet({ general, detail });
                        // Only set if no default category yet (never overwrite existing assignment)
                        await query(
                            `UPDATE recipients SET default_category_id = $1 WHERE id = $2 AND default_category_id IS NULL`,
                            [category.id, recipient.id]
                        );
                    }
                } else {
                    logger.warn(`Recipient import: invalid category format "${categoryStr}" for "${name}" — expected GENERAL:DETAIL`);
                }
            }

            if (created) {
                results.imported++;
            } else {
                results.skipped++;
            }
        } catch (err) {
            logger.warn(`Recipient import: error processing "${name}": ${err.message}`);
            results.errors++;
        }
    }

    logger.info('Recipient CSV import complete', results);
    return results;
}

// ─── Categories ───────────────────────────────────────────────────────────────

/**
 * Import categories from a CSV file.
 *
 * @param {string} filePath  - Path to the temporary CSV file
 * @param {Object} options
 * @param {string} options.separator - Column delimiter (default: ',')
 * @param {string} options.encoding  - File encoding (default: 'utf-8')
 * @returns {Promise<{total_processed, imported, skipped, errors}>}
 */
export async function importCategoriesCSV(filePath, { separator = ',', encoding = 'utf-8' } = {}) {
    const content = await safeReadCsv(filePath, encoding);

    let records;
    try {
        records = parse(content, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
            delimiter: separator,
            relax_column_count: true,
        });
    } catch (parseErr) {
        throw new Error(`CSV parse error: ${parseErr.message}`, { cause: parseErr });
    }

    const results = { total_processed: records.length, imported: 0, skipped: 0, errors: 0 };
    if (records.length === 0) return results;

    // Determine the column to read from: prefer "category", fall back to first column
    const firstKey = Object.keys(records[0])[0];
    const categoryKey = Object.keys(records[0]).find(k => k.toLowerCase().trim() === 'category') ?? firstKey;

    for (const record of records) {
        const categoryStr = (record[categoryKey] ?? '').trim();
        if (!categoryStr) {
            results.errors++;
            continue;
        }

        const colonIdx = categoryStr.indexOf(':');
        if (colonIdx <= 0) {
            logger.warn(`Category import: invalid format "${categoryStr}" — expected GENERAL:DETAIL`);
            results.errors++;
            continue;
        }

        const general = categoryStr.slice(0, colonIdx).trim().toUpperCase();
        const detail = categoryStr.slice(colonIdx + 1).trim().toUpperCase();

        if (!general || !detail) {
            logger.warn(`Category import: empty general or detail in "${categoryStr}"`);
            results.errors++;
            continue;
        }

        try {
            const { created } = await categoryRepository.createOrGet({ general, detail });
            if (created) {
                results.imported++;
            } else {
                results.skipped++;
            }
        } catch (err) {
            logger.warn(`Category import: error processing "${categoryStr}": ${err.message}`);
            results.errors++;
        }
    }

    logger.info('Category CSV import complete', results);
    return results;
}
