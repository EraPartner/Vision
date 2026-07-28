/**
 * Real-Postgres tests for infoRepositoryStatistics.
 *
 * DB-backed complement to infoRepoStatistics.test.js (which stays: it runs
 * without a DB). The mock suite feeds pre-shaped rows into the JS aggregation
 * and asserts SQL substrings; here the live queries run against a migrated
 * schema with realistic fixtures — NUMERIC amounts as strings with cents, DATE
 * columns spanning the Feb→Mar 2024 month boundary, multiple currencies with
 * seeded `exchange_rates` rows (so conversion resolves from the DB, never the
 * network), transfers and inactive rows mixed in, and alias recipients.
 *
 * The materialized-view fast path is NOT exercised: the MVs are dropped by
 * migration 0045 and recreated only at runtime by materializedViewService, so
 * a freshly-migrated test DB always takes the live-query path (mvAvailable →
 * false). That matches a fresh production boot.
 *
 * Process-level caches (currency memoryCache/historical index, MV
 * availability) are cleared around every test so no test sees another's rates.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import { statisticsRepository } from '../src/repositories/infoRepositoryStatistics.js';
import transactionRepository from '../src/repositories/transactionRepository.js';
import { clearMvCache } from '../src/repositories/infoRepositoryHelpers.js';
import { clearMemoryCache } from '../src/services/currency/currencyConversionService.js';
import { closePool } from '../src/database/connection.js';

const cat = {};
const rec = {};

async function seedBase() {
  const pool = getTestPool();
  for (const [key, [general, detail]] of Object.entries({
    Food: ['Food', 'Groceries'],
    Bills: ['Bills', 'Utilities'],
  })) {
    const { rows } = await pool.query(
      'INSERT INTO categories (general, detail) VALUES ($1, $2) RETURNING id',
      [general, detail],
    );
    cat[key] = rows[0].id;
  }
  const addRecipient = async (name, { defaultCategoryId = null, primaryId = null } = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO recipients (name, normalized_name, default_category_id, primary_recipient_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, name.toLowerCase(), defaultCategoryId, primaryId],
    );
    return rows[0].id;
  };
  rec.aldi = await addRecipient('Aldi', { defaultCategoryId: cat.Food });
  rec.aldiAlias = await addRecipient('Aldi Anderlecht', { primaryId: rec.aldi });
  rec.misc = await addRecipient('Misc Payee');
}

/**
 * Ensure an accounts row exists for a label. Pre-created because the sync
 * trigger's own onboarding INSERT is broken at schema head (0076 regressed its
 * ON CONFLICT arbiter to the raw name after 0066 dropped that constraint —
 * pinned in transactionRepository.db.test.js); only the resolve path works.
 */
async function ensureAccount(name) {
  await getTestPool().query(
    `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
     ON CONFLICT (lower(btrim(name))) DO NOTHING`,
    [name],
  );
}

async function insertTxn({
  date,
  amount,
  currency = 'EUR',
  recipientId,
  categoryId = null,
  bank = 'MAIN BANK',
  isActive = true,
  isTransfer = false,
}) {
  if (bank) await ensureAccount(bank);
  const { rows } = await getTestPool().query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, bank_account, is_active, is_transfer)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [date, amount, currency, recipientId, categoryId, bank, isActive, isTransfer],
  );
  return rows[0].id;
}

/** Seed one exchange_rates row; conversion then resolves from the DB. */
async function insertRate(code, date, rate, isLatest = false) {
  await getTestPool().query(
    `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_eur, is_latest)
     VALUES ($1, $2, $3, $4)`,
    [code, date, rate, isLatest],
  );
}

describe.skipIf(!hasTestDatabase())('repositories/infoRepositoryStatistics (real DB)', () => {
  beforeAll(async () => {
    expect(
      process.env.DATABASE_URL,
      'DATABASE_URL must equal TEST_DATABASE_URL for this suite (see scripts/with-test-db.sh)',
    ).toBe(process.env.TEST_DATABASE_URL);
    // DB suites share one database across parallel vitest workers — serialize.
    await acquireDbSuiteLock();
  }, 180_000);

  afterEach(async () => {
    const pool = getTestPool();
    await pool.query('DELETE FROM transactions');
    await pool.query('DELETE FROM accounts');
    await pool.query('DELETE FROM recipients');
    await pool.query('DELETE FROM categories');
    await pool.query('DELETE FROM exchange_rates');
    await pool.query(`DELETE FROM user_settings WHERE key = 'includeTransfers'`);
    for (const bag of [cat, rec]) for (const k of Object.keys(bag)) delete bag[k];
    // Process-level caches: rates loaded from this test's exchange_rates rows
    // (and the negative MV probe) must not leak into the next test.
    clearMemoryCache();
    clearMvCache();
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getCategoryBreakdown (live path)
  // ───────────────────────────────────────────────────────────────────────────
  describe('getCategoryBreakdown', () => {
    it('aggregates per category across currencies, excluding transfers and inactive rows', async () => {
      await seedBase();
      // USD converts at the stored latest rate (0.45 EUR per USD) — no network.
      await insertRate('USD', '2024-06-01', '0.45', true);

      await insertTxn({ date: '2024-02-10', amount: '-10.00', recipientId: rec.aldi }); // Food via recipient default
      await insertTxn({ date: '2024-02-15', amount: '-20.50', recipientId: rec.misc, categoryId: cat.Food });
      await insertTxn({ date: '2024-02-15', amount: '-30.00', currency: 'USD', recipientId: rec.misc, categoryId: cat.Food });
      await insertTxn({ date: '2024-03-05', amount: '-40.00', recipientId: rec.misc, categoryId: cat.Bills });
      await insertTxn({ date: '2024-03-06', amount: '-5.00', recipientId: rec.misc }); // no category anywhere
      await insertTxn({ date: '2024-03-07', amount: '-2.00', recipientId: rec.misc }); // no category anywhere
      await insertTxn({ date: '2024-03-08', amount: '-100.00', recipientId: rec.misc, categoryId: cat.Bills, isTransfer: true });
      await insertTxn({ date: '2024-03-09', amount: '-999.00', recipientId: rec.misc, categoryId: cat.Bills, isActive: false });

      const r = await statisticsRepository.getCategoryBreakdown();

      // Sorted by count DESC: Food (3), Uncategorised (2), Bills (1).
      expect(r).toEqual([
        { id: cat.Food, name: 'Food:Groceries', count: 3, total: -44 }, // −10 − 20.50 − (30 × 0.45)
        { id: null, name: 'UNCATEGORISED', count: 2, total: -7 },
        { id: cat.Bills, name: 'Bills:Utilities', count: 1, total: -40 }, // transfer/inactive stay out
      ]);
    });

    it('includes transfers when the includeTransfers setting is on', async () => {
      await seedBase();
      await getTestPool().query(
        `INSERT INTO user_settings (key, value) VALUES ('includeTransfers', 'true'::jsonb)`,
      );
      await insertTxn({ date: '2024-03-05', amount: '-40.00', recipientId: rec.misc, categoryId: cat.Bills });
      await insertTxn({ date: '2024-03-08', amount: '-100.00', recipientId: rec.misc, categoryId: cat.Bills, isTransfer: true });

      const r = await statisticsRepository.getCategoryBreakdown();
      expect(r).toEqual([
        { id: cat.Bills, name: 'Bills:Utilities', count: 2, total: -140 },
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getBanks / getTransactionCount
  // ───────────────────────────────────────────────────────────────────────────
  describe('getBanks', () => {
    it('lists only accounts with ACTIVE transactions, ordered by name', async () => {
      await seedBase();
      await insertTxn({ date: '2024-02-10', amount: '-1.00', recipientId: rec.misc, bank: 'ZZZ BANK' });
      await insertTxn({ date: '2024-02-11', amount: '-2.00', recipientId: rec.misc, bank: 'AAA BANK' });
      // The dual-write trigger creates the GHOST BANK account row, but its only
      // transaction is inactive — so it must not surface.
      await insertTxn({ date: '2024-02-12', amount: '-3.00', recipientId: rec.misc, bank: 'GHOST BANK', isActive: false });

      expect(await statisticsRepository.getBanks()).toEqual(['AAA BANK', 'ZZZ BANK']);
    });
  });

  describe('getTransactionCount', () => {
    it('counts active rows, optionally scoped to one account', async () => {
      await seedBase();
      await insertTxn({ date: '2024-02-10', amount: '-1.00', recipientId: rec.misc, bank: 'MAIN BANK' });
      await insertTxn({ date: '2024-02-11', amount: '-2.00', recipientId: rec.misc, bank: 'MAIN BANK' });
      await insertTxn({ date: '2024-02-12', amount: '-3.00', recipientId: rec.misc, bank: 'OTHER BANK' });
      await insertTxn({ date: '2024-02-13', amount: '-4.00', recipientId: rec.misc, bank: 'MAIN BANK', isActive: false });
      const { rows } = await getTestPool().query(
        `SELECT id FROM accounts WHERE name = 'MAIN BANK'`,
      );

      expect(await statisticsRepository.getTransactionCount()).toBe(3);
      expect(await statisticsRepository.getTransactionCount({ accountId: rows[0].id })).toBe(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getCategoryPivot
  // ───────────────────────────────────────────────────────────────────────────
  describe('getCategoryPivot', () => {
    it('splits income/expense within a mixed-sign category-month', async () => {
      await seedBase();
      await insertTxn({ date: '2024-02-10', amount: '500.00', recipientId: rec.misc, categoryId: cat.Food });
      await insertTxn({ date: '2024-02-10', amount: '-300.00', recipientId: rec.misc, categoryId: cat.Food });

      const r = await statisticsRepository.getCategoryPivot();
      expect(Object.keys(r.categoryPivot)).toEqual(['2024-02']);
      expect(r.categoryPivot['2024-02']).toEqual([
        {
          categoryId: cat.Food,
          categoryName: 'Food: Groceries', // pivot format is 'general: detail' (with space)
          total: 200,
          income: 500,
          expense: -300,
          transactionCount: 2,
        },
      ]);
    });

    it('converts each month at its own historical rate (per-date FX from exchange_rates)', async () => {
      await seedBase();
      await insertRate('USD', '2024-02-15', '0.5');
      await insertRate('USD', '2024-03-15', '0.4');
      await insertTxn({ date: '2024-02-15', amount: '-30.00', currency: 'USD', recipientId: rec.misc, categoryId: cat.Food });
      await insertTxn({ date: '2024-03-15', amount: '-30.00', currency: 'USD', recipientId: rec.misc, categoryId: cat.Food });

      const r = await statisticsRepository.getCategoryPivot();
      // Same nominal amount, different months, different rates: −15 vs −12.
      expect(r.categoryPivot['2024-02']).toEqual([
        { categoryId: cat.Food, categoryName: 'Food: Groceries', total: -15, income: 0, expense: -15, transactionCount: 1 },
      ]);
      expect(r.categoryPivot['2024-03']).toEqual([
        { categoryId: cat.Food, categoryName: 'Food: Groceries', total: -12, income: 0, expense: -12, transactionCount: 1 },
      ]);
    });

    it('sorts cells ascending by total and applies alias-aware exclusions', async () => {
      await seedBase();
      // Recorded under the ALIAS with its OWN category. (Categories reached
      // via the primary's default also enter the pivot — 3-level resolution,
      // see the last test in this file.)
      await insertTxn({ date: '2024-02-10', amount: '-10.00', recipientId: rec.aldiAlias, categoryId: cat.Food });
      await insertTxn({ date: '2024-02-12', amount: '-20.00', recipientId: rec.misc, categoryId: cat.Bills });

      const all = await statisticsRepository.getCategoryPivot();
      expect(all.categoryPivot['2024-02'].map((c) => [c.categoryId, c.total])).toEqual([
        [cat.Bills, -20], // ascending by total
        [cat.Food, -10],
      ]);

      // Excluding the PRIMARY recipient also removes rows recorded under its alias.
      const exclRecipient = await statisticsRepository.getCategoryPivot([], 'EUR', [rec.aldi]);
      expect(exclRecipient.categoryPivot['2024-02'].map((c) => c.categoryId)).toEqual([cat.Bills]);

      const exclCategory = await statisticsRepository.getCategoryPivot([cat.Bills]);
      expect(exclCategory.categoryPivot['2024-02'].map((c) => c.categoryId)).toEqual([cat.Food]);
    });

    // Regression coverage (formerly a pinned cross-surface inconsistency):
    // both statistics queries used to resolve the effective category over TWO
    // levels only — COALESCE(t.category_id, r.default_category_id) — while
    // the transactions surfaces (list, GET, uncategorised queue) resolve
    // THREE (…, pr.default_category_id). A row recorded under an alias whose
    // PRIMARY carries the default category was therefore categorised in the
    // transactions list but UNCATEGORISED in the breakdown and silently
    // ABSENT from the pivot (whose WHERE requires the COALESCE non-NULL).
    // Both queries now use the canonical 3-level pattern, so the breakdown
    // and pivot must AGREE with the transactions list. (Rows uncategorised at
    // ALL three levels are still excluded from the pivot by design, so the
    // mock suite's "missing category_id → Uncategorised" JS branch remains a
    // defensive path never fed by the real query.)
    it('alias row categorised only via its primary: Bills in breakdown and pivot, agreeing with the transactions list', async () => {
      const pool = getTestPool();
      await seedBase();
      const { rows } = await pool.query(
        `INSERT INTO recipients (name, normalized_name, default_category_id, primary_recipient_id)
         VALUES ('Electrabel', 'electrabel', $1, NULL) RETURNING id`,
        [cat.Bills],
      );
      const aliasRes = await pool.query(
        `INSERT INTO recipients (name, normalized_name, primary_recipient_id)
         VALUES ('Electrabel Invoicing', 'electrabel invoicing', $1) RETURNING id`,
        [rows[0].id],
      );
      const txnId = await insertTxn({ date: '2024-02-10', amount: '-120.00', recipientId: aliasRes.rows[0].id });

      // The transactions list categorises the row via the primary's default…
      const listed = (await transactionRepository.getAll({})).find((t) => t.id === txnId);
      expect(listed.effective_category_id).toBe(cat.Bills);
      expect(listed.category_name).toBe('Bills:Utilities');

      // …and the breakdown now agrees (formerly UNCATEGORISED here).
      const breakdown = await statisticsRepository.getCategoryBreakdown();
      expect(breakdown).toEqual([
        { id: cat.Bills, name: 'Bills:Utilities', count: 1, total: -120 },
      ]);

      // …as does the pivot (the row formerly vanished from it entirely).
      const pivot = await statisticsRepository.getCategoryPivot();
      expect(pivot.categoryPivot).toEqual({
        '2024-02': [
          {
            categoryId: cat.Bills,
            categoryName: 'Bills: Utilities', // pivot format is 'general: detail'
            total: -120,
            income: 0,
            expense: -120,
            transactionCount: 1,
          },
        ],
      });
    });
  });
});
