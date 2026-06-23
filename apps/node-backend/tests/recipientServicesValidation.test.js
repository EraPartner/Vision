import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { query, withTransaction } from '../src/database/connection.js';
import { updatePattern } from '../src/services/recipientPatternService.js';
import { mergeRecipients } from '../src/services/recipientMergeService.js';
import { ValidationError, NotFoundError } from '../src/middleware/errorHandler.js';

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
});

describe('updatePattern — validates the row merged with stored values', () => {
  it('allows a case_sensitive-only toggle on a regex row (keeps the stored pattern)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ pattern: 'FOO[0-9]+', pattern_kind: 'regex', case_sensitive: false }] })
      .mockResolvedValue({ rows: [] });
    await expect(updatePattern(1, { case_sensitive: true })).resolves.toBeUndefined();
    expect(query.mock.calls.length).toBe(2); // SELECT existing + UPDATE
  });

  it('runs the ReDoS guard on a pattern-only edit of a regex row', async () => {
    query.mockResolvedValueOnce({ rows: [{ pattern: 'FOO[0-9]+', pattern_kind: 'regex', case_sensitive: false }] });
    await expect(updatePattern(1, { pattern: '(a+)+$' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws NotFoundError when the pattern row is missing', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(updatePattern(999, { case_sensitive: true })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('mergeRecipients — flattens nested alias chains', () => {
  it('re-points grandchildren aliases onto the new primary', async () => {
    const sqls = [];
    const client = {
      query: vi.fn(async (sql) => {
        sqls.push(sql);
        if (sql.includes('FOR UPDATE')) return { rows: [{ id: 1 }] };
        if (sql.includes('information_schema')) return { rows: [] };
        if (sql.includes('RETURNING id')) return { rows: [{ id: 3 }] };
        return { rows: [], rowCount: 0 };
      }),
    };
    withTransaction.mockImplementation(async (fn) => fn(client));

    await mergeRecipients(1, [3]);

    // The grandchildren re-point updates rows WHERE primary_recipient_id = ANY(...)
    // (distinct from the alias flag update which keys on id = ANY(...)).
    const grandchild = sqls.find(
      (s) => /SET\s+primary_recipient_id = \$1/.test(s) && /WHERE primary_recipient_id = ANY\(\$2::int\[\]\)/.test(s),
    );
    expect(grandchild).toBeTruthy();
  });
});
