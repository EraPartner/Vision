/**
 * Real-Postgres tests for the canonical 3-level effective-category resolution
 * on the aggregation surfaces that used to resolve only TWO levels:
 *
 *   • monthly summary — live path (infoRepositoryMonthly) and the
 *     `mv_monthly_summary` fast path (materializedViewService),
 *   • sankey flow (services/calculations/aggregation/sankey),
 *   • recurring detection (services/recurringDetectionService).
 *
 * …and, added with the follow-up pass, the remaining name-rendering surfaces:
 *
 *   • CSV / NDJSON export (services/transactionExport) and the owed-splits
 *     export (repositories/splitRepository) — both carried the pre-fix
 *     `pc`-before-`rc` CASE, so they labelled a row with the PRIMARY's category
 *     name where the transactions list showed the ALIAS's own,
 *   • planned transactions (repositories/plannedTransactionRepository, which
 *     resolved 2 levels, and repositories/infoRepositoryPlanned, which resolved
 *     1) — planned_transactions carries its own recipient_id + category_id, so
 *     the identical 3-level resolution applies there.
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
import {
  buildIdListWhere,
  streamCsvExport,
  streamNdjsonExport,
} from '../src/services/transactionExport.js';
import splitRepository from '../src/repositories/splitRepository.js';
import plannedTransactionRepository from '../src/repositories/plannedTransactionRepository.js';
import { plannedRepository } from '../src/repositories/infoRepositoryPlanned.js';
import { todayAppDateString } from '../src/lib/timezone.js';

const MANAGED_VIEWS = ['mv_monthly_summary', 'mv_category_totals', 'mv_cashflow_daily'];

/**
 * The APP_TIMEZONE calendar day as a SQL date literal, resolved at call time —
 * the very anchor the monthly and planned repositories bind into their windows
 * (ADR-009, one clock). Fixtures for THOSE surfaces must be dated relative to
 * this, not to Postgres `CURRENT_DATE` (the DB session's UTC day, one day
 * behind the app day for the last hours of every UTC day). The
 * recurring-detection fixtures below deliberately stay on `CURRENT_DATE`:
 * recurringDetectionService still windows on it.
 */
const appTodaySql = () => `('${todayAppDateString()}'::date)`;

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
 * `dateSql`) — the monthly surfaces are windowed on the app-clock today
 * (`appTodaySql()`), so their fixtures must be anchored to that same day, not
 * the test author's calendar (nor the DB session's `CURRENT_DATE`).
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

/**
 * seedBase() plus the topology the parent fix pinned in
 * transactionRepository.db.test.js ("alias with its own default under a
 * differently-defaulted primary"):
 *
 *   Electrabel        — PRIMARY, default category Bills:Utilities
 *   Electrabel Retail — ALIAS of Electrabel, with its OWN default Zzz:Last
 *
 * A row booked against the alias resolves to Zzz:Last. The pre-fix `pc`-first
 * CASE resolved Bills:Utilities instead — this is the only topology in which
 * the two orders disagree, since it is the only one where BOTH rc and pc exist
 * and differ. 'Zzz'/'Last' sorts after every other fixture category, so an
 * ordered assertion can also tell the two resolutions apart.
 */
async function seedAliasWithOwnDefault() {
  await seedBase();
  const pool = getTestPool();
  const { rows: catRows } = await pool.query(
    `INSERT INTO categories (general, detail) VALUES ('Zzz', 'Last') RETURNING id`,
  );
  cat.Zzz = catRows[0].id;
  const { rows: recRows } = await pool.query(
    `INSERT INTO recipients (name, normalized_name, default_category_id, primary_recipient_id)
     VALUES ('Electrabel Retail', 'electrabel retail', $1, $2) RETURNING id`,
    [cat.Zzz, rec.electrabel],
  );
  rec.electrabelOwnAlias = recRows[0].id;
}

/**
 * The name of the category the transactions list's EFFECTIVE id names for a
 * row — the reference every other surface's `category_name` must equal. Read
 * back from `categories` rather than hardcoded, so the assertion is literally
 * "the id and the name denote the same category".
 */
async function listResolvedCategoryName(txnId) {
  const listed = (await transactionRepository.getAll({})).find((t) => t.id === txnId);
  const { rows } = await getTestPool().query(
    `SELECT general || ':' || detail AS name FROM categories WHERE id = $1`,
    [listed.effective_category_id],
  );
  return { effectiveCategoryId: listed.effective_category_id, name: rows[0].name };
}

/** Minimal `res` double for the streaming export pipeline; collects the chunks. */
function collectingRes() {
  /** @type {string[]} */
  const chunks = [];
  return {
    chunks,
    setHeader() {},
    write(chunk) { chunks.push(chunk); return true; },
    end() {},
    headersSent: false,
  };
}

/**
 * Insert one planned_transactions row directly (not through the repository, so
 * repository behaviour is never asserted against itself). `dateSql` is a raw
 * SQL date expression: the planned surfaces are windowed on the app-clock
 * today (`appTodaySql()`).
 */
async function insertPlanned({ dateSql, amount, recipientId, categoryId = null, memo = null }) {
  const { rows } = await getTestPool().query(
    `INSERT INTO planned_transactions (planned_date, amount, currency, recipient_id, category_id, memo)
     VALUES (${dateSql}, $1, 'EUR', $2, $3, $4) RETURNING id`,
    [amount, recipientId, categoryId, memo],
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
    // transaction_splits/split_payments cascade off transactions;
    // planned_transactions does NOT cascade off recipients, so it goes first.
    await pool.query('DELETE FROM planned_transactions');
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
        dateSql: `(date_trunc('month', ${appTodaySql()}) + interval '5 days')::date`,
        amount: '-120.00',
        recipientId: rec.electrabelAlias, // categorised ONLY via the primary's default
      });
      await insertTxn({
        dateSql: `(date_trunc('month', ${appTodaySql()}) + interval '6 days')::date`,
        amount: '-40.00',
        recipientId: rec.aldi, // categorised via its own recipient default
      });
      await insertTxn({
        dateSql: `(date_trunc('month', ${appTodaySql()}) + interval '7 days')::date`,
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
          WHERE month_start = date_trunc('month', ${appTodaySql()})::date
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
        dateSql: `(date_trunc('month', ${appTodaySql()}) - interval '1 month' + interval '5 days')::date`,
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
    /** The finding's fixture: €3000 uncategorised income + an alias-Bills and a Food expense. */
    async function seedSankeyYear() {
      await seedBase();
      // Uncategorised at all three levels — the row the exclusion clause used to eat.
      await insertTxn({ date: '2024-01-15', amount: '3000.00', recipientId: rec.misc });
      await insertTxn({ date: '2024-02-10', amount: '-120.00', recipientId: rec.electrabelAlias });
      await insertTxn({ date: '2024-02-12', amount: '-40.00', recipientId: rec.aldi });
    }

    /** { income, spendingByLabel } for a year's flow graph. */
    async function flow(opts) {
      const env = await computeSankeyFlow({ year: 2024, ...opts });
      return {
        income: env.data.nodes.find((n) => n.id === '__income__')?.value ?? 0,
        spending: Object.fromEntries(
          env.data.nodes.filter((n) => n.id.startsWith('cat:')).map((n) => [n.label, n.value]),
        ),
      };
    }

    // The category JOIN regression pin: the alias row used to land in
    // "Uncategorised" because the join resolved only 2 levels.
    it('attributes an alias row to its PRIMARY default category', async () => {
      await seedSankeyYear();

      expect(await flow({})).toEqual({
        income: 3000,
        spending: { 'Bills: Utilities': 120, 'Food: Groceries': 40 }, // formerly 'Uncategorised'
      });
    });

    // Real pin for the NULL-sentinel half (was characterization only, because
    // pre-fix the alias row vanished for the WRONG reason). `!= ALL($n)` with
    // no `-1` sentinel is NULL — not true — for a NULL effective category, so
    // excluding ANY category silently erased every uncategorised row: this
    // exact fixture rendered "Income 0" with €40 still flowing out of it.
    // buildExclusionClauses' `COALESCE(..., -1) NOT IN (...)` keeps them.
    it('excludes by the PRIMARY default category while keeping uncategorised rows', async () => {
      await seedSankeyYear();

      expect(await flow({ excludedCategoryIds: [cat.Bills] })).toEqual({
        income: 3000, // pre-fix: 0 — the uncategorised income row was dropped
        spending: { 'Food: Groceries': 40 },
      });
    });

    // Recipient exclusion is alias-aware: the bare `t.recipient_id != ALL(...)`
    // left rows booked on an ALIAS of the excluded PRIMARY in the graph, while
    // the category exclusion beside it already resolved the alias.
    it('excludes a PRIMARY recipient together with its aliases, keeping recipient-less rows', async () => {
      await seedSankeyYear();

      expect(await flow({ excludedRecipientIds: [rec.electrabel] })).toEqual({
        income: 3000,
        spending: { 'Food: Groceries': 40 }, // pre-fix: Bills 120 survived
      });
    });

    // ADR-083: a savings transfer's two legs inflated BOTH sides of the graph
    // (fake income in, fake spending out) — sankey had no is_transfer filter
    // at all. It now follows the same runtime setting as its siblings.
    it('excludes internal transfers by default and includes them when the setting is on', async () => {
      await seedBase();
      await insertTxn({ date: '2024-01-15', amount: '3000.00', recipientId: rec.misc });
      await insertTxn({ date: '2024-02-12', amount: '-40.00', recipientId: rec.aldi });
      await insertTxn({ date: '2024-03-01', amount: '-900.00', recipientId: rec.misc, isTransfer: true });
      await insertTxn({ date: '2024-03-01', amount: '900.00', recipientId: rec.misc, isTransfer: true });

      expect(await flow({})).toEqual({
        income: 3000, // pre-fix: 3900
        spending: { 'Food: Groceries': 40 }, // pre-fix: + Uncategorised 900
      });

      await getTestPool().query(
        `INSERT INTO user_settings (key, value) VALUES ('includeTransfers', 'true'::jsonb)`,
      );
      expect(await flow({})).toEqual({
        income: 3900,
        spending: { 'Food: Groceries': 40, Uncategorised: 900 },
      });
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

    it('categoryId denotes the same category categoryName names, even for a recipient-default-resolved alias', async () => {
      await seedBase();
      // Three monthly occurrences under the ALIAS, none carrying its own
      // category.id — the category comes only from the PRIMARY's default.
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
      // Pre-fix: categoryId was the raw (null) t.category_id while categoryName
      // was already resolved through the 3-level COALESCE — so a
      // recipient-default-categorised pattern reported categoryId: null beside
      // a non-null categoryName, and any consumer keying on the id (e.g. the
      // "create planned payment" POST) saw it as uncategorised.
      expect(alias.categoryId).not.toBeNull();
      const { rows } = await getTestPool().query(
        `SELECT general || ':' || detail AS name FROM categories WHERE id = $1`,
        [alias.categoryId],
      );
      expect(rows[0]?.name).toBe(alias.categoryName);
      expect(alias.categoryId).toBe(cat.Bills);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CSV / NDJSON export — services/transactionExport
  // ───────────────────────────────────────────────────────────────────────────
  describe('transaction export', () => {
    /** Category column index in the (balance-less) CSV header. */
    const CSV_CATEGORY_COL = 7;

    it('labels an alias row with the category the transactions list resolves', async () => {
      await seedAliasWithOwnDefault();
      const aliasTxn = await insertTxn({
        date: '2024-03-05',
        amount: '-11.11',
        recipientId: rec.electrabelOwnAlias,
      });
      const { effectiveCategoryId, name } = await listResolvedCategoryName(aliasTxn);
      expect(effectiveCategoryId).toBe(cat.Zzz);
      expect(name).toBe('Zzz:Last');

      const csvRes = collectingRes();
      await streamCsvExport(csvRes, buildIdListWhere([aliasTxn]));
      // [0] is the header line, [1] the single data row.
      expect(csvRes.chunks[0].split(',')[CSV_CATEGORY_COL]).toBe('Category');
      // Pre-fix: 'Bills:Utilities' — the PRIMARY's category, not the alias's.
      expect(csvRes.chunks[1].trim().split(',')[CSV_CATEGORY_COL]).toBe(name);

      const jsonRes = collectingRes();
      await streamNdjsonExport(jsonRes, buildIdListWhere([aliasTxn]));
      expect(JSON.parse(jsonRes.chunks[0]).category).toBe(name);
    });

    it("an own category_id still wins over both recipient defaults", async () => {
      await seedAliasWithOwnDefault();
      const ownTxn = await insertTxn({
        date: '2024-03-06',
        amount: '-22.22',
        recipientId: rec.electrabelOwnAlias,
        categoryId: cat.Food,
      });
      const { effectiveCategoryId, name } = await listResolvedCategoryName(ownTxn);
      expect(effectiveCategoryId).toBe(cat.Food);

      const res = collectingRes();
      await streamCsvExport(res, buildIdListWhere([ownTxn]));
      expect(res.chunks[1].trim().split(',')[CSV_CATEGORY_COL]).toBe(name);
    });

    it('still reaches the PRIMARY default when the alias has none of its own', async () => {
      await seedBase();
      const aliasTxn = await insertTxn({
        date: '2024-03-07',
        amount: '-33.33',
        recipientId: rec.electrabelAlias, // no default of its own
      });
      const { effectiveCategoryId, name } = await listResolvedCategoryName(aliasTxn);
      expect(effectiveCategoryId).toBe(cat.Bills);

      const res = collectingRes();
      await streamCsvExport(res, buildIdListWhere([aliasTxn]));
      expect(res.chunks[1].trim().split(',')[CSV_CATEGORY_COL]).toBe(name);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Owed-splits export — repositories/splitRepository
  // ───────────────────────────────────────────────────────────────────────────
  describe('getOwedExportRowsByRecipient', () => {
    it('labels an alias row with the category the transactions list resolves', async () => {
      await seedAliasWithOwnDefault();
      const aliasTxn = await insertTxn({
        date: '2024-03-05',
        amount: '-11.11',
        recipientId: rec.electrabelOwnAlias,
      });
      // rec.misc owes half of the alias-recipient transaction.
      await getTestPool().query(
        `INSERT INTO transaction_splits (transaction_id, recipient_id, amount, is_settled)
         VALUES ($1, $2, '5.00', false)`,
        [aliasTxn, rec.misc],
      );
      const { effectiveCategoryId, name } = await listResolvedCategoryName(aliasTxn);
      expect(effectiveCategoryId).toBe(cat.Zzz);

      const rows = await splitRepository.getOwedExportRowsByRecipient(rec.misc);
      expect(rows).toHaveLength(1);
      expect(rows[0].amount).toBe(5);
      // Pre-fix: 'Bills:Utilities' — the PRIMARY's category, not the alias's.
      expect(rows[0].category_name).toBe(name);
    });

    it('still reaches the PRIMARY default when the alias has none of its own', async () => {
      await seedBase();
      const aliasTxn = await insertTxn({
        date: '2024-03-05',
        amount: '-11.11',
        recipientId: rec.electrabelAlias,
      });
      await getTestPool().query(
        `INSERT INTO transaction_splits (transaction_id, recipient_id, amount, is_settled)
         VALUES ($1, $2, '4.00', false)`,
        [aliasTxn, rec.misc],
      );
      const { name } = await listResolvedCategoryName(aliasTxn);

      const rows = await splitRepository.getOwedExportRowsByRecipient(rec.misc);
      expect(rows[0].category_name).toBe(name);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Planned transactions — plannedTransactionRepository + infoRepositoryPlanned
  // ───────────────────────────────────────────────────────────────────────────
  describe('planned transactions', () => {
    // Anchored to the app-clock calendar (the anchor every window under test
    // binds — ADR-009) so it lands inside all of them: next month
    // (getPlannedExpensesNextMonth), ≤90 days out (getDueSoon) and ≤3 months
    // out (getForForecast). Resolved per seed so a suite running across
    // midnight stays consistent.
    const NEXT_MONTH_SQL = () => `(date_trunc('month', ${appTodaySql()}) + interval '1 month' + interval '4 days')::date`;

    async function seedPlanned() {
      await seedAliasWithOwnDefault();
      const aliasPlanned = await insertPlanned({
        dateSql: NEXT_MONTH_SQL(),
        amount: '-77.00',
        recipientId: rec.electrabelOwnAlias, // resolves via the ALIAS's own default
        memo: 'alias planned',
      });
      const inheritedPlanned = await insertPlanned({
        dateSql: NEXT_MONTH_SQL(),
        amount: '-55.00',
        recipientId: rec.electrabelAlias, // resolves via the PRIMARY's default
        memo: 'inherited planned',
      });
      const ownPlanned = await insertPlanned({
        dateSql: NEXT_MONTH_SQL(),
        amount: '-11.00',
        recipientId: rec.electrabelOwnAlias,
        categoryId: cat.Food, // own category_id wins over both defaults
        memo: 'own planned',
      });
      return { aliasPlanned, inheritedPlanned, ownPlanned };
    }

    it('getAll / getById / getDueSoon / getForForecast resolve all three levels', async () => {
      const { aliasPlanned, inheritedPlanned, ownPlanned } = await seedPlanned();
      // Pre-fix this repository resolved 2 levels (c → rc, no `pc` branch and
      // no `pr` join), so `inheritedPlanned` came back category_name: null.
      const expected = {
        [aliasPlanned]: 'Zzz:Last',
        [inheritedPlanned]: 'Bills:Utilities',
        [ownPlanned]: 'Food:Groceries',
      };
      const expectedRecipientNames = {
        [aliasPlanned]: 'Electrabel',
        [inheritedPlanned]: 'Electrabel',
        [ownPlanned]: 'Electrabel',
      };

      const { items } = await plannedTransactionRepository.getAll({});
      expect(Object.fromEntries(items.map((r) => [r.id, r.category_name]))).toEqual(expected);
      expect(Object.fromEntries(items.map((r) => [r.id, r.recipient_name]))).toEqual(
        expectedRecipientNames,
      );

      for (const [id, name] of Object.entries(expected)) {
        const row = await plannedTransactionRepository.getById(Number(id));
        expect(row.category_name).toBe(name);
        expect(row.recipient_name).toBe('Electrabel');
        // Where the row carries its OWN category_id, the id and the displayed
        // name must denote the same category; where it does not, the name is
        // an inherited display value and category_id is legitimately null.
        if (row.category_id != null) expect(row.category_id).toBe(cat.Food);
        else expect(name).not.toBe('Food:Groceries');
      }

      const due = await plannedTransactionRepository.getDueSoon(90);
      expect(Object.fromEntries(due.map((r) => [r.id, r.category_name]))).toEqual(expected);
      expect(Object.fromEntries(due.map((r) => [r.id, r.recipient_name]))).toEqual(
        expectedRecipientNames,
      );

      const forecast = await plannedTransactionRepository.getForForecast(3);
      expect(Object.fromEntries(forecast.map((r) => [r.id, r.category_name]))).toEqual(expected);
      expect(Object.fromEntries(forecast.map((r) => [r.id, r.recipient_name]))).toEqual(
        expectedRecipientNames,
      );
    });

    // The search clause matches the RESOLVED label: 'Utilities' reaches the row
    // categorised through the PRIMARY recipient's default (formerly unreachable
    // — the clause had no pc term) and only that row (the two siblings display
    // 'Zzz:Last' and 'Food:Groceries', even though the same pc is joined for
    // them).
    it('search matches the label a planned row actually displays', async () => {
      const { aliasPlanned, inheritedPlanned, ownPlanned } = await seedPlanned();

      const utilities = await plannedTransactionRepository.getAll({ search: 'Utilities' });
      expect(utilities.items.map((r) => r.id)).toEqual([inheritedPlanned]);

      const zzz = await plannedTransactionRepository.getAll({ search: 'Zzz:La' });
      expect(zzz.items.map((r) => r.id)).toEqual([aliasPlanned]);

      const food = await plannedTransactionRepository.getAll({ search: 'Groceries' });
      expect(food.items.map((r) => r.id)).toEqual([ownPlanned]);
    });

    it('getPlannedExpensesNextMonth categorises what its sibling repository categorises', async () => {
      const { aliasPlanned, inheritedPlanned, ownPlanned } = await seedPlanned();

      // The sibling repository is the reference surface for these rows…
      const { items } = await plannedTransactionRepository.getAll({});
      const reference = Object.fromEntries(items.map((r) => [r.id, r.category_name]));

      const result = await plannedRepository.getPlannedExpensesNextMonth('EUR');
      // Response shape is pinned elsewhere — only the name resolution changes.
      expect(Object.keys(result).sort()).toEqual(
        ['daily_data', 'month', 'period_end', 'period_start', 'summary', 'year'],
      );
      const occurrences = result.daily_data.flatMap((d) => d.transactions);
      expect(occurrences).toHaveLength(3);
      // Pre-fix: all three were null except `ownPlanned` — this site joined
      // neither rc nor pc.
      expect(Object.fromEntries(occurrences.map((t) => [t.id, t.category_name]))).toEqual(reference);
      expect(Object.fromEntries(occurrences.map((t) => [t.id, t.recipient_name]))).toEqual({
        [aliasPlanned]: 'Electrabel',
        [inheritedPlanned]: 'Electrabel',
        [ownPlanned]: 'Electrabel',
      });
      expect(reference[aliasPlanned]).toBe('Zzz:Last');
      expect(reference[inheritedPlanned]).toBe('Bills:Utilities');
      expect(reference[ownPlanned]).toBe('Food:Groceries');
    });
  });
});
