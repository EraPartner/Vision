/**
 * Real-Postgres tests for the canonical 3-level effective-category resolution
 * on the aggregation surfaces that used to resolve only TWO levels:
 *
 *   • monthly summary — live path (infoRepositoryMonthly) and the
 *     `mv_monthly_summary` fast path (materializedViewService),
 *   • sankey flow (services/calculations/aggregation/sankey),
 *   • recurring detection (services/recurringDetectionService).
 *
 * "3-level" = own `t.category_id` → recipient's `default_category_id` →
 * PRIMARY recipient's `default_category_id`. A transaction recorded under an
 * ALIAS recipient whose PRIMARY carries the default category is categorised in
 * the transactions list; before this fix these surfaces reported it as
 * uncategorised, so the dashboard/sankey/recurring answers disagreed with the
 * transactions list for the same row.
 *
 * This is a DB suite on purpose: the mock suites for these modules feed
 * pre-shaped rows into the JS half and cannot observe how Postgres resolves the
 * join, which is exactly where the bug lived.
 *
 * The materialized views are created (and populated) inside the MV tests and
 * dropped again before the suite releases the DB lock — every other DB suite
 * assumes a freshly-migrated database with no MVs present.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import { getMonthlyFinancialSummary } from '../src/repositories/infoRepositoryMonthly.js';
import { computeSankeyFlow } from '../src/services/calculations/aggregation/sankey.js';
import {
  detectRecurringPatterns,
  __clearRecurringCacheForTests,
} from '../src/services/recurringDetectionService.js';
import { createMaterializedViews } from '../src/services/materializedViewService.js';
import transactionRepository from '../src/repositories/transactionRepository.js';
import { clearMvCache } from '../src/repositories/infoRepositoryHelpers.js';
import { clearMemoryCache } from '../src/services/currency/currencyConversionService.js';
import { closePool } from '../src/database/connection.js';

const MANAGED_VIEWS = ['mv_monthly_summary', 'mv_category_totals', 'mv_cashflow_daily'];

const cat = {};
const rec = {};

/**
 * Categories, plus the alias topology under test:
 *   Electrabel        — PRIMARY, default category Bills
 *   Electrabel Invoicing — ALIAS of Electrabel, NO default category of its own
 *   Aldi              — plain recipient with default category Food
 *   Misc Payee        — no default category anywhere
 */
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
  rec.electrabel = await addRecipient('Electrabel', { defaultCategoryId: cat.Bills });
  rec.electrabelAlias = await addRecipient('Electrabel Invoicing', { primaryId: rec.electrabel });
  rec.aldi = await addRecipient('Aldi', { defaultCategoryId: cat.Food });
  rec.misc = await addRecipient('Misc Payee');
}

/** Pre-create the accounts row (the sync trigger's own INSERT is broken at head). */
async function ensureAccount(name) {
  await getTestPool().query(
    `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
     ON CONFLICT (lower(btrim(name))) DO NOTHING`,
    [name],
  );
}

/**
 * `date` may be a 'YYYY-MM-DD' string or a raw SQL date expression (passed via
 * `dateSql`) — the monthly surfaces are windowed on CURRENT_DATE, so their
 * fixtures must be anchored to the database's today, not the test author's.
 */
async function insertTxn({
  date = null,
  dateSql = null,
  amount,
  currency = 'EUR',
  recipientId,
  categoryId = null,
  bank = 'MAIN BANK',
  isActive = true,
  isTransfer = false,
}) {
  if (bank) await ensureAccount(bank);
  const dateExpr = dateSql ?? '$1';
  const params = dateSql
    ? [amount, currency, recipientId, categoryId, bank, isActive, isTransfer]
    : [date, amount, currency, recipientId, categoryId, bank, isActive, isTransfer];
  const n = dateSql ? 0 : 1;
  const { rows } = await getTestPool().query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, bank_account, is_active, is_transfer)
     VALUES (${dateExpr}, $${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}) RETURNING id`,
    params,
  );
  return rows[0].id;
}

async function dropManagedViews() {
  const pool = getTestPool();
  for (const view of MANAGED_VIEWS) {
    await pool.query(`DROP MATERIALIZED VIEW IF EXISTS ${view} CASCADE`);
  }
  clearMvCache();
}

describe.skipIf(!hasTestDatabase())('3-level effective-category resolution (real DB)', () => {
  beforeAll(async () => {
    expect(
      process.env.DATABASE_URL,
      'DATABASE_URL must equal TEST_DATABASE_URL for this suite (see scripts/with-test-db.sh)',
    ).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);

  afterEach(async () => {
    const pool = getTestPool();
    // MVs first: they are the only artefact of this suite that outlives a row
    // wipe, and every other DB suite assumes a migrated DB with no MVs.
    await dropManagedViews();
    await pool.query('DELETE FROM transactions');
    await pool.query('DELETE FROM accounts');
    await pool.query('DELETE FROM recipients');
    await pool.query('DELETE FROM categories');
    await pool.query('DELETE FROM exchange_rates');
    await pool.query(`DELETE FROM user_settings WHERE key = 'includeTransfers'`);
    for (const bag of [cat, rec]) for (const k of Object.keys(bag)) delete bag[k];
    clearMemoryCache();
    __clearRecurringCacheForTests();
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Monthly summary — mv_monthly_summary definition + live/MV agreement
  // ───────────────────────────────────────────────────────────────────────────
  describe('monthly summary', () => {
    /**
     * Seed one alias-categorised row and one plainly-categorised row in the
     * current month. Returns the ids so callers can assert on them.
     */
    async function seedCurrentMonth() {
      await seedBase();
      const aliasTxn = await insertTxn({
        dateSql: `(date_trunc('month', CURRENT_DATE) + interval '5 days')::date`,
        amount: '-120.00',
        recipientId: rec.electrabelAlias, // categorised ONLY via the primary's default
      });
      await insertTxn({
        dateSql: `(date_trunc('month', CURRENT_DATE) + interval '6 days')::date`,
        amount: '-40.00',
        recipientId: rec.aldi, // categorised via its own recipient default
      });
      await insertTxn({
        dateSql: `(date_trunc('month', CURRENT_DATE) + interval '7 days')::date`,
        amount: '2000.00',
        recipientId: rec.misc, // uncategorised at all three levels
      });
      return { aliasTxn };
    }

    // The regression pin for the MV definition: mv_monthly_summary used to
    // group the alias row under the UNCATEGORISED bucket (category_id NULL,
    // category_id_key −1) while the transactions list showed it as Bills.
    it('mv_monthly_summary attributes an alias row to its PRIMARY recipient default category', async () => {
      const { aliasTxn } = await seedCurrentMonth();

      // The transactions list is the reference surface for this row…
      const listed = (await transactionRepository.getAll({})).find((t) => t.id === aliasTxn);
      expect(listed.effective_category_id).toBe(cat.Bills);
      expect(listed.category_name).toBe('Bills:Utilities');

      await createMaterializedViews();

      const { rows } = await getTestPool().query(
        `SELECT category_id, category_id_key, category_name, total_spending, total_income, transaction_count
           FROM mv_monthly_summary
          WHERE month_start = date_trunc('month', CURRENT_DATE)::date
          ORDER BY category_name`,
      );

      // …and the MV now agrees: the −120 sits in Bills, not UNCATEGORISED.
      expect(
        rows.map((r) => [r.category_name, Number(r.total_spending), Number(r.total_income)]),
      ).toEqual([
        ['Bills:Utilities', -120, 0],
        ['Food:Groceries', -40, 0],
        ['UNCATEGORISED', 0, 2000], // the genuinely uncategorised income row
      ]);
      const bills = rows.find((r) => r.category_name === 'Bills:Utilities');
      expect(bills.category_id).toBe(cat.Bills);
      expect(bills.category_id_key).toBe(cat.Bills);
      // Nothing but the real uncategorised row is left in the −1 bucket.
      expect(rows.filter((r) => r.category_id_key === -1)).toHaveLength(1);
    });

    // Cross-path guard: the MV fast path and the live query must return the
    // same months/summary for the same corpus, so a future divergence in the
    // effective-category resolution (or anything else) surfaces here.
    it('MV fast path and live path return identical months and summary', async () => {
      await seedCurrentMonth();
      // A second month so the comparison spans more than the current one.
      await insertTxn({
        dateSql: `(date_trunc('month', CURRENT_DATE) - interval '1 month' + interval '5 days')::date`,
        amount: '-33.00',
        recipientId: rec.electrabelAlias,
      });

      // No MVs yet → mvAvailable() is false → live query.
      const live = await getMonthlyFinancialSummary();
      expect(live.months).toHaveLength(6);

      await createMaterializedViews();
      clearMvCache();
      const mv = await getMonthlyFinancialSummary();

      expect(mv.months).toEqual(live.months);
      expect(mv.summary).toEqual(live.summary);
      // Sanity: the alias row's −120 and −33 really are in there.
      const current = mv.months[mv.months.length - 1];
      expect(current.total_spending).toBe(-160);
      expect(current.total_income).toBe(2000);
      expect(mv.months[mv.months.length - 2].total_spending).toBe(-33);
    });

    // The live path's category exclusion resolves 3 levels too: excluding the
    // PRIMARY's default category must drop the alias row's amount.
    it('live path excludes an alias row by its PRIMARY recipient default category', async () => {
      await seedCurrentMonth();

      const withBills = await getMonthlyFinancialSummary();
      expect(withBills.months[withBills.months.length - 1].total_spending).toBe(-160);

      const withoutBills = await getMonthlyFinancialSummary([cat.Bills]);
      expect(withoutBills.months[withoutBills.months.length - 1].total_spending).toBe(-40);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Sankey
  // ───────────────────────────────────────────────────────────────────────────
  describe('computeSankeyFlow', () => {
    // Both cited sankey sites at once. The category JOIN half is the regression
    // pin (the alias row used to land in "Uncategorised"). The exclusion half is
    // characterization only: pre-fix the alias row was ALSO absent when a
    // category was excluded — but via the NULL semantics of `!= ALL` (a NULL
    // effective category fails the comparison and drops the row), not via
    // resolved-category matching. The clause still has that NULL-dropping
    // defect for genuinely uncategorised rows — see the filed sankey-exclusion
    // finding in TODO.md.
    it('attributes an alias row to its PRIMARY default category, and excludes it by that category', async () => {
      await seedBase();
      await insertTxn({ date: '2024-01-15', amount: '3000.00', recipientId: rec.misc });
      await insertTxn({ date: '2024-02-10', amount: '-120.00', recipientId: rec.electrabelAlias });
      await insertTxn({ date: '2024-02-12', amount: '-40.00', recipientId: rec.aldi });

      const env = await computeSankeyFlow({ year: 2024 });
      const byLabel = Object.fromEntries(
        env.data.nodes.filter((n) => n.id.startsWith('cat:')).map((n) => [n.label, n.value]),
      );
      expect(byLabel).toEqual({
        'Bills: Utilities': 120, // formerly 'Uncategorised'
        'Food: Groceries': 40,
      });

      const excluded = await computeSankeyFlow({ year: 2024, excludedCategoryIds: [cat.Bills] });
      expect(
        excluded.data.nodes.filter((n) => n.id.startsWith('cat:')).map((n) => n.label),
      ).toEqual(['Food: Groceries']); // characterization — passes pre-fix too (see comment above)
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Recurring detection
  // ───────────────────────────────────────────────────────────────────────────
  describe('detectRecurringPatterns', () => {
    it('labels an alias-recipient pattern with the PRIMARY default category', async () => {
      await seedBase();
      // Three monthly occurrences under the ALIAS, none carrying its own category.
      for (const daysAgo of [90, 60, 30]) {
        await insertTxn({
          dateSql: `(CURRENT_DATE - interval '${daysAgo} days')::date`,
          amount: '-120.00',
          recipientId: rec.electrabelAlias,
        });
      }
      __clearRecurringCacheForTests();

      const { patterns } = await detectRecurringPatterns();
      const alias = patterns.find((p) => p.recipientId === rec.electrabelAlias);
      expect(alias).toBeDefined();
      expect(alias.detectedPattern).toBe('monthly');
      expect(alias.occurrences).toBe(3);
      // Formerly null: the 2-level join found no category for the alias.
      expect(alias.categoryName).toBe('Bills:Utilities');
    });
  });
});
