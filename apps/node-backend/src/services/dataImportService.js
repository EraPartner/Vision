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
 *
 * Both importers resolve every distinct recipient/category the file names in a
 * handful of set-based statements and then fold the rows against that result,
 * rather than issuing the per-row round trips (~5 per recipient row, 1-2 per
 * category row) a multi-thousand-row migration CSV used to pay. The per-row
 * loop survives as the fallback for a resolve that cannot be applied — the
 * same shape commit.js uses for the bank-import chunk plan — which is what
 * keeps the counters honest: the fallback IS the old code, and the resolve it
 * falls back from is transactional, so it starts on an unchanged database.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { parseCategoryName } from '@vision/shared-utils';
import { logger } from '../config/logger.js';
import { query, withTransaction } from '../database/connection.js';
import { normalizeForMatching } from '../lib/textNormalization.js';
import { recipientRepository } from '../repositories/recipientRepository.js';
import { categoryRepository } from '../repositories/categoryRepository.js';
import { recipientBankAccountRepository } from '../repositories/recipientBankAccountRepository.js';

const ALLOWED_ENCODINGS = new Set(['utf-8', 'utf8', 'latin1', 'iso-8859-1', 'windows-1252']);
const SAFE_BASENAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * @typedef {object} RecipientCsvRow
 * @property {string} name
 * @property {string} bankAccount
 * @property {string} address
 * @property {string} categoryStr
 */

/**
 * @typedef {object} CategoryCsvRow
 * @property {string} raw      the cell as written, for log messages
 * @property {string} general
 * @property {string} detail
 */

/**
 * A recipient the file names, resolved once. `notes`/`defaultCategoryId` are
 * mutated while folding the rows so a later row of the same file sees what an
 * earlier one claimed — the per-row loop got that from re-reading the row.
 *
 * @typedef {object} ResolvedRecipient
 * @property {number} id
 * @property {boolean} created  true when THIS import inserted the row
 * @property {string|null} notes
 * @property {number|null} defaultCategoryId
 */

/** @typedef {'imported'|'skipped'|'error'} RowOutcome */

/**
 * @typedef {object} RecipientImportResults
 * @property {number} total_processed
 * @property {number} imported
 * @property {number} skipped
 * @property {number} errors
 * @property {number} bank_account_errors
 */

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
  return fs.promises.readFile(path.join(os.tmpdir(), basename), /** @type {BufferEncoding} */ (safeEncoding));
}

// ─── Shared resolution ────────────────────────────────────────────────────────

/**
 * GENERAL:DETAIL → the uppercase pair `categories` is keyed on.
 *
 * parseCategoryName (shared GENERAL:DETAIL interchange helper) splits on the
 * first ':' and trims; both parts must be non-empty, matching the old
 * colonIdx > 0 guard. The uppercasing mirrors categoryRepository.createOrGet,
 * whose own `.toUpperCase().trim()` is then a no-op — the batched path has to
 * derive the conflict key exactly as the repository would.
 *
 * @param {string} categoryStr
 * @returns {{ general: string, detail: string }}
 */
function parseCategoryPair(categoryStr) {
  const parsed = parseCategoryName(categoryStr);
  return { general: parsed.general.toUpperCase(), detail: parsed.detail.toUpperCase() };
}

/**
 * @param {{ general: string, detail: string }} pair
 * @returns {string}
 */
function categoryKeyOf(pair) {
  return `${pair.general}\u0000${pair.detail}`;
}

/**
 * @param {string[]} generals
 * @param {string[]} details
 * @returns {Promise<{ id: number, general: string, detail: string }[]>}
 */
async function selectCategories(generals, details) {
  const result = await query(
    `SELECT c.id, c.general, c.detail
       FROM categories c
       JOIN UNNEST($1::text[], $2::text[]) AS want(general, detail)
         ON c.general = want.general AND c.detail = want.detail`,
    [generals, details],
  );
  return result.rows;
}

/**
 * Resolve every distinct (general, detail) pair to a category id, creating the
 * ones that don't exist yet. `created` means the same thing
 * categoryRepository.createOrGet's did — this import inserted the row — because
 * the callers map it onto imported/skipped.
 *
 * @param {{ general: string, detail: string }[]} pairs distinct, first-seen order
 * @returns {Promise<Map<string, { id: number, created: boolean }>>}
 */
async function resolveCategories(pairs) {
  /** @type {Map<string, { id: number, created: boolean }>} */
  const resolved = new Map();
  if (pairs.length === 0) return resolved;

  for (const row of await selectCategories(pairs.map((p) => p.general), pairs.map((p) => p.detail))) {
    resolved.set(categoryKeyOf(row), { id: row.id, created: false });
  }

  const missing = pairs.filter((p) => !resolved.has(categoryKeyOf(p)));
  if (missing.length === 0) return resolved;

  const inserted = await query(
    `INSERT INTO categories (general, detail, description, is_active)
     SELECT UNNEST($1::text[]), UNNEST($2::text[]), NULL, true
     ON CONFLICT (general, detail) DO NOTHING
     RETURNING id, general, detail`,
    [missing.map((p) => p.general), missing.map((p) => p.detail)],
  );
  for (const row of /** @type {{ id: number, general: string, detail: string }[]} */ (inserted.rows)) {
    resolved.set(categoryKeyOf(row), { id: row.id, created: true });
  }

  // A pair that neither pre-existed nor came back from the INSERT lost the
  // conflict to a concurrent writer — the case createOrGet's post-conflict
  // SELECT covers. Such a row exists but is not ours, hence created: false.
  const raced = missing.filter((p) => !resolved.has(categoryKeyOf(p)));
  if (raced.length > 0) {
    for (const row of await selectCategories(raced.map((p) => p.general), raced.map((p) => p.detail))) {
      resolved.set(categoryKeyOf(row), { id: row.id, created: false });
    }
  }

  return resolved;
}

/**
 * @param {string[]} normalizedNames
 * @returns {Promise<{ id: number, normalized_name: string, notes: string|null, default_category_id: number|null }[]>}
 */
async function selectRecipients(normalizedNames) {
  const result = await query(
    `SELECT id, normalized_name, notes, default_category_id
       FROM recipients
      WHERE normalized_name = ANY($1::text[])`,
    [normalizedNames],
  );
  return result.rows;
}

/**
 * Resolve every distinct recipient the file names, creating the ones that don't
 * exist yet. The conflict key is normalizeForMatching(name) and the stored name
 * is the uppercased/trimmed original — the same derivation
 * recipientRepository.createOrGet uses, so "existing" keeps meaning what it
 * meant per row.
 *
 * @param {{ upper: string, normalized: string }[]} names distinct by normalized, first-seen order
 * @returns {Promise<Map<string, ResolvedRecipient>>}
 */
async function resolveRecipients(names) {
  /** @type {Map<string, ResolvedRecipient>} */
  const resolved = new Map();
  if (names.length === 0) return resolved;

  for (const row of await selectRecipients(names.map((n) => n.normalized))) {
    resolved.set(row.normalized_name, {
      id: row.id,
      created: false,
      notes: row.notes,
      defaultCategoryId: row.default_category_id,
    });
  }

  const missing = names.filter((n) => !resolved.has(n.normalized));
  if (missing.length === 0) return resolved;

  const inserted = await query(
    `INSERT INTO recipients (name, normalized_name, is_active)
     SELECT UNNEST($1::text[]), UNNEST($2::text[]), true
     ON CONFLICT (normalized_name) DO NOTHING
     RETURNING id, normalized_name`,
    [missing.map((n) => n.upper), missing.map((n) => n.normalized)],
  );
  for (const row of /** @type {{ id: number, normalized_name: string }[]} */ (inserted.rows)) {
    resolved.set(row.normalized_name, { id: row.id, created: true, notes: null, defaultCategoryId: null });
  }

  const raced = missing.filter((n) => !resolved.has(n.normalized));
  if (raced.length > 0) {
    for (const row of await selectRecipients(raced.map((n) => n.normalized))) {
      resolved.set(row.normalized_name, {
        id: row.id,
        created: false,
        notes: row.notes,
        defaultCategoryId: row.default_category_id,
      });
    }
  }

  return resolved;
}

// ─── Recipients ───────────────────────────────────────────────────────────────

/**
 * Extract the columns the recipient importer reads from one parsed CSV record.
 * Header matching stays case- and whitespace-insensitive.
 *
 * @param {Record<string, string>} record
 * @returns {RecipientCsvRow}
 */
function readRecipientRow(record) {
  const rowKeys = Object.keys(record);
  /** @param {string} name */
  const col = (name) => {
    const key = rowKeys.find((k) => k.toLowerCase().trim() === name);
    return key ? (record[key] ?? '').trim() : '';
  };
  return {
    name: col('name'),
    bankAccount: col('bank_account') || col('account_number'),
    address: col('address'),
    categoryStr: col('category'),
  };
}

/**
 * Apply planned updates in one statement, replaying them as the single-row
 * statements the loop used to issue if the batched form fails — a fault is then
 * charged to the row that caused it, and the rest of the file still counts,
 * exactly as the per-row try/catch charged it.
 *
 * @template {{ rowIndex: number, name: string }} U
 * @param {U[]} updates
 * @param {RowOutcome[]} outcomes
 * @param {string} label
 * @param {(all: U[]) => Promise<unknown>} batched
 * @param {(one: U) => Promise<unknown>} single
 * @returns {Promise<void>}
 */
async function flushRecipientUpdates(updates, outcomes, label, batched, single) {
  if (updates.length === 0) return;
  try {
    await batched(updates);
    return;
  } catch (err) {
    logger.warn(`Recipient import: batched ${label} update failed, applying per row: ${err.message}`);
  }
  for (const update of updates) {
    try {
      await single(update);
    } catch (err) {
      logger.warn(`Recipient import: error processing "${update.name}": ${err.message}`);
      outcomes[update.rowIndex] = 'error';
    }
  }
}

/**
 * Batched recipient import.
 *
 * Only the resolve phase can throw out of here, and it runs inside a
 * transaction: a failure there has written nothing and counted nothing, so the
 * caller can replay the whole file per row without double-counting. Everything
 * after it is charged to a row.
 *
 * @param {RecipientCsvRow[]} rows rows with a non-empty name, in file order
 * @param {RecipientImportResults} results mutated with the outcome
 * @returns {Promise<void>}
 */
async function importRecipientRowsBatched(rows, results) {
  /** @type {Map<string, { upper: string, normalized: string }>} */
  const distinctNames = new Map();
  /** @type {Map<string, { general: string, detail: string }>} */
  const distinctPairs = new Map();
  for (const row of rows) {
    const normalized = normalizeForMatching(row.name);
    if (!distinctNames.has(normalized)) {
      distinctNames.set(normalized, { upper: row.name.toUpperCase().trim(), normalized });
    }
    if (row.categoryStr) {
      const pair = parseCategoryPair(row.categoryStr);
      if (pair.general && pair.detail) distinctPairs.set(categoryKeyOf(pair), pair);
    }
  }

  // One transaction so a resolve that fails part-way leaves nothing behind and
  // the fallback re-derives `created` from an unchanged database. No client is
  // threaded through: the module-level query() helper joins the ambient
  // transaction store (see database/connection.js).
  const { recipients, categories } = await withTransaction(async () => ({
    recipients: await resolveRecipients([...distinctNames.values()]),
    categories: await resolveCategories([...distinctPairs.values()]),
  }));

  /** @type {RowOutcome[]} */
  const outcomes = new Array(rows.length);
  /** @type {{ rowIndex: number, name: string, id: number, notes: string }[]} */
  const notesUpdates = [];
  /** @type {{ rowIndex: number, name: string, id: number, categoryId: number }[]} */
  const categoryUpdates = [];
  /** @type {{ rowIndex: number, name: string, id: number, accountNumber: string }[]} */
  const bankAccounts = [];
  /** @type {Set<number>} */
  const counted = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const recipient = recipients.get(normalizeForMatching(row.name));
    if (!recipient) {
      logger.warn(`Recipient import: error processing "${row.name}": recipient could not be resolved`);
      outcomes[i] = 'error';
      continue;
    }

    // Store address in notes only if the recipient is new or has no notes
    if (row.address && !recipient.notes) {
      notesUpdates.push({ rowIndex: i, name: row.name, id: recipient.id, notes: row.address });
      recipient.notes = row.address;
    }

    if (row.bankAccount) {
      bankAccounts.push({ rowIndex: i, name: row.name, id: recipient.id, accountNumber: row.bankAccount });
    }

    if (row.categoryStr) {
      const pair = parseCategoryPair(row.categoryStr);
      if (pair.general && pair.detail) {
        const category = categories.get(categoryKeyOf(pair));
        if (!category) {
          logger.warn(`Recipient import: error processing "${row.name}": category could not be resolved`);
          outcomes[i] = 'error';
          continue;
        }
        // Only set if no default category yet (never overwrite existing
        // assignment) — within one file that makes the first category named
        // for a recipient the one that sticks, as the guarded UPDATE did.
        if (recipient.defaultCategoryId == null) {
          categoryUpdates.push({ rowIndex: i, name: row.name, id: recipient.id, categoryId: category.id });
          recipient.defaultCategoryId = category.id;
        }
      } else if (row.categoryStr.indexOf(':') <= 0) {
        // Same warn condition as the old colonIdx <= 0 branch; an empty
        // part after a well-placed ':' stays a silent skip, as before.
        logger.warn(`Recipient import: invalid category format "${row.categoryStr}" for "${row.name}" — expected GENERAL:DETAIL`);
      }
    }

    // A repeat of a name already seen in this file hits the row an earlier
    // line created, which the loop counted as skipped.
    const firstOccurrence = !counted.has(recipient.id);
    counted.add(recipient.id);
    outcomes[i] = recipient.created && firstOccurrence ? 'imported' : 'skipped';
  }

  // Ordered as the loop ordered them per row: notes, then bank account, then
  // default category.
  await flushRecipientUpdates(
    notesUpdates, outcomes, 'notes',
    (all) => query(
      `UPDATE recipients r SET notes = u.notes
         FROM UNNEST($1::int[], $2::text[]) AS u(id, notes)
        WHERE r.id = u.id`,
      [all.map((u) => u.id), all.map((u) => u.notes)],
    ),
    (one) => query(`UPDATE recipients SET notes = $1 WHERE id = $2`, [one.notes, one.id]),
  );

  for (const account of bankAccounts) {
    // A row the notes flush charged as an error never reached its bank account
    // in the loop either.
    if (outcomes[account.rowIndex] === 'error') continue;
    await recipientBankAccountRepository.createOrGet({
      recipientId: account.id,
      accountNumber: account.accountNumber,
      setAsPrimary: false,
    }).catch((err) => {
      logger.warn(`Recipient import: could not add bank account for "${account.name}": ${err.message}`);
      results.bank_account_errors++;
    });
  }

  // A row the notes replay charged as an error stopped there in the per-row
  // loop — its category assignment must not still land.
  await flushRecipientUpdates(
    categoryUpdates.filter((u) => outcomes[u.rowIndex] !== 'error'), outcomes, 'default category',
    (all) => query(
      `UPDATE recipients r SET default_category_id = u.category_id
         FROM UNNEST($1::int[], $2::int[]) AS u(id, category_id)
        WHERE r.id = u.id AND r.default_category_id IS NULL`,
      [all.map((u) => u.id), all.map((u) => u.categoryId)],
    ),
    (one) => query(
      `UPDATE recipients SET default_category_id = $1 WHERE id = $2 AND default_category_id IS NULL`,
      [one.categoryId, one.id],
    ),
  );

  for (const outcome of outcomes) {
    if (outcome === 'imported') results.imported++;
    else if (outcome === 'skipped') results.skipped++;
    else results.errors++;
  }
}

/**
 * The per-row recipient loop, kept as the fallback for a batched resolve that
 * could not be applied. It is deliberately a transcription of what the loop
 * always did: the two paths must return identical counters for every input, and
 * the cheapest way to guarantee that for the failure case is to run the old
 * statements.
 *
 * @param {RecipientCsvRow[]} rows
 * @param {RecipientImportResults} results
 * @returns {Promise<void>}
 */
async function importRecipientRowsPerRow(rows, results) {
  for (const row of rows) {
    try {
      const { recipient, created } = await recipientRepository.createOrGet({ name: row.name });

      if (row.address && !recipient.notes) {
        await query(`UPDATE recipients SET notes = $1 WHERE id = $2`, [row.address, recipient.id]);
      }

      if (row.bankAccount) {
        await recipientBankAccountRepository.createOrGet({
          recipientId: recipient.id,
          accountNumber: row.bankAccount,
          setAsPrimary: false,
        }).catch((err) => {
          logger.warn(`Recipient import: could not add bank account for "${row.name}": ${err.message}`);
          results.bank_account_errors++;
        });
      }

      if (row.categoryStr) {
        const { general, detail } = parseCategoryPair(row.categoryStr);
        if (general && detail) {
          const { category } = await categoryRepository.createOrGet({ general, detail });
          await query(
            `UPDATE recipients SET default_category_id = $1 WHERE id = $2 AND default_category_id IS NULL`,
            [category.id, recipient.id],
          );
        } else if (row.categoryStr.indexOf(':') <= 0) {
          logger.warn(`Recipient import: invalid category format "${row.categoryStr}" for "${row.name}" — expected GENERAL:DETAIL`);
        }
      }

      if (created) {
        results.imported++;
      } else {
        results.skipped++;
      }
    } catch (err) {
      logger.warn(`Recipient import: error processing "${row.name}": ${err.message}`);
      results.errors++;
    }
  }
}

/**
 * Import recipients from a CSV file.
 *
 * @param {string} filePath  - Path to the temporary CSV file
 * @param {Object} [options]
 * @param {string} [options.separator] - Column delimiter (default: ',')
 * @param {string} [options.encoding]  - File encoding (default: 'utf-8')
 * @returns {Promise<RecipientImportResults>}
 */
export async function importRecipientsCSV(filePath, { separator = ',', encoding = 'utf-8' } = {}) {
    const content = await safeReadCsv(filePath, encoding);

    // csv-parse's `columns: true` overload is generic (`T = unknown`) and infers
    // `{}` with no column list supplied — annotate to the actual shape
    // (header name -> cell string) so downstream property/index access typechecks.
    /** @type {Record<string, string>[]} */
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

    /** @type {RecipientCsvRow[]} */
    const rows = [];
    for (const record of records) {
        const row = readRecipientRow(record);
        if (!row.name) {
            logger.warn('Recipient import: skipping row with missing name');
            results.errors++;
            continue;
        }
        rows.push(row);
    }

    if (rows.length > 0) {
        try {
            await importRecipientRowsBatched(rows, results);
        } catch (err) {
            logger.warn(`Recipient import: batched resolve unavailable, falling back to per-row: ${err.message}`);
            await importRecipientRowsPerRow(rows, results);
        }
    }

    logger.info('Recipient CSV import complete', results);
    return results;
}

// ─── Categories ───────────────────────────────────────────────────────────────

/**
 * @param {CategoryCsvRow[]} rows
 * @param {{ imported: number, skipped: number, errors: number }} results
 * @returns {Promise<void>}
 */
async function importCategoryRowsBatched(rows, results) {
  /** @type {Map<string, { general: string, detail: string }>} */
  const distinct = new Map();
  for (const row of rows) {
    const key = categoryKeyOf(row);
    if (!distinct.has(key)) distinct.set(key, { general: row.general, detail: row.detail });
  }

  // Transactional for the same reason as the recipient resolve: the fallback
  // below must start from a database this call did not touch.
  const resolved = await withTransaction(() => resolveCategories([...distinct.values()]));

  /** @type {Set<string>} */
  const counted = new Set();
  for (const row of rows) {
    const key = categoryKeyOf(row);
    const category = resolved.get(key);
    if (!category) {
      logger.warn(`Category import: error processing "${row.raw}": category could not be resolved`);
      results.errors++;
      continue;
    }
    const firstOccurrence = !counted.has(key);
    counted.add(key);
    if (category.created && firstOccurrence) {
      results.imported++;
    } else {
      results.skipped++;
    }
  }
}

/**
 * The per-row category loop — the fallback, for the reasons given on
 * {@link importRecipientRowsPerRow}.
 *
 * @param {CategoryCsvRow[]} rows
 * @param {{ imported: number, skipped: number, errors: number }} results
 * @returns {Promise<void>}
 */
async function importCategoryRowsPerRow(rows, results) {
  for (const row of rows) {
    try {
      const { created } = await categoryRepository.createOrGet({ general: row.general, detail: row.detail });
      if (created) {
        results.imported++;
      } else {
        results.skipped++;
      }
    } catch (err) {
      logger.warn(`Category import: error processing "${row.raw}": ${err.message}`);
      results.errors++;
    }
  }
}

/**
 * Import categories from a CSV file.
 *
 * @param {string} filePath  - Path to the temporary CSV file
 * @param {Object} [options]
 * @param {string} [options.separator] - Column delimiter (default: ',')
 * @param {string} [options.encoding]  - File encoding (default: 'utf-8')
 * @returns {Promise<{total_processed: number, imported: number, skipped: number, errors: number}>}
 */
export async function importCategoriesCSV(filePath, { separator = ',', encoding = 'utf-8' } = {}) {
    const content = await safeReadCsv(filePath, encoding);

    /** @type {Record<string, string>[]} */
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

    /** @type {CategoryCsvRow[]} */
    const rows = [];
    for (const record of records) {
        const raw = (record[categoryKey] ?? '').trim();
        if (!raw) {
            results.errors++;
            continue;
        }

        // No ':' at all is a format error; empty parts are flagged below.
        if (!raw.includes(':')) {
            logger.warn(`Category import: invalid format "${raw}" — expected GENERAL:DETAIL`);
            results.errors++;
            continue;
        }

        const { general, detail } = parseCategoryPair(raw);
        if (!general || !detail) {
            logger.warn(`Category import: empty general or detail in "${raw}"`);
            results.errors++;
            continue;
        }

        rows.push({ raw, general, detail });
    }

    if (rows.length > 0) {
        try {
            await importCategoryRowsBatched(rows, results);
        } catch (err) {
            logger.warn(`Category import: batched resolve unavailable, falling back to per-row: ${err.message}`);
            await importCategoryRowsPerRow(rows, results);
        }
    }

    logger.info('Category CSV import complete', results);
    return results;
}
