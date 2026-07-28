/**
 * Real-Postgres tests for transactionRepository.
 *
 * DB-backed complement to transactionRepositoryBehavior.test.js and
 * transactionRepositoryOrdering.test.js (which stay: they run without a DB).
 * Those suites choreograph SQL result ORDER on a mocked pool, so they assert
 * the query strings we wrote rather than the rows Postgres actually returns.
 * Everything here runs the same behaviours against a migrated schema with
 * realistic fixtures: NUMERIC amounts as strings with cents, real DATE columns
 * spanning a (leap-year) month boundary, multiple accounts and currencies,
 * alias recipients, inactive rows mixed in, and the dual-write account trigger
 * (migration 0051) live.
 *
 * Isolation strategy (per the setup/db.js contract): per-test targeted DELETEs
 * rather than a wrapping transaction — create()/update() open their own
 * withTransaction, which would nest, and the account-sync trigger's
 * INSERT ... ON CONFLICT into accounts is easier to reason about against a
 * corpus each test fully owns.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import transactionRepository from '../src/repositories/transactionRepository.js';
import { closePool } from '../src/database/connection.js';

/** 'YYYY-MM-DD' of a row's `date` column (pg returns DATE as a JS Date). */
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

// Fixture ids, repopulated by seedCorpus() before each test.
const cat = {}; // Food, Bills, Salary
const rec = {}; // delhaize, delhaizeAlias, electrabel, electrabelAlias, employer
const acc = {}; // KBC CURRENT, WISE USD
const tag = {}; // groceries (active), archived (inactive)
const T = {}; // t1..t7

/**
 * Ensure an accounts row exists for a label, returning its id. Uses the
 * 0066 normalized-identity arbiter (lower(btrim(name))) directly.
 *
 * The fixtures PRE-CREATE accounts rather than letting the sync trigger mint
 * them, because the trigger's own onboarding INSERT is currently broken at
 * head (see the 'account onboarding' test below): only the resolve path works.
 */
async function ensureAccount(name) {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
     ON CONFLICT (lower(btrim(name))) DO NOTHING`,
    [name],
  );
  const { rows } = await pool.query(
    'SELECT id FROM accounts WHERE lower(btrim(name)) = lower(btrim($1))',
    [name],
  );
  return rows[0].id;
}

/**
 * Insert one transaction through plain SQL (NOT the repository, so repository
 * behaviour is never asserted against itself). `bank_account` is written as
 * the raw string and account_id left NULL: the trg_transactions_account_sync
 * trigger resolves the account exactly as production inserts do (the account
 * row itself is pre-created — see ensureAccount).
 */
async function insertTxn({
  date,
  amount,
  currency = 'EUR',
  recipientId,
  categoryId = null,
  bank = 'KBC CURRENT',
  memo = null,
  isActive = true,
  isTransfer = false,
}) {
  if (bank) await ensureAccount(bank);
  const { rows } = await getTestPool().query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, bank_account, memo, is_active, is_transfer)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [date, amount, currency, recipientId, categoryId, bank, memo, isActive, isTransfer],
  );
  return rows[0].id;
}

/**
 * Shared corpus. Dates straddle the Feb→Mar 2024 boundary (2024 is a leap
 * year, so 2024-02-29 is a real day); amounts are NUMERIC strings with cents;
 * expenses are negative; two accounts and two currencies; one inactive row.
 *
 *   t1 2024-02-27  -52.30 EUR  delhaizeAlias  (no category anywhere → uncategorised)
 *   t7 2024-02-28  -30.00 EUR  electrabel     (category via recipient default)
 *   t2 2024-02-29  -18.75 EUR  delhaize       (own category Food)
 *   t3 2024-03-01 -120.00 EUR  electrabelAlias (category via PRIMARY's default — 3rd level)
 *   t4 2024-03-01 2500.00 EUR  employer       (income, category via recipient default)
 *   t5 2024-03-02  -45.10 USD  delhaize       (own category Food, WISE USD account)
 *   t6 2024-03-02   -9.99 EUR  delhaize       (INACTIVE — must be invisible everywhere)
 */
async function seedCorpus() {
  const pool = getTestPool();

  for (const [key, [general, detail]] of Object.entries({
    Food: ['Food', 'Groceries'],
    Bills: ['Bills', 'Utilities'],
    Salary: ['Income', 'Salary'],
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
  rec.delhaize = await addRecipient('Delhaize');
  rec.delhaizeAlias = await addRecipient('Delhaize BXL', { primaryId: rec.delhaize });
  rec.electrabel = await addRecipient('Electrabel', { defaultCategoryId: cat.Bills });
  rec.electrabelAlias = await addRecipient('Electrabel Invoicing', { primaryId: rec.electrabel });
  rec.employer = await addRecipient('Acme Payroll', { defaultCategoryId: cat.Salary });

  for (const [key, [slug, color, isActive]] of Object.entries({
    groceries: ['groceries', '#0a0', true],
    archived: ['archived', '#999', false],
  })) {
    const { rows } = await pool.query(
      'INSERT INTO tags (slug, color, is_active) VALUES ($1, $2, $3) RETURNING id',
      [slug, color, isActive],
    );
    tag[key] = rows[0].id;
  }

  T.t1 = await insertTxn({ date: '2024-02-27', amount: '-52.30', recipientId: rec.delhaizeAlias, memo: 'CARD PAYMENT DELHAIZE' });
  T.t2 = await insertTxn({ date: '2024-02-29', amount: '-18.75', recipientId: rec.delhaize, categoryId: cat.Food, memo: 'DELHAIZE BXL' });
  T.t3 = await insertTxn({ date: '2024-03-01', amount: '-120.00', recipientId: rec.electrabelAlias, memo: 'ELECTRABEL INVOICE 2024' });
  T.t4 = await insertTxn({ date: '2024-03-01', amount: '2500.00', recipientId: rec.employer, memo: 'SALARY FEBRUARY' });
  T.t5 = await insertTxn({ date: '2024-03-02', amount: '-45.10', currency: 'USD', recipientId: rec.delhaize, categoryId: cat.Food, bank: 'WISE USD', memo: 'DELHAIZE US' });
  T.t6 = await insertTxn({ date: '2024-03-02', amount: '-9.99', recipientId: rec.delhaize, memo: 'DELHAIZE GHOST', isActive: false });
  T.t7 = await insertTxn({ date: '2024-02-28', amount: '-30.00', recipientId: rec.electrabel, memo: 'ELECTRABEL DOMICILIERING' });

  // Account ids as resolved by the dual-write trigger.
  const accounts = await pool.query('SELECT id, name FROM accounts');
  for (const row of accounts.rows) acc[row.name] = row.id;

  await pool.query(
    'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2), ($1, $3), ($4, $2)',
    [T.t1, tag.groceries, tag.archived, T.t2],
  );
}

describe.skipIf(!hasTestDatabase())('repositories/transactionRepository (real DB)', () => {
  beforeAll(async () => {
    expect(
      process.env.DATABASE_URL,
      'DATABASE_URL must equal TEST_DATABASE_URL for this suite (see scripts/with-test-db.sh)',
    ).toBe(process.env.TEST_DATABASE_URL);
    // DB suites share one database across parallel vitest workers — serialize.
    await acquireDbSuiteLock();
  }, 180_000);

  beforeEach(seedCorpus);

  afterEach(async () => {
    const pool = getTestPool();
    // FK order: executions → planned → junction → transactions → the rest.
    // (transactions.account_id is ON DELETE RESTRICT, so accounts go after.)
    await pool.query('DELETE FROM planned_transaction_executions');
    await pool.query('DELETE FROM planned_transactions');
    await pool.query('DELETE FROM transaction_tags');
    await pool.query('DELETE FROM transactions');
    await pool.query('DELETE FROM tags');
    await pool.query('DELETE FROM accounts');
    await pool.query('DELETE FROM recipients');
    await pool.query('DELETE FROM categories');
    for (const bag of [cat, rec, acc, tag, T]) for (const k of Object.keys(bag)) delete bag[k];
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getAll — enrichment, ordering, filters
  // ───────────────────────────────────────────────────────────────────────────
  describe('getAll', () => {
    it('returns active rows ordered date DESC, id DESC with real NUMERIC/DATE types', async () => {
      const rows = await transactionRepository.getAll({});
      expect(rows.map((r) => r.id)).toEqual([T.t5, T.t4, T.t3, T.t2, T.t7, T.t1]);
      const t2 = rows.find((r) => r.id === T.t2);
      // pg NUMERIC arrives as a string, at the column's scale: NUMERIC(18,4).
      expect(t2.amount).toBe('-18.7500');
      expect(ymd(t2.date)).toBe('2024-02-29'); // leap day survives the DATE round-trip
      expect(t2.currency).toBe('EUR');
    });

    it('resolves recipient_name and the 3-level effective category for alias rows', async () => {
      const rows = await transactionRepository.getAll({});
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      // Alias rows display the PRIMARY's name.
      expect(byId[T.t1].recipient_name).toBe('Delhaize');
      expect(byId[T.t3].recipient_name).toBe('Electrabel');
      // Effective category: own → recipient default → primary default → null.
      expect(byId[T.t2].effective_category_id).toBe(cat.Food);
      expect(byId[T.t7].effective_category_id).toBe(cat.Bills);
      expect(byId[T.t3].effective_category_id).toBe(cat.Bills); // via the PRIMARY's default
      expect(byId[T.t3].category_name).toBe('Bills:Utilities');
      expect(byId[T.t1].effective_category_id).toBeNull();
      expect(byId[T.t1].category_name).toBeNull();
    });

    it('attaches tags per row (junction truth, inactive tags included) and [] otherwise', async () => {
      const rows = await transactionRepository.getAll({});
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[T.t1].tags.map((t) => t.slug).sort()).toEqual(['archived', 'groceries']);
      expect(byId[T.t1].tags.find((t) => t.slug === 'archived').is_active).toBe(false);
      expect(byId[T.t2].tags).toEqual([
        { id: tag.groceries, slug: 'groceries', color: '#0a0', is_active: true },
      ]);
      expect(byId[T.t4].tags).toEqual([]);
    });

    it('filters by accountId (FK, trigger-resolved) and bankAccount (ILIKE substring)', async () => {
      const wise = await transactionRepository.getAll({ accountId: acc['WISE USD'] });
      expect(wise.map((r) => r.id)).toEqual([T.t5]);
      const kbc = await transactionRepository.getAll({ bankAccount: 'kbc' });
      expect(kbc.map((r) => r.id)).toEqual([T.t4, T.t3, T.t2, T.t7, T.t1]);
    });

    it('applies inclusive date bounds across the month boundary', async () => {
      const march = await transactionRepository.getAll({ startDate: '2024-03-01' });
      expect(march.map((r) => r.id)).toEqual([T.t5, T.t4, T.t3]);
      const feb = await transactionRepository.getAll({ endDate: '2024-02-29' });
      expect(feb.map((r) => r.id)).toEqual([T.t2, T.t7, T.t1]);
    });

    it('recipientId matches the recipient AND aliases under it; alias id matches only itself', async () => {
      const group = await transactionRepository.getAll({ recipientId: rec.delhaize });
      expect(group.map((r) => r.id)).toEqual([T.t5, T.t2, T.t1]); // t1 recorded under the alias
      const aliasOnly = await transactionRepository.getAll({ recipientId: rec.delhaizeAlias });
      expect(aliasOnly.map((r) => r.id)).toEqual([T.t1]);
      // recipientGroupId from the ALIAS resolves the whole primary group.
      const fullGroup = await transactionRepository.getAll({ recipientGroupId: rec.delhaizeAlias });
      expect(fullGroup.map((r) => r.id)).toEqual([T.t5, T.t2, T.t1]);
    });

    it('sorts by amount numerically, not lexicographically', async () => {
      const rows = await transactionRepository.getAll({ sortBy: 'amount', sortDir: 'asc' });
      // A string sort would put '-120.0000' between '-18.7500' and '-30.0000'.
      expect(rows.map((r) => r.amount)).toEqual([
        '-120.0000', '-52.3000', '-45.1000', '-30.0000', '-18.7500', '2500.0000',
      ]);
    });

    it('computes running_balance as a per-account ledger (partitioned, date ASC over the filtered set)', async () => {
      const rows = await transactionRepository.getAll({ includeBalance: true });
      const rb = Object.fromEntries(rows.map((r) => [r.id, Number(r.running_balance)]));
      // KBC CURRENT: -52.30 → -82.30 → -101.05 → -221.05 → +2278.95 (date ASC, id ASC)
      expect(rb[T.t1]).toBe(-52.3);
      expect(rb[T.t7]).toBe(-82.3);
      expect(rb[T.t2]).toBe(-101.05);
      expect(rb[T.t3]).toBe(-221.05);
      expect(rb[T.t4]).toBe(2278.95);
      // WISE USD is its own partition — NOT a continuation of KBC's sum.
      expect(rb[T.t5]).toBe(-45.1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Pagination — the tiebreaker behaviour the ordering suite pins as SQL text
  // ───────────────────────────────────────────────────────────────────────────
  describe('pagination tiebreaker', () => {
    it('never duplicates or skips same-date rows across pages', async () => {
      // Five more rows all on one date: only the id tiebreaker orders them.
      const sameDay = [];
      for (let i = 0; i < 5; i++) {
        sameDay.push(await insertTxn({
          date: '2024-03-05',
          amount: `-${i + 1}.00`,
          recipientId: rec.delhaize,
        }));
      }
      const seen = [];
      for (let offset = 0; offset < 11; offset += 2) {
        const page = await transactionRepository.getAll({ limit: 2, offset });
        seen.push(...page.map((r) => r.id));
      }
      expect(seen).toHaveLength(11);
      expect(new Set(seen).size).toBe(11); // no duplicates
      expect(seen.slice(0, 5)).toEqual([...sameDay].reverse()); // id DESC within the date
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getCount / getAllWithCount
  // ───────────────────────────────────────────────────────────────────────────
  describe('getCount', () => {
    it('counts active rows by default and everything with active:false', async () => {
      expect(await transactionRepository.getCount({})).toBe(6);
      expect(await transactionRepository.getCount({ active: false })).toBe(7);
    });

    it('counts by effective category across all three levels', async () => {
      // Bills: t7 (recipient default) + t3 (primary's default via alias).
      expect(await transactionRepository.getCount({ categoryId: cat.Bills })).toBe(2);
      expect(await transactionRepository.getCount({ categoryId: cat.Food })).toBe(2);
    });
  });

  describe('getAllWithCount', () => {
    it('returns a page of rows with the total over the whole filtered set', async () => {
      const { rows, total } = await transactionRepository.getAllWithCount({ limit: 2, offset: 0 });
      expect(rows.map((r) => r.id)).toEqual([T.t5, T.t4]);
      expect(total).toBe(6);
    });

    it('splits income from expenses by amount sign', async () => {
      const income = await transactionRepository.getAllWithCount({ transactionType: 'income' });
      expect(income.rows.map((r) => r.id)).toEqual([T.t4]);
      expect(income.total).toBe(1);
      const expense = await transactionRepository.getAllWithCount({ transactionType: 'expense' });
      expect(expense.total).toBe(5);
    });

    it('amount bounds compare magnitude by default and the signed amount when amountSigned', async () => {
      const magnitude = await transactionRepository.getAllWithCount({ amountMin: 50 });
      expect(magnitude.rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(
        [T.t1, T.t3, T.t4].sort((a, b) => a - b), // |−52.30|, |−120|, |2500|
      );
      const signed = await transactionRepository.getAllWithCount({ amountMax: -100, amountSigned: true });
      expect(signed.rows.map((r) => r.id)).toEqual([T.t3]); // only −120.00 ≤ −100
    });

    it('categoryIds matches the effective category (own / recipient default / primary default)', async () => {
      const { rows, total } = await transactionRepository.getAllWithCount({
        categoryIds: [cat.Food, cat.Salary],
      });
      expect(total).toBe(3);
      expect(rows.map((r) => r.id)).toEqual([T.t5, T.t4, T.t2]);
    });

    it('tagSlugs matches rows via ACTIVE tags only', async () => {
      const groceries = await transactionRepository.getAllWithCount({ tagSlugs: ['groceries'] });
      expect(groceries.rows.map((r) => r.id)).toEqual([T.t2, T.t1]);
      // The inactive tag is attached to t1's row payload (see getAll test) but
      // deliberately does NOT match as a filter.
      const archived = await transactionRepository.getAllWithCount({ tagSlugs: ['archived'] });
      expect(archived.total).toBe(0);
    });

    it('free-text search spans memo, recipient (incl. primary), category and amount text', async () => {
      const byName = await transactionRepository.getAllWithCount({ search: 'delhaize' });
      expect(byName.rows.map((r) => r.id)).toEqual([T.t5, T.t2, T.t1]); // t6 inactive stays out
      const byCategory = await transactionRepository.getAllWithCount({ search: 'utilities' });
      expect(byCategory.rows.map((r) => r.id)).toEqual([T.t3, T.t7]);
      const byAmount = await transactionRepository.getAllWithCount({ search: '2500' });
      expect(byAmount.rows.map((r) => r.id)).toEqual([T.t4]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Uncategorised queue — the alias-regression the mock suite pins as SQL text
  // ───────────────────────────────────────────────────────────────────────────
  describe('getUncategorised / getUncategorisedWithCount', () => {
    it('lists only rows whose FULL 3-level effective category is NULL', async () => {
      const rows = await transactionRepository.getUncategorised({});
      // t3 (alias whose primary carries a default) must NOT leak into the
      // queue — the regression that motivated the 3-level predicate. t6 is
      // uncategorised too but inactive.
      expect(rows.map((r) => r.id)).toEqual([T.t1]);
    });

    it('supports recipientName / bankAccount narrowing', async () => {
      const hit = await transactionRepository.getUncategorised({ recipientName: 'delh' });
      expect(hit.map((r) => r.id)).toEqual([T.t1]);
      const miss = await transactionRepository.getUncategorised({ bankAccount: 'wise' });
      expect(miss).toEqual([]);
    });

    it('getUncategorisedWithCount: rows are uncategorised, total keeps full getCount semantics', async () => {
      const { rows, total } = await transactionRepository.getUncategorisedWithCount({});
      expect(rows.map((r) => r.id)).toEqual([T.t1]);
      expect(total).toBe(6); // documented asymmetry: total counts ALL active rows
    });

    it('returns total 0 and no rows when nothing matches', async () => {
      const res = await transactionRepository.getUncategorisedWithCount({ recipientName: 'nobody-here' });
      expect(res).toEqual({ rows: [], total: 0 });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getById / create / update / hardDelete
  // ───────────────────────────────────────────────────────────────────────────
  describe('getById', () => {
    it('returns the enriched row and null for a missing id', async () => {
      const row = await transactionRepository.getById(T.t3);
      expect(row).toMatchObject({
        id: T.t3,
        recipient_name: 'Electrabel',
        effective_category_id: cat.Bills,
        category_name: 'Bills:Utilities',
        tags: [],
      });
      expect(await transactionRepository.getById(T.t7 + 100_000)).toBeNull();
    });
  });

  describe('create', () => {
    it('uppercases bank/memo/currency, and the trigger resolves the account case-insensitively', async () => {
      // Pre-existing account stored with different casing than the write.
      const revolutId = await ensureAccount('Revolut Main');
      const row = await transactionRepository.create({
        transaction_date: '2024-03-10',
        bank_account: 'revolut main',
        recipient_id: rec.delhaize,
        amount: '-3.20',
        memo: 'coffee',
        currency: 'usd',
        category_id: null,
        comment: 'espresso',
      });
      expect(row).toMatchObject({
        bank_account: 'REVOLUT MAIN',
        memo: 'COFFEE',
        currency: 'USD',
        amount: '-3.2000',
        comment: 'espresso',
        is_active: true,
        tags: [],
      });
      expect(row.balance).toBeNull(); // manual rows never carry a bank stamp
      // 'REVOLUT MAIN' reuses 'Revolut Main' instead of minting a twin (0076 fix #2).
      expect(row.account_id).toBe(revolutId);
      const { rows } = await getTestPool().query(
        `SELECT count(*)::int AS n FROM accounts WHERE lower(name) = 'revolut main'`,
      );
      expect(rows[0].n).toBe(1);
    });

    // BUG (pinning current behaviour, flagged for the orchestrator):
    // account ONBOARDING via the sync trigger is broken at schema head.
    // Migration 0066 dropped uq_accounts_name (raw-name unique constraint) in
    // favour of the expression index uq_accounts_name_norm on
    // lower(btrim(name)) — and its trigger correctly targeted
    // `ON CONFLICT (lower(btrim(name)))`. The later trigger rewrite in 0076
    // regressed the arbiter back to `ON CONFLICT (name)`, which no longer
    // matches ANY unique index, so the first INSERT of a transaction whose
    // bank_account label has no existing account raises 42P10 ("there is no
    // unique or exclusion constraint matching the ON CONFLICT specification").
    // Every existing-label write still works (the resolve path short-circuits
    // before the INSERT); only first-seen labels — new-account onboarding,
    // e.g. importing a CSV for a brand-new account — blow up. No mock suite
    // could see this: the arbiter is only validated when the trigger actually
    // executes against the real schema.
    it('rejects a transaction whose bank label would onboard a NEW account (0076 ON CONFLICT regression)', async () => {
      await expect(
        transactionRepository.create({
          transaction_date: '2024-03-10',
          bank_account: 'BRAND NEW BANK',
          recipient_id: rec.delhaize,
          amount: '-1.00',
          category_id: null,
          comment: null,
        }),
      ).rejects.toThrow(/no unique or exclusion constraint matching the ON CONFLICT/i);
      const { rows } = await getTestPool().query(
        `SELECT 1 FROM accounts WHERE name = 'BRAND NEW BANK'`,
      );
      expect(rows).toEqual([]); // nothing was onboarded
    });

    it('defaults currency to EUR and nulls bank/memo when absent', async () => {
      const row = await transactionRepository.create({
        transaction_date: '2024-03-10',
        recipient_id: rec.delhaize,
        amount: '5.00',
        category_id: null,
        comment: null,
      });
      expect(row.currency).toBe('EUR');
      expect(row.bank_account).toBeNull();
      expect(row.memo).toBeNull();
      expect(row.account_id).toBeNull(); // no bank string → trigger leaves the FK alone
    });

    it('resolves the effective category through the recipient on the returned row', async () => {
      const row = await transactionRepository.create({
        transaction_date: '2024-03-10',
        recipient_id: rec.electrabelAlias,
        amount: '-77.77',
        category_id: null,
        comment: null,
      });
      expect(row.recipient_name).toBe('Electrabel');
      expect(row.effective_category_id).toBe(cat.Bills);
      expect(row.category_name).toBe('Bills:Utilities');
    });

    it('sets tags atomically, silently dropping inactive/unknown slugs', async () => {
      const row = await transactionRepository.create({
        transaction_date: '2024-03-10',
        recipient_id: rec.delhaize,
        amount: '-8.00',
        category_id: null,
        comment: null,
        tags: ['groceries', 'archived', 'does-not-exist'],
      });
      expect(row.tags.map((t) => t.slug)).toEqual(['groceries']);
      const { rows } = await getTestPool().query(
        'SELECT tag_id FROM transaction_tags WHERE transaction_id = $1', [row.id],
      );
      expect(rows).toEqual([{ tag_id: tag.groceries }]);
    });
  });

  describe('update', () => {
    it('maps transaction_date → date and persists NUMERIC edits', async () => {
      const row = await transactionRepository.update(T.t1, {
        transaction_date: '2024-03-15',
        amount: '-60.00',
      });
      expect(ymd(row.date)).toBe('2024-03-15');
      expect(row.amount).toBe('-60.0000');
      expect(row.updated_at).not.toBeNull();
      const { rows } = await getTestPool().query(
        'SELECT date, amount FROM transactions WHERE id = $1', [T.t1],
      );
      expect(ymd(rows[0].date)).toBe('2024-03-15');
      expect(rows[0].amount).toBe('-60.0000');
    });

    it('returns null for a missing id, with fields and tags-only alike', async () => {
      expect(await transactionRepository.update(T.t7 + 100_000, { amount: '1.00' })).toBeNull();
      expect(await transactionRepository.update(T.t7 + 100_000, { tags: ['groceries'] })).toBeNull();
      // The tags-only 404 probe must not have leaked a junction row (FK 23503 → 500 bug).
      const { rows } = await getTestPool().query(
        'SELECT 1 FROM transaction_tags WHERE transaction_id = $1', [T.t7 + 100_000],
      );
      expect(rows).toEqual([]);
    });

    it('tags-only PATCH replaces the junction set', async () => {
      const row = await transactionRepository.update(T.t1, { tags: ['groceries'] });
      expect(row.tags.map((t) => t.slug)).toEqual(['groceries']); // 'archived' junction removed
      const cleared = await transactionRepository.update(T.t1, { tags: [] });
      expect(cleared.tags).toEqual([]);
    });

    it('no writable fields and no tags falls back to the current row', async () => {
      const row = await transactionRepository.update(T.t2, {});
      expect(row.id).toBe(T.t2);
      expect(row.amount).toBe('-18.7500');
    });

    // POSSIBLE BUG (pinning current behaviour, flagged for the orchestrator):
    // update()'s RETURNING enrichment joins only 2 category levels (own +
    // recipient default) — unlike getById/getAll/create, which resolve 3
    // levels. For a row categorised via its PRIMARY recipient's default, the
    // update response reports category_name NULL even though a follow-up GET
    // shows 'Bills:Utilities'. The mocked suite could never see this because
    // its fixtures echoed whatever the mocked UPDATE CTE returned.
    it('update() response resolves only 2 category levels — diverges from getById on alias rows', async () => {
      const updated = await transactionRepository.update(T.t3, { amount: '-121.00' });
      expect(updated.category_name).toBeNull(); // ← current (likely buggy) behaviour
      expect(updated.recipient_name).toBe('Electrabel Invoicing'); // r.name, not COALESCE(pr.name, r.name)
      const fetched = await transactionRepository.getById(T.t3);
      expect(fetched.category_name).toBe('Bills:Utilities'); // the same row, via GET
      expect(fetched.recipient_name).toBe('Electrabel');
    });
  });

  describe('hardDelete', () => {
    it('deletes exactly once (junction rows cascade)', async () => {
      expect(await transactionRepository.hardDelete(T.t1)).toBe(true);
      expect(await transactionRepository.hardDelete(T.t1)).toBe(false);
      const { rows } = await getTestPool().query(
        'SELECT 1 FROM transaction_tags WHERE transaction_id = $1', [T.t1],
      );
      expect(rows).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // listRecentUnlinked — NOT EXISTS against planned_transaction_executions
  // ───────────────────────────────────────────────────────────────────────────
  describe('listRecentUnlinked', () => {
    it('excludes already-linked and inactive rows, resolves the recipient cluster root', async () => {
      const pool = getTestPool();
      const planned = await pool.query(
        `INSERT INTO planned_transactions (planned_date, amount, recipient_id)
         VALUES ('2024-02-29', '-18.75', $1) RETURNING id`,
        [rec.delhaize],
      );
      await pool.query(
        `INSERT INTO planned_transaction_executions (planned_transaction_id, executed_transaction_id, execution_date)
         VALUES ($1, $2, '2024-02-29')`,
        [planned.rows[0].id, T.t2],
      );

      const rows = await transactionRepository.listRecentUnlinked({ sinceDate: '2024-02-28' });
      // t1 predates sinceDate, t2 is linked, t6 is inactive.
      expect(rows.map((r) => r.id)).toEqual([T.t5, T.t4, T.t3, T.t7]);
      const t3 = rows.find((r) => r.id === T.t3);
      expect(t3.recipient_cluster_id).toBe(rec.electrabel); // alias resolves to its primary
      expect(t3.recipient_name).toBe('Electrabel Invoicing'); // but the row keeps its own name
      expect(t3.amount).toBe('-120.0000');
    });
  });
});
