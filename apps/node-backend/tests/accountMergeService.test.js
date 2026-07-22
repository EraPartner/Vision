import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTxConnection } from './helpers/repoMocks.js';
const { mockClient } = vi.hoisted(() => ({ mockClient: { query: vi.fn() } }));

vi.mock('../src/database/connection.js', () => mockTxConnection(mockClient));

import { query } from '../src/database/connection.js';
import { mergeAccounts, previewMerge, stampRangesOverlap } from '../src/services/accountMergeService.js';
import { ValidationError, NotFoundError } from '../src/middleware/errorHandler.js';

// Default happy-path SQL router: target #2 ('TARGET'), source #1 exists.
// `stampRanges` primes the per-original-account stamped-date ranges the
// overlapping-stamp guard reads before the repoint (default: nothing stamped).
function happyPath({ stampRanges = [] } = {}) {
  mockClient.query.mockImplementation(async (sql) => {
    if (sql.includes('FOR UPDATE') && sql.includes('WHERE id = $1')) return { rows: [{ id: 2, name: 'TARGET' }] };
    if (sql.includes('FOR UPDATE') && sql.includes('ANY')) return { rows: [{ id: 1 }] };
    if (sql.includes('GROUP BY account_id')) return { rows: stampRanges };
    if (sql.includes('UPDATE transactions')) return { rowCount: 3 };
    if (sql.includes('UPDATE planned_transactions')) return { rowCount: 1 };
    if (sql.includes('to_regclass')) return { rows: [{ r: 'public.portfolio_transactions_base' }] };
    if (sql.includes('UPDATE portfolio_transactions_base')) return { rowCount: 2 };
    if (sql.includes('UPDATE accounts SET funding_account_id')) return { rowCount: 0 };
    if (sql.includes('DELETE FROM accounts')) return { rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

const clearAnchorCall = () =>
  mockClient.query.mock.calls.find(([sql]) => sql.includes('statement_balance = NULL'));

beforeEach(() => vi.clearAllMocks());

describe('mergeAccounts (ADR-088)', () => {
  it('rejects an empty / self-only source set', async () => {
    await expect(mergeAccounts(2, [])).rejects.toThrow(ValidationError);
    await expect(mergeAccounts(2, [2])).rejects.toThrow(ValidationError);
  });

  it('throws NotFound when the survivor is missing', async () => {
    mockClient.query.mockImplementation(async (sql) =>
      sql.includes('WHERE id = $1') ? { rows: [] } : { rows: [], rowCount: 0 });
    await expect(mergeAccounts(2, [1])).rejects.toThrow(NotFoundError);
  });

  it('throws NotFound when a source is missing', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('WHERE id = $1')) return { rows: [{ id: 2, name: 'TARGET' }] };
      if (sql.includes('ANY')) return { rows: [] }; // no sources found
      return { rows: [], rowCount: 0 };
    });
    await expect(mergeAccounts(2, [1])).rejects.toThrow(NotFoundError);
  });

  it('repoints every reference to the survivor, deletes the source, returns counts', async () => {
    happyPath();
    const result = await mergeAccounts(2, [1]);

    expect(result).toEqual({
      into: 2,
      merged: [1],
      reassigned: { transactions: 3, planned: 1, portfolio: 2, funding: 0 },
      stampsInterleaved: false,
    });

    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calls.some((s) => s.includes('UPDATE transactions') && s.includes('bank_account'))).toBe(true);
    expect(calls.some((s) => s.includes('UPDATE planned_transactions'))).toBe(true);
    expect(calls.some((s) => s.includes('UPDATE portfolio_transactions_base'))).toBe(true);
    expect(calls.some((s) => s.includes('UPDATE accounts SET funding_account_id'))).toBe(true);
    expect(calls.some((s) => s.includes('DELETE FROM accounts'))).toBe(true);

    // transactions repoint carries the survivor's name (so the dual-write trigger keeps it merged)
    const txCall = mockClient.query.mock.calls.find(([sql]) => sql.includes('UPDATE transactions'));
    expect(txCall[1]).toEqual([2, 'TARGET', [1]]);
  });

  it('falls back to the flat portfolio_transactions table when there is no inheritance base', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('WHERE id = $1')) return { rows: [{ id: 2, name: 'T' }] };
      if (sql.includes('FOR UPDATE') && sql.includes('ANY')) return { rows: [{ id: 1 }] };
      if (sql.includes('to_regclass')) return { rows: [{ r: null }] }; // flat schema
      if (sql.includes('UPDATE portfolio_transactions ')) return { rowCount: 5 };
      return { rows: [], rowCount: 0 };
    });
    const result = await mergeAccounts(2, [1]);
    expect(result.reassigned.portfolio).toBe(5);
    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calls.some((s) => s.includes('UPDATE portfolio_transactions ') && !s.includes('_base'))).toBe(true);
  });

  // §1 F2 regression: two concurrently-imported accounts (survivor KBC stamped
  // Jan–Jul 1, source Belfius stamped Mar–Jul 5) have INTERLEAVED stamp
  // histories. Post-merge the anchor would silently become Belfius's latest
  // stamp — dropping KBC's balance — so the merge must flag it and clear the
  // survivor's now-invalidated statement anchor.
  it('interleaved-stamp fixture: flags stampsInterleaved and clears the survivor statement anchor', async () => {
    happyPath({
      stampRanges: [
        { account_id: 2, min_date: '2026-01-01', max_date: '2026-07-01' }, // survivor (KBC)
        { account_id: 1, min_date: '2026-03-01', max_date: '2026-07-05' }, // source (Belfius)
      ],
    });
    const result = await mergeAccounts(2, [1]);

    expect(result.stampsInterleaved).toBe(true);
    const clear = clearAnchorCall();
    expect(clear).toBeDefined();
    expect(clear[0]).toContain('statement_balance_date = NULL');
    expect(clear[1]).toEqual([2]); // clears the SURVIVOR's anchor only

    // Historical per-row stamps are never rewritten — no UPDATE touches
    // transactions.balance.
    const balanceRewrites = mockClient.query.mock.calls.filter(
      ([sql]) => sql.includes('UPDATE transactions') && sql.includes('balance'),
    );
    expect(balanceRewrites).toEqual([]);
  });

  it('sequential (non-overlapping) stamp histories do NOT flag or clear the anchor', async () => {
    happyPath({
      stampRanges: [
        { account_id: 2, min_date: '2024-01-01', max_date: '2025-01-31' }, // old account, closed
        { account_id: 1, min_date: '2025-02-01', max_date: '2026-07-01' }, // successor
      ],
    });
    const result = await mergeAccounts(2, [1]);
    expect(result.stampsInterleaved).toBe(false);
    expect(clearAnchorCall()).toBeUndefined();
  });

  it('a single stamped account (only the source ever stamped) does not flag', async () => {
    happyPath({
      stampRanges: [{ account_id: 1, min_date: '2026-01-01', max_date: '2026-07-01' }],
    });
    const result = await mergeAccounts(2, [1]);
    expect(result.stampsInterleaved).toBe(false);
    expect(clearAnchorCall()).toBeUndefined();
  });

  it('reads the stamp ranges BEFORE the repoint (provenance would otherwise be erased)', async () => {
    happyPath({
      stampRanges: [
        { account_id: 2, min_date: '2026-01-01', max_date: '2026-07-01' },
        { account_id: 1, min_date: '2026-03-01', max_date: '2026-07-05' },
      ],
    });
    await mergeAccounts(2, [1]);
    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    const rangeIdx = calls.findIndex((s) => s.includes('GROUP BY account_id'));
    const repointIdx = calls.findIndex((s) => s.includes('UPDATE transactions'));
    expect(rangeIdx).toBeGreaterThanOrEqual(0);
    expect(rangeIdx).toBeLessThan(repointIdx);
  });
});

describe('stampRangesOverlap (§1 F2 predicate)', () => {
  it('is false for empty / single-account ranges', () => {
    expect(stampRangesOverlap([])).toBe(false);
    expect(stampRangesOverlap([{ account_id: 1, min_date: '2026-01-01', max_date: '2026-07-01' }])).toBe(false);
  });

  it('detects overlap in either nesting order and on shared boundary days', () => {
    const a = { account_id: 1, min_date: '2026-01-01', max_date: '2026-06-30' };
    const b = { account_id: 2, min_date: '2026-06-30', max_date: '2026-12-01' }; // touches a.max
    const c = { account_id: 3, min_date: '2026-02-01', max_date: '2026-03-01' }; // nested inside a
    expect(stampRangesOverlap([a, b])).toBe(true);
    expect(stampRangesOverlap([b, a])).toBe(true);
    expect(stampRangesOverlap([a, c])).toBe(true);
  });

  it('is false for strictly sequential ranges, true when ANY pair among three overlaps', () => {
    const a = { account_id: 1, min_date: '2024-01-01', max_date: '2024-12-31' };
    const b = { account_id: 2, min_date: '2025-01-01', max_date: '2025-12-31' };
    const c = { account_id: 3, min_date: '2025-06-01', max_date: '2026-06-01' };
    expect(stampRangesOverlap([a, b])).toBe(false);
    expect(stampRangesOverlap([a, b, c])).toBe(true); // b × c overlap
  });
});

describe('previewMerge (GET /api/accounts/:id/merge-preview)', () => {
  // Routes the pooled `query` spy (previewMerge is read-only — it never opens a
  // transaction). Source #1 merged INTO survivor #2 (EUR).
  function primePreview({
    accounts = [{ id: 1, currency: 'USD' }, { id: 2, currency: 'EUR' }],
    counts = { transactions: '3', planned: '1', portfolio: '2', funding: '0' },
    balance = '1234.505',
    stampRanges = [],
    baseTable = 'public.portfolio_transactions_base',
  } = {}) {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id, currency FROM accounts')) return { rows: accounts };
      if (sql.includes('to_regclass')) return { rows: [{ r: baseTable }] };
      if (sql.includes('FROM transactions WHERE account_id')) return { rows: [{ n: counts.transactions }] };
      if (sql.includes('FROM planned_transactions')) return { rows: [{ n: counts.planned }] };
      if (sql.includes('portfolio_transactions')) return { rows: [{ n: counts.portfolio }] };
      if (sql.includes('funding_account_id')) return { rows: [{ n: counts.funding }] };
      if (sql.includes('GROUP BY account_id')) return { rows: stampRanges };
      if (sql.includes('WITH anchor')) return { rows: [{ balance }] };
      return { rows: [], rowCount: 0 };
    });
  }

  it('rejects a non-integer / non-positive into and self-merge with 400', async () => {
    await expect(previewMerge(1, NaN)).rejects.toThrow(ValidationError); // ?into= missing
    await expect(previewMerge(1, 0)).rejects.toThrow(ValidationError);
    await expect(previewMerge(1, 2.5)).rejects.toThrow(ValidationError);
    await expect(previewMerge(1, 1)).rejects.toThrow(ValidationError); // into === :id
    expect(query).not.toHaveBeenCalled();
  });

  it('404s when the survivor or the source is missing', async () => {
    primePreview({ accounts: [{ id: 1, currency: 'EUR' }] }); // survivor #2 missing
    await expect(previewMerge(1, 2)).rejects.toThrow(NotFoundError);

    primePreview({ accounts: [{ id: 2, currency: 'EUR' }] }); // source #1 missing
    await expect(previewMerge(1, 2)).rejects.toThrow(NotFoundError);
  });

  it('returns counts, projected union balance (survivor currency), and stampsInterleaved', async () => {
    primePreview({
      stampRanges: [
        { account_id: 2, min_date: '2026-01-01', max_date: '2026-07-01' },
        { account_id: 1, min_date: '2026-03-01', max_date: '2026-07-05' },
      ],
    });
    const result = await previewMerge(1, 2);

    expect(result).toEqual({
      into: 2,
      source: 1,
      reassigned: { transactions: 3, planned: 1, portfolio: 2, funding: 0 },
      projectedBalance: 1234.5, // pg NUMERIC string → rounded number (banker's)
      projectedBalanceCurrency: 'EUR', // the SURVIVOR's native currency
      stampsInterleaved: true,
    });
  });

  it('does not flag sequential stamp histories', async () => {
    primePreview({
      stampRanges: [
        { account_id: 2, min_date: '2024-01-01', max_date: '2025-01-31' },
        { account_id: 1, min_date: '2025-02-01', max_date: '2026-07-01' },
      ],
    });
    const result = await previewMerge(1, 2);
    expect(result.stampsInterleaved).toBe(false);
  });

  it('is strictly read-only: only SELECTs, and never opens a transaction', async () => {
    primePreview();
    await previewMerge(1, 2);
    const sqls = query.mock.calls.map(([sql]) => sql);
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
    }
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('evaluates the projected balance with anchor+delta semantics over the UNION of both accounts', async () => {
    primePreview();
    await previewMerge(1, 2);
    const projectedSql = query.mock.calls.map(([sql]) => sql).find((s) => s.includes('WITH anchor'));
    expect(projectedSql).toBeDefined();
    // Union set: account_id = ANY(...) — not a single-account filter.
    expect(projectedSql).toContain('t.account_id = ANY($1::int[])');
    // Anchor = latest stamped row across the union; delta = active rows after it;
    // Σ(amount) fallback when nothing is stamped (COMPUTED_BALANCE_LATERAL semantics).
    expect(projectedSql).toContain('t.balance IS NOT NULL');
    expect(projectedSql).toContain('ORDER BY t.date DESC, t.id DESC');
    expect(projectedSql).toContain('NOT EXISTS (SELECT 1 FROM anchor)');
    expect(projectedSql).toContain("(t2.date, t2.id) > (SELECT date, id FROM anchor)");
    const projectedCall = query.mock.calls.find(([sql]) => sql.includes('WITH anchor'));
    expect(projectedCall[1]).toEqual([[2, 1]]); // survivor + source
  });

  it('counts against the flat portfolio table when there is no inheritance base', async () => {
    primePreview({ baseTable: null, counts: { transactions: '0', planned: '0', portfolio: '7', funding: '0' } });
    const result = await previewMerge(1, 2);
    expect(result.reassigned.portfolio).toBe(7);
    const portfolioSql = query.mock.calls
      .map(([sql]) => sql)
      .find((s) => s.includes('portfolio_transactions') && s.includes('COUNT'));
    expect(portfolioSql).not.toContain('_base');
  });
});
