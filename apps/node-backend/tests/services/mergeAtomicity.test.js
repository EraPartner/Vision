/**
 * Transaction atomicity for the repo-composed write services (ADR-006/ADR-067).
 *
 * These services no longer thread a client through their statements — they call
 * repository methods, which issue module-level query() and rely on the ambient
 * transaction context to land on the open transaction's connection. That is
 * exactly the property worth pinning: if any repo call silently ran on the pool
 * instead, it would survive the ROLLBACK and leave a half-repointed ledger
 * (an account merge that moved transactions but never deleted the source, a
 * recipient merge that moved money rows but never flagged the alias).
 *
 * So these tests drive the REAL connection module over a mocked pg pool — real
 * BEGIN/COMMIT/ROLLBACK, real AsyncLocalStorage routing — force a late failure
 * inside the transaction, and assert the whole statement sequence ran on ONE
 * connection between BEGIN and ROLLBACK, with the pool never touched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Load the real connection module against a mocked pg pool, so `withTransaction`
 * performs its genuine ceremony and module-level query() genuinely reroutes.
 */
async function loadRealTransactionStack() {
  vi.resetModules();

  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  const pool = {
    on: vi.fn(),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn(),
  };

  // Must be a real function: connection.js calls `new pg.Pool(...)`.
  const poolCtor = vi.fn().mockImplementation(function MockPool() {
    return pool;
  });
  vi.doMock('pg', () => ({ default: { Pool: poolCtor } }));
  vi.doMock('../../src/config/config.js', () => ({
    default: {
      database: { url: 'postgresql://test', poolSize: 5, maxOverflow: 10, echo: false },
    },
  }));
  vi.doMock('../../src/config/logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  }));

  return { client, pool };
}

/** BEGIN … ROLLBACK bracket + nothing on the pool: the rollback covered it all. */
function expectRolledBackOnOneConnection(client, pool) {
  const sqls = client.query.mock.calls.map(([sql]) => sql);
  expect(sqls[0]).toBe('BEGIN');
  expect(sqls.at(-1)).toBe('ROLLBACK');
  expect(sqls).not.toContain('COMMIT');
  // Nothing escaped to a pooled connection, which a ROLLBACK could not undo.
  expect(pool.query).not.toHaveBeenCalled();
  expect(client.release).toHaveBeenCalled();
  return sqls;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('account merge atomicity (ADR-088)', () => {
  it('rolls back every repoint on one connection when the source DELETE fails', async () => {
    const { client, pool } = await loadRealTransactionStack();
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('FOR UPDATE') && sql.includes('WHERE id = $1')) {
        return { rows: [{ id: 2, name: 'TARGET' }] };
      }
      if (sql.includes('FOR UPDATE') && sql.includes('ANY')) return { rows: [{ id: 1 }] };
      if (sql.includes('GROUP BY account_id')) return { rows: [] };
      // The realistic late failure: account_id FKs are ON DELETE RESTRICT, so a
      // missed reference makes the final DELETE raise after every repoint ran.
      if (sql.includes('DELETE FROM accounts')) throw new Error('23503 foreign key violation');
      return { rows: [], rowCount: 1 };
    });

    const { mergeAccounts } = await import('../../src/services/accountMergeService.js');
    await expect(mergeAccounts(2, [1])).rejects.toThrow('23503 foreign key violation');

    const sqls = expectRolledBackOnOneConnection(client, pool);
    // All four repoints were issued by repositories, inside this transaction —
    // so the ROLLBACK above undoes every one of them.
    expect(sqls.some((s) => s.includes('UPDATE transactions SET account_id'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE planned_transactions SET account_id'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE portfolio_transactions SET account_id'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE accounts SET funding_account_id'))).toBe(true);
    // …and the survivor lock was taken on the same connection, before them.
    expect(sqls.indexOf('SELECT id, name FROM accounts WHERE id = $1 FOR UPDATE')).toBe(1);
  });
});

describe('recipient merge atomicity (ADR-014)', () => {
  it('rolls back the FK reassignments when the grandchild re-point fails', async () => {
    const { client, pool } = await loadRealTransactionStack();
    client.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('FOR UPDATE')) return { rows: [{ id: 1 }] };
      if (sql.includes('information_schema')) return { rows: [] };
      // Last statement of the merge — fails after every FK has been reassigned.
      if (sql.includes('WHERE primary_recipient_id = ANY')) {
        throw new Error('deadlock detected');
      }
      if (sql.includes('RETURNING id')) return { rows: [{ id: 3 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const { mergeRecipients } = await import('../../src/services/recipientMergeService.js');
    await expect(mergeRecipients(1, [3])).rejects.toThrow('deadlock detected');

    const sqls = expectRolledBackOnOneConnection(client, pool);
    // Every money-bearing reassignment ran inside the rolled-back transaction.
    expect(sqls.some((s) => s.includes('UPDATE transactions') && s.includes('recipient_id = $1'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE transaction_splits'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM recipient_bank_accounts'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE recipient_bank_accounts'))).toBe(true);
    expect(sqls.some((s) => s.includes('RETURNING id'))).toBe(true);
  });
});

describe('transfer mark atomicity (ADR-083)', () => {
  it('rolls back the released peers and the first leg when the second leg fails', async () => {
    const { client, pool } = await loadRealTransactionStack();
    client.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('FOR UPDATE')) {
        return {
          rows: [
            { id: 10, amount: -100, account_id: 1, is_active: true },
            { id: 20, amount: 100, account_id: 2, is_active: true },
          ],
        };
      }
      // The SECOND manual leg fails, after the peer release and the first leg.
      if (sql.includes("transfer_source = 'manual'") && params?.[0] === 20) {
        throw new Error('serialization failure');
      }
      return { rows: [], rowCount: 1 };
    });

    const { markTransfer } = await import('../../src/services/transferReconciliationService.js');
    await expect(markTransfer(10, 20)).rejects.toThrow('serialization failure');

    const sqls = expectRolledBackOnOneConnection(client, pool);
    // The peer release and the first leg are undone together — without one
    // transaction, leg 10 would stay marked against an unmarked peer, and the
    // prior counterparts released above would never come back.
    expect(sqls.some((s) => s.includes('transfer_peer_id = ANY($1) AND id <> ALL($1)'))).toBe(true);
    const manualMarks = client.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes("transfer_source = 'manual'"),
    );
    expect(manualMarks).toHaveLength(2); // first succeeded, second threw
    expect(manualMarks[0][1]).toEqual([10, 20]);
  });
});
