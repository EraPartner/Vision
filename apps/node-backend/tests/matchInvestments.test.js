import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import { matchBatch } from '../src/services/portfolioImportPipeline/matchInvestments.js';

// Batched resolution: one grouped query per resolution kind. The mock indexes a
// fixture "table" of active investments by lowercased symbol / lowercased-trimmed
// name and returns { match_key, id (MIN), count } rows just like the real
// GROUP BY / MIN(id) / COUNT(*) SQL, honouring the `= ANY($1::text[])` filter.
function groupedLookup(fixtures, keyFn, wanted) {
  const buckets = new Map();
  for (const inv of fixtures) {
    if (!inv.is_active) continue;
    const key = keyFn(inv);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(inv.id);
  }
  const wantedSet = new Set(wanted);
  const rows = [];
  for (const [key, ids] of buckets) {
    if (!wantedSet.has(key)) continue;
    rows.push({ match_key: key, id: Math.min(...ids), count: ids.length });
  }
  return { rows };
}

// Existing holdings: AAPL by symbol, "Apple Inc" by exact name.
const DEFAULT_INVESTMENTS = [
  { id: 1, symbol: 'AAPL', name: 'Apple', is_active: true },
  { id: 2, symbol: 'AAPLX', name: 'Apple Inc', is_active: true },
];

function makeDispatch(stagingRows, investments = DEFAULT_INVESTMENTS, capture = {}) {
  return function dispatch(sql, params) {
    if (/SET status = 'matching'/.test(sql)) return { rows: [] };
    if (/route = 'cash'/.test(sql)) return { rows: [] };
    if (/status = 'validated'/.test(sql)) return { rows: stagingRows };
    if (/LOWER\(symbol\)/.test(sql)) {
      capture.symbolLookups = (capture.symbolLookups ?? 0) + 1;
      return groupedLookup(investments, (inv) => inv.symbol.toLowerCase(), params[0]);
    }
    if (/LOWER\(TRIM\(name\)\)/.test(sql)) {
      capture.nameLookups = (capture.nameLookups ?? 0) + 1;
      return groupedLookup(investments, (inv) => inv.name.trim().toLowerCase(), params[0]);
    }
    if (/SET\s+status = 'matched'/.test(sql)) {
      capture.update = params;
      return { rows: [] };
    }
    return { rows: [] };
  };
}

let captured;
beforeEach(() => {
  captured = {};
  query.mockReset();
});

function install(stagingRows, investments) {
  const dispatch = makeDispatch(stagingRows, investments, captured);
  query.mockImplementation((sql, params) => Promise.resolve(dispatch(sql, params)));
}

describe('matchBatch (investment matching)', () => {
  it('resolves by symbol (case-insensitive), then exact name, else unresolved', async () => {
    install([
      { id: 11, symbol_raw: 'AAPL', name_raw: 'Apple' },
      { id: 12, symbol_raw: '', name_raw: 'Apple Inc' },
      { id: 13, symbol_raw: 'ZZZZ', name_raw: '' },
    ]);

    const result = await matchBatch({ batchId: 7 });

    expect(result.matchSourceCounts).toEqual({ symbol: 1, name_exact: 1, unresolved: 1 });
    expect(result.unresolved).toBe(1);

    // unnest update params: [ids, investmentIds, matchSources]
    const [ids, investmentIds, matchSources] = captured.update;
    expect(ids).toEqual([11, 12, 13]);
    expect(investmentIds).toEqual([1, 2, null]);
    expect(matchSources).toEqual(['symbol', 'name_exact', null]);
  });

  it('caches resolution per distinct instrument (one batched symbol lookup)', async () => {
    install([
      { id: 21, symbol_raw: 'AAPL', name_raw: 'Apple' },
      { id: 22, symbol_raw: 'AAPL', name_raw: 'Apple' },
    ]);

    await matchBatch({ batchId: 8 });
    const symbolLookups = query.mock.calls.filter(([sql]) => /LOWER\(symbol\)/.test(sql));
    expect(symbolLookups).toHaveLength(1);
  });

  it('leaves an ambiguous ticker (>1 active match) unresolved instead of picking the lowest id', async () => {
    install(
      [{ id: 31, symbol_raw: 'DUAL', name_raw: 'Dual Listed' }],
      // Two active investments share the ticker → ambiguous.
      [
        { id: 5, symbol: 'DUAL', name: 'Dual A', is_active: true },
        { id: 6, symbol: 'DUAL', name: 'Dual B', is_active: true },
      ],
    );

    const result = await matchBatch({ batchId: 9 });
    expect(result.unresolved).toBe(1);
    const [, investmentIds, matchSources] = captured.update;
    expect(investmentIds).toEqual([null]); // not 5 (the lowest id)
    expect(matchSources).toEqual([null]);
  });

  it('batches resolution: multi-row output identical to the old per-row matcher, with fewer queries than rows', async () => {
    const stagingRows = [
      { id: 1, symbol_raw: 'AAPL', name_raw: 'Apple' },       // symbol → 100
      { id: 2, symbol_raw: 'aapl', name_raw: 'irrelevant' },  // symbol (case-insensitive) → 100
      { id: 3, symbol_raw: 'AAPL', name_raw: 'also ignored' },// symbol → 100
      { id: 4, symbol_raw: '', name_raw: 'Tesla Inc' },       // name_exact → 200
      { id: 5, symbol_raw: 'NOPE', name_raw: 'Tesla Inc' },   // symbol miss → name_exact → 200
      { id: 6, symbol_raw: 'DUAL', name_raw: 'Dual Corp' },   // ambiguous symbol → unresolved (no name fallback)
      { id: 7, symbol_raw: 'DUAL', name_raw: 'Dual Corp' },   // ambiguous symbol → unresolved
      { id: 8, symbol_raw: 'XXX', name_raw: '' },             // nothing → unresolved
    ];
    const investments = [
      { id: 100, symbol: 'AAPL', name: 'Apple Inc', is_active: true },
      { id: 200, symbol: 'TSLA', name: 'Tesla Inc', is_active: true },
      { id: 300, symbol: 'DUAL', name: 'Dual Corp One', is_active: true },
      { id: 301, symbol: 'DUAL', name: 'Dual Corp Two', is_active: true },
    ];
    install(stagingRows, investments);

    const result = await matchBatch({ batchId: 42 });

    // (c) counts / matchSources output unchanged vs the old per-row behaviour.
    expect(result.matchSourceCounts).toEqual({ symbol: 3, name_exact: 2, unresolved: 3 });
    expect(result.unresolved).toBe(3);
    const [ids, investmentIds, matchSources] = captured.update;
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(investmentIds).toEqual([100, 100, 100, 200, 200, null, null, null]);
    expect(matchSources).toEqual(['symbol', 'symbol', 'symbol', 'name_exact', 'name_exact', null, null, null]);

    // (a) fewer queries than rows: exactly one symbol + one name resolution query
    // regardless of row count, and total queries below the row count.
    expect(captured.symbolLookups).toBe(1);
    expect(captured.nameLookups).toBe(1);
    expect(query.mock.calls.length).toBeLessThan(stagingRows.length);

    // (b) the ambiguous ticker never falls through to a name match.
    const dualNameQueried = query.mock.calls.some(
      ([sql, params]) => /LOWER\(TRIM\(name\)\)/.test(sql) && (params[0] || []).includes('dual corp'),
    );
    expect(dualNameQueried).toBe(false);
  });
});
