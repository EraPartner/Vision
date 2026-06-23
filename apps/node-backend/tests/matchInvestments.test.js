import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import { matchBatch } from '../src/services/portfolioImportPipeline/matchInvestments.js';

// Existing holdings: AAPL by symbol, "Apple Inc" by exact name.
function dispatch(sql, params) {
  if (/SET status = 'matching'/.test(sql)) return { rows: [] };
  if (/status = 'validated'/.test(sql)) {
    return {
      rows: [
        { id: 11, symbol_raw: 'AAPL', name_raw: 'Apple' },
        { id: 12, symbol_raw: '', name_raw: 'Apple Inc' },
        { id: 13, symbol_raw: 'ZZZZ', name_raw: '' },
      ],
    };
  }
  if (/LOWER\(symbol\)/.test(sql)) {
    return String(params[0]).toUpperCase() === 'AAPL' ? { rows: [{ id: 1 }] } : { rows: [] };
  }
  if (/LOWER\(TRIM\(name\)\)/.test(sql)) {
    return String(params[0]).trim().toLowerCase() === 'apple inc' ? { rows: [{ id: 2 }] } : { rows: [] };
  }
  if (/SET\s+status = 'matched'/.test(sql)) {
    captured.update = params;
    return { rows: [] };
  }
  return { rows: [] };
}

let captured;
beforeEach(() => {
  captured = {};
  query.mockReset();
  query.mockImplementation((sql, params) => Promise.resolve(dispatch(sql, params)));
});

describe('matchBatch (investment matching)', () => {
  it('resolves by symbol (case-insensitive), then exact name, else unresolved', async () => {
    const result = await matchBatch({ batchId: 7 });

    expect(result.matchSourceCounts).toEqual({ symbol: 1, name_exact: 1, unresolved: 1 });
    expect(result.unresolved).toBe(1);

    // unnest update params: [ids, investmentIds, matchSources]
    const [ids, investmentIds, matchSources] = captured.update;
    expect(ids).toEqual([11, 12, 13]);
    expect(investmentIds).toEqual([1, 2, null]);
    expect(matchSources).toEqual(['symbol', 'name_exact', null]);
  });

  it('caches resolution per distinct instrument (no duplicate lookups)', async () => {
    query.mockReset();
    query.mockImplementation((sql, params) => {
      if (/status = 'validated'/.test(sql)) {
        return Promise.resolve({
          rows: [
            { id: 21, symbol_raw: 'AAPL', name_raw: 'Apple' },
            { id: 22, symbol_raw: 'AAPL', name_raw: 'Apple' },
          ],
        });
      }
      return Promise.resolve(dispatch(sql, params));
    });

    await matchBatch({ batchId: 8 });
    const symbolLookups = query.mock.calls.filter(([sql]) => /LOWER\(symbol\)/.test(sql));
    expect(symbolLookups).toHaveLength(1);
  });
});
