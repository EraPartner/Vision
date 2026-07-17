import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';
// Export date serialization (TODO E11): the CSV column was String(pg Date)
// ("Wed Jul 01 2026 00:00:00 GMT+0200 …" — unusable in Excel, a day off on
// cross-TZ re-import) and buildNdjsonRow went through JSON.stringify's
// toISOString — the PREVIOUS day's timestamp on any backend east of UTC.

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));
vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { query as dbQuery } from '../src/database/connection.js';
import { streamCsvExport, streamNdjsonExport } from '../src/services/transactionExport.js';

// A pg DATE arrives as a LOCAL-midnight Date object; this is the shape the
// export must turn back into a plain calendar day regardless of process TZ.
const JULY_FIRST = new Date(2026, 6, 1);

function exportRow(overrides = {}) {
  return {
    id: 1,
    date: JULY_FIRST,
    bank_account: 'BE12',
    recipient_name: 'Shop',
    memo: 'memo',
    amount: '-12.50',
    currency: 'EUR',
    balance: '100.00',
    category_name: 'Food:Groceries',
    comment: null,
    tags: ['a', 'b'],
    ...overrides,
  };
}

function mockRes() {
  const chunks = [];
  return {
    chunks,
    setHeader: vi.fn(),
    write(chunk) { chunks.push(chunk); return true; },
    end: vi.fn(),
    once: vi.fn(),
    headersSent: true,
  };
}

function primeQueries(rows) {
  dbQuery
    .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // probe
    .mockResolvedValueOnce({ rows }); // single chunk (< EXPORT_CHUNK_SIZE ends the loop)
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('export date serialization', () => {
  it('CSV emits the calendar day, not String(pg Date)', async () => {
    primeQueries([exportRow()]);
    const res = mockRes();

    await streamCsvExport(res, { whereSql: '1=1', params: [], nextParamIdx: 1 });

    const dataRow = res.chunks[1]; // [0] is the header line
    expect(dataRow.startsWith('2026-07-01,')).toBe(true);
    expect(dataRow).not.toMatch(/GMT|Jul/);
  });

  it('CSV running balance is partitioned per account, not one global accumulator', async () => {
    primeQueries([
      exportRow({ id: 1, account_id: 1, amount: '100.00' }),
      exportRow({ id: 2, account_id: 2, amount: '50.00' }),
      exportRow({ id: 3, account_id: 1, amount: '-30.00' }),
    ]);
    const res = mockRes();

    await streamCsvExport(res, { whereSql: '1=1', params: [], nextParamIdx: 1, includeBalance: true });

    const balances = res.chunks.slice(1).map((line) => line.trim().split(',').pop());
    // account 1: 100 → 70; account 2: 50 (not 150/120 from a global sum)
    expect(balances).toEqual(['100', '50', '70']);
  });

  it('NDJSON emits the calendar day, not the previous-day ISO timestamp', async () => {
    primeQueries([exportRow()]);
    const res = mockRes();

    await streamNdjsonExport(res, { whereSql: '1=1', params: [], nextParamIdx: 1 });

    const parsed = JSON.parse(res.chunks[0]);
    expect(parsed.date).toBe('2026-07-01');
  });
});

describe('export tag aggregation', () => {
  it('CSV joins a multi-tag transaction on the slug-ordered array', async () => {
    primeQueries([exportRow({ tags: ['alpha', 'beta', 'gamma'] })]);
    const res = mockRes();

    await streamCsvExport(res, { whereSql: '1=1', params: [], nextParamIdx: 1 });

    // Tags column (10th) preserves order and joins with ';'.
    expect(res.chunks[1]).toContain('alpha;beta;gamma');
  });

  it('NDJSON emits the multi-tag array unchanged', async () => {
    primeQueries([exportRow({ tags: ['alpha', 'beta', 'gamma'] })]);
    const res = mockRes();

    await streamNdjsonExport(res, { whereSql: '1=1', params: [], nextParamIdx: 1 });

    expect(JSON.parse(res.chunks[0]).tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('fetches tags via a single pre-aggregated LEFT JOIN, not a per-row correlated subquery', async () => {
    primeQueries([exportRow()]);
    const res = mockRes();

    await streamNdjsonExport(res, { whereSql: '1=1', params: [], nextParamIdx: 1 });

    // dbQuery calls: [0] probe, [1] first chunk.
    const chunkSql = dbQuery.mock.calls[1][0];
    // Slug ordering + active-only filter preserved …
    expect(chunkSql).toContain('array_agg(tg.slug ORDER BY tg.slug)');
    expect(chunkSql).toContain('WHERE tg.is_active = true');
    // … as a grouped LEFT JOIN, not a t.id-correlated subquery.
    expect(chunkSql).toContain('GROUP BY tt.transaction_id');
    expect(chunkSql).not.toContain('WHERE tt.transaction_id = t.id');
  });
});
