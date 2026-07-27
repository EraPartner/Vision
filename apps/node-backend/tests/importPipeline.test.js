import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockLogger } from './helpers/mockLogger.js'
import { mockTxConnection } from './helpers/repoMocks.js'
import { validateBatch } from '../src/services/importPipeline/validate.js'
import { stageBatch } from '../src/services/importPipeline/stage.js'
import { matchBatch } from '../src/services/importPipeline/match.js'
import { commitBatch } from '../src/services/importPipeline/commit.js'
import { query, poolQuery } from '../src/database/connection.js'
import { getAdapter } from '../src/services/importPipeline/adapters/index.js'
import { findBestRecipientMatches } from '../src/services/calculations/normalization.js'
import { loadActivePatterns, applyPatterns } from '../src/services/recipientPatternService.js'
import { refreshAggregations } from '../src/services/aggregationRefresh.js'

// Ambient-aware connection mock: commitBatch's per-row writes now go through
// repositories, which issue module-level query() inside withTransaction — the
// ambient context routes those onto `mockClient`, alongside the SAVEPOINT
// ceremony the pipeline still issues on the client directly.
const { mockClient } = vi.hoisted(() => ({ mockClient: { query: vi.fn() } }))
vi.mock('../src/database/connection.js', () => mockTxConnection(mockClient))
vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}))
vi.mock('../src/services/importPipeline/adapters/index.js', () => ({
  getAdapter: vi.fn(),
}))
vi.mock('../src/services/calculations/normalization.js', () => ({
  findBestRecipientMatches: vi.fn(),
  normalizeForMatching: vi.fn(),
}))
vi.mock('../src/services/recipientPatternService.js', () => ({
  loadActivePatterns: vi.fn(),
  applyPatterns: vi.fn(),
}))
vi.mock('../src/services/aggregationRefresh.js', () => ({
  refreshAggregations: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockClient.query.mockReset()
  mockClient.query.mockResolvedValue({ rows: [] })
  refreshAggregations.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// validateBatch
// ---------------------------------------------------------------------------

describe('validateBatch', () => {
  function setupPending(row) {
    query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='validating'
      .mockResolvedValueOnce({ rows: [row] }) // SELECT pending
  }

  const baseRow = {
    id: 1,
    row_index: 0,
    tx_date: '2024-01-15',
    amount: '-12.50',
    recipient_raw: 'SHOP',
    memo: 'coffee',
    currency: 'EUR',
    raw_data: null,
    bank_account: 'BE12',
    balance: null,
  }

  it('returns {validated:1, duplicates:0, errors:0} for a valid row', async () => {
    setupPending(baseRow)
    expect(await validateBatch({ batchId: 1 })).toEqual({ validated: 1, duplicates: 0, errors: 0 })
  })

  it('returns {validated:0, duplicates:0, errors:1} for missing tx_date', async () => {
    setupPending({ ...baseRow, tx_date: null })
    expect(await validateBatch({ batchId: 2 })).toEqual({ validated: 0, duplicates: 0, errors: 1 })
  })

  it('returns {validated:0, duplicates:0, errors:1} for null amount', async () => {
    setupPending({ ...baseRow, amount: null })
    expect(await validateBatch({ batchId: 3 })).toEqual({ validated: 0, duplicates: 0, errors: 1 })
  })

  it('returns {validated:0, duplicates:0, errors:1} for non-numeric amount', async () => {
    setupPending({ ...baseRow, amount: 'N/A' })
    expect(await validateBatch({ batchId: 4 })).toEqual({ validated: 0, duplicates: 0, errors: 1 })
  })

  it('marks a second identical row in the same batch as a duplicate', async () => {
    const dupRow = { ...baseRow, id: 2, row_index: 1, raw_data: null }
    query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='validating'
      .mockResolvedValueOnce({ rows: [baseRow, dupRow] }) // SELECT pending — two identical rows
    // The UPDATE import_batches rows_duplicate write also issues a query.
    query.mockResolvedValueOnce({ rows: [] })
    expect(await validateBatch({ batchId: 5 })).toEqual({ validated: 1, duplicates: 1, errors: 0 })
  })
})

// ---------------------------------------------------------------------------
// stageBatch
// ---------------------------------------------------------------------------

describe('stageBatch', () => {
  it('throws for an unknown adapter', async () => {
    query.mockResolvedValueOnce({ rows: [] }) // UPDATE status='staging'
    getAdapter.mockReturnValue(null)
    await expect(
      stageBatch({ batchId: 1, filePath: '/tmp/x.csv', adapterName: 'bogus' }),
    ).rejects.toThrow('Unknown adapter: bogus')
  })

  it('returns {rowsTotal, rowsSkipped} after staging parsed rows', async () => {
    const parsed = [
      { date: '2024-01-01', amount: '-10', recipient: 'A', memo: '', currency: 'EUR' },
      { date: '2024-01-02', amount: '-20', recipient: 'B', memo: '', currency: 'EUR' },
    ]
    parsed.skipped = 3 // adapter reported 3 unparseable rows
    getAdapter.mockReturnValue({ parse: vi.fn().mockResolvedValue(parsed) })
    query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='staging'
      .mockResolvedValueOnce({ rows: [] }) // UPDATE rows_total
    expect(await stageBatch({ batchId: 1, filePath: '/tmp/x.csv', adapterName: 'belfius' }))
      .toEqual({ rowsTotal: 2, rowsSkipped: 3 })
  })
})

// ---------------------------------------------------------------------------
// matchBatch
// ---------------------------------------------------------------------------

describe('matchBatch', () => {
  it('marks a pattern-matched row as matched with source=pattern', async () => {
    query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='matching'
      .mockResolvedValueOnce({ rows: [{ id: 1, recipient_raw: 'COLRUYT' }] })
    loadActivePatterns.mockResolvedValue([])
    applyPatterns.mockResolvedValue(new Map([['COLRUYT', { recipientId: 42, patternId: 7 }]]))
    findBestRecipientMatches.mockResolvedValue(new Map())

    const result = await matchBatch({ batchId: 1 })
    expect(result.matched).toBe(1)
    expect(result.unresolved).toBe(0)
    expect(result.matchSourceCounts.pattern).toBe(1)
  })

  it('marks row as unresolved when recipient_raw is null', async () => {
    query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='matching'
      .mockResolvedValueOnce({ rows: [{ id: 2, recipient_raw: null }] })
    loadActivePatterns.mockResolvedValue([])
    applyPatterns.mockResolvedValue(new Map())
    findBestRecipientMatches.mockResolvedValue(new Map())

    const result = await matchBatch({ batchId: 2 })
    expect(result.matched).toBe(0)
    expect(result.unresolved).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// commitBatch
// ---------------------------------------------------------------------------

describe('commitBatch', () => {
  const matchedRow = {
    id: 1,
    row_index: 0,
    tx_date: '2024-01-15',
    bank_account: 'BE12',
    recipient_raw: 'SHOP',
    memo: 'coffee',
    amount: '-5.00',
    currency: 'EUR',
    balance: null,
    comment: null,
    resolved_recipient_id: 42,
    user_override_recipient_id: null,
    matched_pattern_id: 7,
    override_category_id: null,
    recipient_default_category_id: 3,
  }

  // Primes the POOL sink, not the exported spy: commitBatch's per-row work now
  // runs through repositories inside the chunk transaction, and the ambient
  // context routes those onto `mockClient`. Priming the pool keeps this ordered
  // sequence matched to the three genuinely pooled statements.
  function setupCommit(row) {
    poolQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status='committing'
      .mockResolvedValueOnce({ rows: [row] }) // SELECT matched
      .mockResolvedValueOnce({ rows: [] }) // UPDATE counters
  }

  it('imports a clean row and triggers aggregation refresh', async () => {
    setupCommit(matchedRow)
    // The transactions INSERT now uses ON CONFLICT ... RETURNING id — a
    // returned row means the insert landed (vs. a tx_hash conflict).
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO transactions')) return { rows: [{ id: 100 }] }
      return { rows: [] }
    })
    expect(await commitBatch({ batchId: 1 })).toEqual({ imported: 1, duplicates: 0, errors: 0, autoLinkedCount: 0 })
    expect(refreshAggregations).toHaveBeenCalledOnce()
  })

  it('inserts the local calendar day when tx_date is a Date (no UTC day-shift)', async () => {
    // node-postgres parses DATE columns into a server-local-midnight Date.
    // toISOString() would roll this back a day under a TZ east of UTC.
    setupCommit({ ...matchedRow, tx_date: new Date(2026, 5, 15) })
    let insertedDate
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO transactions')) {
        insertedDate = params[0]
        return { rows: [{ id: 100 }] }
      }
      return { rows: [] }
    })
    await commitBatch({ batchId: 7 })
    expect(insertedDate).toBe('2026-06-15')
  })

  it('marks a duplicate row and skips aggregation refresh', async () => {
    setupCommit(matchedRow)
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT t.id')) return { rows: [{ id: 999 }] }
      return { rows: [] }
    })
    expect(await commitBatch({ batchId: 2 })).toEqual({ imported: 0, duplicates: 1, errors: 0, autoLinkedCount: 0 })
    expect(refreshAggregations).not.toHaveBeenCalled()
  })

  it('field-dedup is scoped to the same account and never matches a differing-hash row', async () => {
    // Two same-day card payments share date+amount+recipient+memo (Revolut
    // stamps the identical "CARD_PAYMENT - CURRENT") but differ by tx_hash
    // (running balance differs) — the second must NOT collapse into the first.
    // Likewise an identical purchase on a DIFFERENT account is distinct.
    setupCommit({ ...matchedRow, tx_hash: 'h2' })
    let dupSql, dupParams
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT t.id')) { dupSql = sql; dupParams = params; return { rows: [] } }
      if (sql.includes('INSERT INTO transactions')) return { rows: [{ id: 100 }] }
      return { rows: [] }
    })
    expect(await commitBatch({ batchId: 9 })).toEqual({ imported: 1, duplicates: 0, errors: 0, autoLinkedCount: 0 })
    expect(dupSql).toContain('t.bank_account IS NOT DISTINCT FROM $5')
    expect(dupSql).toContain('t.tx_hash <> $6')
    expect(dupParams[4]).toBe('BE12')
    expect(dupParams[5]).toBe('h2')
  })

  it('records an insert error via SAVEPOINT rollback', async () => {
    setupCommit(matchedRow)
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('INSERT INTO transactions')) throw new Error('constraint violation')
      return { rows: [] }
    })
    expect(await commitBatch({ batchId: 3 })).toEqual({ imported: 0, duplicates: 0, errors: 1, autoLinkedCount: 0 })
  })

  it('rejects a non-integer staging row.id before issuing SAVEPOINT', async () => {
    // Defence-in-depth: import_staging_rows.id is BIGSERIAL today, but if a
    // future schema change ever loosened that to a string, the savepoint
    // identifier interpolation would become an injection vector. The assert
    // makes that fail loudly rather than silently injecting.
    setupCommit({ ...matchedRow, id: "1; DROP TABLE x" })
    expect(await commitBatch({ batchId: 4 })).toEqual({ imported: 0, duplicates: 0, errors: 1, autoLinkedCount: 0 })
    const savepointCalls = mockClient.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.startsWith('SAVEPOINT'),
    )
    expect(savepointCalls).toHaveLength(0)
  })
})
