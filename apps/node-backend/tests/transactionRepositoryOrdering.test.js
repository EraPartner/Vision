import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  queryPrepared: vi.fn().mockResolvedValue({ rows: [] }),
  withTransaction: vi.fn(),
}));

import { query, withTransaction } from '../src/database/connection.js';
import transactionRepository from '../src/repositories/transactionRepository.js';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  withTransaction.mockReset();
});

/**
 * Regression: LIMIT/OFFSET pagination must carry a unique final tiebreaker
 * (t.id DESC). Without it, same-date rows can be duplicated or skipped across
 * separate page queries because Postgres gives no order among equal sort keys.
 */
describe('transaction list ORDER BY tiebreaker', () => {
  it('getAllWithCount default sort ends with t.id DESC', async () => {
    await transactionRepository.getAllWithCount({ limit: 50, offset: 0 });
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('ORDER BY t.date DESC, t.id DESC');
  });

  it('getAllWithCount custom sort still appends t.id DESC', async () => {
    await transactionRepository.getAllWithCount({ limit: 50, offset: 0, sortBy: 'amount', sortDir: 'asc' });
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/ORDER BY .+, t\.date DESC, t\.id DESC/);
  });

  it('getUncategorisedWithCount paginates with a t.id DESC tiebreaker', async () => {
    await transactionRepository.getUncategorisedWithCount({ limit: 50, offset: 0 });
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('ORDER BY t.date DESC, t.id DESC');
  });
});

describe('tags-only PATCH on a missing transaction', () => {
  it('returns null (→ 404) by probing existence before the tag-junction insert', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementation(async (fn) => fn(client));

    const result = await transactionRepository.update(999, { tags: ['food'] });

    expect(result).toBeNull();
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('SELECT 1 FROM transactions WHERE id = $1'))).toBe(true);
    // The FK-violating junction INSERT must NOT run (that was the 500 source).
    expect(sqls.some((s) => s.includes('INSERT INTO transaction_tags'))).toBe(false);
  });
});
