/**
 * Transaction Repository behavioral tests. Mocks the DB layer (query /
 * queryPrepared / withTransaction) and asserts row enrichment (tag attachment),
 * filter branches, and the create/update tag paths. buildTransactionWhere and
 * sanitizeUpdateFields run for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  queryPrepared: vi.fn().mockResolvedValue({ rows: [] }),
  withTransaction: vi.fn(),
}));

import { query, queryPrepared, withTransaction } from '../src/database/connection.js';
import transactionRepository from '../src/repositories/transactionRepository.js';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  queryPrepared.mockReset();
  queryPrepared.mockResolvedValue({ rows: [] });
  withTransaction.mockReset();
});

describe('tag attachment', () => {
  it('getAll attaches tags grouped by transaction and empty arrays otherwise', async () => {
    // First call: main SELECT returns two rows. Second call: the tag lookup.
    query
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] })
      .mockResolvedValueOnce({
        rows: [
          { transaction_id: 1, id: 10, slug: 'food', color: '#fff', is_active: true },
          { transaction_id: 1, id: 11, slug: 'bill', color: '#000', is_active: true },
        ],
      });
    const rows = await transactionRepository.getAll({ limit: 10, offset: 0 });
    expect(rows[0].tags).toHaveLength(2);
    expect(rows[0].tags[0]).toEqual({ id: 10, slug: 'food', color: '#fff', is_active: true });
    expect(rows[1].tags).toEqual([]); // no tags for tx 2
    // tag lookup queried against the row ids
    expect(query.mock.calls[1][1]).toEqual([[1, 2]]);
  });

  it('skips the tag query entirely when there are no rows', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const rows = await transactionRepository.getAll({});
    expect(rows).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1); // only the main SELECT
  });
});

describe('getCount', () => {
  it('parses the scalar count', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '123' }] });
    expect(await transactionRepository.getCount({})).toBe(123);
  });

  it('forwards every count-compatible route filter to the shared WHERE builder', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    await transactionRepository.getCount({
      categoryIds: [2, 3], transactionType: 'expense', amountMin: 10,
      amountMax: 100, amountSigned: true,
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('t.category_id IN ($1, $2)');
    expect(sql).toContain('t.amount < 0');
    expect(sql).toContain('t.amount >= $3');
    expect(sql).toContain('t.amount <= $4');
    expect(sql).not.toContain('ABS(t.amount)');
    expect(params).toEqual([2, 3, 10, 100]);
  });
});

describe('getUncategorised', () => {
  it('appends each optional filter clause and param in order', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await transactionRepository.getUncategorised({
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      bankAccount: 'kbc',
      recipientId: 5,
      recipientName: 'aldi',
      limit: 25,
      offset: 5,
    });
    const [sql, params] = query.mock.calls[0];
    // Uncategorised = full 3-level effective category is NULL (own, recipient
    // default, and primary-recipient default), so the primary is joined too.
    expect(sql).toContain('LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id');
    expect(sql).toContain('COALESCE(t.category_id, r.default_category_id, pr.default_category_id) IS NULL');
    expect(sql).toContain('t.date >= $1');
    expect(sql).toContain('t.date <= $2');
    // ADR-088 contract phase: the bank filter resolves through account_id.
    expect(sql).toContain('t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name ILIKE $3)');
    expect(sql).not.toContain('t.bank_account');
    expect(sql).toMatch(/primary_recipient_id = \$4/);
    expect(sql).toContain('r.name ILIKE $5');
    expect(params).toEqual(['2024-01-01', '2024-12-31', '%kbc%', 5, '%aldi%', 25, 5]);
  });

  it('uses the shared filter builder for tags, amounts, type, search, and recipient groups', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await transactionRepository.getUncategorised({
      transactionId: 9, recipientGroupId: 7, search: 'coffee',
      transactionType: 'expense', amountMin: 10, amountMax: 100,
      tagSlugs: ['groceries'],
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('t.id = $1');
    expect(sql).toContain('t.id IN (');
    expect(sql).toContain('t.amount < 0');
    expect(sql).toContain('ABS(t.amount) >=');
    expect(sql).toContain('ABS(t.amount) <=');
    expect(sql).toContain('FROM transaction_tags tt');
    expect(sql).toMatch(/primary_recipient_id = \$\d+/);
    expect(params.at(-2)).toBe(50);
    expect(params.at(-1)).toBe(0);
  });

  it('treats an alias recipient whose primary has a category as categorised (excluded from the queue)', async () => {
    // Regression: the old predicate (t.category_id IS NULL AND
    // r.default_category_id IS NULL) missed the primary-recipient default, so
    // alias-recipient rows with a categorised primary leaked into the queue.
    query.mockResolvedValueOnce({ rows: [] });
    await transactionRepository.getUncategorised({});
    const [sql] = query.mock.calls[0];
    // The effective-category predicate now spans all three levels, so a row
    // whose primary carries a default category is NOT NULL → excluded.
    expect(sql).toContain('COALESCE(t.category_id, r.default_category_id, pr.default_category_id) IS NULL');
    expect(sql).toContain('LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id');
    // The old, alias-blind predicate must be gone.
    expect(sql).not.toMatch(/t\.category_id IS NULL\s+AND\s+\(r\.default_category_id IS NULL\)/);
  });
});

describe('getUncategorisedWithCount', () => {
  it('joins the primary recipient and filters on the full effective category', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: null, total_count: '0' }] });
    await transactionRepository.getUncategorisedWithCount({});
    const [sql] = query.mock.calls[0];
    // The uncategorised_rows CTE must join pr and use the 3-level predicate.
    expect(sql).toContain('LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id');
    expect(sql).toContain('COALESCE(t.category_id, r.default_category_id, pr.default_category_id) IS NULL');
  });

  it('counts the total over a REDUCED join set, not the full TRANSACTION_JOINS', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: null, total_count: '0' }] });
    await transactionRepository.getUncategorisedWithCount({ recipientName: 'delh' });
    const [sql] = query.mock.calls[0];
    const totalCte = sql.slice(sql.indexOf('WITH total_cte AS ('), sql.indexOf('uncategorised_rows AS ('));

    // `r` stays: it is the one alias buildTransactionWhere can reference
    // (recipientName's `r.name ILIKE`), so it is load-bearing for the count.
    expect(totalCte).toContain('LEFT JOIN recipients r ON t.recipient_id = r.id');
    expect(totalCte).toContain('r.name ILIKE');
    // The five projection-only joins must NOT be in the count. They are LEFT
    // JOINs onto a PRIMARY KEY, so they can neither drop nor duplicate a row —
    // but a count selects no labels, so they are pure overhead.
    expect(totalCte).not.toContain('LEFT JOIN recipients pr');
    expect(totalCte).not.toContain('LEFT JOIN categories');
    expect(totalCte).not.toContain('LEFT JOIN accounts');

    // The ROW query is untouched: it still projects labels and therefore still
    // needs pr (3-level effective category) and acct (bank_account).
    const rowCte = sql.slice(sql.indexOf('uncategorised_rows AS ('));
    expect(rowCte).toContain('LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id');
    expect(rowCte).toContain('LEFT JOIN accounts acct ON t.account_id = acct.id');
  });

  it('total params and filter semantics are unchanged by the reduced join set', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: null, total_count: '0' }] });
    await transactionRepository.getUncategorisedWithCount({
      startDate: '2024-01-01', recipientName: 'delh', search: 'coffee', active: true,
    });
    const [sql, params] = query.mock.calls[0];
    const totalCte = sql.slice(sql.indexOf('WITH total_cte AS ('), sql.indexOf('uncategorised_rows AS ('));
    // Same predicates as getCount would build, in the same $-order; the row CTE
    // then appends its own copies of the shared filters after them.
    expect(totalCte).toContain('t.is_active = true');
    expect(totalCte).toContain('t.date >= $1');
    expect(totalCte).toContain('r.name ILIKE $2');
    expect(totalCte).toContain('t.id IN (');
    expect(params.slice(0, 3)).toEqual(['2024-01-01', '%delh%', '%coffee%']);
  });

  it('forwards the full route filter set to BOTH halves, params ordered total → rows → limit/offset', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: null, total_count: '0' }] });
    await transactionRepository.getUncategorisedWithCount({
      recipientGroupId: 7, transactionType: 'expense', amountMin: 10, amountMax: 100, tagSlugs: ['groceries'],
    });
    const [sql, params] = query.mock.calls[0];
    const totalCte = sql.slice(sql.indexOf('WITH total_cte AS ('), sql.indexOf('uncategorised_rows AS ('));
    const rowCte = sql.slice(sql.indexOf('uncategorised_rows AS ('));

    // These six used to be dropped by the destructure, so neither half applied them.
    for (const half of [totalCte, rowCte]) {
      expect(half).toContain('t.amount < 0'); // transactionType: expense
      expect(half).toContain('ABS(t.amount) >=');
      expect(half).toContain('ABS(t.amount) <=');
      expect(half).toContain('FROM transaction_tags tt'); // tagSlugs EXISTS
      expect(half).toMatch(/primary_recipient_id = \$\d+/); // recipientGroupId group resolve
    }
    // Each half allocates its own placeholders; limit/offset come last.
    expect(params).toEqual([10, 100, 7, ['groceries'], 10, 100, 7, ['groceries'], 50, 0]);
  });

  it('applies row-compatible filters to the queue while keeping category filters total-only', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: null, total_count: '0' }] });
    await transactionRepository.getUncategorisedWithCount({
      categoryIds: [3], search: 'coffee', transactionId: 5, active: false,
    });
    const [sql] = query.mock.calls[0];
    const rowCte = sql.slice(sql.indexOf('uncategorised_rows AS ('));
    expect(rowCte).not.toMatch(/\(\s+t\.category_id IN \(\$\d+/);
    expect(rowCte).toContain('t.id = $');
    expect(rowCte).toContain('t.id IN (');
    // The queue is an active-rows worklist regardless of the `active` param.
    expect(rowCte).toContain('t.is_active = true');
    expect(rowCte).toContain('COALESCE(t.category_id, r.default_category_id, pr.default_category_id) IS NULL');
  });

  it('returns total 0 and empty rows when CTE yields only the null-joined total row', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: null, total_count: '0' }] });
    const res = await transactionRepository.getUncategorisedWithCount({});
    expect(res.total).toBe(0); // first row total_count parsed
    expect(res.rows).toEqual([]); // id null filtered out
  });

  it('parses total and strips total_count from rows', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 1, total_count: '7', _row_order: '1' }] }) // main CTE
      .mockResolvedValueOnce({ rows: [] }); // tag lookup
    const res = await transactionRepository.getUncategorisedWithCount({ startDate: '2024-01-01' });
    expect(res.total).toBe(7);
    expect(res.rows[0]).not.toHaveProperty('total_count');
    expect(res.rows[0]).not.toHaveProperty('_row_order');
  });
});

describe('getById', () => {
  it('returns the enriched row', async () => {
    queryPrepared.mockResolvedValueOnce({ rows: [{ id: 9, recipient_name: 'X' }] });
    query.mockResolvedValueOnce({ rows: [] }); // tag lookup
    const row = await transactionRepository.getById(9);
    expect(row.id).toBe(9);
    expect(row.tags).toEqual([]);
  });

  it('returns null when not found', async () => {
    queryPrepared.mockResolvedValueOnce({ rows: [] });
    expect(await transactionRepository.getById(99)).toBeNull();
  });
});

describe('create', () => {
  it('uppercases bank_account/memo/currency and uses queryPrepared without tags', async () => {
    queryPrepared.mockResolvedValueOnce({ rows: [{ id: 3 }] });
    query.mockResolvedValueOnce({ rows: [] }); // tag lookup
    const row = await transactionRepository.create({
      transaction_date: '2024-05-01',
      bank_account: 'kbc',
      recipient_id: 1,
      amount: -10,
      memo: 'coffee',
      currency: 'usd',
      balance: 100,
      category_id: 2,
      comment: 'c',
    });
    expect(row.id).toBe(3);
    const params = queryPrepared.mock.calls[0][2];
    expect(params[1]).toBe('KBC');
    expect(params[4]).toBe('COFFEE');
    expect(params[5]).toBe('USD');
  });

  it('defaults currency to EUR and nulls bank/memo when absent', async () => {
    queryPrepared.mockResolvedValueOnce({ rows: [{ id: 4 }] });
    query.mockResolvedValueOnce({ rows: [] });
    await transactionRepository.create({
      transaction_date: '2024-05-01',
      recipient_id: 1,
      amount: 5,
      balance: 0,
      category_id: null,
      comment: null,
    });
    const params = queryPrepared.mock.calls[0][2];
    expect(params[1]).toBeNull(); // bank_account
    expect(params[4]).toBeNull(); // memo
    expect(params[5]).toBe('EUR');
  });

  it('runs inside a transaction and sets tags when tags supplied', async () => {
    const client = { query: vi.fn() };
    // CTE insert -> inserted row
    client.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO transactions')) {
        return { rows: [{ id: 50 }] };
      }
      if (typeof sql === 'string' && sql.startsWith('DELETE FROM transaction_tags')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes('SELECT id FROM tags')) return { rows: [{ id: 99 }] };
      return { rows: [] };
    });
    withTransaction.mockImplementation(async (fn) => fn(client));
    query.mockResolvedValueOnce({ rows: [] }); // final attachTagsToRows tag lookup
    const row = await transactionRepository.create({
      transaction_date: '2024-05-01',
      recipient_id: 1,
      amount: 5,
      balance: 0,
      category_id: null,
      comment: null,
      tags: ['food'],
    });
    expect(row.id).toBe(50);
    expect(withTransaction).toHaveBeenCalled();
    // tag junction insert performed
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO transaction_tags'), [50, [99]]);
  });

  it('returns null when the transactional insert yields no row', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementation(async (fn) => fn(client));
    const row = await transactionRepository.create({
      transaction_date: '2024-05-01',
      recipient_id: 1,
      amount: 5,
      balance: 0,
      category_id: null,
      comment: null,
      tags: [],
    });
    expect(row).toBeNull();
  });
});

describe('update', () => {
  it('falls back to getById when there are no writable fields and no tags', async () => {
    queryPrepared.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // getById
    query.mockResolvedValueOnce({ rows: [] }); // tag lookup
    const row = await transactionRepository.update(1, {});
    expect(row.id).toBe(1);
  });

  it('maps transaction_date to date and returns enriched row', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 2, recipient_name: 'r' }] }) // update CTE
      .mockResolvedValueOnce({ rows: [] }); // tag lookup
    const row = await transactionRepository.update(2, { transaction_date: '2024-06-01', amount: 9 });
    expect(row.id).toBe(2);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('"date" = $1');
    expect(sql).toContain('updated_at = NOW()');
  });

  it('returns null when the update matches no row', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await transactionRepository.update(2, { amount: 1 })).toBeNull();
  });

  it('tags-only update probes existence then sets tags', async () => {
    const client = { query: vi.fn() };
    client.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.startsWith('SELECT 1 FROM transactions')) return { rows: [{ '?column?': 1 }] };
      if (typeof sql === 'string' && sql.startsWith('DELETE FROM transaction_tags')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes('SELECT id FROM tags')) return { rows: [] }; // no matching tags -> early return
      if (typeof sql === 'string' && sql.includes('SELECT t.*')) return { rows: [{ id: 7 }] }; // fetchSql
      return { rows: [] };
    });
    withTransaction.mockImplementation(async (fn) => fn(client));
    query.mockResolvedValueOnce({ rows: [] }); // attachTagsToRows
    const row = await transactionRepository.update(7, { tags: ['nope'] });
    expect(row.id).toBe(7);
    expect(client.query).toHaveBeenCalledWith('SELECT 1 FROM transactions WHERE id = $1', [7]);
  });

  it('tags-only update returns null when the transaction does not exist', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementation(async (fn) => fn(client));
    expect(await transactionRepository.update(123, { tags: [] })).toBeNull();
  });

  it('update with both fields and tags performs the UPDATE then tags', async () => {
    const client = { query: vi.fn() };
    client.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('UPDATE transactions SET')) return { rows: [{ id: 8 }] };
      if (typeof sql === 'string' && sql.includes('SELECT t.*')) return { rows: [{ id: 8 }] };
      return { rows: [] };
    });
    withTransaction.mockImplementation(async (fn) => fn(client));
    query.mockResolvedValueOnce({ rows: [] });
    const row = await transactionRepository.update(8, { amount: 3, tags: [] });
    expect(row.id).toBe(8);
  });
});

describe('hardDelete', () => {
  it('reflects rowCount', async () => {
    queryPrepared.mockResolvedValueOnce({ rowCount: 1 });
    expect(await transactionRepository.hardDelete(1)).toBe(true);
    queryPrepared.mockResolvedValueOnce({ rowCount: 0 });
    expect(await transactionRepository.hardDelete(1)).toBe(false);
  });
});

describe('listRecentUnlinked', () => {
  it('queries from the since date and returns rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, recipient_cluster_id: 3 }] });
    const rows = await transactionRepository.listRecentUnlinked({ sinceDate: '2024-01-01' });
    expect(rows).toEqual([{ id: 1, recipient_cluster_id: 3 }]);
    expect(query.mock.calls[0][1]).toEqual(['2024-01-01']);
    expect(query.mock.calls[0][0]).toContain('NOT EXISTS');
  });
});
