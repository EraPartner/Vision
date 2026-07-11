import { describe, it, expect, vi, beforeEach } from 'vitest';

// Export date serialization (TODO E11): the CSV column was String(pg Date)
// ("Wed Jul 01 2026 00:00:00 GMT+0200 …" — unusable in Excel, a day off on
// cross-TZ re-import) and buildNdjsonRow went through JSON.stringify's
// toISOString — the PREVIOUS day's timestamp on any backend east of UTC.

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

  it('NDJSON emits the calendar day, not the previous-day ISO timestamp', async () => {
    primeQueries([exportRow()]);
    const res = mockRes();

    await streamNdjsonExport(res, { whereSql: '1=1', params: [], nextParamIdx: 1 });

    const parsed = JSON.parse(res.chunks[0]);
    expect(parsed.date).toBe('2026-07-01');
  });
});
