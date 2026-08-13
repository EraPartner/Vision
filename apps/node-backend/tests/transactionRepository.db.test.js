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
 * them, so corpus setup stays independent of the trigger under test. (The
 * trigger's own onboarding path — once broken at head by the 0076 ON CONFLICT
 * regression, fixed by migration 0083 — has its own dedicated test below.)
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

    // The recipientGroupId predicate was rewritten from an OR spanning
    // `t.recipient_id` and the joined `r.primary_recipient_id` into a single
    // semi-join over `recipients`. These pin the RESULT SET (not the SQL text)
    // for every position a recipient can occupy in the alias hierarchy, so a
    // silently narrowed or widened filter fails here rather than in production.
    it('recipientGroupId resolves the same group from the primary, the alias, and a sibling', async () => {
      const fromPrimary = await transactionRepository.getAll({ recipientGroupId: rec.delhaize });
      const fromAlias = await transactionRepository.getAll({ recipientGroupId: rec.delhaizeAlias });
      // Both directions see the whole Delhaize group: t1 sits on the alias,
      // t2/t5 on the primary. t6 is inactive and stays out of both.
      expect(fromPrimary.map((r) => r.id)).toEqual([T.t5, T.t2, T.t1]);
      expect(fromAlias.map((r) => r.id)).toEqual([T.t5, T.t2, T.t1]);

      // Second group, to prove the filter is not just "everything".
      expect((await transactionRepository.getAll({ recipientGroupId: rec.electrabel })).map((r) => r.id))
        .toEqual([T.t3, T.t7]);
      expect((await transactionRepository.getAll({ recipientGroupId: rec.electrabelAlias })).map((r) => r.id))
        .toEqual([T.t3, T.t7]);

      // Standalone recipient — no primary, no aliases — matches only its own rows.
      expect((await transactionRepository.getAll({ recipientGroupId: rec.employer })).map((r) => r.id))
        .toEqual([T.t4]);
    });

    it('recipientGroupId excludes non-members and yields nothing for an unknown id', async () => {
      const rows = await transactionRepository.getAll({ recipientGroupId: rec.delhaize });
      // Cross-group rows must not leak in.
      expect(rows.map((r) => r.id)).not.toContain(T.t3);
      expect(rows.map((r) => r.id)).not.toContain(T.t4);
      expect(rows.map((r) => r.id)).not.toContain(T.t7);
      // An id no recipient has resolves to the empty set (not to "all rows").
      expect(await transactionRepository.getAll({ recipientGroupId: 9_999_999 })).toEqual([]);
    });

    it('recipientGroupId honours inactive rows and composes with other filters', async () => {
      const withInactive = await transactionRepository.getAll({ recipientGroupId: rec.delhaize, active: false });
      // t5/t6 share 2024-03-02, so the t.id DESC tiebreaker puts t6 first.
      expect(withInactive.map((r) => r.id)).toEqual([T.t6, T.t5, T.t2, T.t1]);
      // Combined with a date bound and a count, sharing one $-parameter sequence.
      const march = await transactionRepository.getAll({ recipientGroupId: rec.delhaize, startDate: '2024-03-01' });
      expect(march.map((r) => r.id)).toEqual([T.t5]);
      expect(await transactionRepository.getCount({ recipientGroupId: rec.delhaize })).toBe(3);
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
  describe('ADR-088 string decouple (reads bind to account_id, never the string)', () => {
    // Falsification setup: desynchronize one row's stale string from its FK.
    // A raw-SQL UPDATE to a label with no matching account leaves account_id
    // untouched (the 0062 lookup-only trigger never creates on UPDATE), so
    // the row ends with bank_account='STALE LABEL' while still pointing at
    // KBC CURRENT. Every read below must follow the FK, not the string.
    async function desyncT1() {
      await getTestPool().query(
        `UPDATE transactions SET bank_account = 'STALE LABEL' WHERE id = $1`, [T.t1],
      );
      const { rows } = await getTestPool().query(
        'SELECT account_id, bank_account FROM transactions WHERE id = $1', [T.t1],
      );
      expect(rows[0].account_id).toBe(acc['KBC CURRENT']);
      expect(rows[0].bank_account).toBe('STALE LABEL');
    }

    it('bankAccount filter matches via accounts.name, not the row string', async () => {
      await desyncT1();
      const kbc = await transactionRepository.getAll({ bankAccount: 'kbc' });
      expect(kbc.map((r) => r.id)).toContain(T.t1); // FK still points at KBC
      const stale = await transactionRepository.getAll({ bankAccount: 'stale' });
      expect(stale).toHaveLength(0); // no account is named that
    });

    it('projects bank_account from accounts.name across getAll/getById/getAllWithCount/getUncategorised', async () => {
      await desyncT1();
      const all = await transactionRepository.getAll({});
      expect(all.find((r) => r.id === T.t1).bank_account).toBe('KBC CURRENT');
      expect((await transactionRepository.getById(T.t1)).bank_account).toBe('KBC CURRENT');
      const { rows } = await transactionRepository.getAllWithCount({});
      expect(rows.find((r) => r.id === T.t1).bank_account).toBe('KBC CURRENT');
      const unc = await transactionRepository.getUncategorised({});
      expect(unc.find((r) => r.id === T.t1).bank_account).toBe('KBC CURRENT');
    });

    it('free-text search matches the account name, not the stale string', async () => {
      await desyncT1();
      const byName = await transactionRepository.getAll({ search: 'kbc curr' });
      expect(byName.map((r) => r.id)).toContain(T.t1);
      const byStale = await transactionRepository.getAll({ search: 'stale lab' });
      expect(byStale).toHaveLength(0);
    });

    it('sorts by the canonical account name', async () => {
      // 'KBC CURRENT' < 'WISE USD'; the stale string ('STALE LABEL') would
      // order t1 between them and betray a string-backed sort.
      await desyncT1();
      const rows = await transactionRepository.getAll({ sortBy: 'bank', sortDir: 'asc' });
      const banks = rows.map((r) => r.bank_account);
      expect(banks).toEqual([...banks].sort());
      expect(rows[rows.length - 1].bank_account).toBe('WISE USD');
      expect(banks).toContain('KBC CURRENT');
      expect(banks).not.toContain('STALE LABEL');
    });

    it('projects null for rows with no account', async () => {
      const { rows } = await getTestPool().query(
        `INSERT INTO transactions (date, amount, currency, recipient_id)
         VALUES ('2024-03-03', -1.00, 'EUR', $1) RETURNING id`,
        [rec.delhaize],
      );
      const row = await transactionRepository.getById(rows[0].id);
      expect(row.bank_account).toBeNull();
      expect(row.account_id).toBeNull();
    });
  });

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

    // The total CTE was narrowed from the full 6-way TRANSACTION_JOINS to just
    // `LEFT JOIN recipients r`. Every join dropped is a LEFT JOIN onto a PRIMARY
    // KEY, so none can drop or duplicate a transaction — but that is an argument,
    // not evidence. These cases pin the NUMBER against the independently-built
    // getCount() over the FULL join set, across every filter the endpoint takes.
    it('total equals getCount() over the full join set, for every filter shape', async () => {
      const shapes = [
        {},
        { active: false },
        { startDate: '2024-03-01' },
        { endDate: '2024-02-29' },
        { startDate: '2024-02-01', endDate: '2024-03-31', active: false },
        { accountId: acc['KBC CURRENT'] },
        { bankAccount: 'wise' },
        { categoryId: cat.Food },
        { categoryId: cat.Bills },
        { recipientId: rec.delhaize },
        { recipientId: rec.electrabelAlias, active: false },
        { recipientName: 'delh' },
        { recipientName: 'Electrabel Invoicing' },
        { recipientName: 'nobody' },
        { search: 'DELHAIZE' },
        { search: 'ELECTRABEL' },
        { search: 'groceries' },
        { search: '2024-03' },
        { search: '-52.30' },
        { transactionId: T.t1 },
        { recipientName: 'delh', search: 'DELHAIZE', startDate: '2024-01-01', active: false },
      ];
      for (const shape of shapes) {
        const { total } = await transactionRepository.getUncategorisedWithCount(shape);
        const expected = await transactionRepository.getCount(shape);
        expect(total, `total mismatch for ${JSON.stringify(shape)}`).toBe(expected);
      }
    });

    // Six filters the route (parseTransactionListQuery) has always passed were
    // dropped on the floor by this function's destructure, so the uncategorised
    // queue and its total were computed over a WIDER set than the user asked
    // for. The extra corpus below exists so each case can be answered by rows
    // that differ from a sibling in exactly ONE dimension — a filter that is
    // still ignored cannot pass any of these by accident.
    describe('the route-supplied filters narrow rows AND total', () => {
      const U = {};
      let bakery;

      beforeEach(async () => {
        const { rows } = await getTestPool().query(
          "INSERT INTO recipients (name, normalized_name) VALUES ('Bakery', 'bakery') RETURNING id",
        );
        bakery = rows[0].id;
        // Bakery has no default category and no primary, so all three rows are
        // uncategorised — they differ only in amount/sign, and none is tagged.
        U.small = await insertTxn({ date: '2024-03-05', amount: '-5.00', recipientId: bakery, memo: 'BAKERY SMALL' });
        U.big = await insertTxn({ date: '2024-03-06', amount: '-300.00', recipientId: bakery, memo: 'BAKERY BIG' });
        U.income = await insertTxn({ date: '2024-03-07', amount: '900.00', recipientId: bakery, memo: 'BAKERY REFUND' });
      });

      it('baseline: four uncategorised rows, total over all nine active rows', async () => {
        const { rows, total } = await transactionRepository.getUncategorisedWithCount({});
        expect(rows.map((r) => r.id)).toEqual([U.income, U.big, U.small, T.t1]);
        expect(total).toBe(9);
      });

      it('amountMin narrows both halves (magnitude by default)', async () => {
        const { rows, total } = await transactionRepository.getUncategorisedWithCount({ amountMin: 100 });
        expect(rows.map((r) => r.id)).toEqual([U.income, U.big]); // |900|, |−300|
        expect(total).toBe(4); // t3 (−120), t4 (2500), U.big, U.income
      });

      it('amountMax narrows both halves', async () => {
        const { rows, total } = await transactionRepository.getUncategorisedWithCount({ amountMax: 20 });
        expect(rows.map((r) => r.id)).toEqual([U.small]); // |−5.00|
        expect(total).toBe(2); // t2 (−18.75), U.small
      });

      it('amountMin+amountMax bracket a range, and amountSigned flips to the signed amount', async () => {
        const bracket = await transactionRepository.getUncategorisedWithCount({ amountMin: 40, amountMax: 100 });
        expect(bracket.rows.map((r) => r.id)).toEqual([T.t1]); // |−52.30|
        expect(bracket.total).toBe(2); // t1, t5 (−45.10)

        // Same bound, signed: −52.30 is no longer ≥ 40, only the +900 row is.
        const signed = await transactionRepository.getUncategorisedWithCount({ amountMin: 40, amountSigned: true });
        expect(signed.rows.map((r) => r.id)).toEqual([U.income]);
        expect(signed.total).toBe(2); // t4 (2500), U.income
      });

      it('transactionType narrows both halves', async () => {
        const income = await transactionRepository.getUncategorisedWithCount({ transactionType: 'income' });
        expect(income.rows.map((r) => r.id)).toEqual([U.income]);
        expect(income.total).toBe(2); // t4, U.income

        const expense = await transactionRepository.getUncategorisedWithCount({ transactionType: 'expense' });
        expect(expense.rows.map((r) => r.id)).toEqual([U.big, U.small, T.t1]);
        expect(expense.total).toBe(7); // every active row except t4 and U.income
      });

      it('tagSlugs narrows both halves, via ACTIVE tags only', async () => {
        const groceries = await transactionRepository.getUncategorisedWithCount({ tagSlugs: ['groceries'] });
        expect(groceries.rows.map((r) => r.id)).toEqual([T.t1]); // the only tagged uncategorised row
        expect(groceries.total).toBe(2); // t1, t2

        // `archived` exists on t1 but is an inactive tag — it must match nothing.
        const archived = await transactionRepository.getUncategorisedWithCount({ tagSlugs: ['archived'] });
        expect(archived).toEqual({ rows: [], total: 0 });
      });

      it('recipientGroupId narrows both halves and resolves the whole primary group', async () => {
        const viaPrimary = await transactionRepository.getUncategorisedWithCount({ recipientGroupId: rec.delhaize });
        expect(viaPrimary.rows.map((r) => r.id)).toEqual([T.t1]); // t1 hangs off the ALIAS
        expect(viaPrimary.total).toBe(3); // t1, t2, t5

        // Asking by the alias resolves the same group (primary + siblings).
        const viaAlias = await transactionRepository.getUncategorisedWithCount({ recipientGroupId: rec.delhaizeAlias });
        expect(viaAlias.rows.map((r) => r.id)).toEqual([T.t1]);
        expect(viaAlias.total).toBe(3);

        // A recipient outside that group selects the Bakery rows instead.
        const outside = await transactionRepository.getUncategorisedWithCount({ recipientGroupId: bakery });
        expect(outside.rows.map((r) => r.id)).toEqual([U.income, U.big, U.small]);
        expect(outside.total).toBe(3);
      });

      it('recipientId resolves aliases on the rows exactly as it always did on the total', async () => {
        // Both halves now build this predicate with the same builder, so the
        // queue can no longer be empty while the total counts three. The rows
        // used to compare `t.recipient_id = $` verbatim, which missed t1 (it
        // hangs off the ALIAS of the recipient asked for).
        const { rows, total } = await transactionRepository.getUncategorisedWithCount({ recipientId: rec.delhaize });
        expect(rows.map((r) => r.id)).toEqual([T.t1]);
        expect(total).toBe(3); // t1, t2, t5
      });

      it('categoryIds narrows the TOTAL only — a category filter cannot narrow a set defined by having none', async () => {
        const { rows, total } = await transactionRepository.getUncategorisedWithCount({
          categoryIds: [cat.Food, cat.Salary],
        });
        expect(total).toBe(3); // t2, t4, t5 — same as getAllWithCount's categoryIds case
        // Deliberate, pre-existing asymmetry (shared with the singular
        // categoryId): applying it to the rows would empty the queue by
        // construction, so the queue keeps its full uncategorised row set.
        expect(rows.map((r) => r.id)).toEqual([U.income, U.big, U.small, T.t1]);
      });

      it('combining filters intersects them on both halves', async () => {
        const { rows, total } = await transactionRepository.getUncategorisedWithCount({
          transactionType: 'expense',
          amountMin: 100,
          startDate: '2024-03-01',
        });
        expect(rows.map((r) => r.id)).toEqual([U.big]);
        expect(total).toBe(2); // t3 (−120, 2024-03-01), U.big
      });
    });

    it('the recipientName filter still narrows the total — `r` is load-bearing, not decoration', async () => {
      // If the count had dropped `r` along with the projection joins, this filter
      // would be a no-op (or a SQL error) and the total would stay at 6.
      const all = await transactionRepository.getUncategorisedWithCount({});
      expect(all.total).toBe(6);
      const narrowed = await transactionRepository.getUncategorisedWithCount({ recipientName: 'delh' });
      expect(narrowed.total).toBe(3); // t1 (alias), t2, t5 — t6 inactive
      expect(narrowed.total).toBeLessThan(all.total);
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
        // ADR-088 contract phase: the returned label is the CANONICAL
        // accounts.name over the FK ('Revolut Main', first-seen casing), not
        // the row's raw uppercased string — reads no longer touch the retired
        // bank_account column, so a case-variant write surfaces the account's
        // stored display casing.
        bank_account: 'Revolut Main',
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
      // The dual-write string itself (pre-drop) still carries the uppercased
      // input — the trigger keeps deriving the FK from it until the manual
      // contract drop removes the column.
      const { rows: stored } = await getTestPool().query(
        'SELECT bank_account FROM transactions WHERE id = $1', [row.id],
      );
      expect(stored[0].bank_account).toBe('REVOLUT MAIN');
    });

    // Regression coverage for the (fixed) 0076 ON CONFLICT arbiter finding:
    // migration 0066 dropped uq_accounts_name for the expression index
    // uq_accounts_name_norm on lower(btrim(name)), and the trigger rewrite in
    // 0076 regressed the onboarding INSERT's arbiter back to
    // `ON CONFLICT (name)` — matching NO unique index, so every first-seen
    // label raised 42P10 at schema head ("there is no unique or exclusion
    // constraint matching the ON CONFLICT specification"). Fixed by migration
    // 0083 (CREATE OR REPLACE for already-migrated installs) plus an in-place
    // edit of 0076 (fresh installs). This test formerly PINNED the failure;
    // it now asserts the repaired behaviour: a brand-new label onboards
    // exactly one account (trimmed name, 0066 normalized-identity dedup
    // across casings). No mock suite could see this: the arbiter is only
    // validated when the trigger actually executes against the real schema.
    it('onboards a NEW account for a first-seen bank label (0076 ON CONFLICT regression, fixed by 0083)', async () => {
      const row = await transactionRepository.create({
        transaction_date: '2024-03-10',
        bank_account: 'BRAND NEW BANK',
        recipient_id: rec.delhaize,
        amount: '-1.00',
        category_id: null,
        comment: null,
      });
      // The trigger onboarded the account and stamped the FK on the row.
      const { rows: accounts } = await getTestPool().query(
        `SELECT id, name FROM accounts WHERE lower(btrim(name)) = 'brand new bank'`,
      );
      expect(accounts).toHaveLength(1);
      expect(accounts[0].name).toBe('BRAND NEW BANK'); // trimmed by the trigger
      expect(row.account_id).toBe(accounts[0].id);

      // A second casing/spacing of the SAME new label (raw SQL, bypassing the
      // repository's toUpperCase) resolves to the existing account instead of
      // minting a twin — the 0066 dedup semantics survive the 0083 fix.
      const { rows: second } = await getTestPool().query(
        `INSERT INTO transactions (date, amount, currency, recipient_id, bank_account)
         VALUES ('2024-03-11', -2.00, 'EUR', $1, '  Brand New Bank ')
         RETURNING account_id`,
        [rec.delhaize],
      );
      expect(second[0].account_id).toBe(accounts[0].id);
      const { rows: count } = await getTestPool().query(
        `SELECT count(*)::int AS n FROM accounts WHERE lower(btrim(name)) = 'brand new bank'`,
      );
      expect(count[0].n).toBe(1); // ONE account across both casings
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

    // Regression coverage (formerly a pinned bug): update()'s RETURNING
    // enrichment used to join only 2 category levels (own + recipient default)
    // — unlike getById/getAll/create, which resolve 3. For a row categorised
    // via its PRIMARY recipient's default, the update response reported
    // category_name NULL (and the alias's own name) even though a follow-up
    // GET showed 'Bills:Utilities' / the primary's name. update() now shares
    // the same 3-level fragments as the read paths, in both the RETURNING CTE
    // and the tags-path fetch, so the update response and an immediate GET
    // must be identical.
    it('update() response resolves the full 3-level category — identical to getById on alias rows', async () => {
      const updated = await transactionRepository.update(T.t3, { amount: '-121.00' });
      const fetched = await transactionRepository.getById(T.t3);
      expect(updated.category_name).toBe('Bills:Utilities'); // via the PRIMARY's default
      expect(updated.effective_category_id).toBe(cat.Bills);
      expect(updated.recipient_name).toBe('Electrabel'); // COALESCE(pr.name, r.name)
      expect(fetched).toEqual(updated); // response ≡ immediate GET, field for field

      // The tags-path fetch (fields + tags in one PATCH) resolves identically.
      const withTags = await transactionRepository.update(T.t3, { amount: '-122.00', tags: [] });
      expect(withTags.category_name).toBe('Bills:Utilities');
      expect(withTags.effective_category_id).toBe(cat.Bills);
      expect(withTags.recipient_name).toBe('Electrabel');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Effective-category id vs displayed name — one category, one label
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Formerly a real disagreement: EFFECTIVE_CATEGORY_ID_SQL resolves
  // own → recipient default (rc) → primary default (pc), while the category-name
  // CASE tested `pc` BEFORE `rc`. The two orders only diverge on one topology —
  // an ALIAS recipient that has its OWN default category AND a primary carrying
  // a DIFFERENT one — which the shared corpus does not contain (its alias has no
  // default of its own). On that topology the transactions list reported the
  // alias's category id next to the primary's category NAME, and the aggregation
  // surfaces, which follow the id, disagreed with the list's label.
  describe('alias with its own default under a differently-defaulted primary', () => {
    let aliasId;
    let aliasTxn;

    beforeEach(async () => {
      const pool = getTestPool();
      // Sorts after every other fixture category, so the ORDER BY assertion
      // below can tell the two resolutions apart.
      const { rows: catRows } = await pool.query(
        `INSERT INTO categories (general, detail) VALUES ('Zzz', 'Last') RETURNING id`,
      );
      cat.Zzz = catRows[0].id;
      // ALIAS of Electrabel (whose default is Bills) with its OWN default Zzz.
      const { rows: recRows } = await pool.query(
        `INSERT INTO recipients (name, normalized_name, default_category_id, primary_recipient_id)
         VALUES ('Electrabel Retail', 'electrabel retail', $1, $2) RETURNING id`,
        [cat.Zzz, rec.electrabel],
      );
      aliasId = recRows[0].id;
      aliasTxn = await insertTxn({ date: '2024-03-05', amount: '-11.11', recipientId: aliasId });
    });

    it('getById / getAll / getAllWithCount label the row with the category the id names', async () => {
      const expected = { effective_category_id: cat.Zzz, category_name: 'Zzz:Last' };

      expect(await transactionRepository.getById(aliasTxn)).toMatchObject(expected);

      const all = await transactionRepository.getAll({});
      expect(all.find((r) => r.id === aliasTxn)).toMatchObject(expected);

      const paged = await transactionRepository.getAllWithCount({});
      expect(paged.rows.find((r) => r.id === aliasTxn)).toMatchObject(expected);
    });

    it('create / update return the same pairing as an immediate GET', async () => {
      const created = await transactionRepository.create({
        transaction_date: '2024-03-06',
        recipient_id: aliasId,
        amount: '-22.22',
        category_id: null,
        comment: null,
      });
      expect(created.effective_category_id).toBe(cat.Zzz);
      expect(created.category_name).toBe('Zzz:Last');
      expect(await transactionRepository.getById(created.id)).toEqual(created);

      const updated = await transactionRepository.update(aliasTxn, { amount: '-33.33' });
      expect(updated.effective_category_id).toBe(cat.Zzz);
      expect(updated.category_name).toBe('Zzz:Last');
      expect(await transactionRepository.getById(aliasTxn)).toEqual(updated);

      // The tags-path fetch (fields + tags in one PATCH) resolves identically.
      const withTags = await transactionRepository.update(aliasTxn, { amount: '-34.00', tags: [] });
      expect(withTags.effective_category_id).toBe(cat.Zzz);
      expect(withTags.category_name).toBe('Zzz:Last');
    });

    it("an own category_id still wins over both defaults", async () => {
      const row = await transactionRepository.update(aliasTxn, { category_id: cat.Food });
      expect(row.effective_category_id).toBe(cat.Food);
      expect(row.category_name).toBe('Food:Groceries');
    });

    it('sorts by the same resolved name it displays', async () => {
      const rows = await transactionRepository.getAll({ sortBy: 'category', sortDir: 'asc' });
      const ids = rows.map((r) => r.id);
      // 'Zzz:Last' sorts after t7's 'Bills:Utilities'. Under the old pc-first
      // order the alias row was labelled 'Bills:Utilities' and — being the
      // later date — sorted BEFORE t7 on the tiebreaker.
      expect(ids.indexOf(aliasTxn)).toBeGreaterThan(ids.indexOf(T.t7));
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
