/**
 * Real-Postgres tests for the recipient/category CSV importers.
 *
 * The mock suite (dataImportService.test.js) stubs the repositories, so it
 * pins the per-row fallback and nothing else. This suite exists because the
 * importers were rewritten from a per-row loop (~5 round trips per recipient
 * row, 1-2 per category row) to a set-based resolve, and every semantic the
 * loop got from the database lives in SQL that a mock cannot show:
 *
 *   • `created` (→ imported) vs. existing (→ skipped) is decided by
 *     `ON CONFLICT DO NOTHING` on `recipients.normalized_name` and
 *     `categories (general, detail)`,
 *   • a repeat of a name *within one file* used to hit the row the earlier
 *     line had just inserted — the batched path has to reproduce that from JS,
 *   • matching is on the token-sorted, punctuation-stripped normalized name,
 *     not on the display name,
 *   • the notes / default-category writes are guarded so the first value in
 *     the file wins and an existing value is never overwritten.
 *
 * Every test also asserts the batched path actually ran: a silent throw would
 * fall back to the per-row loop, which produces the same counters by design and
 * would make the rest of the assertions blind.
 *
 * Isolation: the three tables this suite owns are emptied around each test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';

vi.mock('../src/config/logger.js', () => ({ logger: mockLogger() }));

// Wrap the module-level query() helper so the round-trip count is observable.
// Everything else (including withTransaction and its ambient-client routing)
// stays the real implementation.
vi.mock('../src/database/connection.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, query: vi.fn((/** @type {any[]} */ ...args) => actual.query(...args)) };
});

import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import { logger } from '../src/config/logger.js';
import { closePool, query } from '../src/database/connection.js';
import { recipientRepository } from '../src/repositories/recipientRepository.js';
import { categoryRepository } from '../src/repositories/categoryRepository.js';
import { importCategoriesCSV, importRecipientsCSV } from '../src/services/dataImportService.js';
import { useTempCSV } from './helpers/tempFile.js';

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;
const writeTempCSV = useTempCSV('data_import');

/** The batched path must be what ran — the fallback would mask everything. */
function expectBatchedPathRan() {
  const fellBack = logger.warn.mock.calls.some((/** @type {any[]} */ args) =>
    String(args[0]).includes('falling back to per-row'));
  expect(fellBack).toBe(false);
}

/** @param {string} normalizedName */
async function recipientRow(normalizedName) {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.notes, c.general, c.detail
       FROM recipients r
       LEFT JOIN categories c ON c.id = r.default_category_id
      WHERE r.normalized_name = $1`,
    [normalizedName],
  );
  return rows[0] ?? null;
}

describeDb('data import (real Postgres)', () => {
  beforeAll(acquireDbSuiteLock, 180_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await pool.query('DELETE FROM recipient_bank_accounts');
    await pool.query('DELETE FROM recipients');
    await pool.query('DELETE FROM categories');
  });

  afterEach(async () => {
    await pool.query('DELETE FROM recipient_bank_accounts');
    await pool.query('DELETE FROM recipients');
    await pool.query('DELETE FROM categories');
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  describe('importRecipientsCSV', () => {
    it('counts a name repeated inside one file as created once, skipped after', async () => {
      const file = writeTempCSV('name\nAlice\nBob\nalice\nALICE\n');

      const result = await importRecipientsCSV(file);

      expect(result).toEqual({
        total_processed: 4, imported: 2, skipped: 2, errors: 0, bank_account_errors: 0,
      });
      const { rows } = await pool.query('SELECT name FROM recipients ORDER BY name');
      expect(rows.map((/** @type {any} */ r) => r.name)).toEqual(['ALICE', 'BOB']);
      expectBatchedPathRan();
    });

    it('matches a pre-existing recipient on the token-sorted normalized name', async () => {
      await pool.query(
        `INSERT INTO recipients (name, normalized_name) VALUES ('JOHN SMITH', 'JOHN SMITH')`,
      );

      const result = await importRecipientsCSV(writeTempCSV('name\n"Smith, John"\nJohn F. Smith\n'));

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(2);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM recipients');
      expect(rows[0].n).toBe(1);
      expectBatchedPathRan();
    });

    it('writes the first address of the file to notes and never overwrites one', async () => {
      await pool.query(
        `INSERT INTO recipients (name, normalized_name, notes)
         VALUES ('OLD', 'OLD', 'kept')`,
      );

      const result = await importRecipientsCSV(writeTempCSV(
        'name,address\nOld,ignored addr\nNew,first addr\nNew,second addr\n',
      ));

      expect(result).toMatchObject({ imported: 1, skipped: 2, errors: 0 });
      expect((await recipientRow('OLD')).notes).toBe('kept');
      expect((await recipientRow('NEW')).notes).toBe('first addr');
      expectBatchedPathRan();
    });

    it('assigns the first category named for a recipient and never overwrites one', async () => {
      const { rows: seeded } = await pool.query(
        `INSERT INTO categories (general, detail) VALUES ('HOME', 'RENT') RETURNING id`,
      );
      await pool.query(
        `INSERT INTO recipients (name, normalized_name, default_category_id)
         VALUES ('LANDLORD', 'LANDLORD', $1)`,
        [seeded[0].id],
      );

      const result = await importRecipientsCSV(writeTempCSV(
        'name,category\nCarol,food:groceries\nCarol,transport:fuel\nLandlord,food:groceries\n'
        + 'Gina,INVALID_FORMAT\nHank,FOOD:\n',
      ));

      expect(result).toMatchObject({ imported: 3, skipped: 2, errors: 0 });
      // No ':' at all warns; an empty part after a well-placed ':' is a silent
      // skip. Neither is a row error, and neither recipient gets a category.
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid category format "INVALID_FORMAT"'));
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('"FOOD:"'));
      expect(await recipientRow('GINA')).toMatchObject({ general: null });
      expect(await recipientRow('HANK')).toMatchObject({ general: null });
      expect(await recipientRow('CAROL')).toMatchObject({ general: 'FOOD', detail: 'GROCERIES' });
      expect(await recipientRow('LANDLORD')).toMatchObject({ general: 'HOME', detail: 'RENT' });
      // Both categories the file names are created even when the assignment
      // they were named for is a no-op.
      const { rows: cats } = await pool.query('SELECT general, detail FROM categories ORDER BY general');
      expect(cats).toEqual([
        { general: 'FOOD', detail: 'GROCERIES' },
        { general: 'HOME', detail: 'RENT' },
        { general: 'TRANSPORT', detail: 'FUEL' },
      ]);
      expectBatchedPathRan();
    });

    it('links bank accounts per row and charges rejected ones to bank_account_errors', async () => {
      const tooLong = 'BE'.padEnd(40, '9'); // account_number is VARCHAR(34)
      const result = await importRecipientsCSV(writeTempCSV(
        `name,bank_account\nDana,BE11 1111\nErin,${tooLong}\n`,
      ));

      expect(result).toMatchObject({ imported: 2, skipped: 0, errors: 0, bank_account_errors: 1 });
      const { rows } = await pool.query(
        `SELECT account_number, is_primary FROM recipient_bank_accounts`,
      );
      expect(rows).toEqual([{ account_number: 'BE11 1111', is_primary: true }]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not add bank account for "Erin"'));
      expectBatchedPathRan();
    });

    it('counts a row with no name as an error and imports the rest', async () => {
      const result = await importRecipientsCSV(writeTempCSV('name,address\n   ,nowhere\nFrank,\n'));

      expect(result).toMatchObject({ total_processed: 2, imported: 1, skipped: 0, errors: 1 });
      expectBatchedPathRan();
    });

    it('resolves the whole file in a handful of statements', async () => {
      const rows = Array.from({ length: 60 }, (_, i) => `Recipient ${i},cat ${i % 4}:detail`);
      vi.spyOn(recipientRepository, 'createOrGet');
      vi.spyOn(categoryRepository, 'createOrGet');

      const result = await importRecipientsCSV(writeTempCSV(`name,category\n${rows.join('\n')}\n`));

      expect(result).toMatchObject({ imported: 60, skipped: 0, errors: 0 });
      // Two resolve statements per entity plus the one batched category
      // assignment; the per-row loop issued ~5 statements per row.
      expect(query.mock.calls.length).toBeLessThanOrEqual(6);
      expect(recipientRepository.createOrGet).not.toHaveBeenCalled();
      expect(categoryRepository.createOrGet).not.toHaveBeenCalled();
      const { rows: assigned } = await pool.query(
        `SELECT count(*)::int AS n FROM recipients WHERE default_category_id IS NOT NULL`,
      );
      expect(assigned[0].n).toBe(60);
      expectBatchedPathRan();
    });
  });

  describe('importCategoriesCSV', () => {
    it('creates each distinct pair once and counts repeats and pre-existing as skipped', async () => {
      await pool.query(`INSERT INTO categories (general, detail) VALUES ('FOOD', 'GROCERIES')`);

      const result = await importCategoriesCSV(writeTempCSV(
        'category\nfood:groceries\nTransport:Fuel\ntransport: fuel\nHome:Rent\n',
      ));

      expect(result).toEqual({ total_processed: 4, imported: 2, skipped: 2, errors: 0 });
      const { rows } = await pool.query('SELECT general, detail FROM categories ORDER BY general');
      expect(rows).toEqual([
        { general: 'FOOD', detail: 'GROCERIES' },
        { general: 'HOME', detail: 'RENT' },
        { general: 'TRANSPORT', detail: 'FUEL' },
      ]);
      expectBatchedPathRan();
    });

    it('counts malformed rows as errors without touching the valid ones', async () => {
      const result = await importCategoriesCSV(writeTempCSV(
        'category\nFOOD:GROCERIES\nINVALID\n\nFOOD:\n:GROCERIES\n',
      ));

      expect(result).toMatchObject({ imported: 1, skipped: 0, errors: 3 });
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM categories');
      expect(rows[0].n).toBe(1);
      expectBatchedPathRan();
    });

    it('resolves the whole file in a handful of statements', async () => {
      const rows = Array.from({ length: 60 }, (_, i) => `general ${i}:detail`);
      vi.spyOn(categoryRepository, 'createOrGet');

      const result = await importCategoriesCSV(writeTempCSV(`category\n${rows.join('\n')}\n`));

      expect(result).toMatchObject({ imported: 60, skipped: 0, errors: 0 });
      expect(query.mock.calls.length).toBeLessThanOrEqual(3);
      expect(categoryRepository.createOrGet).not.toHaveBeenCalled();
      expectBatchedPathRan();
    });
  });
});
